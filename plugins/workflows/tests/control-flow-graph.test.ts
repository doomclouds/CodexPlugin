import test from "node:test";
import assert from "node:assert/strict";
import { buildControlFlowGraph, renderFlowObservation, renderWorkflowGraph } from "../prototypes/panel-graph.ts";
import type { WorkflowGraphInput, GraphTask } from "../prototypes/panel-graph.ts";
import type { FlowBlock, FlowEvent } from "../prototypes/panel.ts";

const at = "2026-10-15T10:00:00.000Z";
const taskBlock = (id: string): FlowBlock => ({ id, kind: "task", label: id });
const condition: FlowBlock = { id: "choice", kind: "condition", label: "需要更新？", yes: [taskBlock("update")], no: [taskBlock("current")] };
const loop: FlowBlock = { id: "retry", kind: "loop", label: "验证与修复", body: [taskBlock("test"), { id: "passed", kind: "condition", label: "测试通过？", yes: [taskBlock("accept")], no: [taskBlock("repair")] }] };
function run(blocks: FlowBlock[], changes: Partial<WorkflowGraphInput> = {}): WorkflowGraphInput {
  return { meta: { name: "fixture", description: "Control-flow presentation" }, execution: "running", flowExecutionId: "execution-current", flowPlan: { version: 1, blocks, warnings: [], truncated: false }, flowEvents: [], tasks: [], logs: [], ...changes };
}
function task(id: string, nodeId: string, changes: Partial<GraphTask> = {}): GraphTask {
  return { id, index: 0, prompt: "PRIVATE", options: {}, flowNodeId: nodeId, flowExecutionId: "execution-current", label: nodeId, mode: "read", status: "completed", cached: false, attempts: [], ...changes };
}
function decision(nodeId: string, value: boolean, sequence = 1): FlowEvent { return { nodeId, kind: "condition", value, sequence, at }; }

test("an unexecuted condition keeps both routes planned and does not infer a skipped branch", () => {
  const graph = buildControlFlowGraph(run([condition], { execution: "draft" }));
  assert.ok(graph.nodes.every(node => node.status === "planned"));
  assert.ok(graph.edges.every(edge => edge.state === "planned"));
  const html = renderWorkflowGraph(run([condition], { execution: "draft" }));
  assert.match(html, /wf-flow-diamond/);
  assert.match(html, /等待实际判断/);
  assert.match(html, /当前仅展示计划结构/);
  assert.doesNotMatch(html, /data-status="skipped"/);
  assert.doesNotMatch(html, /is-selected/, "Absent task selection must not select every planned node.");
});

test("a real condition decision highlights exactly its selected route and leaves the other branch unentered", () => {
  for (const value of [true, false]) {
    const graph = buildControlFlowGraph(run([condition], { flowEvents: [decision("choice", value)], tasks: [task("task_1", value ? "update" : "current")] }));
    assert.equal(graph.nodes.find(node => node.block.id === (value ? "current" : "update"))?.status, "skipped");
    assert.equal(graph.nodes.find(node => node.block.id === (value ? "update" : "current"))?.status, "completed");
    assert.deepEqual(graph.edges.filter(edge => edge.label === "是" || edge.label === "否").map(edge => [edge.label, edge.state]), [["是", value ? "active" : "inactive"], ["否", value ? "inactive" : "active"]]);
    assert.equal(graph.joins.length, 1);
  }
});

test("loop badges use observed rounds and only show a maximum when the plan actually provides it", () => {
  const events: FlowEvent[] = [1, 2].map((iteration, index) => ({ nodeId: "retry", kind: "iteration", iteration, sequence: index + 1, at }));
  const html = renderWorkflowGraph(run([loop], { flowEvents: events }));
  assert.match(html, /第 2 轮/);
  assert.match(html, /按脚本条件结束/);
  assert.match(html, /data-loop-back="true"/);
  assert.doesNotMatch(html, /最多 3|2 \/ 3|第 3 轮/);
  const bounded = renderWorkflowGraph(run([{ ...loop, maxIterations: 3 }], { flowEvents: events }));
  assert.match(bounded, /第 2 \/ 3 轮/);
  assert.match(bounded, /最多 3 轮/);
});

test("a fresh recovery never colors retained results as current progress before replay has dispatched them", () => {
  const previous = task("task_1", "update", { flowExecutionId: "execution-previous" });
  const current = run([condition], { tasks: [previous] });
  const graph = buildControlFlowGraph(current);
  assert.ok(graph.nodes.every(node => node.status === "planned"));
  assert.deepEqual(graph.historicalTasks.map(task => task.id), ["task_1"]);
  assert.match(renderWorkflowGraph(current), /历史任务 · 1 项，不代表本轮进度/);
  const replayed = renderWorkflowGraph(run([condition], { flowEvents: [decision("choice", true)], tasks: [{ ...previous, flowExecutionId: "execution-current", cached: true }] }));
  assert.match(replayed, /已复用结果/);
  assert.doesNotMatch(replayed, /历史任务 ·/);
});

test("a derived plan on an old run exposes historical tasks without fabricating execution decisions", () => {
  const current = run([condition], { tasks: [task("task_1", "update")], execution: "completed" });
  delete current.flowExecutionId;
  const graph = buildControlFlowGraph(current);
  assert.ok(graph.nodes.every(node => node.status === "planned"));
  assert.equal(graph.traceAvailable, false);
  assert.equal(graph.historicalTasks.length, 1);
});

test("repeated source calls remain individually selectable and the latest branch decision does not erase prior history", () => {
  const current = run([condition], { flowEvents: [decision("choice", true, 1), decision("choice", false, 2)], tasks: [task("task_1", "update"), task("task_2", "update", { index: 1 }), task("task_3", "current", { index: 2, status: "running" })] });
  const graph = buildControlFlowGraph(current);
  assert.equal(graph.nodes.find(node => node.block.id === "update")?.excluded, true);
  const html = renderWorkflowGraph(current, "task_3");
  assert.match(html, /最近判断未进入 · 保留历史调用/);
  assert.match(html, /2 次实际调用/);
  for (const id of ["task_1", "task_2", "task_3"]) assert.match(html, new RegExp(`data-task="${id}"`));
  assert.match(html, /is-selected/);
});

test("parallel lanes and opaque source regions retain every real task through a visible fallback", () => {
  const blocks: FlowBlock[] = [{ id: "fork", kind: "parallel", label: "独立检查", body: [taskBlock("left"), taskBlock("right")] }, { id: "dynamic", kind: "opaque", label: "动态处理", body: [taskBlock("nested")] }];
  const current = run(blocks, { tasks: [task("task_1", "left"), task("task_2", "right"), task("task_3", "nested"), task("task_4", "unknown")] });
  const graph = buildControlFlowGraph(current);
  assert.equal(graph.groups[0]?.parallel, true);
  assert.equal(graph.joins.length, 2);
  assert.deepEqual(graph.unmappedTasks.map(task => task.id), ["task_3", "task_4"]);
  const html = renderWorkflowGraph(current);
  assert.match(html, /其他实际任务/);
  assert.match(html, /各路独立执行后汇合/);
  assert.doesNotMatch(html, /PRIVATE/);
});

test("bad or overly deep plans remain bounded while unmapped real tasks are still accessible", () => {
  let nested: FlowBlock = taskBlock("bottom");
  for (let index = 0; index < 40; index++) nested = { id: `loop-${index}`, kind: "loop", label: "nested", body: [nested] };
  const graph = buildControlFlowGraph(run([nested], { tasks: [task("task_1", "bottom")], flowTraceTruncated: true }));
  assert.ok(graph.nodes.length + graph.groups.length <= 200);
  assert.equal(graph.unmappedTasks.length, 1);
  assert.ok(graph.warnings.some(warning => warning.includes("嵌套层级")));
  assert.ok(graph.warnings.some(warning => warning.includes("路径记录已截断")));
  for (const node of [...graph.nodes, ...graph.groups]) for (const value of [node.x, node.y, node.width, node.height]) assert.ok(Number.isFinite(value) && value >= 0);
});

test("flow labels, source IDs and warnings are escaped rather than interpreted as HTML or attributes", () => {
  const malicious = '<img src=x onerror="evil()">';
  const current = run([{ id: malicious, kind: "task", label: malicious }]);
  current.flowPlan!.warnings = [malicious];
  const html = renderWorkflowGraph(current);
  assert.doesNotMatch(html, /<img|onerror="evil/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-flow-inspect="&lt;img/);
});

test("condition and loop details show only actual events and do not initiate worker actions", () => {
  const current = run([loop], { flowEvents: [{ nodeId: "retry", kind: "iteration", iteration: 2, sequence: 1, at }, decision("passed", false, 2)] });
  assert.match(renderFlowObservation(current, "retry")!.html, /进入第 2 轮/);
  assert.match(renderFlowObservation(current, "passed")!.html, /条件判断：否/);
  assert.match(renderFlowObservation(current, "repair")!.html, /尚无本轮执行记录/);
  assert.equal(renderFlowObservation(current, "missing"), undefined);
  assert.doesNotMatch(renderFlowObservation(current, "retry")!.html, /data-action|data-task|wf-retry/);
});

test("return and throw branches do not visually merge into subsequent tasks", () => {
  const blocks: FlowBlock[] = [{ ...condition, yes: [{ id: "return", kind: "opaque", label: "返回结果", terminal: "return" }], no: [{ id: "throw", kind: "opaque", label: "抛出异常", terminal: "throw" }] }, taskBlock("after")];
  const graph = buildControlFlowGraph(run(blocks));
  const after = graph.nodes.find(node => node.block.id === "after")!;
  assert.equal(graph.joins.length, 0);
  assert.ok(graph.edges.every(edge => !edge.points.some(([x, y]) => x === after.x + after.width / 2 && y === after.y)));
  assert.match(renderWorkflowGraph(run(blocks)), /控制流指令 · 不代表执行成功/);
});

test("break and continue route to their closest loop boundary and do not imply successful worker completion", () => {
  for (const terminal of ["break", "continue"] as const) {
    const blocks: FlowBlock[] = [{ ...loop, body: [{ id: "terminal", kind: "opaque", label: terminal, terminal }] }];
    const graph = buildControlFlowGraph(run(blocks));
    assert.equal(graph.edges.filter(edge => edge.label === (terminal === "break" ? "退出循环" : "继续下一轮")).length, 1);
    assert.equal(graph.edges.some(edge => edge.label === "下一轮"), false);
    assert.equal(graph.nodes.find(node => node.block.id === "terminal")?.status, "planned");
  }
});

test("truncated traces preserve historical observations without claiming a current branch or loop round", () => {
  const current = run([condition, loop], { flowTraceTruncated: true, flowEvents: [decision("choice", false), { nodeId: "retry", kind: "iteration", iteration: 2, sequence: 2, at }], tasks: [task("task_1", "update", { status: "running" })] });
  const graph = buildControlFlowGraph(current);
  assert.equal(graph.nodes.find(node => node.block.id === "choice")?.condition, undefined);
  assert.equal(graph.nodes.find(node => node.block.id === "update")?.status, "running");
  assert.equal(graph.nodes.some(node => node.excluded), false);
  assert.ok(graph.edges.filter(edge => edge.label === "是" || edge.label === "否" || edge.back).every(edge => edge.state === "planned"));
  const html = renderWorkflowGraph(current);
  assert.match(html, /已记录至第 2 轮 · 后续未记录/);
  assert.doesNotMatch(html, /最近判断未进入|aria-current="step"/);
  assert.match(renderFlowObservation(current, "choice")!.html, /条件判断：否/);
});

test("labeled exits keep their explicit target as text instead of guessing the nearest loop", () => {
  const labeled: FlowBlock = { id: "labeled", kind: "opaque", label: "继续外层", terminal: "continue", terminalLabel: "outer" };
  const current = run([{ ...loop, body: [labeled] }]);
  const graph = buildControlFlowGraph(current);
  assert.equal(graph.edges.some(edge => edge.label === "继续下一轮"), false);
  assert.match(renderWorkflowGraph(current), /继续至标签 outer · 跳转范围待确认/);
});

test("a completed pure control loop requires trustworthy observed iterations before showing completion", () => {
  const controlLoop: FlowBlock = { id: "count", kind: "loop", label: "计数", body: [] };
  const events: FlowEvent[] = [1, 2].map((iteration, index) => ({ nodeId: "count", kind: "iteration", iteration, sequence: index + 1, at }));
  const completed = run([controlLoop], { execution: "completed", flowEvents: events });
  assert.equal(buildControlFlowGraph(completed).groups[0]?.status, "completed");
  assert.equal(buildControlFlowGraph({ ...completed, flowTraceTruncated: true }).groups[0]?.status, "planned");
  assert.equal(buildControlFlowGraph({ ...completed, flowEvents: [] }).groups[0]?.status, "planned");
  assert.equal(buildControlFlowGraph(run([{ id: "empty-parallel", kind: "parallel", label: "并行", body: [] }], { execution: "completed" })).groups[0]?.status, "planned");
});
