import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import path from "node:path";
import { z } from "zod";

const maximumFrameBytes = 8 * 1024 * 1024;
const defaultTimeoutMs = 10_000;
const nonempty = z.string().refine(value => value.trim().length > 0, "Expected a non-empty source value");

export interface WorkflowProject { projectId: string; label: string; path: string; hostId: "local" }
export type WorkflowProjectsResult =
  | { available: true; projects: WorkflowProject[]; currentProjectId?: string; contextSource: "thread" | "global-or-unassigned" }
  | { available: false; projects: []; reason: string };
export interface ProjectsProvider {
  getProjects(context: { meta?: unknown; signal: AbortSignal }): Promise<WorkflowProjectsResult>;
}

interface CallerContext { threadId: string; callId: string; turnId: string }
class ProjectQueryError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = false) { super(message); this.transient = transient; }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sourceId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = nonempty.safeParse(value);
  if (!result.success) throw new Error(`Codex caller metadata contains an invalid ${label}.`);
  return result.data;
}
function sameIdentity(values: Array<string | undefined>, label: string): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  if (new Set(present).size > 1) throw new Error(`Codex caller metadata contains conflicting ${label} values.`);
  return present[0];
}
function metadataId(meta: Record<string, unknown>, names: string[], nested: string): string | undefined {
  const values = names.map(name => sourceId(meta[name], name));
  const object = record(meta[nested]);
  if (object.id !== undefined) values.push(sourceId(object.id, `${nested}.id`));
  return sameIdentity(values, nested);
}

export function callerContext(metaValue: unknown): CallerContext {
  const meta = record(metaValue);
  // The desktop host adds these fields after the older caller metadata. They
  // identify this request; a shared MCP startup environment cannot do that.
  const hostThread = sameIdentity([sourceId(meta.threadId, "threadId"), sourceId(meta.thread_id, "thread_id")], "host thread");
  const encoded = meta["x-codex-turn-metadata"];
  let compatibility: Record<string, unknown> = {};
  if (encoded !== undefined) {
    if (typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") > maximumFrameBytes) throw new Error("Codex turn metadata exceeds the 8 MiB pipe bound.");
    try { compatibility = record(typeof encoded === "string" ? JSON.parse(encoded) : encoded); }
    catch { if (hostThread === undefined) throw new Error("Codex turn metadata is not valid JSON."); }
  }
  const threadId = hostThread ?? sameIdentity([metadataId(meta, ["openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id"], "thread"), sourceId(compatibility.thread_id, "thread_id")], "compatible thread");
  if (!threadId) throw new Error("The Codex host did not provide this request's real thread identity.");
  return {
    threadId,
    callId: metadataId(meta, ["openai/toolCallId", "openai/tool_call_id", "codexCallId", "codex_call_id", "callId", "call_id"], "call") ?? randomUUID(),
    turnId: sameIdentity([metadataId(meta, ["openai/turnId", "openai/turn_id", "codexTurnId", "codex_turn_id", "turnId", "turn_id"], "turn"), sourceId(compatibility.turn_id, "turn_id")], "turn") ?? randomUUID(),
  };
}

const projectResponse = z.object({ schemaVersion: z.literal(2), projects: z.array(z.object({
  projectId: nonempty, label: z.string(), projectKind: nonempty, hostId: z.string().nullable(), path: z.string().nullable().optional(),
}).passthrough()) }).passthrough();
const threadEntry = z.object({ id: nonempty, projectId: z.string().nullable().optional(), hostId: z.string().nullable().optional() }).passthrough();
const threadsResponse = z.object({ schemaVersion: z.literal(4), pinnedThreads: z.array(threadEntry), threads: z.array(threadEntry) }).passthrough();

export function mapProjects(projectsValue: unknown, threadsValue: unknown, threadId: string): Extract<WorkflowProjectsResult, { available: true }> {
  const inventory = projectResponse.parse(projectsValue);
  const roster = threadsResponse.parse(threadsValue);
  const projects: WorkflowProject[] = inventory.projects.filter(project => project.projectKind === "local" && project.hostId === "local" && typeof project.path === "string" && path.isAbsolute(project.path)).map(project => ({ projectId: project.projectId, label: project.label, path: project.path!, hostId: "local" }));
  if (new Set(projects.map(project => project.projectId)).size !== projects.length) throw new Error("Codex returned duplicate local project identities.");
  const matches = [...roster.pinnedThreads, ...roster.threads].filter(thread => thread.id === threadId);
  if (new Set(matches.map(thread => thread.projectId ?? null)).size > 1) throw new Error("Codex returned conflicting current-project ownership.");
  const projectId = sameIdentity(matches.map(thread => thread.projectId ?? undefined), "current project");
  const current = matches.length > 0 && matches.every(thread => thread.hostId === "local") ? projects.find(project => project.projectId === projectId) : undefined;
  return { available: true, projects, ...(current ? { currentProjectId: current.projectId } : {}), contextSource: current ? "thread" : "global-or-unassigned" };
}

const pipeResponse = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.string(), result: z.unknown() }).strict(),
  z.object({ jsonrpc: z.literal("2.0"), id: z.string(), error: z.object({ code: z.number(), message: z.string() }).passthrough() }).strict(),
]);
const toolResponse = z.object({ success: z.boolean(), contentItems: z.array(z.object({ type: z.literal("inputText"), text: z.string() })) }).passthrough();

function frame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maximumFrameBytes) throw new Error("Codex project request exceeds the 8 MiB pipe limit.");
  const result = Buffer.allocUnsafe(4 + bytes);
  result.writeUInt32LE(bytes, 0);
  result.write(json, 4, bytes, "utf8");
  return result;
}
function toolData(value: unknown): unknown {
  const response = toolResponse.parse(value);
  if (!response.success) throw new Error(response.contentItems.map(item => item.text).join("\n") || "Codex could not read the project inventory for this caller.");
  if (response.contentItems.length !== 1) throw new Error("Codex project tool returned an unexpected content structure.");
  return JSON.parse(response.contentItems[0]!.text);
}

async function query(pipePath: string, caller: CallerContext, tool: "list_projects" | "list_threads", argumentsValue: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  if (signal.aborted) throw new Error("Codex project discovery was cancelled.");
  const id = randomUUID();
  // One outer MCP invocation makes two different host tool calls. The host
  // journals call identities, so each nested call must have its own identity.
  const callId = `${caller.callId}:${tool}:${randomUUID()}`;
  const request = frame({ jsonrpc: "2.0", id, method: "tools/call", params: { namespace: "codex_app", tool, arguments: argumentsValue, callerSource: "codex", ...caller, callId } });
  const socket = createConnection({ path: pipePath });
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  let abort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let finished = false;
      let sent = false;
      let headerBytes = 0;
      let payloadBytes = 0;
      const header = Buffer.allocUnsafe(4);
      let payload: Buffer | undefined;
      const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
      abort = () => {
        if (sent && !socket.destroyed) socket.write(frame({ jsonrpc: "2.0", id, method: "tools/cancel" }));
        fail(new Error("Codex project discovery was cancelled."));
      };
      socket.once("connect", () => { sent = true; socket.write(request); });
      socket.on("error", (error: NodeJS.ErrnoException) => fail(new ProjectQueryError("The Codex desktop project pipe is unavailable.", ["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT"].includes(error.code ?? ""))));
      // Node delivers buffered data before end. A complete, validated response
      // settles synchronously in data; EOF may only fail an unfinished frame.
      socket.once("end", () => fail(new ProjectQueryError("The Codex project pipe ended before a complete response.", true)));
      socket.once("close", () => fail(new ProjectQueryError("The Codex project pipe closed before a complete response.", true)));
      socket.on("data", (chunk: Buffer) => {
        if (finished) return;
        try {
          let offset = 0;
          if (headerBytes < 4) {
            const length = Math.min(4 - headerBytes, chunk.length);
            chunk.copy(header, headerBytes, 0, length); headerBytes += length; offset += length;
            if (headerBytes < 4) return;
            const lengthValue = header.readUInt32LE(0);
            if (lengthValue < 1 || lengthValue > maximumFrameBytes) throw new Error("Codex project response violates the 8 MiB pipe frame limit.");
            payload = Buffer.allocUnsafe(lengthValue);
          }
          const length = Math.min(payload!.length - payloadBytes, chunk.length - offset);
          chunk.copy(payload!, payloadBytes, offset, offset + length); payloadBytes += length;
          if (payloadBytes < payload!.length) return;
          if (offset + length !== chunk.length) throw new Error("Codex project pipe returned unexpected trailing data.");
          const response = pipeResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
          if (response.id !== id) throw new Error("Codex project pipe response did not match this request.");
          if ("error" in response) throw new Error(`Codex project tool request failed: ${response.error.message}`);
          const data = toolData(response.result);
          finished = true; resolve(data);
        } catch (error) { fail(error instanceof Error ? error : new Error("Codex project pipe returned invalid data.")); }
      });
      timer = setTimeout(() => {
        if (sent && !socket.destroyed) socket.write(frame({ jsonrpc: "2.0", id, method: "tools/cancel" }));
        fail(new ProjectQueryError("Codex project discovery timed out.", true));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } catch (error) {
    throw new ProjectQueryError(`Codex ${tool}: ${error instanceof Error ? error.message : "project query failed"}`, error instanceof ProjectQueryError && error.transient);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    socket.destroy();
    await closed;
  }
}

async function queryWithRetry(pipePath: string, caller: CallerContext, tool: "list_projects" | "list_threads", argumentsValue: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  // Both attempts fit inside the existing per-query bound. Never replay a
  // malformed response, ownership mismatch, native tool failure or cancellation.
  const firstBudget = Math.max(1, Math.floor(timeoutMs * 0.7));
  try { return await query(pipePath, caller, tool, argumentsValue, signal, firstBudget); }
  catch (error) {
    if (!(error instanceof ProjectQueryError) || !error.transient || signal.aborted) throw error;
    const delayMs = Math.min(75, Math.floor(timeoutMs * 0.05));
    if (Date.now() + delayMs >= deadline) throw error;
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(new Error("Codex project discovery was cancelled.")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, delayMs);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    const remaining = deadline - Date.now();
    if (remaining < 1) throw error;
    try { return await query(pipePath, caller, tool, argumentsValue, signal, remaining); }
    catch (retryError) {
      if (retryError instanceof ProjectQueryError && retryError.transient) throw new ProjectQueryError(`${retryError.message} A read-only retry also failed; refresh after the desktop connection recovers.`);
      throw retryError;
    }
  }
}

export class CodexProjectsProvider implements ProjectsProvider {
  private readonly pipePath: string | undefined;
  private readonly timeoutMs: number;
  constructor(options: { pipePath?: string; timeoutMs?: number } = {}) {
    this.pipePath = options.pipePath ?? process.env.CODEX_APP_TOOLS_PIPE_PATH;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > defaultTimeoutMs) throw new Error("Project discovery timeout must be within the 10 second request bound.");
  }
  async getProjects(context: { meta?: unknown; signal: AbortSignal }): Promise<WorkflowProjectsResult> {
    try {
      const caller = callerContext(context.meta);
      if (!this.pipePath?.trim()) throw new Error("Codex did not provide CODEX_APP_TOOLS_PIPE_PATH to this MCP connection.");
      if (process.platform === "win32" ? !/^\\\\[.?]\\pipe\\/i.test(this.pipePath) : !path.isAbsolute(this.pipePath)) throw new Error("Codex did not provide a local desktop project pipe.");
      const projects = await queryWithRetry(this.pipePath, caller, "list_projects", {}, context.signal, this.timeoutMs);
      const threads = await queryWithRetry(this.pipePath, caller, "list_threads", { limit: 50 }, context.signal, this.timeoutMs);
      return mapProjects(projects, threads, caller.threadId);
    } catch (error) { return { available: false, projects: [], reason: error instanceof Error ? error.message : "Codex project discovery is unavailable." }; }
  }
}
