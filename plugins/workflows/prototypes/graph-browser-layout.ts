import type { GraphGeometry, GraphLayoutFunction, GraphScene } from "./graph-types.ts";

declare const __WORKFLOW_LAYOUT_WORKER__: string;
export interface BrowserLayoutService { layout: GraphLayoutFunction; dispose(): void; }
export interface BrowserLayoutOptions { createWorker?: () => Worker; timeoutMs?: number; }

/** A canvas owns one ephemeral browser worker; no host service or network is involved. */
export function createBrowserGraphLayout(options: BrowserLayoutOptions = {}): BrowserLayoutService {
  const pending = new Map<number, { signature: string; resolve: (geometry: GraphGeometry) => void; reject: (error: Error) => void; cleanup: () => void }>();
  let worker: Worker | undefined, objectUrl: string | undefined, sequence = 0, disposed = false, startupFailure: Error | undefined, hasResponse = false;
  function releaseWorker(): void { worker?.terminate(); worker = undefined; if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; } }
  function fail(error: Error): void { releaseWorker(); for (const request of pending.values()) { request.cleanup(); request.reject(error); } pending.clear(); }
  function connect(): Worker {
    if (worker) return worker;
    if (disposed) throw new Error("Workflow layout has been disposed.");
    if (startupFailure) throw startupFailure;
    hasResponse = false;
    try { if (options.createWorker) worker = options.createWorker();
    else {
      if (typeof Worker === "undefined" || typeof __WORKFLOW_LAYOUT_WORKER__ !== "string") throw new Error("当前环境无法启动工作流布局线程。");
      objectUrl = URL.createObjectURL(new Blob([__WORKFLOW_LAYOUT_WORKER__], { type: "text/javascript" }));
      try { worker = new Worker(objectUrl, { name: "workflow-layout" }); }
      catch (error) { releaseWorker(); throw new Error(`无法启动工作流布局线程：${error instanceof Error ? error.message : String(error)}`); }
    } } catch (error) { startupFailure = error instanceof Error ? error : new Error(String(error)); throw startupFailure; }
    const connected = worker;
    connected.addEventListener("message", event => {
      if (disposed || worker !== connected) return;
      const response = event.data as { id?: unknown; geometry?: GraphGeometry; error?: unknown };
      if (!Number.isSafeInteger(response?.id)) return;
      const request = pending.get(response.id as number); if (!request) return;
      hasResponse = true;
      pending.delete(response.id as number); request.cleanup();
      if (typeof response.error === "string") request.reject(new Error(response.error));
      else if (!response.geometry || response.geometry.signature !== request.signature) request.reject(new Error("Layout response does not match the requested topology."));
      else request.resolve(response.geometry);
    });
    connected.addEventListener("error", event => { event.preventDefault(); if (disposed || worker !== connected) return; const error = new Error(hasResponse ? "工作流布局线程异常退出，请重新布局。" : "工作流布局线程启动失败，请重新打开面板并核对宿主支持。"); if (!hasResponse) startupFailure = error; fail(error); });
    connected.addEventListener("messageerror", () => { if (disposed || worker !== connected) return; fail(new Error("工作流布局结果无法读取。")); });
    return worker;
  }
  const layout: GraphLayoutFunction = (scene: GraphScene, signal?: AbortSignal) => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error("Workflow layout has been disposed.")); return; }
    if (signal?.aborted) { reject(aborted()); return; }
    let target: Worker; try { target = connect(); } catch (error) { reject(error); return; }
    const id = ++sequence;
    const abort = () => fail(aborted());
    const timer = setTimeout(() => fail(new Error("流程布局超时，请折叠部分容器后重试。")), options.timeoutMs ?? 30000);
    pending.set(id, { signature: scene.signature, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
    signal?.addEventListener("abort", abort, { once: true });
    try { target.postMessage({ id, scene }); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  return { layout, dispose() { if (disposed) return; disposed = true; fail(aborted()); } };
}
function aborted(): Error { const error = new Error("Workflow layout was superseded or closed."); error.name = "AbortError"; return error; }
