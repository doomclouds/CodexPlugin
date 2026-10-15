import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { projectRunForTransport } from "../src/run-view.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { ApprovalMode, WorkflowRun } from "../src/types.ts";

const script = 'export const meta={name:"approval-contract",description:"Test only approval routing"}; await agent("First"); return await agent("Second");';

// These tests exercise persisted execution and replay with a test-only adapter.
// They do not start Codex, a model, or an external MCP tool.
async function fixture(t: TestContext, handler?: (request: WorkerRequest, signal: AbortSignal) => Promise<string>) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-approval-engine-"));
  const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "source.txt"), "retained user file\n");
  const calls: WorkerRequest[] = [], store = new RunStore(path.join(root, "state"));
  const adapter: WorkerAdapter = { run: async (request, signal) => {
    calls.push(request);
    return { output: handler ? await handler(request, signal) : "verified", threadId: "test-approval", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }, close: async () => {} };
  const engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const preview = (approvalMode?: ApprovalMode) => engine.preview({ projectPath: project, script, allowWrite: true, workspaceMode: "local", networkAccess: true, allowedMcpServers: ["fixture"], allowedMcpTools: { fixture: ["read_probe"] }, ...(approvalMode ? { approvalMode } : {}) });
  return { root, project, store, engine, calls, preview, templates: new TemplateStore(store) };
}

test("new previews record automatic review and workers receive the saved choice", async t => {
  const f = await fixture(t);
  const run = await f.preview();
  assert.equal(run.approvalMode, "auto-review");
  assert.equal((await f.store.load(run.id)).approvalMode, "auto-review");
  assert.equal(projectRunForTransport(run).approvalMode, "auto-review");
  await f.engine.start({ id: run.id, revision: run.revision });
  const done = await f.engine.wait(run.id);
  assert.equal(done.execution, "completed", done.error);
  assert.deepEqual(f.calls.map(call => call.approvalMode), ["auto-review", "auto-review"]);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "retained user file\n");
});

test("explicit never is preserved and legacy runs do not silently gain automatic review", async t => {
  const f = await fixture(t);
  for (const legacy of [false, true]) {
    const run = await f.preview("never");
    if (legacy) { delete run.approvalMode; await f.store.save(run); }
    await f.engine.start({ id: run.id, revision: run.revision });
    const done = await f.engine.wait(run.id);
    assert.equal(done.execution, "completed", done.error);
    assert.equal(done.approvalMode, legacy ? undefined : "never");
  }
  assert.deepEqual(f.calls.map(call => call.approvalMode), ["never", "never", "never", "never"]);
});

test("explicit resume selects automatic review before dispatch while retaining script, scope and cached prefix", async t => {
  let secondAttempts = 0, runId = "";
  const f = await fixture(t, async request => {
    const stored = await f.store.load(runId);
    assert.equal(request.approvalMode, stored.approvalMode);
    if (request.id.startsWith("task_2_") && secondAttempts++ === 0) throw new Error("Fixture approval required");
    return "verified";
  });
  const run = await f.preview("never"); runId = run.id;
  await f.engine.start({ id: run.id, revision: run.revision });
  const failed = await f.engine.wait(run.id);
  assert.equal(failed.execution, "failed");
  const permissions = (value: WorkflowRun) => ({ script: value.script, args: value.args, scriptDigest: value.scriptDigest, projectPath: value.projectPath, allowWrite: value.allowWrite, networkAccess: value.networkAccess, workspaceMode: value.workspaceMode, localGitWrite: value.localGitWrite, allowedMcpServers: value.allowedMcpServers, allowedMcpTools: value.allowedMcpTools, workspace: value.workspace });
  const accepted = await f.engine.start({ id: run.id, revision: failed.revision, approvalMode: "auto-review" }, true);
  assert.equal(accepted.approvalMode, "auto-review"); assert.ok(accepted.revision > failed.revision);
  const done = await f.engine.wait(run.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks[0]?.cached, true);
  assert.deepEqual(permissions(done), permissions(failed));
  assert.deepEqual(f.calls.map(call => call.approvalMode), ["never", "never", "auto-review"]);
  assert.equal(done.tasks[1]?.attempts.length, 2);
});

test("ordinary resume preserves explicit never and absent legacy mode", async t => {
  let callsToSecond = 0;
  const f = await fixture(t, async request => {
    if (request.id.startsWith("task_2_") && callsToSecond++ % 2 === 0) throw new Error("Fixture stopped before approval");
    return "verified";
  });
  for (const legacy of [false, true]) {
    const run = await f.preview("never");
    if (legacy) { delete run.approvalMode; await f.store.save(run); }
    await f.engine.start({ id: run.id, revision: run.revision });
    const failed = await f.engine.wait(run.id); assert.equal(failed.execution, "failed");
    await f.engine.start({ id: run.id, revision: failed.revision }, true);
    const done = await f.engine.wait(run.id);
    assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks[0]?.cached, true);
    assert.equal(done.approvalMode, legacy ? undefined : "never");
  }
  assert.ok(f.calls.every(call => call.approvalMode === "never"));
});

test("mode-only stopped-plan updates keep valid completed task results", async t => {
  const f = await fixture(t);
  const run = await f.preview("never");
  await f.engine.start({ id: run.id, revision: run.revision });
  const completed = await f.engine.wait(run.id);
  const updated = await f.engine.update({ id: run.id, revision: completed.revision, script, args: {}, approvalMode: "auto-review" });
  assert.equal(updated.approvalMode, "auto-review");
  assert.ok(updated.tasks.every(task => task.status === "completed"));
  await f.engine.start({ id: run.id, revision: updated.revision });
  const replayed = await f.engine.wait(run.id);
  assert.equal(replayed.execution, "completed", replayed.error);
  assert.ok(replayed.tasks.every(task => task.cached)); assert.equal(f.calls.length, 2);
});

test("invalid, stale and unpreviewed approval changes do not mutate the run", async t => {
  const f = await fixture(t);
  const run = await f.preview("never");
  await assert.rejects(f.engine.preview({ projectPath: f.project, script, approvalMode: "approve" as ApprovalMode }), /Unsupported workflow approval mode/);
  await assert.rejects(f.engine.update({ id: run.id, revision: run.revision, script, args: {}, approvalMode: "auto" as ApprovalMode }), /Unsupported workflow approval mode/);
  await assert.rejects(f.engine.start({ id: run.id, revision: run.revision, approvalMode: "auto-review" }), /preview before workflow_start/);
  await assert.rejects(f.engine.start({ id: run.id, revision: run.revision - 1, approvalMode: "auto-review" }, true), /Workflow changed/);
  await assert.rejects(f.engine.start({ id: run.id, revision: run.revision, approvalMode: "approve" as ApprovalMode }, true), /Unsupported workflow approval mode/);
  assert.deepEqual(await f.store.load(run.id), run); assert.equal(f.calls.length, 0);
});

test("running workflows reject approval-mode changes", async t => {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, async (_request, signal) => {
    ready(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    throw new Error("Fixture stopped");
  });
  const run = await f.preview("never");
  await f.engine.start({ id: run.id, revision: run.revision }); await started;
  const active = await f.engine.get(run.id);
  await assert.rejects(f.engine.start({ id: run.id, revision: active.revision, approvalMode: "auto-review" }, true), /Old workers have not exited/);
  await assert.rejects(f.engine.update({ id: run.id, revision: active.revision, script, args: {}, approvalMode: "auto-review" }), /running/);
  assert.equal((await f.engine.get(run.id)).approvalMode, "never");
  await f.engine.stop(run.id);
});

test("saved definitions persist approval choices and preserve legacy defaults on update", async t => {
  const f = await fixture(t);
  const created = await f.templates.save({ script });
  assert.equal(created.approvalMode, "auto-review");
  assert.equal((await f.templates.get(created.id))?.approvalMode, "auto-review");
  const explicit = await f.templates.save({ script, revision: created.revision, approvalMode: "never" });
  assert.equal(explicit.approvalMode, "never");
  const unchanged = await f.templates.save({ script, revision: explicit.revision });
  assert.equal(unchanged.approvalMode, "never");
  const filename = f.templates.filename(created.id), persisted = JSON.parse(await readFile(filename, "utf8"));
  delete persisted.approvalMode; await writeFile(filename, JSON.stringify(persisted));
  const legacy = await f.templates.save({ script, revision: unchanged.revision });
  assert.equal(legacy.approvalMode, "never");
  await assert.rejects(f.templates.save({ script, revision: legacy.revision, approvalMode: "approve" as ApprovalMode }), /Unsupported workflow approval mode/);
  assert.equal((await f.templates.get(created.id))?.approvalMode, "never");
});
