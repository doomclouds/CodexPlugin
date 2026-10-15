import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";

const exec = promisify(execFile);
const script = (body: string) => `export const meta={name:"local-engine",description:"Modify only the local fixture project"}; ${body}`;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(settle => { resolve = settle; }); return { promise, resolve }; }
async function fixture(t: TestContext, handler: (request: WorkerRequest, signal: AbortSignal) => Promise<string>, git = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-engine-")));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await writeFile(path.join(project, "source.txt"), "user baseline\n");
  if (git) {
    await exec("git", ["init", "--quiet"], { cwd: project });
    await exec("git", ["add", "source.txt"], { cwd: project });
    await writeFile(path.join(project, "source.txt"), "user dirty edit\n");
    await writeFile(path.join(project, "notes.txt"), "user untracked\n");
    await writeFile(path.join(project, ".gitignore"), "build-output\n");
  }
  const calls: WorkerRequest[] = [];
  const adapter: WorkerAdapter = { run: async (request, signal) => {
    calls.push(request); const output = await handler(request, signal);
    return { output, threadId: "local-fixture", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }, close: async () => {} };
  const store = new RunStore(state), engine = new WorkflowEngine({ store, adapter });
  const engines = [engine];
  t.after(async () => { for (const item of engines) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, state, store, engine, engines, adapter, calls };
}
function localInput(projectPath: string, body: string) { return { projectPath, script: script(body), allowWrite: true, workspaceMode: "local" as const }; }
async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= until) throw new Error("Local fixture did not reach its expected state"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("local agents change the original dirty project immediately without applying or staging user files", async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, async request => {
    assert.equal(request.cwd, f.project); assert.equal(request.mode, "write");
    assert.match(request.prompt, /original local project directly/);
    await writeFile(path.join(request.cwd, "source.txt"), "user dirty edit\nworkflow change\n"); started.resolve(); await finish.promise; return "edited";
  }, true);
  const indexBefore = (await exec("git", ["ls-files", "--stage"], { cwd: f.project })).stdout;
  const preview = await f.engine.preview(localInput(f.project, 'return await agent("Edit only source.txt",{mode:"write"});'));
  await f.engine.start({ id: preview.id, revision: preview.revision }); await started.promise;
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "user dirty edit\nworkflow change\n");
  assert.equal((await f.engine.get(preview.id)).execution, "running");
  finish.resolve(); const done = await f.engine.wait(preview.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.review, "ready"); assert.equal(done.application, "none");
  assert.equal(done.workspace?.kind, "local"); assert.equal(done.workspacePath, f.project); assert.match(done.workspaceCheckpoint!, /^local-v1:/);
  assert.deepEqual(done.diff?.files.map(file => file.path), ["source.txt"]);
  assert.equal(await readFile(path.join(f.project, "notes.txt"), "utf8"), "user untracked\n");
  assert.equal((await exec("git", ["ls-files", "--stage"], { cwd: f.project })).stdout, indexBefore);
  const revision = done.revision;
  await assert.rejects(f.engine.apply(done.id, revision), /already in the original project/);
  assert.equal((await f.engine.get(done.id)).revision, revision, "An unavailable apply must not mutate run state.");
});

test("local stop preserves partial edits and resume reuses the completed prefix with the same project", async t => {
  const working = deferred(); let second = 0;
  const f = await fixture(t, async (request, signal) => {
    const file = path.join(request.cwd, "source.txt");
    if (request.id.startsWith("task_1_")) { await writeFile(file, "first completed\n"); return "first"; }
    if (second++ === 0) {
      await writeFile(file, "first completed\nsecond partial\n"); working.resolve();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("Interrupted after partial edits");
    }
    assert.match(await readFile(file, "utf8"), /second partial/); await writeFile(file, "first completed\nsecond completed\n"); return "second";
  });
  const preview = await f.engine.preview(localInput(f.project, 'await agent("First",{mode:"write"}); return await agent("Second",{mode:"write"});'));
  await f.engine.start({ id: preview.id, revision: preview.revision }); await working.promise;
  const stopped = await f.engine.stop(preview.id);
  assert.equal(stopped.execution, "stopped"); assert.match(stopped.workspaceCheckpoint!, /^local-v1:/);
  assert.match(await readFile(path.join(f.project, "source.txt"), "utf8"), /second partial/);
  await f.engine.start({ id: stopped.id, revision: stopped.revision }, true);
  const done = await f.engine.wait(stopped.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks[0]?.cached, true);
  assert.equal(f.calls.filter(call => call.id.startsWith("task_1_")).length, 1);
  assert.match(await readFile(path.join(f.project, "source.txt"), "utf8"), /second completed/);
});

test("shared-store local runs serialize the whole project and a waiter can stop without dispatch", async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, async () => { started.resolve(); await finish.promise; return "held"; });
  const secondCalls: WorkerRequest[] = [];
  const viewer = new WorkflowEngine({ store: new RunStore(f.state), adapter: { run: async request => { secondCalls.push(request); throw new Error("A waiting workflow must not dispatch"); }, close: async () => {} } });
  f.engines.push(viewer);
  const a = await f.engine.preview(localInput(f.project, 'return await agent("Hold",{mode:"write"});'));
  const b = await viewer.preview(localInput(f.project, 'return await agent("Wait",{mode:"write"});'));
  await f.engine.start({ id: a.id, revision: a.revision }); await started.promise;
  await viewer.start({ id: b.id, revision: b.revision });
  await eventually(async () => (await viewer.get(b.id)).preparation?.stages.some(stage => stage.id === "project" && stage.status === "running") ?? false);
  const stopped = await viewer.stop(b.id);
  assert.equal(stopped.execution, "stopped"); assert.equal(secondCalls.length, 0); assert.equal(stopped.workspace, undefined);
  finish.resolve(); assert.equal((await f.engine.wait(a.id)).execution, "completed");
});

test("local project locks prevent isolated application while edits are active", async t => {
  const started = deferred(), finish = deferred(); let local = false;
  const f = await fixture(t, async request => {
    if (local) { started.resolve(); await finish.promise; return "held"; }
    await writeFile(path.join(request.cwd, "isolated.txt"), "reviewed\n"); return "isolated";
  }, true);
  const isolated = await f.engine.preview({ ...localInput(f.project, 'return await agent("Isolated",{mode:"write"});'), workspaceMode: "snapshot" });
  await f.engine.start({ id: isolated.id, revision: isolated.revision }); const reviewed = await f.engine.wait(isolated.id); assert.equal(reviewed.execution, "completed", reviewed.error);
  local = true;
  const draft = await f.engine.preview(localInput(f.project, 'return await agent("Local",{mode:"write"});'));
  await f.engine.start({ id: draft.id, revision: draft.revision }); await started.promise;
  await assert.rejects(f.engine.apply(reviewed.id, reviewed.revision), /Another workflow is modifying this project/);
  finish.resolve(); await f.engine.wait(draft.id);
  const applied = await f.engine.apply(reviewed.id, reviewed.revision);
  assert.equal(applied.application, "applied", applied.error); assert.equal(await readFile(path.join(f.project, "isolated.txt"), "utf8"), "reviewed\n");
});

test("external source or ignored-artifact changes refuse local cached replay", async t => {
  const f = await fixture(t, async () => "verified", true);
  const preview = await f.engine.preview(localInput(f.project, 'await agent("Verify"); throw new Error("Manual decision required");'));
  await f.engine.start({ id: preview.id, revision: preview.revision }); const failed = await f.engine.wait(preview.id);
  assert.equal(failed.execution, "failed"); assert.match(failed.workspaceCheckpoint!, /^local-v1:/);
  await writeFile(path.join(f.project, "build-output"), "external artifact\n");
  await f.engine.start({ id: failed.id, revision: failed.revision }, true); const refused = await f.engine.wait(failed.id);
  assert.equal(refused.execution, "failed"); assert.match(refused.error!, /changed since the last checkpoint/); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(path.join(f.project, "build-output"), "utf8"), "external artifact\n");
});

test("a local crash without a reliable checkpoint cannot replay previously started workers", async t => {
  const f = await fixture(t, async () => "verified");
  const preview = await f.engine.preview(localInput(f.project, 'await agent("Verify"); throw new Error("Stop");'));
  await f.engine.start({ id: preview.id, revision: preview.revision }); const failed = await f.engine.wait(preview.id);
  delete failed.workspaceCheckpoint; await f.store.save(failed);
  await f.engine.start({ id: failed.id, revision: failed.revision }, true); const refused = await f.engine.wait(failed.id);
  assert.equal(refused.execution, "failed"); assert.match(refused.error!, /without a reliable checkpoint/); assert.equal(f.calls.length, 1);
});

test("local write permission is explicit and cannot be removed or converted after creating its project baseline", async t => {
  const f = await fixture(t, async () => "verified");
  await assert.rejects(f.engine.preview({ ...localInput(f.project, 'return "no";'), allowWrite: false }), /explicit allowWrite/);
  const preview = await f.engine.preview(localInput(f.project, 'await agent("Verify"); throw new Error("Stop");'));
  await f.engine.start({ id: preview.id, revision: preview.revision }); const failed = await f.engine.wait(preview.id);
  await assert.rejects(f.engine.update({ id: failed.id, revision: failed.revision, script: failed.script, args: failed.args, workspaceMode: "snapshot" }), /Changing execution scope/);
  await assert.rejects(f.engine.update({ id: failed.id, revision: failed.revision, script: failed.script, args: failed.args, allowWrite: false }), /Changing write scope/);
});

test("local dynamic branches and bounded loops compose with serialized parallel writes", async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, async request => {
    active++; maximum = Math.max(maximum, active);
    try {
      const file = path.join(request.cwd, "source.txt"), value = Number(await readFile(file, "utf8")) + 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      await writeFile(file, String(value)); return String(value);
    } finally { active--; }
  });
  await writeFile(path.join(f.project, "source.txt"), "0");
  const draft = await f.engine.preview(localInput(f.project, 'let value=0; for(let i=0;i<3;i++){value=Number(await agent("Advance",{mode:"write"})); if(value===2) break;} if(value!==2) throw new Error("Branch did not stop at two"); return await parallel([()=>agent("Left",{mode:"write"}),()=>agent("Right",{mode:"write"})]);'));
  await f.engine.start({ id: draft.id, revision: draft.revision }); const done = await f.engine.wait(draft.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(f.calls.length, 4); assert.equal(maximum, 1);
  assert.deepEqual(done.result, ["3", "4"]); assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "4");
});

test("a local task cannot silently claim worktree isolation while writing the original project", async t => {
  const f = await fixture(t, async () => "must not dispatch");
  const draft = await f.engine.preview(localInput(f.project, 'return await agent("Isolated",{isolation:"worktree"});'));
  await f.engine.start({ id: draft.id, revision: draft.revision }); const done = await f.engine.wait(draft.id);
  assert.equal(done.execution, "failed"); assert.match(done.error!, /Worktree isolation cannot be requested in local/); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "user baseline\n");
});

test("waiting for a local project writer respects the workflow time budget without dispatch", async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, async () => { started.resolve(); await finish.promise; return "held"; });
  const first = await f.engine.preview(localInput(f.project, 'return await agent("Hold",{mode:"write"});'));
  const second = await f.engine.preview({ ...localInput(f.project, 'return await agent("Wait",{mode:"write"});'), limits: { timeoutMs: 100 } });
  await f.engine.start({ id: first.id, revision: first.revision }); await started.promise;
  await f.engine.start({ id: second.id, revision: second.revision }); const refused = await f.engine.wait(second.id);
  assert.equal(refused.execution, "failed"); assert.match(refused.error!, /Timed out waiting/); assert.equal(f.calls.length, 1); assert.equal(refused.workspace, undefined);
  finish.resolve(); assert.equal((await f.engine.wait(first.id)).execution, "completed");
});
