import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserGraphLayout } from "../prototypes/graph-browser-layout.ts";
import type { GraphGeometry, GraphScene } from "../prototypes/graph-types.ts";

class TestWorker extends EventTarget {
  sent: Array<{ id: number; scene: GraphScene }> = []; terminated = false;
  postMessage(message: { id: number; scene: GraphScene }) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  respond(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}
const scene = (signature: string): GraphScene => ({ signature, nodes: [], edges: [], font: { family: "sans-serif", size: 14, lineHeight: 20 } });
const geometry = (signature: string): GraphGeometry => ({ signature, width: 100, height: 100, nodes: [], edges: [], durationMs: 1 });
test("the layout worker returns geometry only for its exact request signature", async () => {
  const worker = new TestWorker(), service = createBrowserGraphLayout({ createWorker: () => worker as unknown as Worker });
  try { const pending = service.layout(scene("one")); worker.respond({ id: 0, geometry: geometry("wrong") }); worker.respond({ id: 1, geometry: geometry("one") }); assert.equal((await pending).signature, "one");
    const invalid = service.layout(scene("two")); worker.respond({ id: 2, geometry: geometry("wrong") }); await assert.rejects(invalid, /topology/); }
  finally { service.dispose(); }
});
test("aborting an old layout terminates computation and late replies cannot overwrite a new topology", async () => {
  const workers: TestWorker[] = [], service = createBrowserGraphLayout({ createWorker: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; } });
  try { const controller = new AbortController(), old = service.layout(scene("old"), controller.signal); controller.abort(); await assert.rejects(old, { name: "AbortError" }); assert.equal(workers[0]!.terminated, true);
    const current = service.layout(scene("new")); workers[0]!.respond({ id: 1, geometry: geometry("old") }); workers[1]!.respond({ id: 2, geometry: geometry("new") }); assert.equal((await current).signature, "new"); }
  finally { service.dispose(); }
});
test("layout timeouts settle the request and release the worker", async () => {
  const worker = new TestWorker(), service = createBrowserGraphLayout({ createWorker: () => worker as unknown as Worker, timeoutMs: 10 });
  try { await assert.rejects(service.layout(scene("slow")), /超时/); assert.equal(worker.terminated, true); }
  finally { service.dispose(); }
});
test("disposing a canvas cancels pending layout work and refuses new requests", async () => {
  const worker = new TestWorker(), service = createBrowserGraphLayout({ createWorker: () => worker as unknown as Worker });
  const pending = service.layout(scene("pending")); service.dispose(); await assert.rejects(pending, { name: "AbortError" }); await assert.rejects(service.layout(scene("later")), /disposed/); assert.equal(worker.terminated, true);
});
test("a rejected worker startup is not repeatedly spawned by background polling", async () => {
  let starts = 0;
  const service = createBrowserGraphLayout({ createWorker() { starts++; throw new Error("Worker refused by the host"); } });
  try { for (let i = 0; i < 10; i++) await assert.rejects(service.layout(scene("same")), /refused/); assert.equal(starts, 1); }
  finally { service.dispose(); }
});

test("late errors from a cancelled worker cannot terminate or poison its replacement", async () => {
  for (const kind of ["error", "messageerror"]) {
    const workers: TestWorker[] = [], service = createBrowserGraphLayout({ createWorker: () => { const worker = new TestWorker(); workers.push(worker); return worker as unknown as Worker; } });
    try {
      const controller = new AbortController(), old = service.layout(scene("old"), controller.signal); controller.abort(); await assert.rejects(old, { name: "AbortError" });
      const current = service.layout(scene("new")); workers[0]!.dispatchEvent(new Event(kind, { cancelable: true }));
      assert.equal(workers[1]!.terminated, false, `${kind} from a retired worker must not affect the active worker`);
      workers[1]!.respond({ id: 2, geometry: geometry("new") }); assert.equal((await current).signature, "new");
      const later = service.layout(scene("later")); workers[1]!.respond({ id: 3, geometry: geometry("later") }); assert.equal((await later).signature, "later"); assert.equal(workers.length, 2);
    } finally { service.dispose(); }
  }
});
