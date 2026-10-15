import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { CheckpointStore } from "../src/checkpoint-store.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest } from "../src/adapter.ts";
import type { WorkflowRun } from "../src/types.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(settle => { resolve = settle; }); return { promise, resolve }; }
const promptOf = (request: WorkerRequest) => request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8);
const script = (body: string) => `export const meta={name:"checkpoint-engine",description:"Inspect or modify only this disposable fixture project"}; ${body}`;
type Handler = (request: WorkerRequest, signal: AbortSignal, emit: (event: WorkerEvent) => void) => Promise<unknown>;
async function fixture(t: TestContext, handler: Handler, storeFactory?: (root: string) => RunStore) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-engine-")));
  const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "source.txt"), "existing user edit\n"); await writeFile(path.join(project, "notes.txt"), "preserve user notes\n");
  const calls: WorkerRequest[] = [], store = storeFactory?.(path.join(root, "state")) ?? new RunStore(path.join(root, "state"));
  const adapter: WorkerAdapter = {
    executionEnvironment: async () => ({ defaults: { model: "fixture-checkpoint", reasoningEffort: "max" }, models: [{ id: "fixture-checkpoint", displayName: "Checkpoint fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] }),
    run: async (request, signal, emit) => {
      calls.push(request); emit({ type: "identity", threadId: `fixture-${request.id}`, turnId: request.id });
      const result = await handler(request, signal, emit);
      return { output: typeof result === "string" ? result : JSON.stringify(result), ...(request.outputSchema ? { data: result } : {}), threadId: `fixture-${request.id}`, turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    }, close: async () => {},
  };
  const engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const preview = (body: string) => engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "local", script: script(body) });
  return { root, project, store, engine, calls, preview };
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Fixture checkpoint state was not reached"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function inventory(root: string): Promise<Array<[string, string]>> {
  const records: Array<[string, string]> = [];
  const visit = async (relative: string) => {
    const filename = path.join(root, relative), info = await lstat(filename);
    if (info.isDirectory()) for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name));
    else if (info.isFile()) records.push([relative, createHash("sha256").update(await readFile(filename)).digest("hex")]);
    else throw new Error("Fixture inventory contains an unsupported file");
  };
  await visit(""); return records;
}
async function failedPrefix(t: TestContext) {
  const f = await fixture(t, async () => "verified prefix");
  const draft = await f.preview('await agent("prefix"); throw new Error("Manual decision required");');
  await f.engine.start({ id: draft.id, revision: draft.revision }); const run = await f.engine.wait(draft.id);
  assert.equal(run.execution, "failed"); assert.equal(run.tasks[0]?.status, "completed"); assert.equal(run.checkpointState?.status, "ready");
  return { ...f, run };
}

test("a sequential write's result and checkpoint are committed before its following read begins", async t => {
  const reading = deferred(), finish = deferred();
  const f = await fixture(t, async request => {
    if (promptOf(request) === "write") { await writeFile(path.join(request.cwd, "source.txt"), "existing user edit\nworkflow edit\n"); return "write verified"; }
    reading.resolve(); await finish.promise; return readFile(path.join(request.cwd, "source.txt"), "utf8");
  });
  const draft = await f.preview('await agent("write",{mode:"write"}); return await agent("read");');
  await f.engine.start({ id: draft.id, revision: draft.revision }); await reading.promise;
  try {
    const saved = await f.store.load(draft.id), checkpoint = await new CheckpointStore(f.store).read(saved);
    assert.equal(saved.tasks[0]?.status, "completed"); assert.equal(saved.tasks[0]?.output, "write verified");
    assert.equal(saved.nodeCheckpoint?.reason, "node"); assert.equal(saved.nodeCheckpoint?.completedTasks, 1);
    assert.deepEqual(checkpoint.nodes.map(node => node.taskId), ["task_1"]);
    assert.equal(checkpoint.workspaceFingerprint, saved.workspaceCheckpoint);
    assert.equal(saved.checkpointState?.status, "dirty", "The new read has started after the previous checkpoint was committed.");
    assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "existing user edit\nworkflow edit\n");
    assert.ok(f.calls.every(call => call.model === "fixture-checkpoint" && call.reasoningEffort === "max"));
  } finally { finish.resolve(); }
  const done = await f.engine.wait(draft.id); assert.equal(done.execution, "completed", done.error); assert.equal(done.nodeCheckpoint?.completedTasks, 2);
});

test("parallel nodes commit a stable boundary only after the last actual worker exits", async t => {
  const slowStarted = deferred(), finishSlow = deferred();
  const f = await fixture(t, async request => {
    if (promptOf(request) === "slow") { slowStarted.resolve(); await finishSlow.promise; return "slow verified"; }
    await slowStarted.promise; return "fast verified";
  });
  const draft = await f.preview('return await parallel([()=>agent("fast"),()=>agent("slow")]);');
  await f.engine.start({ id: draft.id, revision: draft.revision }); await slowStarted.promise;
  try {
    await eventually(async () => (await f.store.load(draft.id)).tasks[0]?.status === "completed");
    const pending = await f.store.load(draft.id), listed = await f.engine.listCheckpoints({ id: draft.id });
    assert.equal(pending.tasks[1]?.status, "running"); assert.equal(pending.checkpointState?.status, "dirty");
    assert.equal(pending.nodeCheckpoint?.completedTasks, 0);
    assert.ok(listed.checkpoints.every(checkpoint => checkpoint.reason !== "node"));
  } finally { finishSlow.resolve(); }
  const done = await f.engine.wait(draft.id), listed = await f.engine.listCheckpoints({ id: draft.id });
  assert.equal(done.execution, "completed", done.error); assert.equal(done.checkpointState?.status, "ready");
  const boundaries = listed.checkpoints.filter(checkpoint => checkpoint.reason === "node");
  assert.equal(boundaries.length, 1); assert.equal(boundaries[0]?.completedTasks, 2);
});

test("recovery preview is read-only and file drift invalidates confirmation without rollback or worker dispatch", async t => {
  const f = await failedPrefix(t), directory = f.store.directory(f.run.id), before = await inventory(directory), projectBefore = await inventory(f.project);
  const preview = await f.engine.previewRecovery({ id: f.run.id, revision: f.run.revision });
  assert.equal(preview.canResume, true); assert.equal(preview.strategy, "preserve-files"); assert.equal(preview.currentFilesPreserved, true); assert.equal(preview.externalEffectsReverted, false);
  assert.deepEqual(preview.reusedTaskIds, ["task_1"]); assert.deepEqual(await inventory(directory), before); assert.deepEqual(await inventory(f.project), projectBefore); assert.equal(f.calls.length, 1);
  const repeated = await f.engine.previewRecovery({ id: f.run.id, revision: f.run.revision }); assert.equal(repeated.fingerprint, preview.fingerprint);
  await writeFile(path.join(f.project, "source.txt"), "external user edit after recovery preview\n");
  await assert.rejects(f.engine.start({ id: f.run.id, revision: f.run.revision, recoveryFingerprint: preview.fingerprint }, true), /preview changed or is blocked/);
  assert.deepEqual(await inventory(directory), before); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "external user edit after recovery preview\n");
  const blocked = await f.engine.previewRecovery({ id: f.run.id, revision: f.run.revision });
  assert.equal(blocked.canResume, false); assert.ok(blocked.blockers.some(blocker => blocker.code === "workspace_changed"));
});

test("a stale revision rejects recovery confirmation before changing the current saved run", async t => {
  const f = await failedPrefix(t), preview = await f.engine.previewRecovery({ id: f.run.id, revision: f.run.revision });
  const current = await f.store.load(f.run.id); current.revision++; current.logs.push({ at: new Date().toISOString(), level: "info", message: "Fixture concurrent client update" }); await f.store.save(current, true);
  const before = await inventory(f.store.directory(f.run.id));
  await assert.rejects(f.engine.start({ id: f.run.id, revision: f.run.revision, recoveryFingerprint: preview.fingerprint }, true), /Workflow changed/);
  assert.deepEqual(await inventory(f.store.directory(f.run.id)), before); assert.equal(f.calls.length, 1);
});

test("changed read-only projects preview and execute a full recheck instead of reusing the old result", async t => {
  const f = await fixture(t, async request => readFile(path.join(request.cwd, "source.txt"), "utf8"));
  const draft = await f.engine.preview({ projectPath: f.project, script: script('await agent("read"); throw new Error("Manual decision required");') });
  await f.engine.start({ id: draft.id, revision: draft.revision }); const first = await f.engine.wait(draft.id);
  await writeFile(path.join(f.project, "source.txt"), "new source for the read-only recheck\n");
  const before = await inventory(f.store.directory(draft.id)), preview = await f.engine.previewRecovery({ id: draft.id, revision: first.revision });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers)); assert.deepEqual(preview.reusedTaskIds, []); assert.deepEqual(preview.rerunTaskIds, ["task_1"]); assert.deepEqual(preview.invalidatedTaskIds, ["task_1"]);
  assert.deepEqual(await inventory(f.store.directory(draft.id)), before);
  await f.engine.start({ id: draft.id, revision: first.revision, recoveryFingerprint: preview.fingerprint }, true); const result = await f.engine.wait(draft.id);
  assert.equal(result.error, "Manual decision required"); assert.equal(result.tasks[0]?.cached, false); assert.equal(result.tasks[0]?.attempts.length, 2);
  assert.equal(result.tasks[0]?.output, "new source for the read-only recheck\n"); assert.equal(f.calls.length, 2);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "new source for the read-only recheck\n");
});

for (const stopped of [false, true]) test(`${stopped ? "stopped" : "failed"} workflow recovery reuses its completed prefix and retains partial files and attempts`, async t => {
  const verifying = deferred(); let verifyCalls = 0;
  const f = await fixture(t, async (request, signal) => {
    if (promptOf(request) === "write") { await writeFile(path.join(request.cwd, "source.txt"), "existing user edit\nworkflow edit retained\n"); return "write verified"; }
    if (++verifyCalls === 1) {
      verifying.resolve();
      if (stopped) await new Promise<void>((_resolve, reject) => { const abort = () => reject(new Error("Fixture verification interrupted")); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
      throw new Error("Fixture verification temporarily unavailable");
    }
    return "verification passed";
  });
  const draft = await f.preview('await agent("write",{mode:"write"}); return await agent("verify");');
  await f.engine.start({ id: draft.id, revision: draft.revision }); await verifying.promise;
  const interrupted = stopped ? await f.engine.stop(draft.id) : await f.engine.wait(draft.id), filesBefore = await inventory(f.project);
  assert.equal(interrupted.execution, stopped ? "stopped" : "failed");
  const preview = await f.engine.previewRecovery({ id: draft.id, revision: interrupted.revision });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers)); assert.deepEqual(preview.reusedTaskIds, ["task_1"]); assert.deepEqual(preview.rerunTaskIds, ["task_2"]);
  await f.engine.start({ id: draft.id, revision: interrupted.revision, recoveryFingerprint: preview.fingerprint }, true);
  const done = await f.engine.wait(draft.id);
  assert.equal(done.execution, "completed", done.error); assert.deepEqual(done.tasks.map(task => task.cached), [true, false]); assert.deepEqual(done.tasks.map(task => task.attempts.length), [1, 2]);
  assert.equal(done.tasks[1]?.attempts[0]?.status, stopped ? "interrupted" : "failed");
  assert.deepEqual(await inventory(f.project), filesBefore); assert.equal(await readFile(path.join(f.project, "notes.txt"), "utf8"), "preserve user notes\n");
  assert.deepEqual(f.calls.map(promptOf), ["write", "verify", "verify"]);
});

test("explicit node retry reports and invalidates its tail while preserving earlier attempts", async t => {
  let verifyCalls = 0;
  const f = await fixture(t, async request => promptOf(request) === "verify" ? { accepted: ++verifyCalls > 1 } : promptOf(request));
  const schema = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false };
  const draft = await f.preview(`await agent("prefix"); const report=await agent("verify",{schema:${JSON.stringify(schema)}}); await agent("tail"); if(!report.accepted) throw new Error("Business result rejected"); return report;`);
  await f.engine.start({ id: draft.id, revision: draft.revision }); const failed = await f.engine.wait(draft.id);
  assert.equal(failed.execution, "failed"); assert.ok(failed.tasks.every(task => task.status === "completed"));
  const preview = await f.engine.previewRecovery({ id: draft.id, revision: failed.revision, retryFromTaskId: "task_2" });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers)); assert.deepEqual(preview.reusedTaskIds, ["task_1"]); assert.deepEqual(preview.invalidatedTaskIds, ["task_2", "task_3"]);
  await f.engine.start({ id: draft.id, revision: failed.revision, retryFromTaskId: "task_2", recoveryFingerprint: preview.fingerprint }, true); const done = await f.engine.wait(draft.id);
  assert.equal(done.execution, "completed", done.error); assert.deepEqual(done.tasks.map(task => task.cached), [true, false, false]); assert.deepEqual(done.tasks.map(task => task.attempts.length), [1, 2, 2]);
  assert.deepEqual(done.tasks[1]?.attempts[0]?.output, { accepted: false }); assert.deepEqual(done.tasks[1]?.attempts[1]?.output, { accepted: true });
});

test("a shorter dynamic branch archives every retired task with paged full attempt history", async t => {
  let choices = 0;
  const f = await fixture(t, async request => promptOf(request) === "choose" ? { longer: ++choices === 1 } : promptOf(request));
  const schema = { type: "object", properties: { longer: { type: "boolean" } }, required: ["longer"], additionalProperties: false };
  const draft = await f.preview(`const choice=await agent("choose",{schema:${JSON.stringify(schema)}}); if(choice.longer){await agent("retired one");await agent("retired two");throw new Error("Retry branch decision");} return choice;`);
  await f.engine.start({ id: draft.id, revision: draft.revision }); const first = await f.engine.wait(draft.id), retired = structuredClone(first.tasks.slice(1));
  assert.equal(first.execution, "failed"); assert.equal(first.tasks.length, 3);
  await f.engine.start({ id: draft.id, revision: first.revision, retryFromTaskId: "task_1" }, true); const done = await f.engine.wait(draft.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks.length, 1); assert.equal(done.tasks[0]?.attempts.length, 2);
  const firstPage = await f.engine.taskHistory({ id: draft.id, limit: 1 });
  assert.ok("total" in firstPage); assert.equal(firstPage.total, 2); assert.equal(firstPage.nextOffset, 1);
  const secondPage = await f.engine.taskHistory({ id: draft.id, offset: 1, limit: 1 }); assert.ok("total" in secondPage);
  const records = [...firstPage.history, ...secondPage.history]; assert.deepEqual(records.map(item => item.taskId).sort(), ["task_2", "task_3"]);
  for (const record of records) {
    const full = await f.engine.taskHistory({ id: draft.id, historyId: record.id, detail: "developer" }); assert.ok("task" in full);
    assert.deepEqual(full.task, { ...retired.find(task => task.id === record.taskId), cacheInvalidated: true });
    const brief = await f.engine.taskHistory({ id: draft.id, historyId: record.id, detail: "brief" }); assert.ok("task" in brief); assert.equal("prompt" in brief.task, false); assert.equal("output" in brief.task, false);
  }
  const checkpoints = await f.engine.listCheckpoints({ id: draft.id, limit: 100 }); assert.equal(checkpoints.latest?.completedTasks, 1); assert.equal(checkpoints.state.status, "ready");
});

test("an edited retained plan cannot reuse a concurrent reader from before its changed write", async t => {
  const oldWritten = deferred(), newWritten = deferred(); let updated = false;
  const f = await fixture(t, async request => {
    const prompt = promptOf(request);
    if (prompt.startsWith("writer ")) {
      const value = prompt.slice("writer ".length); await writeFile(path.join(request.cwd, "source.txt"), value);
      if (value === "old") oldWritten.resolve(); else newWritten.resolve();
      return value;
    }
    await (updated ? newWritten.promise : oldWritten.promise);
    return readFile(path.join(request.cwd, "source.txt"), "utf8");
  });
  const body = (value: string) => `return await parallel([()=>agent("writer ${value}",{mode:"write"}),()=>agent("reader")]);`;
  const draft = await f.preview(body("old")); await f.engine.start({ id: draft.id, revision: draft.revision }); const first = await f.engine.wait(draft.id);
  assert.deepEqual(first.result, ["old", "old"]);
  const changed = await f.engine.update({ id: draft.id, revision: first.revision, script: script(body("new")), args: {} }); updated = true;
  const scheduling = f.engine as unknown as { agentEnvironment(...args: unknown[]): Promise<unknown> }, original = scheduling.agentEnvironment.bind(f.engine); let arrivals = 0;
  scheduling.agentEnvironment = async (...args) => { if (++arrivals === 1) await new Promise(resolve => setTimeout(resolve, 50)); return original(...args); };
  await f.engine.start({ id: draft.id, revision: changed.revision }); const result = await f.engine.wait(draft.id);
  assert.equal(result.execution, "completed", result.error); assert.deepEqual(result.result, ["new", "new"]);
  assert.deepEqual(result.tasks.map(task => task.cached), [false, false]); assert.deepEqual(result.tasks.map(task => task.attempts.length), [2, 2]);
  for (let index = 0; index < 2; index++) assert.deepEqual(result.tasks[index]?.attempts[0], first.tasks[index]?.attempts[0]);
  assert.deepEqual(f.calls.map(promptOf), ["writer old", "reader", "reader", "writer new"]);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "new");
});

test("file drift after recovery validation cannot be sealed into a new checkpoint with old results", async t => {
  let inject = false, changed = false, project = "";
  class ConcurrentEditStore extends RunStore {
    override async save(run: WorkflowRun, durable = false) {
      if (inject && !changed && run.execution === "preparing" && run.preparation?.stages.find(stage => stage.id === "validation")?.status === "completed") {
        changed = true; await writeFile(path.join(project, "source.txt"), "external user edit after validation\n");
      }
      return super.save(run, durable);
    }
  }
  const f = await fixture(t, async request => readFile(path.join(request.cwd, "source.txt"), "utf8"), root => new ConcurrentEditStore(root)); project = f.project;
  const draft = await f.preview('await agent("read"); throw new Error("Manual decision required");');
  await f.engine.start({ id: draft.id, revision: draft.revision }); const first = await f.engine.wait(draft.id);
  assert.equal(first.tasks[0]?.output, "existing user edit\n");
  const preview = await f.engine.previewRecovery({ id: draft.id, revision: first.revision }); assert.equal(preview.canResume, true);
  const checkpointDirectory = path.join(f.store.directory(draft.id), "checkpoints"), priorArtifacts = (await readdir(checkpointDirectory)).sort();
  inject = true; await f.engine.start({ id: draft.id, revision: first.revision, recoveryFingerprint: preview.fingerprint }, true); const refused = await f.engine.wait(draft.id);
  assert.equal(changed, true); assert.equal(refused.execution, "failed"); assert.equal(refused.checkpointState?.status, "failed");
  assert.equal(f.calls.length, 1); assert.equal(refused.tasks[0]?.cached, false, "The old read must never reach the replay cache after confirmation drift.");
  assert.equal(refused.nodeCheckpoint?.id, first.nodeCheckpoint?.id); assert.equal(refused.workspaceCheckpoint, first.workspaceCheckpoint);
  assert.deepEqual((await readdir(checkpointDirectory)).sort(), priorArtifacts, "A changed project cannot produce a new manifest that certifies the old result.");
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "external user edit after validation\n");
  assert.match(refused.error ?? "", /checkpoint|changed|检查点|变化/i);
});

test("legacy checkpoint migration retains the fingerprint that actually matched the saved workspace", async t => {
  const f = await failedPrefix(t), legacy = await f.store.load(f.run.id);
  delete legacy.nodeCheckpoint; delete legacy.checkpointState; await f.store.save(legacy, true);
  const preview = await f.engine.previewRecovery({ id: legacy.id, revision: legacy.revision }); assert.equal(preview.canResume, true);
  const capturing = f.engine as unknown as { captureCheckpointState(run: WorkflowRun): Promise<unknown> }, original = capturing.captureCheckpointState.bind(f.engine); let changed = false;
  capturing.captureCheckpointState = async run => {
    // The unfixed implementation samples a second time inside validation; a
    // fixed implementation first reaches this hook when committing recovery.
    if (!changed && (run.execution === "preparing" && run.preparation?.stages.find(stage => stage.id === "validation")?.status === "running" || run.execution === "running")) {
      changed = true; await writeFile(path.join(f.project, "source.txt"), "external edit after legacy fingerprint matched\n");
    }
    return original(run);
  };
  const directory = path.join(f.store.directory(legacy.id), "checkpoints"), artifacts = (await readdir(directory)).sort();
  await f.engine.start({ id: legacy.id, revision: legacy.revision, recoveryFingerprint: preview.fingerprint }, true); const refused = await f.engine.wait(legacy.id);
  assert.equal(changed, true); assert.equal(refused.execution, "failed"); assert.equal(refused.checkpointState?.status, "failed");
  assert.equal(refused.nodeCheckpoint, undefined); assert.equal(refused.workspaceCheckpoint, legacy.workspaceCheckpoint);
  assert.equal(f.calls.length, 1); assert.equal(refused.tasks[0]?.cached, false); assert.deepEqual((await readdir(directory)).sort(), artifacts);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "external edit after legacy fingerprint matched\n");
});

for (const corruption of ["manifest", "covered-output"] as const) test(`corrupt ${corruption} blocks recovery preview and cannot launch another worker`, async t => {
  const f = await failedPrefix(t);
  if (corruption === "manifest") await writeFile(path.join(f.store.directory(f.run.id), "checkpoints", `${f.run.nodeCheckpoint!.id}.json`), "{}");
  else { const changed = await f.store.load(f.run.id); changed.tasks[0]!.output = "tampered covered output"; await f.store.save(changed, true); }
  const before = await inventory(f.store.directory(f.run.id)), preview = await f.engine.previewRecovery({ id: f.run.id, revision: f.run.revision });
  assert.equal(preview.canResume, false, "A stored completed output must be checked against its committed manifest during preview."); assert.ok(preview.blockers.length > 0);
  assert.deepEqual(await inventory(f.store.directory(f.run.id)), before); assert.equal(f.calls.length, 1);
  await assert.rejects(f.engine.start({ id: f.run.id, revision: f.run.revision, recoveryFingerprint: preview.fingerprint }, true), /blocked|changed/); assert.equal(f.calls.length, 1);
  const projectBefore = await inventory(f.project);
  await f.engine.start({ id: f.run.id, revision: f.run.revision }, true); const refused = await f.engine.wait(f.run.id);
  assert.equal(refused.execution, "failed"); assert.match(refused.error ?? "", /checkpoint/); assert.equal(f.calls.length, 1);
  assert.deepEqual(await inventory(f.project), projectBefore, "Omitting the optional confirmation fingerprint cannot bypass checkpoint integrity checks.");
});

for (const corruption of ["tampered", "missing"] as const) test(`${corruption} checkpoint manifests cannot inherit stale node-process coverage in the same engine`, async t => {
  const f = await failedPrefix(t), input = { taskId: "task_1", detail: "developer" as const };
  const initial = await f.engine.getNodeProcess(f.run.id, input); assert.equal(initial.checkpoint.covered, true);
  const filename = path.join(f.store.directory(f.run.id), "checkpoints", `${f.run.nodeCheckpoint!.id}.json`);
  if (corruption === "missing") await rm(filename); else await writeFile(filename, "{}");
  const readable = await f.engine.getNodeProcess(f.run.id, input);
  assert.equal(readable.checkpoint.covered, false); assert.equal(readable.status, "completed");
  assert.ok(readable.logs?.length, "Checkpoint damage must not block the saved node's diagnostic logs.");
  assert.ok(readable.logs?.some(log => /Worker completed/.test(log.message)));
  assert.equal(f.calls.length, 1);
});

test("a node-checkpoint save failure retains the old pointer and prevents the following node", async t => {
  class FailingNodeStore extends RunStore {
    initialId?: string; rejected = false;
    override async save(run: WorkflowRun, durable = false) {
      if (run.nodeCheckpoint?.reason === "initial") this.initialId = run.nodeCheckpoint.id;
      if (!this.rejected && durable && run.nodeCheckpoint?.reason === "node") { this.rejected = true; throw new Error("Fixture node-checkpoint persistence unavailable"); }
      return super.save(run, durable);
    }
  }
  let store!: FailingNodeStore;
  const f = await fixture(t, async request => { await writeFile(path.join(request.cwd, "source.txt"), "partial workflow edit retained\n"); return "first result"; }, root => store = new FailingNodeStore(root));
  const draft = await f.preview('await agent("first",{mode:"write"}); return await agent("must not start");');
  await f.engine.start({ id: draft.id, revision: draft.revision }); const failed = await f.engine.wait(draft.id);
  assert.equal(store.rejected, true); assert.equal(failed.execution, "failed"); assert.equal(failed.checkpointState?.status, "failed"); assert.equal(failed.failureContext?.kind, "checkpoint"); assert.equal(failed.nodeCheckpoint?.id, store.initialId);
  assert.deepEqual(f.calls.map(promptOf), ["first"]); assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "partial workflow edit retained\n");
  const listed = await f.engine.listCheckpoints({ id: draft.id }); assert.equal(listed.total, 1); assert.equal(listed.latest?.id, store.initialId);
  const recovery = await f.engine.previewRecovery({ id: draft.id, revision: failed.revision }); assert.equal(recovery.canResume, false); assert.ok(recovery.blockers.some(blocker => blocker.code === "checkpoint_commit_failed"));
});

for (const verified of [false, true]) test(`legacy records establish new node checkpoints only after ${verified ? "successful" : "failed"} whole-workspace verification`, async t => {
  const f = await failedPrefix(t), legacy = await f.store.load(f.run.id);
  delete legacy.nodeCheckpoint; delete legacy.checkpointState; if (!verified) delete legacy.workspaceCheckpoint; await f.store.save(legacy, true);
  const manifestDirectory = path.join(f.store.directory(f.run.id), "checkpoints"), priorFiles = await readdir(manifestDirectory);
  const preview = await f.engine.previewRecovery({ id: legacy.id, revision: legacy.revision }); assert.equal(preview.canResume, verified);
  await f.engine.start({ id: legacy.id, revision: legacy.revision }, true); const resumed = await f.engine.wait(legacy.id);
  assert.equal(resumed.execution, "failed"); assert.equal(f.calls.length, 1); assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "existing user edit\n");
  if (verified) { assert.equal(resumed.tasks[0]?.cached, true); assert.ok(resumed.nodeCheckpoint); assert.equal(resumed.checkpointState?.status, "ready"); assert.ok((await readdir(manifestDirectory)).length > priorFiles.length); }
  else { assert.equal(resumed.nodeCheckpoint, undefined); assert.deepEqual(await readdir(manifestDirectory), priorFiles); assert.match(resumed.error ?? "", /reliable checkpoint/); }
});
