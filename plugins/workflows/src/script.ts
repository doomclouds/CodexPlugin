import { parse } from "acorn";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export interface ScriptHooks {
  agent(prompt: string, options: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  operation?(id: string, signal: AbortSignal): Promise<unknown>;
  phase(title: string): void;
  log(message: string): void;
}

export interface ScriptLimits {
  timeoutMs?: number;
  maxCalls?: number;
  memoryMb?: number;
  // Token accounting belongs to the agent adapter, rather than the JS sandbox.
  maxTokens?: number;
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
// Keep runtime assets alive when a marketplace upgrade removes the old checkout.
const scriptWorkerUrl = new URL(import.meta.url.endsWith(".ts") ? "../runtime/script-worker.js" : "./script-worker.js", import.meta.url);
const scriptWorkerSource = readFileSync(scriptWorkerUrl, "utf8");
const scriptWorkerDataUrl = new URL(`data:text/javascript;base64,${Buffer.from(scriptWorkerSource).toString("base64")}`);
const forbiddenNames = new Set([
  "process", "require", "module", "exports", "Buffer", "fs", "fetch", "XMLHttpRequest",
  "WebSocket", "Worker", "SharedWorker", "window", "document", "navigator",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "Date",
]);

function invalid(message: string): never {
  throw new Error(`Invalid workflow script: ${message}`);
}

function literal(node: AstNode): unknown {
  if (node.type === "Literal" && !node.regex && !node.bigint) {
    if (typeof node.value === "number" && !Number.isFinite(node.value)) invalid("metadata numbers must be finite");
    return node.value;
  }
  if (node.type === "UnaryExpression" && ["-", "+"].includes(String(node.operator))) {
    const value = literal(node.argument as AstNode);
    if (typeof value !== "number") invalid("metadata unary expressions require a number literal");
    return node.operator === "-" ? -value : value;
  }
  if (node.type === "ArrayExpression") {
    return (node.elements as Array<AstNode | null>).map(item => {
      if (!item) invalid("metadata arrays cannot contain holes");
      return literal(item);
    });
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const property of node.properties as AstNode[]) {
      if (property.type !== "Property" || property.computed || property.method || property.shorthand || property.kind !== "init") {
        invalid("metadata must contain only literal properties");
      }
      const keyNode = property.key as AstNode;
      const key = keyNode.type === "Identifier" ? keyNode.name : literal(keyNode);
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) invalid("invalid metadata key");
      if (Object.hasOwn(value, key)) invalid(`duplicate metadata key: ${key}`);
      value[key] = literal(property.value as AstNode);
    }
    return value;
  }
  return invalid("metadata must be a pure literal object");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function textField(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

export function validateScript(source: string): { meta: WorkflowMeta; body: string } {
  if (typeof source !== "string" || !source.trim()) invalid("source is empty");
  if (Buffer.byteLength(source, "utf8") > 256 * 1024) invalid("source exceeds 256 KiB");
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AstNode;
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "syntax error");
  }
  const statements = program.body as AstNode[];
  const first = statements[0];
  const declaration = first?.declaration as AstNode | undefined;
  const declarations = declaration?.declarations as AstNode[] | undefined;
  const definition = declarations?.[0];
  if (first?.type !== "ExportNamedDeclaration" || declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declarations?.length !== 1 || (definition?.id as AstNode | undefined)?.name !== "meta") {
    invalid("the first statement must be export const meta = { ... }");
  }
  const rawMeta = record(literal(definition?.init as AstNode), "meta");
  for (const key of Object.keys(rawMeta)) if (!["name", "description", "phases"].includes(key)) invalid(`unknown metadata key: ${key}`);
  const name = textField(rawMeta.name, "meta.name", 64);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) invalid("meta.name must use lowercase letters, digits and hyphens");
  const meta: WorkflowMeta = { name, description: textField(rawMeta.description, "meta.description", 2048) };
  if (rawMeta.phases !== undefined) {
    if (!Array.isArray(rawMeta.phases) || rawMeta.phases.length > 64) invalid("meta.phases must be an array of at most 64 phases");
    const titles = new Set<string>();
    meta.phases = rawMeta.phases.map(item => {
      const phase = record(item, "phase");
      for (const key of Object.keys(phase)) if (!["title", "detail"].includes(key)) invalid(`unknown phase key: ${key}`);
      const result: { title: string; detail?: string } = { title: textField(phase.title, "phase.title", 128) };
      if (titles.has(result.title)) invalid(`duplicate phase title: ${result.title}`);
      titles.add(result.title);
      if (phase.detail !== undefined) result.detail = textField(phase.detail, "phase.detail", 4096);
      return result;
    });
  }
  const walk = (node: AstNode, parent?: AstNode, key?: string): void => {
    if (["ImportDeclaration", "ImportExpression", "ExportDefaultDeclaration", "ExportAllDeclaration"].includes(node.type) || (node.type === "ExportNamedDeclaration" && node !== first)) invalid("imports and additional exports are not supported");
    if (node.type === "Identifier" && forbiddenNames.has(String(node.name))) {
      const propertyName = parent && ((parent.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) || (parent.type === "MemberExpression" && key === "property" && !parent.computed));
      if (!propertyName) invalid(`host API ${String(node.name)} is unavailable`);
    }
    if (node.type === "MemberExpression" && (node.object as AstNode).type === "Identifier" && (node.object as AstNode).name === "Math") {
      const property = node.property as AstNode;
      if ((!node.computed && property.name === "random") || (node.computed && property.value === "random")) invalid("Math.random is unavailable because workflows must replay deterministically");
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (child && typeof child === "object" && "type" in child) walk(child as AstNode, node, childKey);
      else if (Array.isArray(child)) for (const entry of child) if (entry && typeof entry === "object" && "type" in entry) walk(entry as AstNode, node, childKey);
    }
  };
  walk(program);
  return { meta, body: source.slice(first.end) };
}

function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  return result;
}

function encode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Workflow values must be JSON serializable");
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error("Workflow value exceeds 8 MiB");
  return json;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Workflow script was cancelled");
  error.name = "AbortError";
  return error;
}

export async function executeScript(source: string, args: unknown, hooks: ScriptHooks, signal: AbortSignal, limits: ScriptLimits = {}): Promise<unknown> {
  const { body } = validateScript(source);
  if (signal.aborted) throw abortError(signal.reason);
  if (limits.maxTokens !== undefined) throw new Error("maxTokens must be enforced by the agent adapter, not the script sandbox");
  const resolvedLimits = {
    timeoutMs: limit(limits.timeoutMs, 30 * 60 * 1000, 24 * 60 * 60 * 1000, "timeoutMs"),
    maxCalls: limit(limits.maxCalls, 1000, 10000, "maxCalls"),
    memoryMb: limit(limits.memoryMb, 64, 256, "memoryMb"),
  };
  const argsJson = encode(args);
  const worker = new Worker(scriptWorkerDataUrl, { workerData: { body, argsJson, limits: resolvedLimits, moduleBaseUrl: scriptWorkerUrl.href }, execArgv: [] });
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  return await new Promise<unknown>((resolve, reject) => {
    let finishing = false;
    const finish = async (error?: Error, result?: unknown): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) controller.abort(error);
      try { await worker.terminate(); } catch { /* Worker exit may win the termination race. */ }
      // The adapter must honour this signal and resolve only after its real worker exits.
      await Promise.allSettled([...pending]);
      if (error) reject(error); else resolve(result);
    };
    const abort = (): void => { void finish(abortError(signal.reason)); };
    const timer = setTimeout(() => { void finish(new Error(`Workflow script timed out after ${resolvedLimits.timeoutMs} ms`)); }, resolvedLimits.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.on("error", error => { void finish(error); });
    worker.on("exit", code => { if (!finishing) void finish(new Error(`Workflow sandbox exited before returning a result (${code})`)); });
    worker.on("message", (message: { type: string; id?: number; prompt?: string; options?: Record<string, unknown>; text?: string; resultJson?: string; error?: string }) => {
      if (finishing) return;
      if (message.type === "agent" || message.type === "operation") {
        const task = Promise.resolve().then(() => message.type === "operation"
          ? hooks.operation ? hooks.operation(message.prompt!, controller.signal) : Promise.reject(new Error("No operations were approved for this workflow"))
          : hooks.agent(message.prompt!, message.options!, controller.signal)).then(result => {
          if (!finishing) worker.postMessage({ type: "agent-result", id: message.id, resultJson: encode(result) });
        }).catch(error => {
          if (!finishing) worker.postMessage({ type: "agent-result", id: message.id, error: error instanceof Error ? error.message : String(error) });
        }).finally(() => { pending.delete(task); });
        pending.add(task);
      } else if (message.type === "phase" || message.type === "log") {
        try { if (message.type === "phase") hooks.phase(message.text!); else hooks.log(message.text!); }
        catch (error) { void finish(abortError(error)); }
      } else if (message.type === "done") {
        try { void finish(undefined, message.resultJson === undefined ? undefined : JSON.parse(message.resultJson)); }
        catch (error) { void finish(abortError(error)); }
      } else if (message.type === "error") void finish(new Error(message.error ?? "Workflow sandbox failed"));
    });
    if (signal.aborted) abort();
  });
}
