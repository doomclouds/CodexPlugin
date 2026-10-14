import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "../src/adapter.ts";

const execute = promisify(execFile);
const script = (body: string) => `export const meta = { name: "review-regression", description: "Explicit test-only adapter regression" };\n${body}`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Protocol-independent scheduling fixture; no Codex process or model is started.
class MeteredTestAdapter implements WorkerAdapter {
  calls = 0;
  fail = false;
  async run(request: WorkerRequest, _signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    this.calls++;
    const usage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
    onEvent({ type: "usage", ...usage });
    if (this.fail) throw new Error("Test worker failed after consuming tokens");
    if (request.mode === "write") await writeFile(path.join(request.cwd, "source.txt"), "updated\n");
    return { output: "real scheduling test fixture output", threadId: `test-thread-${this.calls}`, turnId: `test-turn-${this.calls}`, usage, durationMs: 1 };
  }
  async close() {}
}

class PausedAcquireStore extends RunStore {
  pauseNextAcquire = false;
  reached = deferred();
  continue = deferred();
  override async acquire(id: string) {
    if (this.pauseNextAcquire) {
      this.pauseNextAcquire = false;
      this.reached.resolve();
      await this.continue.promise;
    }
    return super.acquire(id);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-review-regression-"));
  const project = path.join(root, "project");
  const storage = path.join(root, "state");
  await mkdir(project);
  await execute("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "source.txt"), "original\n");
  await execute("git", ["add", "--", "source.txt"], { cwd: project });
  const adapter = new MeteredTestAdapter();
  const store = new PausedAcquireStore(storage);
  const engine = new WorkflowEngine({ store, adapter });
  const engines = [engine];
  t.after(async () => { store.continue.resolve(); for (const item of engines) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { project, storage, adapter, store, engine, engines };
}

test("caught admission errors never persist null task entries", async t => {
  const { project, engine } = await fixture(t);
  const run = await engine.preview({ projectPath: project, script: script('try { await agent("bad options", { mode: "unsupported" }); } catch {} return await agent("valid task");') });
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.ok(complete.tasks.every(task => task !== null && typeof task === "object"), "Caught validation errors must not create holes that serialize as null tasks.");
  const revised = await engine.update({ id: run.id, revision: complete.revision, script: run.script, args: run.args });
  await engine.start({ id: revised.id, revision: revised.revision });
  assert.equal((await engine.wait(run.id)).execution, "completed");
});

test("failed attempts consume the admission budget before a handled retry", async t => {
  const { project, engine, adapter } = await fixture(t);
  adapter.fail = true;
  const run = await engine.preview({ projectPath: project, limits: { maxTokens: 10 }, script: script('for (let i = 0; i < 2; i++) { try { await agent("try again"); } catch {} } return "handled";') });
  await engine.start({ id: run.id, revision: run.revision });
  await engine.wait(run.id);
  assert.equal(adapter.calls, 1, "The failed first attempt reported ten tokens, so a second worker must not be admitted.");
});

test("cached results remain reusable when the admission budget is already exhausted", async t => {
  const { project, engine, adapter } = await fixture(t);
  const source = script('return await agent("cached task");');
  const run = await engine.preview({ projectPath: project, limits: { maxTokens: 10 }, script: source });
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  const updated = await engine.update({ id: run.id, revision: complete.revision, script: source, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  const replayed = await engine.wait(run.id);
  assert.equal(replayed.execution, "completed", replayed.error);
  assert.equal(replayed.tasks[0]?.cached, true);
  assert.equal(adapter.calls, 1);
});

test("a stale apply racing a newer preview does not mutate that preview", async t => {
  const { project, storage, engine, adapter, store, engines } = await fixture(t);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('return await agent("write fixture", { mode: "write" });') });
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  const other = new WorkflowEngine({ store: new RunStore(storage), adapter });
  engines.push(other);
  await other.get(run.id);
  store.pauseNextAcquire = true;
  const oldApply = engine.apply(run.id, complete.revision);
  await store.reached.promise;
  const updated = await other.update({ id: run.id, revision: complete.revision, script: script('return "new preview";'), args: { newer: true } });
  store.continue.resolve();
  await assert.rejects(oldApply, /Workflow changed/);
  const retained = await other.get(run.id);
  assert.equal(retained.revision, updated.revision);
  assert.equal(retained.execution, "draft");
  assert.equal(retained.application, "none");
  assert.deepEqual(retained.args, { newer: true });
});

test("restarting a draft after snapshot preparation failed does not retain deleted files", async t => {
  const { project, engine, adapter, store } = await fixture(t);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('return "No worker edits";') });
  // Fail deterministically after the first source file is copied, rather than relying on fs.watch timing.
  await writeFile(path.join(project, "z-too-large.bin"), Buffer.alloc(17 * 1024 * 1024));
  assert.equal((await engine.start({ id: run.id, revision: run.revision })).execution, "preparing");
  const failed = await engine.wait(run.id);
  assert.match(failed.error ?? "", /exceeds 16 MiB/);
  const draft = await engine.get(run.id);
  assert.equal(draft.execution, "failed");
  assert.equal(draft.workspace, undefined);
  await rm(path.join(project, "z-too-large.bin"));
  await rm(path.join(project, "source.txt"));
  await execute("git", ["add", "--all"], { cwd: project });
  await engine.start({ id: draft.id, revision: draft.revision }, true);
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.equal(adapter.calls, 0);
  assert.deepEqual(complete.diff?.files, [], "The completed snapshot must not resurrect a file deleted after the aborted preparation.");
});
