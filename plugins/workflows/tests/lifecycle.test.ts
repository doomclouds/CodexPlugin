import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunStore } from "../src/store.ts";
import { WorkflowEngine } from "../src/engine.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { WorkflowRun } from "../src/types.ts";

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
    assert.match(stopped.error ?? "", /Panel closed|interrupted/);
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
