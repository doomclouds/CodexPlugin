import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeScript } from "../src/script.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { nodeProcess } from "../src/node-process.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";

const schema = { type: "object", properties: { status: { type: "string" }, error: { type: "string" } }, required: ["status", "error"], additionalProperties: false };
const accept = { type: "object", properties: { status: { const: "passed" } }, required: ["status"] };
const metadata = 'export const meta={name:"task-contract",description:"Verify task results",phases:[{title:"Verify"},{title:"Cleanup"}]};';

async function fixture(t: test.TestContext, result: (request: WorkerRequest) => unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-task-contract-")), project = path.join(root, "project");
  await mkdir(project);
  let calls = 0;
  const adapter: WorkerAdapter = {
    async run(request) { calls++; const data = result(request); return { data, output: JSON.stringify(data), threadId: `fixture-${calls}`, turnId: `turn-${calls}`, toolsUsed: ["native:commandExecution"], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 }; },
    async close() {},
  };
  const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const execute = async (script: string) => { const draft = await engine.preview({ projectPath: project, script: metadata + script }); await engine.start({ id: draft.id, revision: draft.revision }); return engine.wait(draft.id); };
  return { engine, execute, calls: () => calls };
}

test("a host failure keeps its exact identity through script catch, cleanup and rethrow", async () => {
  const original = new Error("Actual task failure");
  let cleanup = false;
  await assert.rejects(executeScript(`${metadata} let failure; try { await agent("verify"); } catch(error) { failure=error; } finally { phase("Cleanup"); await agent("cleanup"); } throw failure;`, {}, {
    agent: async prompt => { if (prompt === "verify") throw original; cleanup = true; return "done"; }, phase() {}, log() {},
  }, new AbortController().signal), error => error === original);
  assert.equal(cleanup, true);
});

test("a new script error never acquires the identity of a previously handled host failure", async () => {
  const original = new Error("Handled failure");
  await assert.rejects(executeScript(`${metadata} try { await agent("verify"); } catch {} throw new Error("Independent script failure");`, {}, {
    agent: async () => { throw original; }, phase() {}, log() {},
  }, new AbortController().signal), error => error !== original && error instanceof Error && error.message === "Independent script failure");
});

test("the opaque host failure identity does not leak into serialized business error data", async () => {
  const result = await executeScript(`${metadata} try { await agent("verify"); } catch(error) { return {text:String(error),json:JSON.stringify(error),keys:Object.keys(error)}; }`, {}, {
    agent: async () => { throw new Error("tool failure"); }, phase() {}, log() {},
  }, new AbortController().signal);
  assert.deepEqual(result, { text: "Error: tool failure", json: '{"message":"tool failure"}', keys: ["message"] });
});

test("an explicit acceptance contract marks the source task failed even after cleanup completes", async t => {
  const f = await fixture(t, request => request.id.startsWith("task_1_") ? { status: "failed", error: "tool exit 7" } : { status: "passed", error: "" });
  const run = await f.execute(`let failure; try { phase("Verify"); await agent("verify",{schema:${JSON.stringify(schema)},accept:${JSON.stringify(accept)}}); } catch(error) { failure=error; } finally { phase("Cleanup"); await agent("cleanup",{schema:${JSON.stringify(schema)}}); } if(failure) throw failure;`);
  assert.equal(run.execution, "failed");
  assert.equal(run.tasks[0]?.status, "failed"); assert.equal(run.tasks[1]?.status, "completed");
  assert.deepEqual(run.tasks[0]?.output, { status: "failed", error: "tool exit 7" });
  assert.deepEqual(run.tasks[0]?.attempts[0]?.toolsUsed, ["native:commandExecution"]);
  assert.deepEqual(run.failureContext, { kind: "task", taskId: "task_1", attemptId: "task_1_attempt_1", phase: "Verify" });
  assert.equal(nodeProcess(run, { phase: "Verify" }).status, "failed");
  assert.equal(nodeProcess(run, { phase: "Cleanup" }).status, "completed");
});

test("a business status remains ordinary data without an explicit acceptance contract", async t => {
  const f = await fixture(t, () => ({ status: "failed", error: "expected branch data" }));
  const run = await f.execute(`return await agent("inspect",{schema:${JSON.stringify(schema)}});`);
  assert.equal(run.execution, "completed"); assert.equal(run.tasks[0]?.status, "completed");
  assert.deepEqual(run.result, { status: "failed", error: "expected branch data" });
});

test("invalid output and invalid contracts cannot become successful task results", async t => {
  const f = await fixture(t, () => ({ status: "passed" }));
  const invalidOutput = await f.execute(`return await agent("inspect",{schema:${JSON.stringify(schema)}});`);
  assert.equal(invalidOutput.execution, "failed"); assert.equal(invalidOutput.tasks[0]?.status, "failed");
  assert.match(invalidOutput.error!, /schema validation failed/);
  const before = f.calls();
  const invalidContract = await f.execute('phase("Verify"); return await agent("inspect",{schema:{type:"object"},accept:{$ref:"https://example.test/schema"}});');
  assert.equal(invalidContract.execution, "failed"); assert.equal(f.calls(), before);
  assert.equal(nodeProcess(invalidContract, { phase: "Verify" }).status, "failed");
});

test("parallel workers share the current observed recovery budget without double counting usage", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-shared-recovery-budget-")), project = path.join(root, "project");
  await mkdir(project);
  const requests: WorkerRequest[] = [];
  let release!: () => void;
  const paired = new Promise<void>(resolve => { release = resolve; });
  const adapter: WorkerAdapter = {
    async run(request, _signal, onEvent) {
      requests.push(request); if (requests.length === 2) release();
      await paired;
      onEvent({ type: "usage", inputTokens: 3, outputTokens: 3, totalTokens: 6 });
      return { data: { status: "passed", error: "" }, output: "verified", threadId: request.id, turnId: "turn", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 }, durationMs: 1 };
    }, async close() {},
  };
  const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  t.after(async () => { release(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const script = `${metadata} return await parallel([()=>agent("first",{schema:${JSON.stringify(schema)}}),()=>agent("second",{schema:${JSON.stringify(schema)}})]);`;
  const draft = await engine.preview({ projectPath: project, script, limits: { maxReadWorkers: 2, maxTokens: 10 } });
  await engine.start({ id: draft.id, revision: draft.revision });
  const result = await engine.wait(draft.id);
  assert.equal(result.execution, "completed", result.error); assert.equal(requests.length, 2);
  assert.equal(requests[0]?.recoveryBudget, requests[1]?.recoveryBudget);
  assert.equal(requests[0]?.recoveryBudget?.remainingTokens, 0);
  assert.deepEqual(result.tasks.map(task => task.attempts[0]?.usage?.totalTokens), [6, 6]);
});
