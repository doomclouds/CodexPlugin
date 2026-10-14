import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter } from "../src/adapter.ts";
import type { WorkflowRun } from "../src/types.ts";

test("a second MCP instance can stop the owning workflow and acknowledge actual worker exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-owner-control-"));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  let started!: () => void;
  let exited = false;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const adapter: WorkerAdapter = {
    async run(_request, signal) {
      started();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => setTimeout(resolve, 100), { once: true }));
      exited = true;
      throw new Error("Worker exited after interrupt");
    },
    async close() {},
  };
  const owner = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  const panel = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  try {
    const draft = await owner.preview({ projectPath, script: 'export const meta = {name:"owner-control",description:"Cross-instance lifecycle"}; return await agent("inspect");' });
    await owner.start({ id: draft.id, revision: draft.revision });
    await begun;
    assert.equal((await panel.get(draft.id)).execution, "running");
    const stopped = await panel.stop(draft.id);
    assert.ok(exited, "Stop must wait for adapter exit, not merely acknowledge a request file");
    assert.equal(stopped.execution, "stopped");
    assert.equal(stopped.tasks[0]?.status, "interrupted");
    assert.equal((await owner.get(draft.id)).execution, "stopped");
  } finally { await panel.close(); await owner.close(); await rm(root, { recursive: true, force: true }); }
});

test("remote stop waits for acknowledgment after the owner releases its lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-control-ack-"));
  const store = new RunStore(root);const id = "wf_" + "a".repeat(24);
  await store.create({ id, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), meta: { name: "control-ack", description: "Owner exit acknowledgment fixture" }, script: 'export const meta = {name:"control-ack",description:"Owner exit acknowledgment fixture"}; return true;', scriptDigest: "fixture-digest", args: {}, projectPath: root, allowWrite: false, limits: { maxReadWorkers: 1, maxCalls: 1, timeoutMs: 1000, maxTokens: 0 }, execution: "running", review: "unavailable", application: "none", tasks: [], logs: [], controlId: "execution" } satisfies WorkflowRun);
  const release = await store.acquire(id);
  const request = store.requestControl(id, "execution", "stop");
  await new Promise(resolve => setTimeout(resolve, 100));
  await store.consumeControls(id, "execution", async () => {
    await release();
    await new Promise(resolve => setTimeout(resolve, 250));
  });
  await request;
  await rm(root, {recursive:true,force:true});
});
