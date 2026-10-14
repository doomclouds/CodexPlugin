import { projectFixtureResponse } from "./panel-project-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { deletionPreviewPayload, fullFailureDetails, renderDeletionPreview, renderNodeProcess } from "../prototypes/panel.ts";
import type { DeletionPreview, NodeProcess, WorkflowActivity } from "../prototypes/panel.ts";
import { elapsedLabel, renderWorkflowGraph } from "../prototypes/panel-graph.ts";

const activity: WorkflowActivity = { id: "activity-1", kind: "command", label: "正在运行测试", status: "running", startedAt: "2026-10-14T00:00:00Z" };
const process: NodeProcess = { id: "run", taskId: "task", label: "验证", status: "running", currentActivity: activity, activities: [activity], summary: "检查了 3 个文件", logs: [{ at: activity.startedAt, level: "info", message: "SECRET raw argv prompt workspace path" }] };
test("a node process shows concise real activity and elapsed time while excluding developer logs and raw details", () => {
  const html = renderNodeProcess({ ...process, activities: [{ ...activity, detail: "private full tool argument" }] }, Date.parse("2026-10-14T00:01:18Z"));
  assert.match(html, /正在运行测试/);
  assert.match(html, /01:18/);
  assert.match(html, /is-spinning/);
  assert.match(html, /检查了 3 个文件/);
  assert.doesNotMatch(html, /SECRET|raw argv|private full tool argument/);
});
test("errors and results stay visible and escape executable markup", () => {
  const html = renderNodeProcess({ ...process, error: '<img onerror="evil">', summary: "测试失败：断言不一致", activities: [{ ...activity, status: "failed" }] });
  assert.match(html, /测试失败/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-icon="alert-circle"/);
});
test("full failure diagnostics are collapsed, escaped and credential redacted", () => {
  const detail = "Result rejected\n\n" + "diagnostic ".repeat(600) + '<img src=x onerror="evil"> token=private-fixture';
  const html = fullFailureDetails(detail);
  assert.match(html, /<details class="wf-failure-details"><summary>完整错误<\/summary>/);
  assert.ok(html.includes("diagnostic ".repeat(600)));
  assert.doesNotMatch(html, /<img|private-fixture|<details[^>]* open/);
  assert.match(html, /&lt;img/);
});
const preview: DeletionPreview = { fingerprint: "verified", target: { kind: "run", id: "run", revision: 4 }, runs: [{ id: "run", revision: 4, name: "test", projectPath: "fixture" }], objects: [{ path: "owned-run", kind: "run", bytes: 1024, files: 5 }], totalBytes: 1024, totalFiles: 5, canDelete: false, blocked: [{ code: "ACTIVE_PROCESS", runId: "run", message: "执行器仍在运行，停止后重试" }] };
test("deletion previews disclose exact counts and blockers without advertising successful cleanup", () => {
  assert.deepEqual(deletionPreviewPayload({ preview }), preview);
  const html = renderDeletionPreview(preview);
  assert.match(html, /运行记录：1 条/);
  assert.match(html, /文件：5 个 · 1 KB/);
  assert.match(html, /执行器仍在运行/);
  assert.doesNotMatch(html, /删除成功/);
  assert.throws(() => deletionPreviewPayload({ preview: { canDelete: true } }), /删除清单/);
});
test("graph nodes show current action from actual telemetry and never fall back to a private prompt", () => {
  const html = renderWorkflowGraph({ meta: { name: "test", description: "", phases: ["验证"] }, execution: "running", logs: [], tasks: [{ id: "task", index: 0, prompt: "PRIVATE PROMPT", options: {}, phase: "验证", mode: "read", status: "running", cached: false, currentActivity: activity, attempts: [{ id: "attempt", status: "running", startedAt: activity.startedAt }] }] }, "task", Date.parse("2026-10-14T00:01:18Z"));
  assert.match(html, /正在运行测试/);
  assert.match(html, /任务 1/);
  assert.match(html, /01:18/);
  assert.match(html, /is-spinning/);
  assert.doesNotMatch(html, /PRIVATE PROMPT|<svg/);
});
test("elapsed labels ignore invalid historical timestamps and stop counting at real completion", () => {
  assert.equal(elapsedLabel("bad"), "");
  assert.equal(elapsedLabel(activity.startedAt, "2026-10-14T00:00:32Z", Date.parse("2026-10-14T00:05:00Z")), "00:32");
  assert.equal(elapsedLabel(activity.startedAt, undefined, Date.parse("2026-10-13T23:59:00Z")), "00:00");
});

test("progress polling cannot replace newer activity with an older response at the same run revision", async t => {
  const { WorkflowPanelController } = await import("../prototypes/panel.ts");
  const current = { id: "run", revision: 2, progressSequence: 5, createdAt: "", updatedAt: "", meta: { name: "test", description: "" }, script: "return args", args: {}, projectPath: "fixture", allowWrite: false, execution: "running" as const, review: "unavailable" as const, application: "none" as const, tasks: [], logs: [], limits: { maxReadWorkers: 1, maxCalls: 2, timeoutMs: 10000, maxTokens: 0 } };
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse(current.projectPath);
    if (name === "workflow_list_runs") return { structuredContent: { runs: [{ ...current, progressSequence: 1 }] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Unavailable in fixture" }] };
    return { structuredContent: { run: current } };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  panel.receive({ structuredContent: { run: current } });
  await panel.refresh();
  assert.equal(panel.selected?.progressSequence, 5);
  panel.receive({ structuredContent: { run: { ...current, progressSequence: 3 } } });
  assert.equal(panel.selected?.progressSequence, 5);
});

test("pending cleanup records cannot restart, mutate their draft or apply retained changes", async t => {
  const { WorkflowPanelController, canApply } = await import("../prototypes/panel.ts");
  const run = { id: "pending", revision: 4, deletionPending: true, deletionTarget: { kind: "run" as const, id: "pending", revision: 4 }, createdAt: "", updatedAt: "", meta: { name: "test", description: "" }, script: "return args", args: {}, projectPath: "fixture", allowWrite: false, execution: "stopped" as const, review: "ready" as const, application: "none" as const, tasks: [], logs: [], diff: { text: "", fingerprint: "fixed", files: [{ path: "file", status: "modified" }] }, limits: { maxReadWorkers: 1, maxCalls: 2, timeoutMs: 10000, maxTokens: 0 } };
  const mutations: string[] = [];
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse(run.projectPath);
    if (name === "workflow_list_runs") return { structuredContent: { runs: [run] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Unavailable in fixture" }] };
    mutations.push(name); return { structuredContent: { run } };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  const input = { projectPath: run.projectPath, script: run.script, args: run.args, allowWrite: false };
  await panel.startWithInput(input);
  await panel.save(input, { id: run.id, revision: run.revision });
  panel.state.tab = "diff";
  await panel.perform("apply", true);
  await panel.perform("resume", true);
  assert.deepEqual(mutations, []);
  assert.equal(canApply({ ...run, execution: "completed" }, "diff"), false);
  assert.match(panel.state.error, /清理未完成/);
});
