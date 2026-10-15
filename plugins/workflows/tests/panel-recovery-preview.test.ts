import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowPanelController, recoveryPreviewPayload, renderRecoveryPreview, renderNodeProcess } from "../prototypes/panel.ts";
import type { RecoveryPreview, ToolCaller, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

function run(): WorkflowRun {
  return { id: "wf_" + "a".repeat(24), revision: 7, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:01:00Z", projectPath: "/project", script: 'export const meta={name:"recover",description:"Preserve actual files"}; return 1;', args: {}, meta: { name: "recover", description: "Preserve actual files" }, allowWrite: true, workspaceMode: "local", execution: "failed", review: "unavailable", application: "none", error: "worker failure", tasks: [{ id: "task_1", index: 0, prompt: "PRIVATE PROMPT", label: "检查项目", options: {}, mode: "read", status: "completed", cached: false, attempts: [] }, { id: "task_2", index: 1, prompt: "PRIVATE PROMPT", label: "修复代码", options: {}, mode: "write", status: "failed", cached: false, attempts: [] }], logs: [], limits: { maxReadWorkers: 2, maxCalls: 8, timeoutMs: 60000, maxTokens: 0 } };
}
function preview(current: WorkflowRun): RecoveryPreview {
  return { id: current.id, revision: current.revision, fingerprint: "b".repeat(64), canResume: true, strategy: "preserve-files", reusedTaskIds: ["task_1"], rerunTaskIds: ["task_2"], invalidatedTaskIds: ["task_2"], blockers: [], warnings: [], currentFilesPreserved: true, externalEffectsReverted: false, checkpoint: { id: "cp_1", sequence: 1, createdAt: current.updatedAt, reason: "task-completed", completedTasks: 1 } };
}
function fixture(options: { gate?: Promise<void>; blocked?: boolean; resumeFailure?: boolean } = {}) {
  let current = run(), projectPath = current.projectPath;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse(projectPath);
    if (name === "workflow_list_runs") return { structuredContent: { runs: [current] } };
    if (name === "workflow_get_run") return { structuredContent: { run: current } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No model catalogue in this UI fixture" }] };
    if (name === "workflow_preview_recovery") {
      const value = preview(current); await options.gate;
      return { structuredContent: { preview: options.blocked ? { ...value, canResume: false, blockers: [{ code: "unknown-effect", message: "先核对已开始命令的实际效果。" }] } : value } };
    }
    if (name === "workflow_resume") {
      if (options.resumeFailure) return { isError: true, content: [{ type: "text", text: "Recovery preview changed; refresh before resuming" }] };
      current = { ...current, revision: current.revision + 1, execution: "running" }; return { structuredContent: { run: current } };
    }
    return { structuredContent: {} };
  };
  return { panel: new WorkflowPanelController(caller, () => {}, () => () => {}), calls, current: () => current, setProject: (value: string) => { projectPath = value; } };
}
const mutations = (calls: Array<{ name: string }>) => calls.filter(call => ["workflow_resume", "workflow_start", "workflow_update", "workflow_preview"].includes(call.name));

test("recovery preview is read only and confirms the exact revision, task and fingerprint once", async () => {
  const f = fixture(); await f.panel.connected();
  const value = await f.panel.prepareRecovery("task_2", "auto-review");
  assert.deepEqual(value, preview(f.current())); assert.equal(f.panel.recoveryValid, true);
  assert.equal(mutations(f.calls).length, 0);
  assert.deepEqual(f.calls.find(call => call.name === "workflow_preview_recovery")?.args, { id: f.current().id, revision: 7, retryFromTaskId: "task_2" });
  await f.panel.confirmRecovery(); await f.panel.confirmRecovery();
  assert.deepEqual(f.calls.filter(call => call.name === "workflow_resume").map(call => call.args), [{ id: f.current().id, revision: 7, leaseId: "lease", retryFromTaskId: "task_2", approvalMode: "auto-review", recoveryFingerprint: "b".repeat(64) }]);
  assert.equal(f.panel.selected?.execution, "running"); assert.equal(f.panel.state.recoveryPreview, undefined);
  await f.panel.teardown();
});

test("cancel, blockers and unsupported approval choices never dispatch workers", async () => {
  for (const condition of ["cancel", "blocker", "invalid-mode"] as const) {
    const f = fixture({ blocked: condition === "blocker" }); await f.panel.connected();
    await f.panel.prepareRecovery("task_2", condition === "invalid-mode" ? "invalid" as "never" : undefined);
    if (condition === "cancel") f.panel.cancelRecovery();
    await f.panel.confirmRecovery();
    assert.equal(mutations(f.calls).length, 0);
    if (condition === "invalid-mode") assert.equal(f.calls.some(call => call.name === "workflow_preview_recovery"), false);
    await f.panel.teardown();
  }
});

test("revision changes invalidate an existing recovery preview before confirmation", async () => {
  const f = fixture(); await f.panel.connected(); await f.panel.prepareRecovery();
  f.panel.receive({ structuredContent: { run: { ...f.current(), revision: 8 } } });
  assert.equal(f.panel.recoveryValid, false); await f.panel.confirmRecovery();
  assert.equal(mutations(f.calls).length, 0); assert.match(f.panel.state.recoveryError ?? "", /预览已失效/);
  await f.panel.teardown();
});

test("disconnect discards the preview even after connection state is restored", async () => {
  const f = fixture(); await f.panel.connected(); await f.panel.prepareRecovery();
  f.panel.disconnected(new Error("lost connection"));
  f.panel.state.connection = "connected";
  assert.equal(f.panel.state.recoveryPreview, undefined); assert.equal(f.panel.recoveryValid, false);
  await f.panel.confirmRecovery(); assert.equal(mutations(f.calls).length, 0);
  await f.panel.teardown();
});

test("late preview cannot reappear after cancellation, project ownership changes or newer revision", async () => {
  for (const condition of ["cancel", "project", "revision"] as const) {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ gate }); await f.panel.connected();
    const pending = f.panel.prepareRecovery("task_2");
    if (condition === "cancel") f.panel.cancelRecovery();
    if (condition === "project") { f.setProject("/different-project"); await f.panel.refreshProjects(); }
    if (condition === "revision") f.panel.receive({ structuredContent: { run: { ...f.current(), revision: 8 } } });
    release(); assert.equal(await pending, undefined);
    assert.equal(f.panel.state.recoveryPreview, undefined); await f.panel.confirmRecovery(); assert.equal(mutations(f.calls).length, 0);
    await f.panel.teardown();
  }
});

test("a failed compare-and-swap confirmation is not resent automatically", async () => {
  const f = fixture({ resumeFailure: true }); await f.panel.connected(); await f.panel.prepareRecovery();
  await f.panel.confirmRecovery(); await f.panel.confirmRecovery(); await f.panel.refresh();
  assert.equal(f.calls.filter(call => call.name === "workflow_resume").length, 1);
  assert.equal(f.panel.selected?.execution, "failed"); assert.equal(f.panel.state.recoveryPreview, undefined);
  await f.panel.teardown();
});

test("DOM start routing can request a recovery preview while legacy controller callers remain compatible", async () => {
  const f = fixture(); await f.panel.connected(); let opened = 0;
  const current = f.current();
  await f.panel.startWithInput({ projectPath: current.projectPath, script: current.script, args: current.args, allowWrite: true, workspaceMode: "local" }, () => { opened++; });
  assert.equal(opened, 1); assert.equal(f.panel.recoveryValid, true); assert.equal(mutations(f.calls).length, 0);
  await f.panel.teardown();
});

test("recovery and checkpoint views disclose file preservation, exact effects and escaped labels", () => {
  const current = run(); current.tasks[1]!.label = '<img src=x onerror="evil">';
  const value = preview(current); value.warnings.push("远端状态需要核对");
  const html = renderRecoveryPreview(value, current);
  assert.match(html, /保留当前项目文件/); assert.match(html, /不会恢复旧文件/); assert.match(html, /复用有效结果：1/); assert.match(html, /重新执行：1/); assert.match(html, /失效的旧结果：1/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|PRIVATE PROMPT/);
  assert.deepEqual(recoveryPreviewPayload({ preview: value }), value);
  for (const patch of [{ currentFilesPreserved: false }, { externalEffectsReverted: true }, { fingerprint: "weak" }, { strategy: "rewind-files" }, { rerunTaskIds: [false] }]) assert.throws(() => recoveryPreviewPayload({ preview: { ...value, ...patch } }), /恢复预览/);
  const processHtml = renderNodeProcess({ id: current.id, taskId: "task_1", label: "检查", status: "completed", summary: "完成", activities: [], checkpoint: { state: "ready", covered: true, latest: value.checkpoint } });
  assert.match(processHtml, /本次结果已包含在已保存进度中/);
});

test("node process renders current validation failures separately without changing historical execution status", () => {
  const html = renderNodeProcess({ id: "wf-test", taskId: "task_1", label: "构建", status: "completed", activities: [], summary: "历史执行状态保留", validationError: '<img src=x onerror="evil">' });
  assert.match(html, /已完成/); assert.match(html, /结果校验失败：&lt;img/); assert.match(html, /历史执行状态保留/); assert.doesNotMatch(html, /<img/);
});
