import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import { CheckpointStore } from "../src/checkpoint-store.ts";
import type { CheckpointRef } from "../src/checkpoint-store.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { Task } from "../src/types.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/checkpoint-owner.mjs", import.meta.url));
const ownerPhaseTimeoutMs = 10000;
const ownerCloseTimeoutMs = 5000;
const staleLockTimeoutMs = 11000;
// Loading the subprocess and preparing its preview each have their own budget.
// Keep the crash boundary, real stale-lock wait and recovery budgets separate.
const crashTestTimeoutMs = ownerPhaseTimeoutMs * 3 + ownerCloseTimeoutMs + staleLockTimeoutMs + 30000;
type Scenario = "entered" | "partial-write" | "uncommitted-manifest" | "uncommitted-no-change";
interface OwnerMessage {
  event: string;
  id: string;
  error?: string;
  checkpoint?: CheckpointRef;
  committed?: CheckpointRef;
  pending?: CheckpointRef;
  tasks?: Task[];
}
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function ownedCrashFixture(t: TestContext, scenario: Scenario) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-crash-")));
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "source.txt"), "original user source\n");
  const store = new RunStore(path.join(root, "state"));
  const requests: WorkerRequest[] = [], engines: WorkflowEngine[] = [];
  const child = spawn(process.execPath, ["--experimental-strip-types", fixturePath, root, scenario], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const spawnedAt = Date.now(), eventTimes: string[] = [];
  let diagnostics = "", closed = false;
  child.stderr?.on("data", (data: Buffer) => { diagnostics = (diagnostics + data.toString("utf8")).slice(-8192); });
  const messages: OwnerMessage[] = [];
  const changed = new Set<() => void>();
  const wake = () => { for (const notify of changed) notify(); };
  let startupError: Error | undefined;
  child.on("error", error => { startupError = error; wake(); });
  child.on("message", message => {
    messages.push(message as OwnerMessage);
    eventTimes.push(`${(message as OwnerMessage).event}@${Date.now() - spawnedAt}ms`);
    wake();
  });
  const closing = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => { closed = true; wake(); resolve({ code, signal }); });
  });
  async function waitFor(event: string): Promise<OwnerMessage> {
    const startedAt = Date.now(), deadline = startedAt + ownerPhaseTimeoutMs;
    while (true) {
      const fatal = messages.find(message => message.event === "fatal");
      if (fatal) throw new Error(`Checkpoint owner failed while waiting for ${event}: ${fatal.error}\nEvents: ${eventTimes.join(", ")}\n${diagnostics}`);
      const found = messages.find(message => message.event === event);
      if (found) return found;
      if (startupError) throw startupError;
      if (closed || Date.now() >= deadline) throw new Error(`Checkpoint owner did not report ${event} after ${Date.now() - startedAt}ms; closed=${closed}\nEvents: ${eventTimes.join(", ")}\n${diagnostics}`);
      await new Promise<void>(resolve => {
        let timer: NodeJS.Timeout;
        const notify = () => { clearTimeout(timer); changed.delete(notify); resolve(); };
        changed.add(notify);
        timer = setTimeout(notify, 50);
      });
    }
  }
  async function waitForOwnerClose() {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      closing,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned checkpoint fixture did not close after SIGKILL")), ownerCloseTimeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }
  async function killOwner() {
    assert.ok(child.pid && child.pid !== process.pid, "the killed PID must belong to this spawned fixture");
    if (!closed) assert.equal(child.kill("SIGKILL"), true);
    const result = await waitForOwnerClose();
    assert.equal(result.signal, "SIGKILL");
    return result;
  }
  t.after(async () => {
    if (!closed) { child.kill("SIGKILL"); await waitForOwnerClose(); }
    for (const engine of engines) await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  const adapter: WorkerAdapter = {
    run: async request => {
      requests.push(request);
      if (request.id.startsWith("task_1_")) await appendFile(path.join(project, "first-writes.txt"), "unexpected replay\n");
      await writeFile(path.join(project, "second-completed.txt"), "second completed after manual resume\n");
      return { output: "second completed", threadId: "fixture-reopened-owner", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    },
    close: async () => {},
  };
  async function reopen(id: string) {
    const deadline = Date.now() + staleLockTimeoutMs;
    while (await store.isLocked(id)) {
      if (Date.now() >= deadline) throw new Error("Crashed fixture owner lock did not become stale");
      await pause(50);
    }
    const engine = new WorkflowEngine({ store: new RunStore(store.root), adapter });
    engines.push(engine);
    return { engine, recovered: await engine.get(id) };
  }
  const command = (event: "prepare" | "start") => new Promise<void>((resolve, reject) => {
    child.send({ event }, error => error ? reject(error) : resolve());
  });
  await waitFor("ready");
  await command("prepare");
  await waitFor("created");
  await command("start");
  return { root, project, store, requests, messages, waitFor, killOwner, reopen };
}

test("a real owner crash preserves a stable completed node and manually resumes only the interrupted node", { timeout: crashTestTimeoutMs }, async t => {
  const f = await ownedCrashFixture(t, "entered");
  const entered = await f.waitFor("second-entered");
  assert.equal(entered.checkpoint?.completedTasks, 1);
  assert.deepEqual(entered.tasks?.map(task => task.status), ["completed", "running"]);
  const first = structuredClone(entered.tasks![0]!);
  const interruptedAttempt = entered.tasks![1]!.attempts[0]!.id;
  assert.equal(await readFile(path.join(f.project, "first-writes.txt"), "utf8"), "first write\n");
  await f.killOwner();

  const { engine, recovered } = await f.reopen(entered.id);
  assert.equal(recovered.execution, "stopped");
  assert.equal(recovered.stopReason, "owner-exited");
  assert.deepEqual(recovered.tasks.map(task => task.status), ["completed", "interrupted"]);
  assert.equal(f.requests.length, 0, "startup recovery must not dispatch work");
  const beforePreview = await f.store.load(recovered.id);
  const preview = await engine.previewRecovery({ id: recovered.id, revision: recovered.revision });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.reusedTaskIds, ["task_1"]);
  assert.deepEqual(preview.rerunTaskIds, ["task_2"]);
  assert.equal(preview.currentFilesPreserved, true);
  assert.equal(preview.externalEffectsReverted, false);
  assert.deepEqual(await f.store.load(recovered.id), beforePreview, "recovery preview must not mutate the saved owner state");
  assert.equal(f.requests.length, 0);

  await engine.start({ id: recovered.id, revision: recovered.revision, recoveryFingerprint: preview.fingerprint }, true);
  const completed = await engine.wait(recovered.id);
  assert.equal(completed.execution, "completed", completed.error);
  assert.equal(completed.tasks[0]?.cached, true);
  assert.deepEqual(completed.tasks[0]?.attempts, first.attempts);
  assert.equal(completed.tasks[0]?.output, first.output);
  assert.equal(completed.tasks[1]?.attempts.length, 2);
  assert.equal(completed.tasks[1]?.attempts[0]?.id, interruptedAttempt);
  assert.equal(completed.tasks[1]?.attempts[0]?.status, "interrupted");
  assert.equal(completed.tasks[1]?.attempts[1]?.status, "completed");
  assert.deepEqual(f.requests.map(request => request.id), ["task_2_attempt_2"]);
  assert.equal(await readFile(path.join(f.project, "first-writes.txt"), "utf8"), "first write\n");
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "original user source\n");
  assert.equal(completed.nodeCheckpoint?.completedTasks, 2);
  assert.equal(completed.checkpointState?.status, "ready");
  const manifest = await new CheckpointStore(f.store).read(completed);
  assert.deepEqual(manifest.nodes.map(node => node.attemptId), [first.attempts[0]!.id, "task_2_attempt_2"]);
});

test("a real crash after a partial write blocks recovery and preserves the actual source changes", { timeout: crashTestTimeoutMs }, async t => {
  const f = await ownedCrashFixture(t, "partial-write");
  const entered = await f.waitFor("second-entered");
  assert.equal(entered.checkpoint?.completedTasks, 1);
  await f.killOwner();
  const { engine, recovered } = await f.reopen(entered.id);
  assert.equal(recovered.tasks[1]?.status, "interrupted");
  const preview = await engine.previewRecovery({ id: recovered.id, revision: recovered.revision });
  assert.equal(preview.canResume, false);
  assert.ok(preview.blockers.some(blocker => blocker.code === "workspace_changed"));
  assert.equal(preview.currentFilesPreserved, true);
  assert.equal(preview.externalEffectsReverted, false);
  await assert.rejects(engine.start({ id: recovered.id, revision: recovered.revision, recoveryFingerprint: preview.fingerprint }, true), /Recovery preview changed or is blocked/);
  assert.equal(f.requests.length, 0, "blocked recovery cannot start new side effects");
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "partial write before owner crash\n");
  assert.equal(await readFile(path.join(f.project, "first-writes.txt"), "utf8"), "first write\n");
  assert.equal((await f.store.load(recovered.id)).nodeCheckpoint?.id, entered.checkpoint?.id);
  assert.equal((await f.store.load(recovered.id)).revision, recovered.revision);
});

test("an immutable manifest written before the owner crashes is not a committed checkpoint without its run pointer", { timeout: crashTestTimeoutMs }, async t => {
  const f = await ownedCrashFixture(t, "uncommitted-manifest");
  const boundary = await f.waitFor("uncommitted-manifest");
  assert.equal(boundary.pending?.completedTasks, 1);
  assert.equal(boundary.committed?.completedTasks, 0);
  assert.notEqual(boundary.pending?.id, boundary.committed?.id);
  const artifacts = await readdir(path.join(f.store.directory(boundary.id), "checkpoints"));
  assert.ok(artifacts.includes(`${boundary.pending!.id}.json`), "the orphan candidate must have really reached disk");
  await f.killOwner();
  const { engine, recovered } = await f.reopen(boundary.id);
  assert.equal(recovered.nodeCheckpoint?.id, boundary.committed?.id);
  assert.equal(recovered.nodeCheckpoint?.completedTasks, 0);
  assert.equal(f.requests.length, 0);
  const checkpoints = new CheckpointStore(f.store);
  const history = await checkpoints.list(recovered);
  assert.equal(history.total, 1);
  assert.deepEqual(history.checkpoints.map(checkpoint => checkpoint.id), [boundary.committed!.id]);
  await assert.rejects(checkpoints.read(recovered, boundary.pending!), /not in the committed checkpoint chain/);
  const preview = await engine.previewRecovery({ id: recovered.id, revision: recovered.revision });
  assert.equal(preview.canResume, false);
  assert.ok(preview.blockers.some(blocker => blocker.code === "workspace_changed"));
  assert.equal(preview.checkpoint?.id, boundary.committed?.id);
  assert.equal(await readFile(path.join(f.project, "first-writes.txt"), "utf8"), "first write\n");
  assert.equal(f.messages.some(message => message.event === "second-entered"), false);
});

test("an unchanged workspace cannot make a completed result reusable before its checkpoint pointer commits", { timeout: crashTestTimeoutMs }, async t => {
  const f = await ownedCrashFixture(t, "uncommitted-no-change");
  const boundary = await f.waitFor("uncommitted-manifest");
  await f.killOwner();
  const { engine, recovered } = await f.reopen(boundary.id);
  assert.equal(recovered.tasks[0]?.status, "completed", "the result must really have reached run.json before this crash boundary");
  assert.equal(recovered.nodeCheckpoint?.completedTasks, 0);
  const preview = await engine.previewRecovery({ id: recovered.id, revision: recovered.revision });
  assert.equal(preview.blockers.some(blocker => blocker.code === "workspace_changed"), false, "this variation deliberately preserves the project fingerprint");
  assert.ok(!preview.canResume || !preview.reusedTaskIds.includes("task_1"), "an uncommitted result must be blocked or explicitly rerun, even when current files match");
  if (preview.canResume) {
    await engine.start({ id: recovered.id, revision: recovered.revision, recoveryFingerprint: preview.fingerprint }, true);
    const completed = await engine.wait(recovered.id);
    assert.equal(completed.execution, "completed", completed.error);
    assert.equal(completed.tasks[0]?.cached, false);
    assert.equal(completed.tasks[0]?.attempts.length, 2);
    assert.equal(f.requests[0]?.id, "task_1_attempt_2");
  }
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "original user source\n");
});
