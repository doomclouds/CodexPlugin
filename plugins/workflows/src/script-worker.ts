import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSDeferredPromise, QuickJSHandle } from "quickjs-emscripten-core";

const port = parentPort;
if (!port) throw new Error("Workflow sandbox requires a worker thread");
const data = workerData as { body: string; flowHelperName?: string; argsJson?: string; limits: { timeoutMs: number; maxCalls: number; memoryMb: number } };

async function main(): Promise<void> {
  const QuickJS = await newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-singlefile-cjs-release-sync"));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(data.limits.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + data.limits.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let callCount = 0;
  let rpcMessages = 0;
  let rpcBytes = 0;
  let flowMessages = 0;
  let flowTruncated = false;
  let finished = false;
  let promise: QuickJSHandle | undefined;
  let resolveResult!: (handle: QuickJSHandle) => void;
  let rejectResult!: (error: unknown) => void;
  const resultReady = new Promise<QuickJSHandle>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let resultObserved = false;
  const scriptError = (handle: QuickJSHandle): Error & { failureId?: string } => {
    const dumped: unknown = context.dump(handle);
    const error: Error & { failureId?: string } = new Error(dumped && typeof dumped === "object" && "message" in dumped ? String((dumped as { message: unknown }).message) : String(dumped));
    if (dumped && typeof dumped === "object") {
      const identity = context.getProp(handle, "__workflowFailureId");
      try { if (context.typeof(identity) === "string") { const value = context.getString(identity); if (/^[a-f0-9]{32}$/.test(value)) error.failureId = value; } }
      finally { identity.dispose(); }
    }
    return error;
  };
  const pump = (): void => {
    const result = runtime.executePendingJobs();
    if (result.error) {
      const error = scriptError(result.error);
      result.error.dispose();
      throw error;
    }
    if (promise && !resultObserved) {
      const state = context.getPromiseState(promise);
      if (state.type === "fulfilled") {
        resultObserved = true;
        resolveResult(state.value);
      } else if (state.type === "rejected") {
        resultObserved = true;
        const error = scriptError(state.error);
        state.error.dispose();
        rejectResult(error);
      }
    }
  };
  const setFunction = (name: string, implementation: Parameters<typeof context.newFunction>[1]): void => {
    const handle = context.newFunction(name, implementation);
    context.setProp(context.global, name, handle);
    handle.dispose();
  };
  const chargeMessage = (...values: string[]): void => {
    if (++rpcMessages > Math.max(1000, data.limits.maxCalls * 10)) throw new Error("Workflow RPC message limit exceeded");
    rpcBytes += values.reduce((size, value) => size + Buffer.byteLength(value, "utf8"), 0);
    if (rpcBytes > data.limits.memoryMb * 1024 * 1024) throw new Error("Workflow RPC payload memory limit exceeded");
  };
  const fail = (error: unknown): void => {
    if (finished) return;
    finished = true;
    if (promise && !resultObserved) { resultObserved = true; rejectResult(error); }
    port!.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error), ...(error instanceof Error && "failureId" in error && typeof error.failureId === "string" ? { failureId: error.failureId } : {}) });
  };
  try {
    const flowNodeId = (handle: QuickJSHandle | undefined): string | undefined => {
      if (!handle || context.typeof(handle) !== "string") return undefined;
      const value = context.getString(handle);
      return /^flow_[a-z]+_[a-z0-9]+_[a-z0-9]+$/.test(value) && value.length <= 80 ? value : undefined;
    };
    setFunction("__workflowFlowTrace", (idHandle, kindHandle, valueHandle) => {
      if (flowTruncated) return context.undefined;
      if (flowMessages >= 2000) {
        flowTruncated = true;
        port!.postMessage({ type: "flow", event: { nodeId: "", kind: "trace-truncated" } });
        return context.undefined;
      }
      const nodeId = flowNodeId(idHandle);
      const kind = kindHandle && context.getString(kindHandle);
      if (!nodeId || !["condition", "iteration"].includes(kind ?? "")) return context.undefined;
      if (kind === "condition") {
        if (!valueHandle || context.typeof(valueHandle) !== "boolean") return context.undefined;
        flowMessages++;
        port!.postMessage({ type: "flow", event: { nodeId, kind, value: !!context.dump(valueHandle) } });
      } else {
        const iteration = valueHandle && context.getNumber(valueHandle);
        if (!Number.isSafeInteger(iteration) || iteration! < 1) return context.undefined;
        flowMessages++;
        port!.postMessage({ type: "flow", event: { nodeId, kind, iteration } });
      }
      return context.undefined;
    });
    setFunction("__workflowAgent", (promptHandle, optionsHandle, flowHandle) => {
      if (++callCount > data.limits.maxCalls) throw new Error(`Workflow agent call limit exceeded (${data.limits.maxCalls})`);
      const prompt = context.getString(promptHandle!);
      const optionsJson = context.getString(optionsHandle!);
      if (!prompt.trim() || prompt.length > 1024 * 1024) throw new Error("agent prompt must be a non-empty string of at most 1 MiB");
      if (optionsJson.length > 1024 * 1024) throw new Error("agent options exceed 1 MiB");
      chargeMessage(prompt, optionsJson);
      const options = JSON.parse(optionsJson) as unknown;
      if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("agent options must be an object");
      const deferred = context.newPromise();
      pending.set(callCount, deferred);
      port!.postMessage({ type: "agent", id: callCount, prompt, options, flowNodeId: flowNodeId(flowHandle) });
      return deferred.handle;
    });
    setFunction("__workflowOperation", (idHandle, flowHandle) => {
      if (++callCount > data.limits.maxCalls) throw new Error("Workflow call limit exceeded");
      const id = context.getString(idHandle!);
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("operation requires a declared step ID");
      chargeMessage(id);
      const deferred = context.newPromise();
      pending.set(callCount, deferred);
      port!.postMessage({ type: "operation", id: callCount, prompt: id, flowNodeId: flowNodeId(flowHandle) });
      return deferred.handle;
    });
    for (const type of ["phase", "log"] as const) setFunction(`__workflow${type}`, handle => {
      const text = context.getString(handle!);
      if (!text.trim() || text.length > 4096) throw new Error(`${type} requires a non-empty string of at most 4096 characters`);
      chargeMessage(text);
      port!.postMessage({ type, text });
      return context.undefined;
    });
    const bootstrap = context.evalCode(`
      "use strict";
      globalThis.Date = undefined;
      Object.defineProperty(Math, "random", { value: () => { throw new Error("Math.random is unavailable because workflows must replay deterministically"); }, writable: false, configurable: false });
      Object.freeze(Math);
      const __hostAgent = __workflowAgent;
      const __hostOperation = __workflowOperation;
      const __hostPhase = __workflowphase;
      const __hostLog = __workflowlog;
      const __hostFlowTrace = __workflowFlowTrace;
      delete globalThis.__workflowAgent;
      delete globalThis.__workflowOperation;
      delete globalThis.__workflowphase;
      delete globalThis.__workflowlog;
      delete globalThis.__workflowFlowTrace;
      const args = ${data.argsJson === undefined ? "undefined" : `JSON.parse(${JSON.stringify(data.argsJson)})`};
      const __invokeFlowAgent = (prompt, options = {}, flowNodeId) => {
        if (typeof prompt !== "string") throw new TypeError("agent prompt must be a string");
        if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("agent options must be an object");
        return __hostAgent(prompt, JSON.stringify(options), flowNodeId);
      };
      const agent = (prompt, options = {}) => __invokeFlowAgent(prompt, options);
      const __invokeFlowOperation = (id, flowNodeId) => {
        if (typeof id !== "string") throw new TypeError("operation ID must be a string");
        return __hostOperation(id, flowNodeId);
      };
      const operation = id => __invokeFlowOperation(id);
      ${data.flowHelperName ? `const ${data.flowHelperName} = (() => {
        const iterations = Object.create(null);
        let observations = 0;
        const emit = (nodeId, kind, value) => {
          if (observations > 2000) return;
          observations++;
          __hostFlowTrace(nodeId, kind, value);
        };
        return Object.freeze({
          condition: (nodeId, value) => { emit(nodeId, "condition", !!value); return value; },
          reset: nodeId => { iterations[nodeId] = 0; },
          iteration: nodeId => { if (observations > 2000) return; const iteration = (iterations[nodeId] || 0) + 1; iterations[nodeId] = iteration; emit(nodeId, "iteration", iteration); },
          call: (nodeId, fn, kind) => kind === "agent" && fn === agent
            ? (...values) => __invokeFlowAgent(values[0], values[1], nodeId)
            : kind === "operation" && fn === operation
              ? (...values) => __invokeFlowOperation(values[0], nodeId)
              : fn
        });
      })();` : ""}
      const parallel = async tasks => {
        if (!Array.isArray(tasks) || tasks.length > 4096 || tasks.some(task => typeof task !== "function")) throw new TypeError("parallel requires at most 4096 functions");
        const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
        return results.map(result => {
          if (result.status === "fulfilled") return result.value;
          __hostLog(("parallel task failed: " + String(result.reason)).slice(0, 4096));
          return null;
        });
      };
      const pipeline = async (items, ...stages) => {
        if (!Array.isArray(items) || items.length > 4096 || !stages.length || stages.some(stage => typeof stage !== "function")) throw new TypeError("pipeline requires at most 4096 items and one or more stage functions");
        const results = await Promise.allSettled(items.map(async (item, index) => {
          let value = item;
          for (const stage of stages) {
            value = await stage(value, index);
            if (value === null) break;
          }
          return value;
        }));
        return results.map(result => {
          if (result.status === "fulfilled") return result.value;
          __hostLog(("pipeline item failed: " + String(result.reason)).slice(0, 4096));
          return null;
        });
      };
      const phase = title => { if (typeof title !== "string") throw new TypeError("phase title must be a string"); __hostPhase(title); };
      const log = message => { if (typeof message !== "string") throw new TypeError("log message must be a string"); __hostLog(message); };
    `, "workflow-bootstrap.js", { type: "global" });
    context.unwrapResult(bootstrap).dispose();
    port!.on("message", (message: { type: string; id: number; resultJson?: string; error?: string; failureId?: string }) => {
      if (finished || message.type !== "agent-result") return;
      const deferred = pending.get(message.id);
      if (!deferred) return;
      pending.delete(message.id);
      try {
        if (message.error !== undefined) {
          const error = context.newError(message.error);
          if (typeof message.failureId === "string" && /^[a-f0-9]{32}$/.test(message.failureId)) {
            const identity = context.newString(message.failureId);
            try { context.defineProp(error, "__workflowFailureId", { value: identity, enumerable: false, configurable: false }); } finally { identity.dispose(); }
          }
          deferred.reject(error);
          error.dispose();
        } else if (message.resultJson === undefined) deferred.resolve(context.undefined);
        else {
          const value = context.unwrapResult(context.evalCode(`JSON.parse(${JSON.stringify(message.resultJson)})`, "agent-result.js", { type: "global" }));
          deferred.resolve(value);
          value.dispose();
        }
        pump();
      } catch (error) { fail(error); }
    });
    promise = context.unwrapResult(context.evalCode(`(async () => { "use strict";\n${data.body}\n})()`, "workflow.js", { type: "global" }));
    pump();
    const handle = await resultReady;
    if (finished) return;
    try {
      if (pending.size) throw new Error(`Workflow returned with ${pending.size} unawaited agent call(s)`);
      if (["function", "symbol"].includes(context.typeof(handle))) throw new Error("Workflow result must be JSON serializable");
      const json = context.getProp(context.global, "JSON");
      const stringify = context.getProp(json, "stringify");
      try {
        const serialized = context.unwrapResult(context.callFunction(stringify, json, handle));
        try {
          const resultJson = context.typeof(serialized) === "undefined" ? undefined : context.getString(serialized);
          if (resultJson !== undefined && resultJson.length > 8 * 1024 * 1024) throw new Error("Workflow result exceeds 8 MiB");
          finished = true;
          port!.postMessage({ type: "done", resultJson });
        } finally { serialized.dispose(); }
      } finally { stringify.dispose(); json.dispose(); }
    } finally { handle.dispose(); }
  } catch (error) { fail(error); }
  finally {
    for (const deferred of pending.values()) deferred.dispose();
    pending.clear();
    promise?.dispose();
    context.dispose();
    runtime.dispose();
  }
}

void main().catch(error => { port.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) }); });
