import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface WorkerRequest {
  id: string;
  prompt: string;
  cwd: string;
  mode: "read" | "write";
  model?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export type WorkerEvent =
  | { type: "identity"; threadId: string; turnId?: string }
  | { type: "log"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number };

export interface WorkerResult {
  output: string;
  data?: unknown;
  threadId: string;
  turnId: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

export interface WorkerAdapter {
  run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult>;
  close(): Promise<void>;
}

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  startupTimeoutMs?: number;
  interruptTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type Usage = WorkerResult["usage"];
type Completion = { id: string; status: string; items?: unknown; error?: unknown };

const disabledFeatures = ["apps", "plugins", "remote_plugin", "browser_use", "computer_use", "multi_agent", "hooks", "skill_mcp_dependency_install", "memories"];
const maxMessageBytes = 16 * 1024 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function abortError(message = "Worker execution was interrupted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|sess-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/((?:api[-_ ]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[url]");
}

function safeMessage(value: unknown): string {
  return redact(typeof value === "string" ? value : "Unknown server error.").slice(0, 500);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

class ProtocolSession {
  readonly failure = deferred<never>();
  readonly child: ChildProcessWithoutNullStreams;
  private readonly exited = deferred<void>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private failed = false;
  private closing = false;
  private isExited = false;
  private closingPromise?: Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  constructor(command: string, args: string[], cwd: string, requestTimeoutMs: number, shutdownTimeoutMs: number, onNotification: (method: string, params: JsonObject) => void) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.failure.promise.catch(() => {});
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    this.child.on("error", () => this.fail(new Error("Could not launch Codex app-server. Check the configured executable and working directory.")));
    this.child.stdin.on("error", () => { if (!this.closing) this.fail(new Error("Codex app-server input pipe closed.")); });
    // Diagnostics may contain credentials. Never forward raw stderr to workflow logs.
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > maxMessageBytes) {
        this.fail(new Error("Codex app-server exceeded the protocol message limit."));
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = object(JSON.parse(line));
          if (typeof message.method === "string" && message.id !== undefined) {
            // This integration cannot grant approvals or silently answer user-input requests.
            this.send({ id: message.id, error: { code: -32601, message: "This worker host does not support server requests or approval escalation." } });
            this.fail(new Error(`Codex worker requested unsupported host interaction (${safeMessage(message.method)}).`));
            continue;
          }
          if (message.id !== undefined) {
            const entry = this.pending.get(String(message.id));
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(String(message.id));
              const error = object(message.error);
              if (message.error) entry.reject(new Error(`Codex app-server rejected a request: ${safeMessage(error.message)}`));
              else entry.resolve(message.result);
            }
          } else if (typeof message.method === "string") {
            onNotification(message.method, object(message.params));
          } else {
            this.fail(new Error("Codex app-server emitted an invalid protocol message."));
          }
        } catch {
          this.fail(new Error("Codex app-server emitted invalid JSON or a notification handler failed."));
        }
      }
    });
    this.child.once("close", (code, signal) => {
      this.isExited = true;
      this.exited.resolve();
      if (!this.closing) this.fail(new Error(`Codex app-server exited before completion (${signal ?? code ?? "unknown"}).`));
    });
  }

  fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.failure.reject(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  send(message: JsonObject) {
    if (this.closing || this.failed) throw new Error("Codex app-server connection is closed.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: JsonObject, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = timeoutError(`Codex app-server ${method} request timed out.`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(String(id)); reject(error); }
    });
  }

  private signal(signal: NodeJS.Signals) {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else if (process.platform === "win32" && signal === "SIGKILL" && this.child.pid) {
        const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => this.child.kill(signal));
      } else this.child.kill(signal);
    } catch (error) { if (object(error).code !== "ESRCH") this.child.kill(signal); }
  }

  private async waitForExit(milliseconds: number): Promise<boolean> {
    if (this.isExited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([this.exited.promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    if (timer) clearTimeout(timer);
    return result;
  }

  close(): Promise<void> {
    this.closingPromise ??= this.shutdown();
    return this.closingPromise;
  }

  private async shutdown() {
    this.closing = true;
    this.fail(new Error("Codex app-server connection closed."));
    this.child.stdin.end();
    this.signal("SIGTERM");
    if (!await this.waitForExit(this.shutdownTimeoutMs)) {
      this.signal("SIGKILL");
      if (!await this.waitForExit(this.shutdownTimeoutMs)) throw new Error("Codex app-server did not exit after forced termination.");
    }
    // A detached process group can retain command children after the parent exits.
    this.signal("SIGKILL");
  }
}

export class CodexAdapter implements WorkerAdapter {
  private readonly options: Required<CodexAdapterOptions>;
  private readonly running = new Map<Promise<WorkerResult>, AbortController>();
  private closed = false;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server", "--stdio"],
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      interruptTimeoutMs: options.interruptTimeoutMs ?? 5_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1_000,
    };
  }

  run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    if (this.closed) return Promise.reject(new Error("Worker adapter is closed."));
    if (signal.aborted) return Promise.reject(abortError());
    if (!path.isAbsolute(request.cwd) || !request.prompt.trim() || !request.id.trim()) return Promise.reject(new Error("Worker requires an ID, a prompt, and an absolute working directory."));
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) return Promise.reject(new Error("Worker timeout must be a positive integer."));
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal.addEventListener("abort", relay, { once: true });
    const operation = this.runWorker(request, controller.signal, onEvent);
    this.running.set(operation, controller);
    return operation.finally(() => { signal.removeEventListener("abort", relay); this.running.delete(operation); });
  }

  async close(): Promise<void> {
    this.closed = true;
    const operations = [...this.running];
    for (const [, controller] of operations) controller.abort();
    await Promise.allSettled(operations.map(([operation]) => operation));
  }

  private async runWorker(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    const started = Date.now();
    const completion = deferred<Completion>();
    const messages = new Map<string, { text: string; phase?: string }>();
    const logBuffers = new Map<string, string>();
    let messageBytes = 0;
    let threadId = "";
    let turnId = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let turnSent = false;
    let interruptSent = false;
    let canceled: Error | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let session!: ProtocolSession;
    const emit = (event: WorkerEvent) => { try { onEvent(event); } catch { session.fail(new Error("Worker event handler failed.")); } };
    const storeMessage = (id: string, value: { text: string; phase?: string }) => {
      const size = messageBytes - Buffer.byteLength(messages.get(id)?.text ?? "") + Buffer.byteLength(value.text);
      if (size > maxOutputBytes) { session.fail(new Error("Worker output exceeded the size limit.")); return; }
      messageBytes = size;
      messages.set(id, value);
    };
    const logChunk = (key: string, chunk: string, flush = false) => {
      // Redact complete lines, because credentials can span multiple protocol deltas.
      let buffer = (logBuffers.get(key) ?? "") + chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        emit({ type: "log", message: redact(buffer.slice(0, newline + 1)).slice(0, 32_768) });
        buffer = buffer.slice(newline + 1);
      }
      if (Buffer.byteLength(buffer) > maxOutputBytes) {
        session.fail(new Error("Worker log line exceeded the size limit."));
        return;
      }
      if (flush) {
        if (buffer) emit({ type: "log", message: redact(buffer).slice(0, 32_768) });
        logBuffers.delete(key);
      } else logBuffers.set(key, buffer);
    };
    const capture = (itemValue: unknown) => {
      const item = object(itemValue);
      if (item.type === "commandExecution") { logChunk(`command:${String(item.id)}`, "", true); return; }
      if (item.type !== "agentMessage" || typeof item.text !== "string") return;
      const id = String(item.id);
      logChunk(`agent:${id}`, logBuffers.has(`agent:${id}`) ? "" : item.text, true);
      storeMessage(id, { text: item.text, ...(typeof item.phase === "string" ? { phase: item.phase } : {}) });
    };
    const interrupt = () => {
      if (!canceled || !threadId || !turnId || interruptSent) return;
      interruptSent = true;
      // Completion is observed independently of the interrupt acknowledgement.
      void session.request("turn/interrupt", { threadId, turnId }, this.options.interruptTimeoutMs).catch(() => { if (canceled) session.fail(canceled); });
    };
    const cancel = (reason: Error) => {
      if (canceled) return;
      canceled = reason;
      if (!turnSent) { session.fail(reason); return; }
      cancelTimer = setTimeout(() => session.fail(reason), this.options.interruptTimeoutMs);
      interrupt();
    };
    const abort = () => cancel(abortError());
    session = new ProtocolSession(this.options.command, [...this.options.args, ...disabledFeatures.flatMap(feature => ["--disable", feature])], request.cwd, this.options.startupTimeoutMs, this.options.shutdownTimeoutMs, (method, params) => {
      if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return;
      if (method === "turn/started" || method === "turn/completed") {
        const turn = object(params.turn);
        if (typeof turn.id !== "string") { session.fail(new Error("Codex emitted a turn without an ID.")); return; }
        if (turnId && turn.id !== turnId) return;
        turnId = turn.id;
        if (threadId) emit({ type: "identity", threadId, turnId });
        interrupt();
        if (method === "turn/completed") {
          for (const item of Array.isArray(turn.items) ? turn.items : []) capture(item);
          for (const key of [...logBuffers.keys()]) logChunk(key, "", true);
          completion.resolve({ id: turnId, status: String(turn.status), items: turn.items, error: turn.error });
        }
      } else if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const id = String(params.itemId ?? "message");
        const previous = messages.get(id);
        const text = (previous?.text ?? "") + params.delta;
        storeMessage(id, { text, ...(previous?.phase ? { phase: previous.phase } : {}) });
        logChunk(`agent:${id}`, params.delta);
      } else if (method === "item/completed") capture(params.item);
      else if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") logChunk(`command:${String(params.itemId)}`, params.delta);
      else if (method === "item/started" && object(params.item).type === "commandExecution") emit({ type: "log", message: "Command execution started." });
      else if (method === "thread/tokenUsage/updated") {
        const total = object(object(params.tokenUsage).total);
        usage = { inputTokens: tokenCount(total.inputTokens), outputTokens: tokenCount(total.outputTokens), totalTokens: tokenCount(total.totalTokens) };
        emit({ type: "usage", ...usage });
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    startupTimer = setTimeout(() => session.fail(timeoutError("Codex worker startup timed out.")), this.options.startupTimeoutMs);
    try {
      await session.request("initialize", { clientInfo: { name: "codex_workflows", title: "Codex Workflows", version: "0.2.1" }, capabilities: { experimentalApi: true } });
      session.send({ method: "initialized", params: {} });
      const effective = object(object(await session.request("config/read", { cwd: request.cwd })).config);
      const config: JsonObject = { "web_search": "disabled" };
      for (const feature of disabledFeatures) config[`features.${feature}`] = false;
      for (const name of Object.keys(object(effective.mcp_servers))) {
        // App-server config paths split on dots; quoted TOML keys are not supported.
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Cannot safely disable an inherited MCP server with this config key format.");
        config[`mcp_servers.${name}.enabled`] = false;
        config[`mcp_servers.${name}.required`] = false;
      }
      config["sandbox_workspace_write.writable_roots"] = [request.cwd];
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      const threadResponse = object(await session.request("thread/start", {
        cwd: request.cwd, approvalPolicy: "never", sandbox: request.mode === "read" ? "read-only" : "workspace-write", config,
        ephemeral: true, ...(request.model ? { model: request.model } : {}),
        developerInstructions: "You are a workflow worker. Complete only the supplied task. Do not send messages, publish, deploy, install plugins, change global configuration, or launch other agents. External tools and network access are disabled. If additional permission or user input is needed, explain the limitation and stop.",
      }));
      const thread = object(threadResponse.thread);
      if (typeof thread.id !== "string" || !thread.id) throw new Error("Codex did not return a worker thread ID.");
      threadId = thread.id;
      emit({ type: "identity", threadId });
      if (canceled) throw canceled;
      const actualSandbox = object(threadResponse.sandbox);
      if (actualSandbox.type !== (request.mode === "read" ? "readOnly" : "workspaceWrite") || actualSandbox.networkAccess !== false) throw new Error("Codex did not enforce the requested worker sandbox.");
      if (request.mode === "write" && (!Array.isArray(actualSandbox.writableRoots) || actualSandbox.writableRoots.some(root => typeof root !== "string" || path.resolve(root) !== path.resolve(request.cwd)) || actualSandbox.excludeTmpdirEnvVar !== true || actualSandbox.excludeSlashTmp !== true)) throw new Error("Codex worker write access is not limited to its workspace.");
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const roster = object(await session.request("mcpServerStatus/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(roster.data) || roster.data.some(server => object(server).runtimeStatus !== "disabled" || Object.keys(object(object(server).tools)).length > 0)) throw new Error("Inherited MCP tools remain enabled in the worker; execution was refused.");
        cursor = typeof roster.nextCursor === "string" ? roster.nextCursor : undefined;
        if (cursor && seenCursors.has(cursor)) throw new Error("Codex MCP inventory pagination did not advance.");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      clearTimeout(startupTimer);
      startupTimer = undefined;
      if (canceled || signal.aborted) throw canceled ?? abortError();
      turnTimer = setTimeout(() => cancel(timeoutError("Codex worker execution timed out.")), request.timeoutMs ?? 30 * 60_000);
      turnSent = true;
      const sandboxPolicy = request.mode === "read" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [request.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      const turnAck = session.request("turn/start", { threadId, input: [{ type: "text", text: request.prompt }], cwd: request.cwd, approvalPolicy: "never", sandboxPolicy, ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}) }, request.timeoutMs ?? 30 * 60_000);
      const first = object(await Promise.race([turnAck, completion.promise.then(turn => ({ turn })), session.failure.promise]));
      const firstTurn = object(first.turn);
      if (typeof firstTurn.id !== "string") throw new Error("Codex did not return a worker turn ID.");
      if (turnId && firstTurn.id !== turnId) throw new Error("Codex turn identity changed during startup.");
      turnId = firstTurn.id;
      emit({ type: "identity", threadId, turnId });
      interrupt();
      const terminal = await Promise.race([completion.promise, session.failure.promise]);
      if (canceled) throw canceled;
      if (terminal.status === "interrupted") throw abortError();
      if (terminal.status !== "completed") throw new Error(`Codex worker failed: ${safeMessage(object(terminal.error).message)}`);
      const values = [...messages.values()];
      const finalMessages = values.filter(message => message.phase === "final_answer");
      const output = (finalMessages.length ? finalMessages : values.slice(-1)).map(message => message.text).join("\n");
      let data: unknown;
      if (request.outputSchema) {
        try { data = JSON.parse(output); } catch { throw new Error("Codex worker did not return valid structured JSON output."); }
      }
      return { output, ...(request.outputSchema ? { data } : {}), threadId, turnId, usage, durationMs: Date.now() - started };
    } catch (error) {
      if (canceled) throw canceled;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (startupTimer) clearTimeout(startupTimer);
      if (turnTimer) clearTimeout(turnTimer);
      if (cancelTimer) clearTimeout(cancelTimer);
      await session.close();
    }
  }
}
