import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import { CheckpointStore } from "../src/checkpoint-store.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";

const loopPrompt = "Process the next loop input.", branchPrompt = "Verify the selected loop branch.";
const executionTimeoutMs = 20000;
// This test performs two executions, then checks recovery and durable history.
const testTimeoutMs = executionTimeoutMs * 3;
const promptOf = (request: WorkerRequest) => request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8);
const script = `export const meta={name:"checkpoint-loop-identity",description:"Verify distinct loop calls and result-directed branches in this disposable fixture",phases:[{title:"循环"},{title:"分支"}]};
const reports=[];
let firstFailure;
for(let iteration=0;iteration<3;iteration++){
  phase("循环");
  let result;
  try { result=await agent(args.loopPrompt,{label:"重复节点",schema:args.schema}); }
  catch(error){ firstFailure ??= error; continue; }
  if(result.kind!=="loop"||result.iteration!==iteration) throw new Error("A loop result belongs to a different iteration");
  reports.push(result);
  if(result.branch){
    phase("分支");
    const branch=await agent(args.branchPrompt,{label:"重复节点",schema:args.schema});
    if(branch.kind!=="branch"||branch.iteration!==iteration) throw new Error("A branch result belongs to a different iteration");
    reports.push(branch);
  }
}
if(firstFailure) throw firstFailure;
return reports;`;

interface FixtureResult { kind: "loop" | "branch"; iteration: number; branch: boolean; value: string }
const loopValues: FixtureResult[] = [
  { kind: "loop", iteration: 0, branch: false, value: "first actual file value" },
  { kind: "loop", iteration: 1, branch: true, value: "middle actual file value" },
  { kind: "loop", iteration: 2, branch: false, value: "last actual file value" },
];
const branchValue: FixtureResult = { kind: "branch", iteration: 1, branch: false, value: "selected branch actual file value" };

async function fixture(t: TestContext, stopped: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-loop-")));
  const project = path.join(root, "project"), state = path.join(root, "state"), ledger = path.join(root, "dispatches.jsonl");
  await mkdir(project);
  const input = JSON.stringify({ iterations: loopValues, branch: branchValue });
  await writeFile(path.join(project, "input.json"), input);
  await writeFile(path.join(project, "notes.txt"), "preserve the original user notes\n");
  const engines: WorkflowEngine[] = [], calls: Array<{ owner: string; attemptId: string; prompt: string; iteration: number; kind: string }> = [];
  let reachedMiddle!: () => void;
  const middle = new Promise<void>(resolve => { reachedMiddle = resolve; });
  const makeEngine = (owner: "original" | "reopened") => {
    // Fixture scheduling is explicit. The real engine decides which cached
    // results to reuse; this adapter only supplies results for actual dispatches.
    let nextIteration = owner === "original" ? 0 : 1;
    const adapter: WorkerAdapter = {
      run: async (request, signal) => {
        const prompt = promptOf(request);
        assert.equal(request.mode, "read");
        assert.equal(request.cwd, project);
        const actual = JSON.parse(await readFile(path.join(request.cwd, "input.json"), "utf8")) as { iterations: FixtureResult[]; branch: FixtureResult };
        assert.ok([loopPrompt, branchPrompt].includes(prompt));
        const data = prompt === branchPrompt ? actual.branch : actual.iterations[nextIteration++];
        assert.ok(data, "An unexpected loop dispatch cannot silently reuse another iteration's fixture output");
        const call = { owner, attemptId: request.id, prompt, iteration: data.iteration, kind: data.kind };
        calls.push(call);
        await appendFile(ledger, JSON.stringify(call) + "\n");
        if (owner === "original" && data.kind === "loop" && data.iteration === 1) {
          reachedMiddle();
          if (stopped) await new Promise<void>((_resolve, reject) => {
            const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Middle loop iteration stopped by fixture")); };
            if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
          });
          throw new Error("Middle loop iteration needs a later retry");
        }
        return { output: JSON.stringify(data), data, threadId: `loop-fixture-${owner}`, turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
      },
      close: async () => {},
    };
    const engine = new WorkflowEngine({ store: new RunStore(state), adapter });
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, state, ledger, input, calls, middle, makeEngine };
}

for (const stopped of [false, true]) test(`${stopped ? "stopped" : "failed"} loop recovery distinguishes identical prompts and follows a newly returned branch after reopening`, { timeout: testTimeoutMs }, async t => {
  const f = await fixture(t, stopped);
  const firstEngine = f.makeEngine("original");
  const schema = {
    type: "object", properties: { kind: { type: "string", enum: ["loop", "branch"] }, iteration: { type: "integer" }, branch: { type: "boolean" }, value: { type: "string" } },
    required: ["kind", "iteration", "branch", "value"], additionalProperties: false,
  };
  const draft = await firstEngine.preview({ projectPath: f.project, allowWrite: true, workspaceMode: "local", script, args: { loopPrompt, branchPrompt, schema }, limits: { maxCalls: 5, timeoutMs: executionTimeoutMs } });
  await firstEngine.start({ id: draft.id, revision: draft.revision });
  await Promise.race([f.middle, firstEngine.wait(draft.id).then(run => { throw new Error(`Loop fixture finished before reaching the middle: ${run.execution}: ${run.error ?? "no error"}`); })]);
  const first = stopped ? await firstEngine.stop(draft.id) : await firstEngine.wait(draft.id);
  assert.equal(first.execution, stopped ? "stopped" : "failed", first.error);
  assert.equal(first.tasks[0]?.status, "completed");
  assert.equal(first.tasks[1]?.status, stopped ? "interrupted" : "failed");
  assert.equal(first.checkpointState?.status, "ready");
  assert.deepEqual(first.tasks[0]?.output, loopValues[0]);
  const prefixAttempts = structuredClone(first.tasks[0]!.attempts);
  const failedAttempt = structuredClone(first.tasks[1]!.attempts[0]!);
  if (!stopped) {
    assert.equal(first.tasks[2]?.status, "completed", "The first pass deliberately continues the loop after the middle failure");
    assert.deepEqual(first.tasks[2]?.output, loopValues[2]);
  }
  assert.ok(first.tasks.every(task => task.prompt === loopPrompt && task.label === "重复节点"));
  const checkpointBefore = await new CheckpointStore(new RunStore(f.state)).read(first);
  assert.ok(checkpointBefore.nodes.some(node => node.taskId === "task_1" && node.attemptId === prefixAttempts[0]?.id && node.status === "completed"));
  await firstEngine.close();

  const callsBeforeReopen = f.calls.length;
  const reopenedEngine = f.makeEngine("reopened");
  const recovered = await reopenedEngine.get(first.id);
  assert.equal(f.calls.length, callsBeforeReopen, "Reopening the checkpoint cannot dispatch loop iterations");
  const preview = await reopenedEngine.previewRecovery({ id: recovered.id, revision: recovered.revision, retryFromTaskId: "task_2" });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.reusedTaskIds, ["task_1"]);
  assert.deepEqual(preview.rerunTaskIds, stopped ? ["task_2"] : ["task_2", "task_3"]);
  assert.deepEqual(preview.invalidatedTaskIds, stopped ? [] : ["task_3"]);
  await reopenedEngine.start({ id: recovered.id, revision: recovered.revision, retryFromTaskId: "task_2", recoveryFingerprint: preview.fingerprint }, true);
  const done = await reopenedEngine.wait(recovered.id);
  assert.equal(done.execution, "completed", done.error);
  assert.deepEqual(done.result, [loopValues[0], loopValues[1], branchValue, loopValues[2]]);
  assert.deepEqual(done.tasks.map(task => task.prompt), [loopPrompt, loopPrompt, branchPrompt, loopPrompt]);
  assert.deepEqual(done.tasks.map(task => task.label), ["重复节点", "重复节点", "重复节点", "重复节点"]);
  assert.deepEqual(done.tasks.map(task => task.cached), [true, false, false, false]);
  assert.deepEqual(done.tasks[0]?.attempts, prefixAttempts);
  assert.equal(done.tasks[1]?.attempts.length, 2);
  assert.deepEqual(done.tasks[1]?.attempts[0], failedAttempt);
  assert.equal(done.tasks[1]?.attempts[1]?.status, "completed");
  assert.equal(done.nodeCheckpoint?.completedTasks, 4);
  const reopenedCalls = f.calls.filter(call => call.owner === "reopened");
  assert.deepEqual(reopenedCalls.map(call => [call.prompt, call.iteration, call.kind]), [[loopPrompt, 1, "loop"], [branchPrompt, 1, "branch"], [loopPrompt, 2, "loop"]]);
  assert.equal(f.calls.filter(call => call.kind === "loop" && call.iteration === 0).length, 1);
  assert.equal(f.calls.filter(call => call.kind === "loop" && call.iteration === 1).length, 2);
  assert.equal(f.calls.filter(call => call.kind === "loop" && call.iteration === 2).length, stopped ? 1 : 2);
  if (!stopped) {
    assert.equal(done.tasks[2]?.attempts.length, 2, "A new branch at the old later-iteration position retains both attempts");
    assert.deepEqual(done.tasks[2]?.attempts[0]?.output, loopValues[2]);
    assert.deepEqual(done.tasks[2]?.attempts[1]?.output, branchValue);
    const checkpointStore = new CheckpointStore(new RunStore(f.state));
    const history = await checkpointStore.listTaskHistory(done.id, { taskId: "task_3" });
    assert.equal(history.total, 1, "The replaced later iteration must remain inspectable after the branch changes launch positions");
    const archived = await checkpointStore.readTaskHistory(done.id, history.history[0]!.id);
    assert.equal(archived.prompt, loopPrompt);
    assert.deepEqual(archived.output, loopValues[2]);
    assert.equal(archived.attempts.length, 1);
  }
  const persisted = await new RunStore(f.state).load(done.id);
  assert.deepEqual(persisted.result, done.result);
  assert.deepEqual((await readFile(f.ledger, "utf8")).trim().split("\n").map(line => JSON.parse(line)), f.calls);
  assert.equal(await readFile(path.join(f.project, "input.json"), "utf8"), f.input);
  assert.equal(await readFile(path.join(f.project, "notes.txt"), "utf8"), "preserve the original user notes\n");
});
