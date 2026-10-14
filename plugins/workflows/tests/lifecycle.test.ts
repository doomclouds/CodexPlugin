import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunStore } from "../src/store.ts";
import { WorkflowEngine } from "../src/engine.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { WorkflowRun } from "../src/types.ts";
import type { TestContext } from "node:test";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";
import { ExecutionSettingsStore } from "../src/execution-settings.ts";
import { nodeProcess } from "../src/node-process.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
const lifecycleScript = 'export const meta={name:"lifecycle-stop",description:"Explicit scheduling fixture without a model"}; return await agent("read");';
const fixtureEnvironment: ExecutionEnvironment = { defaults: { model: "fixture-model", reasoningEffort: "max" }, models: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] };
async function lifecycleFixture(t: TestContext, worker: WorkerAdapter) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-stop-context-"));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const store = new RunStore(path.join(root, "data"));
  const engine = new WorkflowEngine({ store, adapter: worker });
  const engines = [engine];
  t.after(async () => { for (const item of engines) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projectPath, store, engine, engines };
}
function abortedError() { const error = new Error("This operation was aborted"); error.name = "AbortError"; return error; }
function blockingAdapter() {
  const begun = deferred();
  const requests: WorkerRequest[] = [];
  let block = true;
  const worker: WorkerAdapter = {
    async run(request, signal) {
      requests.push(request);
      if (block) {
        begun.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { setImmediate(() => reject(abortedError())); };
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return { output: "Fixture result", threadId: "test-thread", turnId: "test-turn", durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    async close() {},
  };
  return { worker, requests, begun, releaseFuture: () => { block = false; } };
}

class ControlledStore extends RunStore {
  afterRunningSave?: () => void;
  override async save(run: WorkflowRun) {
    await super.save(run);
    if (run.execution === "running") this.afterRunningSave?.();
  }
}
function adapter(requests: WorkerRequest[]): WorkerAdapter {
  return {
    async run(request) { requests.push(request); return { output: request.id, threadId: "test-thread", turnId: "test-turn", durationMs: 1, usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } }; },
    async close() {},
  };
}
test("closing the panel during the final start save prevents every worker from launching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-lease-race-"));
  const projectPath = path.join(root, "project"); await mkdir(projectPath);
  const store = new ControlledStore(path.join(root, "data")); const requests: WorkerRequest[] = [];
  const engine = new WorkflowEngine({ store, adapter: adapter(requests) });
  try {
    const run = await engine.preview({ projectPath, script: 'export const meta = { name: "lease-race", description: "Lease shutdown race" }; return await agent("Read the project");' });
    const lease = engine.lease({});
    store.afterRunningSave = () => { engine.lease({ leaseId: lease.leaseId, release: true }); store.afterRunningSave = undefined; };
    assert.equal((await engine.start({ id: run.id, revision: run.revision, leaseId: lease.leaseId })).execution, "preparing");
    const stopped = await engine.wait(run.id);
    assert.equal(stopped.error, undefined);
    assert.equal(stopped.stopReason, "panel-closed");
    assert.equal(requests.length, 0);
    assert.equal((await engine.get(run.id)).execution, "stopped");
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});
test("a queued worker cannot pass a token budget exhausted by the preceding worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-budget-dispatch-"));
  const projectPath = path.join(root, "project"); await mkdir(projectPath);
  const requests: WorkerRequest[] = []; const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "data")), adapter: adapter(requests) });
  try {
    const run = await engine.preview({ projectPath, limits: { maxReadWorkers: 1, maxTokens: 5 }, script: 'export const meta = { name: "budget-dispatch", description: "Budget admission" }; return await parallel([() => agent("first"), () => agent("second")]);' });
    await engine.start({ id: run.id, revision: run.revision });
    const final = await engine.wait(run.id);
    assert.equal(final.execution, "completed");
    assert.equal(requests.length, 1);
    assert.equal(final.tasks[1]?.status, "failed");
    assert.match(final.tasks[1]?.error ?? "", /token budget/);
    assert.deepEqual(final.result, ["task_1_attempt_1", null]);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit stop records its reason without presenting cancellation as a workflow error", async t => {
  const fixture = blockingAdapter();
  const { projectPath, engine } = await lifecycleFixture(t, fixture.worker);
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  await engine.start({ id: draft.id, revision: draft.revision });
  await fixture.begun.promise;
  const stopped = await engine.stop(draft.id);
  assert.equal(stopped.execution, "stopped");
  assert.equal(stopped.stopReason, "requested");
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.failureContext, undefined);
  assert.equal(stopped.tasks[0]?.status, "interrupted");
  const process = nodeProcess(stopped, { scope: "workflow" });
  assert.equal(process.error, undefined);
  assert.match(process.summary, /停止请求/);
  assert.doesNotMatch(process.summary, /AbortError|operation was aborted/);
  fixture.releaseFuture();
  await engine.start({ id: draft.id, revision: stopped.revision }, true);
  const resumed = await engine.wait(draft.id);
  assert.equal(resumed.execution, "completed", resumed.error);
  assert.equal(resumed.stopReason, undefined);
});

test("service shutdown stops its actual worker and records service-shutdown independently of user stop", async t => {
  const fixture = blockingAdapter();
  const { projectPath, store, engine } = await lifecycleFixture(t, fixture.worker);
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  await engine.start({ id: draft.id, revision: draft.revision });
  await fixture.begun.promise;
  await engine.close();
  const stopped = await store.load(draft.id);
  assert.equal(stopped.execution, "stopped");
  assert.equal(stopped.stopReason, "service-shutdown");
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.failureContext, undefined);
  assert.equal(await store.isLocked(draft.id), false);
  assert.equal(nodeProcess(stopped, { scope: "workflow" }).error, undefined);
  assert.match(nodeProcess(stopped, { scope: "workflow" }).summary, /执行服务正在关闭/);
});

test("service shutdown during model discovery marks preparation interrupted and launches no worker", async t => {
  const begun = deferred();
  const requests: WorkerRequest[] = [];
  const worker = adapter(requests);
  worker.executionEnvironment = async (_cwd, signal) => {
    begun.resolve();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { setImmediate(() => reject(abortedError())); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    return fixtureEnvironment;
  };
  const { projectPath, store, engine } = await lifecycleFixture(t, worker);
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  await engine.start({ id: draft.id, revision: draft.revision });
  await begun.promise;
  await engine.close();
  const stopped = await store.load(draft.id);
  assert.equal(stopped.execution, "stopped");
  assert.equal(stopped.stopReason, "service-shutdown");
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.failureContext, undefined);
  assert.equal(stopped.preparation?.stages[0]?.status, "interrupted");
  assert.equal(requests.length, 0);
  assert.equal(nodeProcess(stopped, { scope: "workflow" }).error, undefined);
});

test("explicit stop during model discovery preserves requested rather than preparation failure", async t => {
  const begun = deferred();
  const requests: WorkerRequest[] = [];
  const worker = adapter(requests);
  worker.executionEnvironment = async (_cwd, signal) => {
    begun.resolve();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { setImmediate(() => reject(abortedError())); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    return fixtureEnvironment;
  };
  const { projectPath, engine } = await lifecycleFixture(t, worker);
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  await engine.start({ id: draft.id, revision: draft.revision });
  await begun.promise;
  const stopped = await engine.stop(draft.id);
  assert.equal(stopped.execution, "stopped");
  assert.equal(stopped.stopReason, "requested");
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.failureContext, undefined);
  assert.equal(stopped.preparation?.stages[0]?.status, "interrupted");
  assert.equal(requests.length, 0);
});

test("start is refused while close still waits for an owned configuration discovery to exit", async t => {
  const begun = deferred(), interrupted = deferred(), exit = deferred();
  const requests: WorkerRequest[] = [];
  const worker = adapter(requests);
  worker.executionEnvironment = async (_cwd, signal) => {
    begun.resolve();
    const abort = () => interrupted.resolve();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    await exit.promise;
    throw abortedError();
  };
  const { projectPath, store, engine } = await lifecycleFixture(t, worker);
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  const discovery = engine.getExecutionSettings(projectPath);
  void discovery.catch(() => {});
  await begun.promise;
  let closed = false;
  const closing = engine.close().then(() => { closed = true; });
  try {
    await interrupted.promise;
    assert.equal(closed, false);
    await assert.rejects(engine.start({ id: draft.id, revision: draft.revision }), /service is closing/);
    assert.deepEqual(await store.load(draft.id), draft);
    assert.equal(requests.length, 0);
  } finally { exit.resolve(); }
  await assert.rejects(discovery, /aborted/);
  await closing;
});

test("close racing a start's delayed settings read cannot dispatch through an already closed adapter", async t => {
  const reading = deferred(), releaseRead = deferred();
  const originalGet = ExecutionSettingsStore.prototype.get;
  t.mock.method(ExecutionSettingsStore.prototype, "get", async function (this: ExecutionSettingsStore) {
    reading.resolve();
    await releaseRead.promise;
    return originalGet.call(this);
  });
  const requests: WorkerRequest[] = [];
  const { projectPath, store, engine } = await lifecycleFixture(t, adapter(requests));
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  const starting = engine.start({ id: draft.id, revision: draft.revision });
  void starting.catch(() => {});
  try {
    await reading.promise;
    await engine.close();
    releaseRead.resolve();
    await assert.rejects(starting, /service is closing/);
    assert.deepEqual(await store.load(draft.id), draft);
    assert.equal(await store.isLocked(draft.id), false);
    assert.equal(requests.length, 0);
  } finally { releaseRead.resolve(); await Promise.allSettled([starting]); }
});

test("recovering an exited owner preserves history and replaces a stale abort error with owner-exited", async t => {
  const requests: WorkerRequest[] = [];
  const { projectPath, store, engine, engines } = await lifecycleFixture(t, adapter(requests));
  const draft = await engine.preview({ projectPath, script: lifecycleScript });
  await store.save({ ...draft, execution: "running", error: "This operation was aborted", failureContext: { kind: "preparation" }, tasks: [{ id: "task_1", index: 0, prompt: "read", options: {}, mode: "read", status: "running", cached: false, attempts: [{ id: "task_1_attempt_1", status: "running", startedAt: new Date().toISOString() }] }] });
  const reopened = new WorkflowEngine({ store: new RunStore(store.root), adapter: adapter(requests) });
  engines.push(reopened);
  const recovered = await reopened.get(draft.id);
  assert.equal(recovered.execution, "stopped");
  assert.equal(recovered.stopReason, "owner-exited");
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.failureContext, undefined);
  assert.equal(recovered.tasks[0]?.status, "interrupted");
  assert.equal(recovered.tasks[0]?.attempts.length, 1);
  assert.equal(nodeProcess(recovered, { scope: "workflow" }).error, undefined);
  assert.match(nodeProcess(recovered, { scope: "workflow" }).summary, /上次执行进程已退出/);
  assert.equal(requests.length, 0, "Recovery must never resume the work automatically.");
});
