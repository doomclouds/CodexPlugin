import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { CommandRequest, WorkerAdapter, WorkerRequest, WorkerResult, WorkerEvent } from "../src/adapter.ts";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";
import type { WorkflowRun } from "../src/types.ts";

const exec = promisify(execFile);
const script = (body: string): string => `export const meta = { name: "engine-test", description: "Exercise orchestration with an explicit test adapter" };\n${body}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
const taskPrompt = (request: WorkerRequest) => request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8);

// Test-only adapter: it exercises scheduling and persistence without starting Codex or a model.
class TestAdapter implements WorkerAdapter {
  calls: string[] = [];
  private handler: (request: WorkerRequest, signal: AbortSignal) => Promise<unknown>;
  constructor(handler: (request: WorkerRequest, signal: AbortSignal) => Promise<unknown> = async request => taskPrompt(request)) { this.handler = handler; }
  async run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    this.calls.push(taskPrompt(request));
    onEvent({ type: "identity", threadId: `test-${request.id}`, turnId: `turn-${request.id}` });
    const value = await this.handler(request, signal);
    return { output: typeof value === "string" ? value : JSON.stringify(value), ...(request.outputSchema ? { data: value } : {}),
      threadId: `test-${request.id}`, turnId: `turn-${request.id}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }
  async close(): Promise<void> {}
}

async function fixture(t: TestContext, adapter = new TestAdapter()) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-engine-test-"));
  const project = path.join(root, "project");
  const storage = path.join(root, "state");
  await mkdir(project);
  await exec("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "source.txt"), "original\n");
  await exec("git", ["add", "--", "source.txt"], { cwd: project });
  const engine = new WorkflowEngine({ store: new RunStore(storage), adapter });
  const engines = [engine];
  t.after(async () => { for (const item of engines) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, storage, engine, adapter, engines };
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Expected workflow state was not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("preview persists the plan without starting an adapter or creating a workspace", async t => {
  const { project, engine, adapter } = await fixture(t);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("inspect");'), allowWrite: true });
  assert.equal(run.execution, "draft");
  assert.equal(run.workspace, undefined);
  assert.equal(adapter.calls.length, 0);
  assert.equal((await engine.get(run.id)).script, run.script);
});

test("start acknowledges preparing before slow model discovery and stop waits its owned promise", async t => {
  const discovery = deferred<void>(), interrupted = deferred<void>(), exit = deferred<void>();
  const adapter = new TestAdapter();
  const environment: ExecutionEnvironment = { defaults: { model: "fixture-model", reasoningEffort: "low" }, models: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }] };
  (adapter as TestAdapter & WorkerAdapter).executionEnvironment = async (_cwd, signal) => {
    discovery.resolve(); signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
    await exit.promise;
    if (signal.aborted) throw new Error("Owned discovery process exited after cancellation");
    return environment;
  };
  const { engine, project, storage, engines } = await fixture(t, adapter);
  const viewer = new WorkflowEngine({ store: new RunStore(storage), adapter: new TestAdapter() }); engines.push(viewer);
  const draft = await engine.preview({ projectPath: project, script: script('return await agent("inspect");') });
  const accepted = await engine.start({ id: draft.id, revision: draft.revision });
  assert.equal(accepted.execution, "preparing");
  await discovery.promise;
  const observed = await viewer.get(draft.id);
  assert.equal(observed.execution, "preparing");
  assert.equal(observed.preparation?.stages[0]?.id, "settings");
  assert.equal(observed.preparation?.stages[0]?.status, "running");
  assert.ok(observed.preparation?.stages[0]?.startedAt);
  assert.equal(observed.revision, accepted.revision, "Telemetry must not churn action revisions");
  assert.ok((observed.progressSequence ?? 0) > 0);
  let settled = false;
  const stopped = engine.stop(draft.id).then(run => { settled = true; return run; });
  await interrupted.promise;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(settled, false);
  assert.equal((await viewer.get(draft.id)).execution, "stopping");
  assert.equal(await engine.store.isLocked(draft.id), true);
  exit.resolve();
  const final = await stopped;
  assert.equal(final.execution, "stopped");
  assert.equal(final.preparation?.stages[0]?.status, "interrupted");
  assert.ok(final.preparation?.endedAt);
  assert.equal(await engine.store.isLocked(draft.id), false);
  assert.deepEqual(adapter.calls, []);
});

test("live node activity and streamed logs become visible to another engine before completion", async t => {
  const begun = deferred<void>(), exit = deferred<void>();
  const adapter = new TestAdapter();
  adapter.run = async (request, _signal, onEvent) => {
    onEvent({ type: "activity", activity: { id: "inspect-files", kind: "command", label: "读取项目文件", status: "running", startedAt: new Date().toISOString(), detail: "token=private-test-secret" } });
    onEvent({ type: "log", message: "Inspecting project files." });
    begun.resolve(); await exit.promise;
    onEvent({ type: "activity", activity: { id: "inspect-files", kind: "command", label: "读取项目文件", status: "completed", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } });
    return { output: "Actual fixture result", threadId: request.id, turnId: "turn", durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  };
  const { engine, project, storage, engines } = await fixture(t, adapter);
  const viewer = new WorkflowEngine({ store: new RunStore(storage), adapter: new TestAdapter() }); engines.push(viewer);
  const draft = await engine.preview({ projectPath: project, script: script('phase("Inspect"); return await agent("inspect",{label:"Inspect files"});') });
  await engine.start({ id: draft.id, revision: draft.revision }); await begun.promise;
  const before = await engine.get(draft.id);
  await eventually(async () => (await viewer.get(draft.id)).logs.some(log => log.message === "Inspecting project files."));
  const observed = await viewer.get(draft.id);
  assert.equal(observed.execution, "running");
  assert.equal(observed.tasks[0]?.currentActivity?.label, "读取项目文件");
  assert.equal(observed.tasks[0]?.currentActivity?.status, "running");
  assert.equal(observed.tasks[0]?.currentActivity?.detail, undefined);
  assert.equal(observed.tasks[0]?.phase, "Inspect");
  assert.equal(observed.revision, before.revision);
  exit.resolve(); const final = await engine.wait(draft.id);
  assert.equal(final.execution, "completed");
  assert.ok(final.startedAt && final.endedAt);
  assert.ok(final.preparation?.stages.every(stage => stage.status === "completed" && stage.endedAt));
  assert.equal(final.tasks[0]?.currentActivity?.status, "completed");
  assert.ok(final.tasks[0]?.attempts[0]?.activities?.some(activity => activity.id === "inspect-files" && activity.endedAt));
});

test("unowned preparing records recover without restarting any discovery or worker", async t => {
  const { engine, project, storage, engines } = await fixture(t);
  const draft = await engine.preview({ projectPath: project, script: script('return await agent("inspect");') });
  await engine.store.save({ ...draft, execution: "preparing", startedAt: new Date().toISOString(), preparation: { startedAt: new Date().toISOString(), stages: [{ id: "workspace", label: "准备隔离工作区", status: "running", startedAt: new Date().toISOString() }] } });
  const adapter = new TestAdapter(); const recovered = new WorkflowEngine({ store: new RunStore(storage), adapter }); engines.push(recovered);
  const run = await recovered.get(draft.id);
  assert.equal(run.execution, "stopped");
  assert.equal(run.preparation?.stages[0]?.status, "interrupted");
  assert.ok(run.endedAt && run.preparation?.endedAt);
  assert.deepEqual(adapter.calls, []);
});

test("pending deletion views are read-only and never recover or persist cleared execution data", async t => {
  const { engine, project, storage, engines } = await fixture(t);
  const draft = await engine.preview({ projectPath: project, script: script('return await agent("inspect");') });
  class PendingStore extends RunStore {
    writes = 0; acquisitions = 0;
    override async load(id: string) { const run = await super.load(id); return { ...run, script: "", tasks: [], logs: [], execution: "running" as const, application: "applying" as const, deletionPending: true, deletionTarget: { kind: "run" as const, id: run.id, revision: run.revision } }; }
    override async save(run: WorkflowRun) { this.writes++; await super.save(run); }
    override async acquire(id: string) { this.acquisitions++; return super.acquire(id); }
  }
  const store = new PendingStore(storage); const adapter = new TestAdapter();
  const viewer = new WorkflowEngine({ store, adapter }); engines.push(viewer);
  const pending = await viewer.get(draft.id);
  assert.equal(pending.deletionPending, true);
  assert.equal(pending.execution, "running", "Read-only cleanup view must not masquerade as recovered execution");
  assert.equal((await viewer.list())[0]?.deletionPending, true);
  const error = /清理尚未完成.*继续删除/;
  await assert.rejects(viewer.start({ id: draft.id, revision: draft.revision }), error);
  await assert.rejects(viewer.start({ id: draft.id, revision: draft.revision }, true), error);
  await assert.rejects(viewer.update({ id: draft.id, revision: draft.revision, script: "", args: {} }), error);
  await assert.rejects(viewer.stop(draft.id), error);
  await assert.rejects(viewer.cancelTask(draft.id, "task_1"), error);
  await assert.rejects(viewer.apply(draft.id, draft.revision), error);
  assert.equal(store.writes, 0);
  assert.equal(store.acquisitions, 0);
  assert.deepEqual(adapter.calls, []);
});

test("a partially removed run exposes only its pending deletion summary across engine restart", async t => {
  const { engine, project, storage, engines } = await fixture(t);
  const draft = await engine.preview({ projectPath: project, script: script('return await agent("private task");') });
  await engine.store.withMutation(async () => {
    await engine.store.markDeleted(draft.id, "fixture-delete", draft.revision, { name: draft.meta.name, createdAt: draft.createdAt, projectPath: draft.projectPath }, { kind: "run", id: draft.id, revision: draft.revision });
    await rm(path.join(engine.store.directory(draft.id), "run.json"));
  });
  const adapter = new TestAdapter(); const restarted = new WorkflowEngine({ store: new RunStore(storage), adapter }); engines.push(restarted);
  const pending = await restarted.get(draft.id);
  assert.equal(pending.deletionPending, true);
  assert.equal(pending.meta.name, draft.meta.name);
  assert.equal(pending.script, "");
  assert.deepEqual(pending.tasks, []);
  assert.deepEqual(pending.logs, []);
  assert.equal(pending.result, undefined);
  assert.deepEqual(pending.deletionTarget, { kind: "run", id: draft.id, revision: draft.revision });
  assert.equal((await restarted.list())[0]?.deletionPending, true);
  await assert.rejects(restarted.start({ id: draft.id, revision: draft.revision }), /清理尚未完成.*继续删除/);
  assert.deepEqual(adapter.calls, []);
});

test("stop during terminal checkpoint save waits lock cleanup and preserves completion", async t => {
  const { engine, project, storage, engines } = await fixture(t);
  const draft = await engine.preview({ projectPath: project, script: script('return "actual result";') });
  const checkpoint = deferred<void>(), releaseSave = deferred<void>();
  class CheckpointStore extends RunStore {
    override async save(run: WorkflowRun) { if (run.execution === "completed") { checkpoint.resolve(); await releaseSave.promise; } await super.save(run); }
  }
  const store = new CheckpointStore(storage);
  const owner = new WorkflowEngine({ store, adapter: new TestAdapter() }); engines.push(owner);
  await owner.start({ id: draft.id, revision: draft.revision }); await checkpoint.promise;
  let settled = false;
  const stopped = owner.stop(draft.id).then(run => { settled = true; return run; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);
  assert.equal(await store.isLocked(draft.id), true);
  releaseSave.resolve();
  const final = await stopped;
  assert.equal(final.execution, "completed");
  assert.equal(final.result, "actual result");
  assert.equal(await store.isLocked(draft.id), false);
});

test("selected workflow parameters survive preview and reach workers only after start", async t => {
  const { project, engine, adapter } = await fixture(t);
  const source = 'export const meta={name:"bug-input",description:"Selected workflow input",parameters:[{name:"bug",label:"Bug 编号",type:"string",required:true},{name:"url",label:"Bug URL",type:"string"},{name:"description",label:"问题描述",type:"string",multiline:true},{name:"attempts",label:"次数",type:"number",required:true},{name:"verify",label:"验证",type:"boolean",required:true},{name:"files",label:"文件",type:"string[]",required:true}]}; return await agent(JSON.stringify(args),{label:"分析输入"});';
  const args = { bug: "123", url: "https://example.invalid/bugs/123", description: "第一行\n第二行", attempts: 0, verify: false, files: ["source.txt"], additional: { kept: null } };
  const run = await engine.preview({ projectPath: project, script: source, args });
  assert.deepEqual(run.args, args);
  assert.equal(run.meta.parameters?.[0]?.name, "bug");
  assert.deepEqual((await engine.get(run.id)).args, args);
  assert.deepEqual(adapter.calls, []);
  for (const invalid of [{ ...args, bug: "" }, { ...args, attempts: "0" }, { ...args, verify: "false" }, { ...args, files: "source.txt" }]) await assert.rejects(engine.update({ id: run.id, revision: run.revision, script: source, args: invalid }), /Missing required|must be/);
  assert.deepEqual((await engine.get(run.id)).args, args);
  await engine.start({ id: run.id, revision: run.revision });
  const final = await engine.wait(run.id);
  assert.equal(final.execution, "completed", final.error);
  assert.deepEqual(adapter.calls, [JSON.stringify(args)]);
  assert.deepEqual(final.args, args);
});

test("missing or mistyped declared input fails before persistence or worker dispatch", async t => {
  const { project, engine, adapter } = await fixture(t);
  const source = 'export const meta={name:"required-input",description:"Required input",parameters:[{name:"bug",label:"Bug",type:"string",required:true}]}; return await agent(args.bug);';
  await assert.rejects(engine.preview({ projectPath: project, script: source }), /Missing required/);
  await assert.rejects(engine.preview({ projectPath: project, script: source, args: { bug: 42 } }), /must be string/);
  assert.deepEqual(await engine.list(), []);
  const run = await engine.preview({ projectPath: project, script: source, args: { bug: "42" } });
  // A retained draft is revalidated at start, before any worker/workspace exists.
  await engine.store.save({ ...run, args: {} });
  await assert.rejects(engine.start({ id: run.id, revision: run.revision }), /Missing required/);
  const retained = await engine.get(run.id);
  assert.equal(retained.execution, "draft");
  assert.equal(retained.workspace, undefined);
  assert.deepEqual(adapter.calls, []);
});

test("read tasks run concurrently while write tasks share one slot", async t => {
  let reads = 0, writes = 0, maxReads = 0, maxWrites = 0;
  const adapter = new TestAdapter(async request => {
    if (request.mode === "read") maxReads = Math.max(maxReads, ++reads);
    else maxWrites = Math.max(maxWrites, ++writes);
    await new Promise(resolve => setTimeout(resolve, 40));
    if (request.mode === "read") reads--; else writes--;
    return taskPrompt(request);
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, limits: { maxReadWorkers: 2 }, script: script(`
    return await parallel([
      () => agent("write A", {mode: "write"}), () => agent("write B", {mode: "write"}),
      () => agent("read A"), () => agent("read B"), () => agent("read C")]);
  `) });
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.equal(maxReads, 2);
  assert.equal(maxWrites, 1);
  assert.equal(adapter.calls.length, 5);
  assert.ok(complete.workspacePath && complete.workspacePath !== project);
});

test("stop remains stopping until the real adapter promise settles", async t => {
  const begun = deferred<void>();
  const interrupted = deferred<void>();
  const exit = deferred<void>();
  const { project, engine } = await fixture(t, new TestAdapter(async (_request, signal) => {
    begun.resolve();
    signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
    await exit.promise;
    throw new Error("Test worker exited after interruption");
  }));
  const run = await engine.preview({ projectPath: project, script: script('return await agent("long task");') });
  await engine.start({ id: run.id, revision: run.revision });
  await begun.promise;
  let settled = false;
  const stopping = engine.stop(run.id).then(result => { settled = true; return result; });
  await interrupted.promise;
  await new Promise(resolve => setImmediate(resolve));
  let stoppingState: string;
  const settledBeforeExit = settled;
  try { stoppingState = (await engine.get(run.id)).execution; } finally { exit.resolve(); }
  const stopped = await stopping;
  assert.equal(settledBeforeExit, false);
  assert.equal(stoppingState, "stopping");
  assert.equal(stopped.execution, "stopped");
  assert.equal(stopped.tasks[0]?.status, "interrupted");
});

test("resume retries interrupted tasks and retains completed caches before and after them", async t => {
  const begun = deferred<void>();
  let middleAttempts = 0;
  const adapter = new TestAdapter(async (request, signal) => {
    const prompt = taskPrompt(request);
    if (prompt !== "B") return prompt;
    if (++middleAttempts > 1) return "B resumed";
    begun.resolve();
    return await new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("Test interrupted task"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await parallel([() => agent("A"), () => agent("B"), () => agent("C")]);') });
  await engine.start({ id: run.id, revision: run.revision });
  await begun.promise;
  await eventually(async () => {
    const current = await engine.get(run.id);
    return current.tasks[0]?.status === "completed" && current.tasks[2]?.status === "completed";
  });
  const stopped = await engine.stop(run.id);
  assert.deepEqual(stopped.tasks.map(task => task.status), ["completed", "interrupted", "completed"]);
  await engine.start({ id: run.id, revision: stopped.revision }, true);
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.deepEqual(complete.tasks.map(task => task.cached), [true, false, true]);
  assert.deepEqual(complete.tasks.map(task => task.attempts.length), [1, 2, 1]);
  assert.deepEqual(complete.result, ["A", "B resumed", "C"]);
});

test("the first failed task invalidates every subsequent saved result", async t => {
  let middleAttempts = 0;
  const adapter = new TestAdapter(async request => {
    const prompt = taskPrompt(request);
    if (prompt === "B" && ++middleAttempts === 1) throw new Error("Expected first attempt failure");
    return prompt;
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script(`
    const result = await parallel([() => agent("A"), () => agent("B"), () => agent("C")]);
    if (result.includes(null)) throw new Error("Verification failed");
    return result;
  `) });
  await engine.start({ id: run.id, revision: run.revision });
  const failed = await engine.wait(run.id);
  assert.equal(failed.execution, "failed");
  assert.deepEqual(failed.tasks.map(task => task.status), ["completed", "failed", "completed"]);
  await engine.start({ id: run.id, revision: failed.revision }, true);
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.deepEqual(complete.tasks.map(task => task.cached), [true, false, false]);
  assert.deepEqual(complete.tasks.map(task => task.attempts.length), [1, 2, 2]);
});

test("an input-induced prompt change invalidates that task and every later cache", async t => {
  const { project, engine, adapter } = await fixture(t);
  const source = script('const a = await agent("A"); const b = await agent(args.middle); const c = await agent("C"); return [a, b, c];');
  const run = await engine.preview({ projectPath: project, script: source, args: { middle: "old B" } });
  await engine.start({ id: run.id, revision: run.revision });
  const before = await engine.wait(run.id);
  const updated = await engine.update({ id: run.id, revision: before.revision, script: source, args: { middle: "new B" } });
  await engine.start({ id: run.id, revision: updated.revision });
  const after = await engine.wait(run.id);
  assert.equal(after.execution, "completed", after.error);
  assert.deepEqual(after.tasks.map(task => task.cached), [true, false, false]);
  assert.deepEqual(adapter.calls, ["A", "old B", "C", "new B", "C"]);
});

test("loading retained crash state marks it stopped without automatically starting workers", async t => {
  const { project, storage, engine, engines } = await fixture(t);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("recover");') });
  // Explicitly simulate the on-disk state left by a terminated process, without a live worker.
  const store = new RunStore(storage);
  const interrupted = await store.load(run.id);
  interrupted.execution = "running";
  interrupted.tasks = [{ id: "task_1", index: 0, prompt: "recover", options: {}, mode: "read", status: "running", cached: false, attempts: [{ id: "task_1_attempt_1", status: "running" }] }];
  await store.save(interrupted);
  const adapter = new TestAdapter();
  const reopened = new WorkflowEngine({ store: new RunStore(storage), adapter });
  engines.push(reopened);
  const retained = (await reopened.list())[0]!;
  assert.equal(retained.execution, "stopped");
  assert.equal(retained.tasks[0]?.status, "interrupted");
  assert.deepEqual(adapter.calls, []);
  await reopened.start({ id: run.id, revision: retained.revision }, true);
  assert.equal((await reopened.wait(run.id)).execution, "completed");
  assert.deepEqual(adapter.calls, ["recover"]);
});

test("concurrent owners cannot both start the same saved workflow", async t => {
  const releaseWorker = deferred<void>();
  const adapter = new TestAdapter(async (_request, signal) => {
    const abort = () => releaseWorker.resolve();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    await releaseWorker.promise;
    return "done";
  });
  const { project, storage, engine, engines } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("exclusive");') });
  const other = new WorkflowEngine({ store: new RunStore(storage), adapter });
  engines.push(other);
  const starts = await Promise.allSettled([engine.start({ id: run.id, revision: run.revision }), other.start({ id: run.id, revision: run.revision })]);
  assert.equal(starts.filter(item => item.status === "fulfilled").length, 1);
  releaseWorker.resolve();
  await Promise.all([engine.wait(run.id), other.wait(run.id)]);
});

test("an external owner holding the run lock prevents editing an already previewed plan", async t => {
  const { project, storage, engine } = await fixture(t);
  const source = script('return await agent("approved task");');
  const run = await engine.preview({ projectPath: project, script: source });
  const release = await new RunStore(storage).acquire(run.id);
  try {
    await assert.rejects(engine.update({ id: run.id, revision: run.revision, script: script('return await agent("replaced task");'), args: {} }), /lock|owned|running/i);
    assert.equal((await engine.get(run.id)).script, source);
  } finally { await release(); }
});

test("independent server engines share one actual write-worker slot", async t => {
  let writers = 0, maximum = 0;
  const adapter = new TestAdapter(async request => {
    maximum = Math.max(maximum, ++writers);
    await new Promise(resolve => setTimeout(resolve, 50));
    writers--;
    return taskPrompt(request);
  });
  const { project, storage, engine, engines } = await fixture(t, adapter);
  const other = new WorkflowEngine({ store: new RunStore(storage), adapter });
  engines.push(other);
  const first = await engine.preview({ projectPath: project, allowWrite: true, script: script('return await agent("first writer", {mode: "write"});') });
  const second = await other.preview({ projectPath: project, allowWrite: true, script: script('return await agent("second writer", {mode: "write"});') });
  await Promise.all([engine.start({ id: first.id, revision: first.revision }), other.start({ id: second.id, revision: second.revision })]);
  const results = await Promise.all([engine.wait(first.id), other.wait(second.id)]);
  assert.deepEqual(results.map(run => run.execution), ["completed", "completed"]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(maximum, 1);
});

test("simultaneous disk recovery by two servers retains valid stopped state without starting adapters", async t => {
  const { project, storage, engine, engines } = await fixture(t);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("recover");') });
  const store = new RunStore(storage);
  const stale = await store.load(run.id);
  stale.execution = "running";
  await store.save(stale);
  const firstAdapter = new TestAdapter(), secondAdapter = new TestAdapter();
  const first = new WorkflowEngine({ store: new RunStore(storage), adapter: firstAdapter });
  const second = new WorkflowEngine({ store: new RunStore(storage), adapter: secondAdapter });
  engines.push(first, second);
  await Promise.all([first.list(), second.list()]);
  // One reader may observe the other server's in-flight recovery; both must converge after it exits.
  const retained = await Promise.all([first.get(run.id), second.get(run.id)]);
  assert.deepEqual(retained.map(item => item.execution), ["stopped", "stopped"]);
  assert.deepEqual(firstAdapter.calls, []);
  assert.deepEqual(secondAdapter.calls, []);
  assert.equal((await store.load(run.id)).execution, "stopped");
});

test("a write task changes only the snapshot until the completed diff is explicitly applied", async t => {
  const adapter = new TestAdapter(async request => {
    await writeFile(path.join(request.cwd, "source.txt"), "edited in snapshot\n");
    return "Edited one file; test adapter produced no model output";
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('return await agent("edit", {mode: "write"});') });
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "original\n");
  assert.deepEqual(complete.diff?.files, [{ path: "source.txt", status: "modified" }]);
  await writeFile(path.join(project, "source.txt"), "user changed during review\n");
  const conflicted = await engine.apply(run.id, complete.revision);
  assert.equal(conflicted.application, "conflict");
  assert.deepEqual(conflicted.diff?.conflicts, ["source.txt"]);
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "user changed during review\n");
  await writeFile(path.join(project, "source.txt"), "original\n");
  const applied = await engine.apply(run.id, conflicted.revision);
  assert.equal(applied.application, "applied", applied.error);
  assert.equal(applied.diff?.conflicts, undefined);
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "edited in snapshot\n");
});

test("changing the overall delegated task invalidates otherwise identical agent calls", async t => {
  const {project,engine,adapter}=await fixture(t);
  const source=script('return await agent("inspect");');
  const first=await engine.preview({projectPath:project,script:source});
  await engine.start({id:first.id,revision:first.revision});
  const done=await engine.wait(first.id);
  const updated=await engine.update({id:first.id,revision:done.revision,script:source.replace("Exercise orchestration with an explicit test adapter","A different overall delegated task"),args:{}});
  await engine.start({id:updated.id,revision:updated.revision});
  const result=await engine.wait(first.id);
  assert.equal(result.execution,"completed",result.error);
  assert.equal(adapter.calls.length,2);
  assert.equal(result.tasks[0]?.cached,false);
});

test("resuming an operation with lost acknowledgment does not duplicate its existing side effect", async t => {
  let begun!: () => void;const started=new Promise<void>(resolve=>{begun=resolve;});
  let commandCalls=0;
  const adapter=new TestAdapter();
  const {project,engine}=await fixture(t,adapter);
  await writeFile(path.join(project,".gitignore"),"effect-count.txt\n");
  await exec("git",["add","-A"],{cwd:project});
  await exec("git",["-c","user.name=Workflow Test","-c","user.email=workflow-test@example.invalid","commit","--quiet","-m","Add operation recovery fixture"],{cwd:project});
  (adapter as TestAdapter & WorkerAdapter).command=async (request,signal)=>{
    commandCalls++;
    await writeFile(path.join(request.cwd,"effect-count.txt"),String(commandCalls));
    await new Promise<void>((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(new Error("Acknowledgment lost after effect")),{once:true});begun();});
    return {exitCode:0,stdout:"",stderr:"",attempts:1};
  };
  const run=await engine.preview({projectPath:project,allowWrite:true,workspaceMode:"git-worktree",maintenance:{steps:[{id:"increment",command:["node","-e","0"]}]},script:script('return await operation("increment");')});
  await engine.start({id:run.id,revision:run.revision});await started;
  const stopped=await engine.stop(run.id);
  assert.equal(stopped.tasks[0]?.attempts[0]?.outcome,"unknown");
  await engine.start({id:run.id,revision:stopped.revision},true);
  const refused=await engine.wait(run.id);
  assert.equal(refused.execution,"failed");assert.match(refused.error??"",/will not be repeated/);
  assert.equal(commandCalls,1);assert.equal(await readFile(path.join(refused.workspacePath!,"effect-count.txt"),"utf8"),"1");
});

test("protected maintenance roots reach only their declared command and cannot change after workspace creation", async t => {
  const workers: WorkerRequest[] = [], commands: CommandRequest[] = [];
  const adapter = new TestAdapter(async request => { workers.push(request); return "Read-only fixture evidence"; });
  (adapter as TestAdapter & WorkerAdapter).command = async request => {
    commands.push(request);
    await writeFile(path.join(request.cwd, ".agents", "skills", "fixture.md"), "generated in the isolated checkout\n");
    return { exitCode: 0, stdout: "Generated fixture", stderr: "", attempts: 1 };
  };
  const { project, engine } = await fixture(t, adapter);
  await mkdir(path.join(project, ".agents", "skills"), { recursive: true });
  await writeFile(path.join(project, ".agents", "skills", "fixture.md"), "original\n");
  await exec("git", ["add", "--force", "--", ".agents/skills/fixture.md"], { cwd: project });
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Add protected command fixture"], { cwd: project });
  const maintenance = { steps: [{ id: "generate", command: ["node", "generate-fixture.mjs"], protectedPaths: [".agents/skills"] }] };
  const run = await engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "git-worktree", maintenance, script: script('await agent("inspect before"); await operation("generate"); return await agent("inspect after");') });
  assert.deepEqual(run.maintenance, maintenance);
  await engine.start({ id: run.id, revision: run.revision });
  const complete = await engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]?.protectedPaths, [".agents/skills"]);
  assert.equal(commands[0]?.cwd, complete.workspacePath);
  assert.equal(workers.length, 2);
  assert.ok(workers.every(request => request.mode === "read" && !Object.hasOwn(request, "protectedPaths")));
  assert.equal(await readFile(path.join(project, ".agents", "skills", "fixture.md"), "utf8"), "original\n");
  const equivalent = await engine.update({ id: run.id, revision: complete.revision, script: run.script, args: run.args, maintenance: { steps: [{ ...maintenance.steps[0]!, protectedPaths: [".agents/skills", ".agents/skills"] }] } });
  assert.equal(equivalent.execution, "draft");
  assert.equal(equivalent.workspace?.root, complete.workspace?.root);
  assert.equal(equivalent.workspacePath, complete.workspacePath);
  assert.deepEqual(equivalent.maintenance, maintenance);
  assert.equal(commands.length, 1);
  assert.equal(workers.length, 2, "Updating an equivalent normalized scope must not start a new worker.");
  await assert.rejects(engine.update({ id: run.id, revision: equivalent.revision, script: run.script, args: run.args, maintenance: { steps: [{ ...maintenance.steps[0]!, protectedPaths: [".codex"] }] } }), /scope requires a new preview/);
  assert.deepEqual((await engine.get(run.id)).maintenance, maintenance);
  assert.equal(commands.length, 1);
});

test("read-only agents cannot request protected command paths through script options", async t => {
  const { project, engine, adapter } = await fixture(t);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("request broader access", {protectedPaths:[".agents/skills"]});') });
  await engine.start({ id: run.id, revision: run.revision });
  const failed = await engine.wait(run.id);
  assert.equal(failed.execution, "failed");
  assert.match(failed.error ?? "", /Unsupported agent option: protectedPaths/);
  assert.deepEqual(adapter.calls, []);
  assert.equal(failed.workspace, undefined);
});

test("protected operations revalidate independent Git ownership after an earlier worker changes metadata", async t => {
  let original = "", commands = 0;
  const adapter = new TestAdapter(async request => {
    await rm(path.join(request.cwd, ".git"), { recursive: true });
    await writeFile(path.join(request.cwd, ".git"), `gitdir: ${path.join(original, ".git")}\n`);
    return "Fixture replaced its own metadata pointer";
  });
  (adapter as TestAdapter & WorkerAdapter).command = async () => { commands++; return { exitCode: 0, stdout: "Must never dispatch", stderr: "", attempts: 1 }; };
  const { project, engine } = await fixture(t, adapter);
  original = project;
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Commit Git ownership fixture"], { cwd: project });
  const run = await engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "git-worktree", maintenance: { steps: [{ id: "generate", command: ["node", "fixture.mjs"], protectedPaths: [".agents/skills"] }] }, script: script('await agent("replace fixture metadata", {mode:"write"}); return await operation("generate");') });
  await engine.start({ id: run.id, revision: run.revision });
  const failed = await engine.wait(run.id);
  assert.equal(failed.execution, "failed");
  assert.equal(commands, 0);
  assert.equal(failed.tasks[1]?.status, "failed");
  assert.match(failed.tasks[1]?.error ?? "", /Git metadata.*independent checkout/);
  assert.equal(failed.tasks[1]?.attempts.at(-1)?.startedAt, undefined, "Ownership rejection must not claim the command started.");
  assert.equal(failed.tasks[1]?.attempts.at(-1)?.outcome, undefined);
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "original\n");
});

test("protected operations reject a retained command cwd redirected to the original project", async t => {
  const adapter = new TestAdapter();
  let commands = 0;
  (adapter as TestAdapter & WorkerAdapter).command = async () => { commands++; return { exitCode: 0, stdout: "Isolated fixture command", stderr: "", attempts: 1 }; };
  const { project, engine, storage } = await fixture(t, adapter);
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Commit command cwd fence fixture"], { cwd: project });
  const run = await engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "git-worktree", maintenance: { steps: [{ id: "generate", command: ["node", "fixture.mjs"], protectedPaths: [".agents/skills"], idempotent: true }] }, script: script('await operation("generate"); throw new Error("Await final decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  assert.equal(commands, 1);
  assert.notEqual(first.workspace?.root, first.projectPath);
  const store = new RunStore(storage);
  await store.save({ ...first, workspacePath: first.projectPath });
  await engine.start({ id: run.id, revision: first.revision, retryFromTaskId: "task_1" }, true);
  const refused = await engine.wait(run.id);
  assert.equal(refused.execution, "failed");
  assert.equal(commands, 1, "The redirected command must never receive protected roots on the original project.");
  assert.match(refused.tasks[0]?.error ?? "", /bound to this run's owned isolated workspace/);
  assert.equal(refused.tasks[0]?.attempts.at(-1)?.startedAt, undefined);
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "original\n");
  assert.equal((await exec("git", ["status", "--porcelain=v1"], { cwd: project })).stdout, "");
});
