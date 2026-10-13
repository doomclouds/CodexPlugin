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
import type { WorkerAdapter, WorkerRequest, WorkerResult, WorkerEvent } from "../src/adapter.ts";

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
  const applied = await engine.apply(run.id, complete.revision);
  assert.equal(applied.application, "applied", applied.error);
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
