import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { FlowBlock } from "../src/control-flow.ts";

const source = (body: string) => 'export const meta={name:"flow-engine-fixture",description:"Only observe or modify this disposable fixture"};\n' + body;
const flatten = (blocks: FlowBlock[]): FlowBlock[] => blocks.flatMap(block => [block, ...flatten(block.yes ?? []), ...flatten(block.no ?? []), ...flatten(block.body ?? [])]);
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-flow-engine-"))), project = path.join(root, "project");
  await mkdir(project); await writeFile(path.join(project, "notes.txt"), "preserve notes\n");
  const calls: string[] = [];
  const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter: {
    run: async request => {
      const prompt = request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8); calls.push(prompt);
      return { output: prompt, threadId: "flow-fixture", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    }, close: async () => {},
  } });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { engine, project, calls };
}

test("persisted flow observations bind exact task callsites and are renewed on checkpoint replay", async t => {
  const f = await fixture(t);
  const draft = await f.engine.preview({ projectPath: f.project, allowWrite: true, workspaceMode: "local", args: { update: false }, script: source(`
await agent("probe", {label:"环境预检"});
// @flow-label: 远端有新提交？
if(args.update) await agent("pull",{label:"拉取代码"}); else await agent("current",{label:"使用当前代码"});
// @flow-label: 验证与修复
for(let i=0;i<3;i++) {
  await agent("test",{label:"执行测试"});
  if(i<1) await agent("repair",{label:"修复",mode:"write"}); else break;
}
throw new Error("Manual decision");`) });
  assert.ok(draft.flowPlan?.blocks.length); assert.deepEqual(draft.flowEvents, []);
  await f.engine.start({ id: draft.id, revision: draft.revision }); const first = await f.engine.wait(draft.id);
  assert.equal(first.error, "Manual decision"); assert.ok(first.flowExecutionId);
  assert.deepEqual(f.calls, ["probe", "current", "test", "repair", "test"]);
  assert.ok(first.tasks.every(task => task.flowNodeId && task.flowExecutionId === first.flowExecutionId));
  assert.equal(first.tasks[2]?.flowNodeId, first.tasks[4]?.flowNodeId, "Loop iterations share the static callsite, not task identity.");
  assert.notEqual(first.tasks[2]?.id, first.tasks[4]?.id);
  const blocks = flatten(first.flowPlan!.blocks), loop = blocks.find(block => block.kind === "loop")!;
  assert.equal(loop.maxIterations, 3);
  assert.deepEqual(first.flowEvents?.filter(event => event.kind === "iteration" && event.nodeId === loop.id).map(event => event.kind === "iteration" ? event.iteration : undefined), [1, 2]);
  const branch = blocks.find(block => block.kind === "condition")!;
  assert.ok(first.flowEvents?.some(event => event.nodeId === branch.id && event.kind === "condition" && event.value === false));
  const savedBefore = await readFile(path.join(f.engine.store.directory(first.id), "run.json"), "utf8");
  assert.equal(JSON.parse(savedBefore).flowExecutionId, first.flowExecutionId);
  const recovery = await f.engine.previewRecovery({ id: first.id, revision: first.revision }); assert.equal(recovery.canResume, true);
  await f.engine.start({ id: first.id, revision: first.revision, recoveryFingerprint: recovery.fingerprint }, true);
  const replayed = await f.engine.wait(first.id);
  assert.equal(replayed.error, "Manual decision"); assert.notEqual(replayed.flowExecutionId, first.flowExecutionId);
  assert.deepEqual(f.calls, ["probe", "current", "test", "repair", "test"]);
  assert.ok(replayed.tasks.every(task => task.cached && task.flowExecutionId === replayed.flowExecutionId && task.attempts.length === 1));
  assert.deepEqual(replayed.flowEvents?.map(({ at: _at, ...event }) => event), first.flowEvents?.map(({ at: _at, ...event }) => event));
  assert.equal(await readFile(path.join(f.project, "notes.txt"), "utf8"), "preserve notes\n");
});

test("bounded flow trace does not stop a valid long control loop or consume the agent budget", async t => {
  const f = await fixture(t);
  const draft = await f.engine.preview({ projectPath: f.project, limits: { maxCalls: 1 }, script: source('for(let i=0;i<6000;i++){if(i%2){}} return await agent("after trace");') });
  await f.engine.start({ id: draft.id, revision: draft.revision }); const result = await f.engine.wait(draft.id);
  assert.equal(result.execution, "completed", result.error); assert.equal(result.result, "after trace");
  assert.equal(result.flowTraceTruncated, true); assert.ok((result.flowEvents?.length ?? 0) <= 2000);
  assert.deepEqual(f.calls, ["after trace"]); assert.equal(result.tasks.length, 1);
});

test("unmapped alias calls still belong to the current execution instead of appearing as old history", async t => {
  const f = await fixture(t), draft = await f.engine.preview({ projectPath: f.project, script: source('const run=agent; return await run("dynamic alias");') });
  await f.engine.start({ id: draft.id, revision: draft.revision }); const result = await f.engine.wait(draft.id);
  assert.equal(result.execution, "completed", result.error);
  assert.equal(result.tasks[0]?.flowNodeId, undefined); assert.equal(result.tasks[0]?.flowExecutionId, result.flowExecutionId);
  assert.ok(result.flowPlan?.warnings.length);
});
