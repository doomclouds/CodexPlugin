import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { projectRunForTransport } from "../src/run-view.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";

const script = (body: string) => `export const meta={name:"local-git-scope",description:"Execute only the delegated fixture task"}; ${body}`;
async function fixture(t: TestContext, handler: (request: WorkerRequest) => Promise<string> = async () => "verified") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-git-scope-")));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await writeFile(path.join(project, "source.txt"), "existing user content\n");
  const calls: WorkerRequest[] = [];
  const adapter: WorkerAdapter = { run: async request => {
    calls.push(request); const output = await handler(request);
    return { output, threadId: "scope-fixture", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }, close: async () => {} };
  const store = new RunStore(state), engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { project, store, engine, calls };
}
function localInput(projectPath: string, body: string) { return { projectPath, script: script(body), args: { branch: "main" }, allowWrite: true, workspaceMode: "local" as const }; }
async function execute(f: Awaited<ReturnType<typeof fixture>>, run: { id: string; revision: number }, resume = false) {
  await f.engine.start({ id: run.id, revision: run.revision }, resume);
  return f.engine.wait(run.id);
}

test("new local previews snapshot Git metadata write scope and grant it only to write nodes", async t => {
  const f = await fixture(t);
  const draft = await f.engine.preview(localInput(f.project, 'await agent("Inspect"); return await agent("Update authorized Git state",{mode:"write"});'));
  assert.equal(draft.localGitWrite, true);
  assert.equal((await f.store.load(draft.id)).localGitWrite, true);
  assert.equal(projectRunForTransport(draft).localGitWrite, true);
  assert.equal(f.calls.length, 0);
  const done = await execute(f, draft);
  assert.equal(done.execution, "completed", done.error);
  assert.equal(done.localGitWrite, true);
  assert.equal(f.calls[0]?.mode, "read"); assert.equal(f.calls[0]?.localGitWrite, undefined);
  assert.equal(f.calls[1]?.mode, "write"); assert.equal(f.calls[1]?.localGitWrite, true);
});

test("snapshot and read-only previews never acquire the internal local Git write scope", async t => {
  const f = await fixture(t);
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: f.project });
  const snapshot = await f.engine.preview({ ...localInput(f.project, 'return await agent("Edit isolated files",{mode:"write"});'), workspaceMode: "snapshot", localGitWrite: true } as Parameters<WorkflowEngine["preview"]>[0]);
  const readOnly = await f.engine.preview({ projectPath: f.project, script: script('return await agent("Inspect");') });
  for (const draft of [snapshot, readOnly]) {
    assert.equal(draft.localGitWrite, undefined);
    const done = await execute(f, draft);
    assert.equal(done.execution, "completed", done.error);
  }
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(request => request.localGitWrite === undefined));
});

test("legacy local resumes and script saves preserve their original Git write scope", async t => {
  let fail = true;
  const f = await fixture(t, async request => {
    if (request.mode === "write" && fail) { fail = false; throw new Error("Fixture task stopped before its authorized update"); }
    return "verified";
  });
  const draft = await f.engine.preview(localInput(f.project, 'await agent("Preflight"); return await agent("Update",{mode:"write"});'));
  delete draft.localGitWrite; await f.store.save(draft);
  const failed = await execute(f, draft);
  assert.equal(failed.execution, "failed"); assert.equal(failed.localGitWrite, undefined);
  assert.equal(failed.tasks[0]?.status, "completed");
  const updated = await f.engine.update({ id: failed.id, revision: failed.revision, script: failed.script, args: failed.args, workspaceMode: "local", allowWrite: true });
  assert.equal(updated.localGitWrite, undefined, "Saving unchanged local mode must not broaden a legacy sandbox.");
  const done = await execute(f, updated);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks[0]?.cached, true);
  assert.equal(done.tasks[0]?.attempts.length, 1); assert.equal(done.tasks[1]?.attempts.length, 2);
  assert.ok(f.calls.every(request => request.localGitWrite === undefined));
});

test("draft scope changes acquire local Git permission only before any worker has started", async t => {
  const f = await fixture(t);
  const initial = await f.engine.preview({ projectPath: f.project, script: script('return await agent("Inspect");') });
  const local = await f.engine.update({ id: initial.id, revision: initial.revision, script: initial.script, args: initial.args, workspaceMode: "local", allowWrite: true });
  assert.equal(local.localGitWrite, true);
  const settingsOnly = await f.engine.update({ id: local.id, revision: local.revision, script: local.script, args: local.args, networkAccess: true });
  assert.equal(settingsOnly.localGitWrite, true);
  const isolated = await f.engine.update({ id: settingsOnly.id, revision: settingsOnly.revision, script: settingsOnly.script, args: settingsOnly.args, workspaceMode: "snapshot" });
  assert.equal(isolated.localGitWrite, undefined);
  const started = await f.engine.preview({ projectPath: f.project, script: script('await agent("Inspect"); throw new Error("Review before editing");') });
  const failed = await execute(f, started);
  assert.equal(failed.workspace, undefined); assert.equal(failed.tasks[0]?.attempts.length, 1);
  const before = await readFile(path.join(f.store.directory(failed.id), "run.json"), "utf8");
  await assert.rejects(f.engine.update({ id: failed.id, revision: failed.revision, script: failed.script, args: failed.args, workspaceMode: "local", allowWrite: true }), /requires a new preview/);
  assert.equal(await readFile(path.join(f.store.directory(failed.id), "run.json"), "utf8"), before);
});

test("an existing local workspace keeps its scope immutable and a new preview preserves the workflow bytes", async t => {
  const f = await fixture(t);
  const draft = await f.engine.preview(localInput(f.project, 'await agent("Inspect"); throw new Error("Await repair");'));
  delete draft.localGitWrite; await f.store.save(draft);
  const failed = await execute(f, draft);
  assert.ok(failed.workspace); assert.equal(failed.localGitWrite, undefined);
  const before = await readFile(path.join(f.store.directory(failed.id), "run.json"), "utf8");
  await assert.rejects(f.engine.update({ id: failed.id, revision: failed.revision, script: failed.script, args: failed.args, workspaceMode: "snapshot" }), /Changing execution scope/);
  const fresh = await f.engine.preview({ projectPath: failed.projectPath, script: failed.script, args: failed.args, allowWrite: failed.allowWrite, workspaceMode: failed.workspaceMode, networkAccess: failed.networkAccess, allowedMcpServers: failed.allowedMcpServers, allowedMcpTools: failed.allowedMcpTools, limits: failed.limits });
  assert.notEqual(fresh.id, failed.id); assert.equal(fresh.localGitWrite, true);
  assert.equal(fresh.script, failed.script); assert.equal(fresh.scriptDigest, failed.scriptDigest); assert.deepEqual(fresh.args, failed.args);
  assert.equal(fresh.execution, "draft"); assert.equal(fresh.workspace, undefined); assert.deepEqual(fresh.tasks, []);
  assert.equal(await readFile(path.join(f.store.directory(failed.id), "run.json"), "utf8"), before);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "existing user content\n");
});
