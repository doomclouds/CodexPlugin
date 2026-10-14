import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "../src/adapter.ts";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";

const exec = promisify(execFile);
const script = (body: string) => `export const meta = { name: "engine-stability", description: "Deterministic engine regression fixture" };\n${body}`;
const promptOf = (request: WorkerRequest) => request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8);
const schema = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false };

// Test-only adapter exercises real scheduling, persistence and sandbox RPC without a model.
class StabilityAdapter implements WorkerAdapter {
  calls: string[] = [];
  handler: (request: WorkerRequest, signal: AbortSignal) => Promise<unknown>;
  constructor(handler: StabilityAdapter["handler"] = async request => promptOf(request)) { this.handler = handler; }
  async run(request: WorkerRequest, signal: AbortSignal, _onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    this.calls.push(promptOf(request));
    const value = await this.handler(request, signal);
    return { output: typeof value === "string" ? value : JSON.stringify(value), ...(request.outputSchema ? { data: value } : {}), threadId: `fixture-${request.id}`, turnId: `turn-${request.id}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }
  async close() {}
}

async function fixture(t: TestContext, adapter: StabilityAdapter) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-engine-stability-"));
  const project = path.join(root, "project");
  await mkdir(project);
  await exec("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "source.txt"), "original\n");
  await exec("git", ["add", "--all"], { cwd: project });
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Add stability fixture"], { cwd: project });
  const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  const engines = [engine];
  t.after(async () => { for (const item of engines) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, engine, engines };
}

test("ordinary resume never interprets business result fields as execution failure", async t => {
  const adapter = new StabilityAdapter(async () => ({ accepted: false }));
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script(`phase("Verification"); const report = await agent("verify", {schema:${JSON.stringify(schema)}}); if (!report.accepted) throw new Error("Verification rejected"); return report;`) });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  assert.equal(first.tasks[0]?.status, "completed", "Worker execution succeeded; the script owns the acceptance decision.");
  assert.deepEqual(first.failureContext, { kind: "script", phase: "Verification", afterTaskId: "task_1" });
  const preparing = await engine.start({ id: run.id, revision: first.revision }, true);
  assert.equal(preparing.failureContext, undefined, "A new execution does not display the previous failure provenance.");
  const resumed = await engine.wait(run.id);
  assert.equal(resumed.execution, "failed");
  assert.equal(resumed.tasks[0]?.cached, true);
  assert.deepEqual(adapter.calls, ["verify"]);
});

test("preparation errors record preparation provenance without inventing a failed worker", async t => {
  const adapter = new StabilityAdapter();
  (adapter as StabilityAdapter & WorkerAdapter).executionEnvironment = async () => { throw new Error("Fixture catalogue unavailable"); };
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("verify");') });
  await engine.start({ id: run.id, revision: run.revision });
  const failed = await engine.wait(run.id);
  assert.equal(failed.execution, "failed");
  assert.deepEqual(failed.failureContext, { kind: "preparation" });
  assert.deepEqual(failed.tasks, []); assert.deepEqual(adapter.calls, []);
});

test("explicit retry from a completed validation task invalidates its tail and preserves the prefix", async t => {
  let verificationCalls = 0;
  const adapter = new StabilityAdapter(async request => promptOf(request) === "verify" ? { accepted: ++verificationCalls > 1 } : promptOf(request));
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script(`const prefix = await agent("prefix"); const report = await agent("verify", {schema:${JSON.stringify(schema)}}); const tail = await agent("tail"); if (!report.accepted) throw new Error("Verification rejected"); return {prefix,report,tail};`) });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  const retry = { id: run.id, revision: first.revision, retryFromTaskId: "task_2" };
  await engine.start(retry, true);
  const retried = await engine.wait(run.id);
  assert.equal(retried.execution, "completed", retried.error);
  assert.deepEqual(retried.tasks.map(task => task.cached), [true, false, false]);
  assert.deepEqual(retried.tasks.map(task => task.attempts.length), [1, 2, 2]);
  assert.deepEqual(adapter.calls, ["prefix", "verify", "tail", "verify", "tail"]);
});

test("explicit retry refuses a started non-idempotent operation in its tail before dispatch or mutation", async t => {
  const adapter = new StabilityAdapter(async request => promptOf(request) === "verify" ? { accepted: false } : promptOf(request));
  let commandCalls = 0;
  (adapter as StabilityAdapter & WorkerAdapter).command = async request => {
    await writeFile(path.join(request.cwd, "effect-count.txt"), String(++commandCalls));
    return { exitCode: 0, stdout: "Fixture effect recorded", stderr: "", attempts: 1 };
  };
  const { project, engine } = await fixture(t, adapter);
  await writeFile(path.join(project, ".gitignore"), "effect-count.txt\n");
  await exec("git", ["add", "--all"], { cwd: project });
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Ignore isolated effect fixture"], { cwd: project });
  const run = await engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "git-worktree", maintenance: { steps: [{ id: "record_effect", command: ["node", "-e", "0"] }] }, script: script(`await agent("prefix"); const report = await agent("verify", {schema:${JSON.stringify(schema)}}); await operation("record_effect"); await agent("tail"); if (!report.accepted) throw new Error("Verification rejected"); return report;`) });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  assert.equal(commandCalls, 1);
  const calls = [...adapter.calls];
  await assert.rejects(engine.start({ id: run.id, revision: first.revision, retryFromTaskId: "task_2" }, true), /already started.*not declared idempotent/);
  assert.deepEqual(await engine.get(run.id), first, "Refusal must leave the confirmed saved scope and result history untouched.");
  assert.deepEqual(adapter.calls, calls);
  assert.equal(commandCalls, 1);
  assert.equal(await readFile(path.join(first.workspacePath!, "effect-count.txt"), "utf8"), "1");
});

test("unknown retry tasks and retry on start leave the saved run unchanged", async t => {
  const adapter = new StabilityAdapter();
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('await agent("prefix"); await agent("verify"); throw new Error("Await decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  await assert.rejects(engine.start({ id: run.id, revision: first.revision, retryFromTaskId: "task_999" }, true), /Unknown workflow retry task/);
  assert.deepEqual(await engine.get(run.id), first);
  const draft = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  const savedDraft = await engine.get(run.id);
  await assert.rejects(engine.start({ id: run.id, revision: draft.revision, retryFromTaskId: "task_2" }), /requires workflow_resume/);
  assert.deepEqual(await engine.get(run.id), savedDraft);
  assert.deepEqual(adapter.calls, ["prefix", "verify"]);
});

test("retry cache invalidation survives a failed preparation and restart before an ordinary resume", async t => {
  let verificationCalls = 0, unavailable = false;
  const adapter = new StabilityAdapter(async request => promptOf(request) === "verify" ? { accepted: ++verificationCalls > 1 } : promptOf(request));
  const environment: ExecutionEnvironment = { defaults: { model: "fixture-model", reasoningEffort: "max" }, models: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] };
  (adapter as StabilityAdapter & WorkerAdapter).executionEnvironment = async () => {
    if (unavailable) throw new Error("Fixture catalogue temporarily unavailable");
    return environment;
  };
  const { root, project, engine, engines } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script(`const prefix = await agent("prefix"); const report = await agent("verify", {schema:${JSON.stringify(schema)}}); const tail = await agent("tail"); if (!report.accepted) throw new Error("Verification rejected"); return {prefix,report,tail};`) });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  unavailable = true;
  await engine.start({ id: run.id, revision: first.revision, retryFromTaskId: "task_2" }, true);
  const interruptedRetry = await engine.wait(run.id);
  assert.equal(interruptedRetry.execution, "failed");
  assert.match(interruptedRetry.error ?? "", /catalogue temporarily unavailable/);
  assert.deepEqual(interruptedRetry.tasks.map(task => Boolean(task.cacheInvalidated)), [false, true, true]);
  assert.deepEqual(adapter.calls, ["prefix", "verify", "tail"]);
  await engine.close();

  unavailable = false;
  const reopened = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  engines.push(reopened);
  const retained = await reopened.get(run.id);
  assert.deepEqual(retained.tasks.map(task => Boolean(task.cacheInvalidated)), [false, true, true]);
  await reopened.start({ id: run.id, revision: retained.revision }, true);
  const completed = await reopened.wait(run.id);
  assert.equal(completed.execution, "completed", completed.error);
  assert.deepEqual(completed.tasks.map(task => task.cached), [true, false, false]);
  assert.deepEqual(completed.tasks.map(task => task.attempts.length), [1, 2, 2]);
  assert.deepEqual(adapter.calls, ["prefix", "verify", "tail", "verify", "tail"]);
  assert.deepEqual(completed.executionSettings, first.executionSettings, "Explicit retry must retain the run's original model snapshot.");
});

test("externally changed retained snapshot cannot reuse old verification results", async t => {
  const adapter = new StabilityAdapter(async request => {
    if (request.mode === "write") await writeFile(path.join(request.cwd, "source.txt"), "verified contents\n");
    return await readFile(path.join(request.cwd, "source.txt"), "utf8");
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("write", {mode:"write"}); await agent("verify"); throw new Error("Await final authorization");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  assert.ok(first.workspacePath);
  await writeFile(path.join(first.workspacePath!, "source.txt"), "unverified external contents\n");
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.match(resumed.error ?? "", /snapshot.*changed|workspace.*changed/i, "Resume must stop before treating old completed results as verification of changed snapshot contents.");
  assert.deepEqual(adapter.calls, ["write", "verify"]);
});

test("read-only cached Git inspection is invalidated when the branch changes with identical files", async t => {
  const adapter = new StabilityAdapter(async request => (await exec("git", ["branch", "--show-current"], { cwd: request.cwd })).stdout.trim());
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("current branch");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "completed", first.error);
  await exec("git", ["checkout", "-b", "different-branch"], { cwd: project });
  const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  const second = await engine.wait(run.id);
  assert.equal(second.execution, "completed", second.error);
  assert.equal(second.result, "different-branch");
  assert.deepEqual(adapter.calls, ["current branch", "current branch"]);
});

test("snapshot checkpoint covers ignored products used by completed verification", async t => {
  const adapter = new StabilityAdapter(async request => {
    const generated = path.join(request.cwd, "generated", "result.txt");
    if (request.mode === "write") { await mkdir(path.dirname(generated), { recursive: true }); await writeFile(generated, "verified artifact\n"); }
    return await readFile(generated, "utf8");
  });
  const { project, engine } = await fixture(t, adapter);
  await writeFile(path.join(project, ".gitignore"), "generated/\n");
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("build", {mode:"write"}); await agent("verify ignored output"); throw new Error("Await final authorization");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  await writeFile(path.join(first.workspacePath!, "generated", "result.txt"), "unverified artifact\n");
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.match(resumed.error ?? "", /snapshot.*changed|workspace.*changed/i);
  assert.deepEqual(adapter.calls, ["build", "verify ignored output"]);
});

test("legacy snapshots with already started workers require a new preview before replay", async t => {
  const adapter = new StabilityAdapter();
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("old verification"); throw new Error("Await final authorization");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  delete first.workspaceCheckpoint;
  await engine.store.save(first);
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.match(resumed.error ?? "", /snapshot.*checkpoint|checkpoint.*snapshot|new preview/i);
  assert.deepEqual(adapter.calls, ["old verification"]);
});

test("snapshot recovery treats harmless timestamp changes as unchanged contents", async t => {
  const adapter = new StabilityAdapter();
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("verified source"); throw new Error("Await decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  await utimes(path.join(first.workspacePath!, "source.txt"), 1, 1);
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.equal(resumed.error, "Await decision");
  assert.equal(resumed.tasks[0]?.cached, true);
  assert.deepEqual(adapter.calls, ["verified source"]);
});

test("snapshot recovery reuses verification after harmless Git index stat refresh", async t => {
  const adapter = new StabilityAdapter();
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("verified source"); throw new Error("Await decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  const source = path.join(first.workspacePath!, "source.txt"), index = path.join(first.workspacePath!, ".git", "index");
  const before = await readFile(index);
  await utimes(source, 1, 1);
  await exec("git", ["status", "--porcelain=v1"], { cwd: first.workspacePath!, env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" } });
  assert.equal(before.equals(await readFile(index)), false, "The fixture must actually exercise Git's byte-level stat cache rewrite.");
  assert.equal(await readFile(source, "utf8"), "original\n");
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.equal(resumed.error, "Await decision");
  assert.equal(resumed.tasks[0]?.cached, true);
  assert.deepEqual(adapter.calls, ["verified source"]);
});

test("snapshot recovery rejects real staging changes even with unchanged files and existing Git objects", async t => {
  let alternateOid = "";
  const adapter = new StabilityAdapter(async request => {
    const source = path.join(request.cwd, "source.txt");
    if (promptOf(request) === "prepare existing index objects") {
      await writeFile(source, "different staged contents\n");
      await exec("git", ["add", "--", "source.txt"], { cwd: request.cwd });
      alternateOid = (await exec("git", ["rev-parse", ":source.txt"], { cwd: request.cwd })).stdout.trim();
      await writeFile(source, "original\n");
      await exec("git", ["add", "--", "source.txt"], { cwd: request.cwd });
    }
    return await readFile(source, "utf8");
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("prepare existing index objects", {mode:"write"}); await agent("verify source"); throw new Error("Await decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.ok(alternateOid);
  await exec("git", ["update-index", "--cacheinfo", `100644,${alternateOid},source.txt`], { cwd: first.workspacePath! });
  assert.equal(await readFile(path.join(first.workspacePath!, "source.txt"), "utf8"), "original\n");
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.match(resumed.error ?? "", /snapshot.*changed|workspace.*changed/i);
  assert.deepEqual(adapter.calls, ["prepare existing index objects", "verify source"]);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
  test(`snapshot recovery rejects Git ${flag} changes when blobs and files are unchanged`, async t => {
    const adapter = new StabilityAdapter();
    const { project, engine } = await fixture(t, adapter);
    const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("verify source"); throw new Error("Await decision");') });
    await engine.start({ id: run.id, revision: run.revision });
    const first = await engine.wait(run.id);
    const before = (await exec("git", ["ls-files", "--stage", "-z"], { cwd: first.workspacePath! })).stdout;
    await exec("git", ["update-index", flag, "--", "source.txt"], { cwd: first.workspacePath! });
    assert.equal((await exec("git", ["ls-files", "--stage", "-z"], { cwd: first.workspacePath! })).stdout, before);
    assert.equal(await readFile(path.join(first.workspacePath!, "source.txt"), "utf8"), "original\n");
    await engine.start({ id: run.id, revision: first.revision }, true);
    const resumed = await engine.wait(run.id);
    assert.match(resumed.error ?? "", /snapshot.*changed|workspace.*changed/i);
    assert.deepEqual(adapter.calls, ["verify source"]);
  });

  test(`read-only Git cache includes ${flag} when blobs and files are unchanged`, async t => {
    const adapter = new StabilityAdapter(async request => (await exec("git", ["ls-files", "-v", "--", "source.txt"], { cwd: request.cwd })).stdout.trim());
    const { project, engine } = await fixture(t, adapter);
    const run = await engine.preview({ projectPath: project, script: script('return await agent("index flags");') });
    await engine.start({ id: run.id, revision: run.revision });
    const first = await engine.wait(run.id);
    const before = (await exec("git", ["ls-files", "--stage", "-z"], { cwd: project })).stdout;
    await exec("git", ["update-index", flag, "--", "source.txt"], { cwd: project });
    assert.equal((await exec("git", ["ls-files", "--stage", "-z"], { cwd: project })).stdout, before);
    const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
    await engine.start({ id: run.id, revision: updated.revision });
    const second = await engine.wait(run.id);
    assert.equal(second.execution, "completed", second.error);
    assert.notEqual(second.result, first.result);
    assert.equal(second.tasks[0]?.cached, false);
    assert.deepEqual(adapter.calls, ["index flags", "index flags"]);
  });
}

test("snapshot recovery includes intent-to-add without changing paths, modes, objects or file contents", async t => {
  const adapter = new StabilityAdapter(async request => {
    if (request.mode === "write") {
      await writeFile(path.join(request.cwd, "empty.txt"), "");
      await exec("git", ["hash-object", "-w", "empty.txt"], { cwd: request.cwd });
      await exec("git", ["add", "--intent-to-add", "--", "empty.txt"], { cwd: request.cwd });
    }
    return "Verified pending empty entry";
  });
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('await agent("prepare intent", {mode:"write"}); await agent("verify intent"); throw new Error("Await decision");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  const before = (await exec("git", ["ls-files", "--stage", "-z"], { cwd: first.workspacePath! })).stdout;
  await exec("git", ["add", "--", "empty.txt"], { cwd: first.workspacePath! });
  assert.equal((await exec("git", ["ls-files", "--stage", "-z"], { cwd: first.workspacePath! })).stdout, before);
  await engine.start({ id: run.id, revision: first.revision }, true);
  const resumed = await engine.wait(run.id);
  assert.match(resumed.error ?? "", /snapshot.*changed|workspace.*changed/i);
  assert.deepEqual(adapter.calls, ["prepare intent", "verify intent"]);
});

test("read-only Git cache includes intent-to-add when index objects and worktree contents are unchanged", async t => {
  const adapter = new StabilityAdapter(async request => (await exec("git", ["diff", "--cached", "--name-only"], { cwd: request.cwd })).stdout.trim());
  const { project, engine } = await fixture(t, adapter);
  await writeFile(path.join(project, "empty.txt"), "");
  await exec("git", ["hash-object", "-w", "empty.txt"], { cwd: project });
  await exec("git", ["add", "--intent-to-add", "--", "empty.txt"], { cwd: project });
  const run = await engine.preview({ projectPath: project, script: script('return await agent("staged files");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.result, "");
  const before = (await exec("git", ["ls-files", "--stage", "-z"], { cwd: project })).stdout;
  await exec("git", ["add", "--", "empty.txt"], { cwd: project });
  assert.equal((await exec("git", ["ls-files", "--stage", "-z"], { cwd: project })).stdout, before);
  const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  const second = await engine.wait(run.id);
  assert.equal(second.execution, "completed", second.error);
  assert.equal(second.result, "empty.txt");
  assert.equal(second.tasks[0]?.cached, false);
  assert.deepEqual(adapter.calls, ["staged files", "staged files"]);
});

for (const redirection of ["gitdir-file", "external-common-dir", "external-alternates"] as const) {
  test(`snapshot final checkpoint refuses ${redirection} before trusting external metadata`, async t => {
    let original = "";
    const adapter = new StabilityAdapter(async request => {
      const metadata = path.join(request.cwd, ".git");
      if (redirection === "gitdir-file") {
        await rm(metadata, { recursive: true });
        await writeFile(metadata, `gitdir: ${path.join(original, ".git")}\n`);
      } else if (redirection === "external-common-dir") await writeFile(path.join(metadata, "commondir"), path.join(original, ".git") + "\n");
      else await writeFile(path.join(metadata, "objects", "info", "alternates"), path.join(original, ".git", "objects") + "\n");
      return "Fixture attempted metadata redirection";
    });
    const { project, engine } = await fixture(t, adapter);
    original = project;
    const originalHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: project })).stdout;
    const run = await engine.preview({ projectPath: project, allowWrite: true, script: script('return await agent("attempt metadata redirect", {mode:"write"});') });
    await engine.start({ id: run.id, revision: run.revision });
    const first = await engine.wait(run.id);
    assert.equal(first.tasks[0]?.status, "completed");
    assert.equal(first.execution, "failed");
    assert.match(first.error ?? "", /checkpoint.*snapshot.*(independent|alternate|redirect)/i);
    assert.equal(first.workspaceCheckpoint, undefined);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: project })).stdout, originalHead);
    assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "original\n");
  });
}

test("read-only cached Git inspection includes index contents when the worktree is unchanged", async t => {
  const adapter = new StabilityAdapter(async request => (await exec("git", ["show", ":source.txt"], { cwd: request.cwd })).stdout);
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("staged source");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.result, "original\n");
  await writeFile(path.join(project, "source.txt"), "different staged contents\n");
  await exec("git", ["add", "--", "source.txt"], { cwd: project });
  await writeFile(path.join(project, "source.txt"), "original\n");
  const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  const second = await engine.wait(run.id);
  assert.equal(second.execution, "completed", second.error);
  assert.equal(second.result, "different staged contents\n");
  assert.deepEqual(adapter.calls, ["staged source", "staged source"]);
});

test("read-only cached Git inspection includes refs when HEAD and files are unchanged", async t => {
  const adapter = new StabilityAdapter(async request => (await exec("git", ["tag", "--list"], { cwd: request.cwd })).stdout.trim());
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("tags");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.result, "");
  await exec("git", ["tag", "new-fixture-tag"], { cwd: project });
  const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  const second = await engine.wait(run.id);
  assert.equal(second.execution, "completed", second.error);
  assert.equal(second.result, "new-fixture-tag");
  assert.deepEqual(adapter.calls, ["tags", "tags"]);
});

test("ordinary non-Git read-only projects still execute and reopen without checkpoints", async t => {
  const adapter = new StabilityAdapter();
  const { root, engine } = await fixture(t, adapter);
  const project = path.join(root, "non-git-project");
  await mkdir(project);
  const run = await engine.preview({ projectPath: project, script: script('return await agent("plain directory");') });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "completed", first.error);
  assert.equal(first.workspaceCheckpoint, undefined);
  const updated = await engine.update({ id: run.id, revision: first.revision, script: run.script, args: run.args });
  await engine.start({ id: run.id, revision: updated.revision });
  assert.equal((await engine.wait(run.id)).execution, "completed");
  assert.equal((await engine.get(run.id)).result, "plain directory");
});

test("parallel explicit retry preserves a completed prefix while both launches await environment discovery", async t => {
  let verificationCalls = 0;
  const adapter = new StabilityAdapter(async request => promptOf(request) === "verify" ? { accepted: ++verificationCalls > 1 } : promptOf(request));
  const environment: ExecutionEnvironment = { defaults: { model: "fixture-model", reasoningEffort: "max" }, models: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] };
  (adapter as StabilityAdapter & WorkerAdapter).executionEnvironment = async () => environment;
  const { project, engine } = await fixture(t, adapter);
  const run = await engine.preview({ projectPath: project, script: script(`const reports = await parallel([() => agent("prefix"), () => agent("verify", {schema:${JSON.stringify(schema)}})]); if (!reports[1].accepted) throw new Error("Verification rejected"); return reports;`) });
  await engine.start({ id: run.id, revision: run.revision });
  const first = await engine.wait(run.id);
  assert.equal(first.execution, "failed");
  assert.deepEqual(first.tasks.map(task => task.status), ["completed", "completed"]);

  // Gate the awaited discovery boundary, rather than racing wall-clock delays.
  // Both launches must be in flight before either may make a cache decision.
  const scheduling = engine as unknown as { agentEnvironment(...args: unknown[]): Promise<ExecutionEnvironment | undefined> };
  const discover = scheduling.agentEnvironment.bind(engine);
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>(resolve => { release = resolve; });
  scheduling.agentEnvironment = async (...args) => {
    if (++entered === 2) release();
    await bothEntered;
    return await discover(...args);
  };
  await engine.start({ id: run.id, revision: first.revision, retryFromTaskId: "task_2" }, true);
  const retried = await engine.wait(run.id);
  assert.equal(entered, 2, "The fixture must overlap both discovery waits.");
  assert.equal(retried.execution, "completed", retried.error);
  assert.deepEqual(retried.tasks.map(task => task.cached), [true, false]);
  assert.deepEqual(retried.tasks.map(task => task.attempts.length), [1, 2]);
  assert.deepEqual(adapter.calls, ["prefix", "verify", "verify"]);
  assert.deepEqual(retried.result, ["prefix", { accepted: true }]);
});

