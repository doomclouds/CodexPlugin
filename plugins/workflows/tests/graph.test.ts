import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowGraph, renderWorkflowGraph } from "../prototypes/panel-graph.ts";
import type { GraphTask, WorkflowGraphInput } from "../prototypes/panel-graph.ts";
import type { WorkflowTask } from "../prototypes/panel.ts";

function run(overrides: Partial<WorkflowGraphInput> = {}): WorkflowGraphInput {
  return { meta: { name: "review", description: "Review", phases: [{ title: "审查" }, { title: "汇总" }] }, execution: "draft", tasks: [], logs: [], ...overrides };
}
function task(id: string, overrides: Partial<GraphTask> = {}): GraphTask {
  return { id, index: Number(id.slice(-1)) - 1, prompt: `Review ${id}`, options: {}, phase: "审查", mode: "read", status: "queued", cached: false, attempts: [], ...overrides };
}
const at = (seconds: number): string => `2026-10-14T00:00:${String(seconds).padStart(2, "0")}Z`;

test("draft graph shows declared phases without fabricating future worker nodes", () => {
  const graph = buildWorkflowGraph(run());
  assert.deepEqual(graph.phases.map(phase => [phase.title, phase.status, phase.groups.length]), [["审查", "planned", 0], ["汇总", "planned", 0]]);
  assert.equal(graph.taskCount, 0);
  const html = renderWorkflowGraph(run());
  assert.equal(html.includes("data-task="), false);
  assert.match(html, /任务将在实际派发后显示/);
  assert.match(html, /连线表示阶段展示顺序/);
  assert.match(renderWorkflowGraph(), /选择工作流并保存预览/);
});

test("actual task transitions remain visible across stop, failure, retry and result reuse", () => {
  for (const status of ["queued", "running", "stopping", "interrupted", "failed", "completed"] as const) {
    const current = run({ execution: status === "stopping" ? "stopping" : status === "interrupted" ? "stopped" : "running", tasks: [task("task-1", { status })] });
    assert.equal(buildWorkflowGraph(current).phases[0]?.status, status);
    assert.match(renderWorkflowGraph(current, "task-1"), new RegExp(`data-task="task-1" data-status="${status}"`));
    assert.match(renderWorkflowGraph(current, "task-1"), /is-selected/);
  }
  const cached = renderWorkflowGraph(run({ execution: "completed", tasks: [task("task-1", { status: "completed", cached: true })] }));
  assert.match(cached, /is-cached/);
  assert.match(cached, /已复用结果/);
});

test("concurrency groups require real overlapping latest attempts, not adjacent dispatch or queued tasks", () => {
  const tasks = [
    task("task-1", { status: "completed", attempts: [{ id: "a1", status: "completed", startedAt: at(0), endedAt: at(10) }] }),
    task("task-2", { status: "running", attempts: [{ id: "a2", status: "running", startedAt: at(5) }] }),
    task("task-3"),
  ];
  const groups = buildWorkflowGraph(run({ execution: "running", tasks })).phases[0]!.groups;
  assert.deepEqual(groups.map(group => [group.concurrent, group.tasks.map(value => value.id)]), [[true, ["task-1", "task-2"]], [false, ["task-3"]]]);
  assert.equal(groups[0]?.live, true);
  assert.match(renderWorkflowGraph(run({ execution: "running", tasks })), /并行任务组 · 2 个任务/);
  const serial = [tasks[0]!, task("task-2", { status: "completed", attempts: [{ id: "a2", status: "completed", startedAt: at(10), endedAt: at(20) }] })];
  assert.equal(buildWorkflowGraph(run({ tasks: serial })).phases[0]!.groups.every(group => !group.concurrent), true);
  const retry = task("task-2", { attempts: [{ id: "old", status: "completed", startedAt: at(5), endedAt: at(9) }, { id: "new", status: "queued" }] });
  assert.equal(buildWorkflowGraph(run({ tasks: [tasks[0]!, retry] })).phases[0]!.groups.every(group => !group.concurrent), true);
});

test("dynamic and unphased tasks appear only when dispatched and are not assigned an invented phase", () => {
  const unphased = task("task-2");
  delete unphased.phase;
  const current = run({ execution: "running", tasks: [task("task-1", { phase: "动态核实", status: "running" }), unphased] });
  const graph = buildWorkflowGraph(current);
  assert.deepEqual(graph.phases.map(phase => phase.title), ["审查", "汇总", "动态核实", "未分阶段的任务"]);
  assert.deepEqual(graph.phases.map(phase => phase.groups.flatMap(group => group.tasks.map(value => value.id))), [[], [], ["task-1"], ["task-2"]]);
  const html = renderWorkflowGraph(current);
  assert.equal((html.match(/data-task=/g) ?? []).length, 2);
});

test("phase log text does not invent task completion and empty workflow nodes follow actual run state", () => {
  const logs = [{ at: at(0), level: "info" as const, message: "Phase: 审查" }];
  assert.equal(buildWorkflowGraph(run({ execution: "running", logs })).phases[0]?.status, "planned");
  assert.deepEqual(buildWorkflowGraph(run({ execution: "completed", logs })).phases.map(phase => phase.status), ["skipped", "skipped"]);
  for (const execution of ["draft", "running", "stopping", "stopped", "completed", "failed"] as const) {
    const current = run({ meta: { name: "dynamic", description: "" }, execution });
    const graph = buildWorkflowGraph(current);
    assert.equal(graph.phases[0]?.kind, "workflow");
    assert.equal(graph.phases[0]?.status, execution === "draft" ? "planned" : execution);
    assert.equal(graph.taskCount, 0);
    assert.equal(renderWorkflowGraph(current).includes("data-task="), false);
  }
  assert.match(renderWorkflowGraph(run({ meta: { name: "dynamic", description: "" } })), /启动后展示动态任务/);
});

test("task titles, phase names, run names and task identifiers cannot inject graph markup", () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const html = renderWorkflowGraph(run({ meta: { name: malicious, description: "", phases: [malicious] }, tasks: [task('task-1" onclick="evil', { phase: malicious, label: malicious })] }));
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes('data-task="task-1" onclick='), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-task="task-1&quot; onclick=&quot;evil"/);
  const invalidStatus = task("task-1");
  invalidStatus.status = 'running" onclick="evil' as WorkflowTask["status"];
  const unknown = renderWorkflowGraph(run({ tasks: [invalidStatus] }));
  assert.match(unknown, /data-status="unknown"/);
  assert.match(unknown, /状态未知/);
  assert.equal(unknown.includes("onclick"), false);
  const unknownRun = renderWorkflowGraph(run({ meta: { name: "dynamic", description: "" }, execution: 'running" onclick="evil' as WorkflowGraphInput["execution"] }));
  assert.match(unknownRun, /data-status="unknown"/);
  assert.equal(unknownRun.includes("onclick"), false);
});

test("settings affordances use declared phase or stable task index keys without replacing task details", () => {
  const current = run({ tasks: [task("task-1"), task("task-2", { phase: "动态阶段" })] });
  const html = renderWorkflowGraph(current, "task-1");
  assert.match(html, /data-node-settings="phase:审查"/);
  assert.match(html, /data-node-settings="phase:汇总"/);
  assert.equal(html.includes('data-node-settings="phase:动态阶段"'), false);
  assert.match(html, /data-node-settings="task:0"/);
  assert.match(html, /data-node-settings="task:1"/);
  assert.match(html, /data-task="task-1"/);
  assert.match(html, /<\/button><button type="button" class="wf-node-settings-icon"/);
  assert.equal(/<button\b[^>]*>[\s\S]*?<button\b/.test(html.slice(html.indexOf('data-task="task-1"'), html.indexOf('data-node-settings="task:0"'))), false);
  assert.match(html, /data-icon="settings"/);
});

test("node settings keys escape phase names and cannot change running or stopping invocations", () => {
  const title = 'phase" onclick="evil <script>';
  const current = run({ meta: { name: "review", description: "", phases: [{ title }] }, tasks: [task("task-1", { phase: title })] });
  const html = renderWorkflowGraph(current);
  assert.match(html, /data-node-settings="phase:phase&quot; onclick=&quot;evil &lt;script&gt;"/);
  assert.equal(html.includes('<script>'), false);
  for (const execution of ["running", "stopping"] as const) {
    const active = renderWorkflowGraph({ ...current, execution });
    const buttons = active.match(/<button[^>]*data-node-settings=[^>]*>/g) ?? [];
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every(button => button.includes(" disabled")));
    assert.match(active, /data-task="task-1"/);
  }
});

test("node configuration labels use real snapshot and override values without claiming parent model inheritance", () => {
  const empty = renderWorkflowGraph(run());
  assert.match(empty, /默认配置/);
  assert.equal(empty.includes("主对话"), false);
  assert.equal(empty.includes("已确认配置"), false);
  const current = run({
    executionSettings: { model: "workflow-model", reasoningEffort: "workflow-effort" },
    nodeSettings: { "phase:审查": { model: "phase-model" }, "task:0": { reasoningEffort: "node-effort" } },
    tasks: [task("task-1", { options: { model: "script-model", reasoningEffort: "script-effort" } })],
  });
  const html = renderWorkflowGraph(current);
  assert.match(html, /计划配置：phase-model · node-effort/);
  assert.match(html, /计划配置：workflow-model · workflow-effort/);
  assert.equal(html.includes("已确认配置"), false);
});

test("recorded worker settings retain provenance and are not relabelled using future overrides", () => {
  const current = run({
    execution: "stopped", executionSettings: { model: "future-default", reasoningEffort: "future-effort" },
    nodeSettings: { "task:0": { model: "future-node" } },
    tasks: [task("task-1", {
      status: "interrupted", executionSettings: { model: "requested-model", source: "task", provenance: "requested" },
      attempts: [{ id: "attempt-1", status: "interrupted", executionSettings: { model: "confirmed-model", reasoningEffort: "confirmed-effort", source: "task", provenance: "configured" } }],
    })],
  });
  const html = renderWorkflowGraph(current);
  assert.match(html, /已确认配置：confirmed-model · confirmed-effort/);
  const primary = html.slice(html.indexOf('data-task="task-1"'), html.indexOf('data-node-settings="task:0"'));
  assert.equal(primary.includes("future-node"), false);
  assert.equal(primary.includes("requested-model"), false);
  const runtime = renderWorkflowGraph(run({ tasks: [task("task-1", { executionSettings: { model: "rerouted-model", reasoningEffort: "configured-effort", source: "codex-config", provenance: "runtime" } })] }));
  assert.match(runtime, /运行模型：rerouted-model · 思考配置：configured-effort/);
  const requested = renderWorkflowGraph(run({ tasks: [task("task-1", { executionSettings: { model: "requested-model", source: "script", provenance: "requested" } })] }));
  assert.match(requested, /计划配置：requested-model · 默认深度/);
  assert.equal(requested.includes("已确认配置"), false);
});

test("returned model and effort names escape markup and are never interpreted as icon or HTML sources", () => {
  const malicious = '<img src=x onerror="evil()">';
  const html = renderWorkflowGraph(run({ executionSettings: { model: malicious, reasoningEffort: malicious }, tasks: [task("task-1")] }));
  assert.equal(html.includes("<img"), false);
  assert.match(html, /计划配置：&lt;img/);
  assert.match(html, /&quot;evil\(\)&quot;/);
});

test("fixed command tasks expose their status and details without advertising unused model settings", () => {
  const current = run({ executionSettings: { model: "workflow-model", reasoningEffort: "workflow-effort" }, nodeSettings: { "task:0": { model: "unused-override" } }, tasks: [task("task-1", { mode: "write", label: "安装依赖", options: { mode: "write", operation: { id: "install", command: ["npm", "ci"] } }, status: "completed" })] });
  const html = renderWorkflowGraph(current);
  const command = html.slice(html.indexOf('data-task="task-1"'), html.indexOf('</button>', html.indexOf('data-task="task-1"')));
  assert.match(command, /固定命令/);
  assert.match(command, /data-icon="settings"/);
  assert.equal(command.includes("wf-graph-node-model"), false);
  assert.equal(command.includes("workflow-model"), false);
  assert.equal(html.includes('data-node-settings="task:0"'), false);
  assert.match(command, /data-status="completed"/);
});
