import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController, canApply, canChangeWorkspaceMode, renderWorkflowDiff, workspaceModeDescription, workspaceModeLabel, workspaceModeRestriction } from "../prototypes/panel.ts";
import type { TemplateDefinition, ToolCaller, WorkflowInput, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

const script = 'export const meta = { name: "local-edit", description: "Edit current project" }; return await agent("edit", { mode: "write" });';
function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-local", revision: 1, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
    meta: { name: "local-edit", description: "Edit current project" }, projectPath: "/project", script, args: { file: "src/main.ts" },
    allowWrite: true, workspaceMode: "local", networkAccess: false, allowedMcpServers: [], allowedMcpTools: {},
    execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [],
    limits: { maxReadWorkers: 2, maxCalls: 4, timeoutMs: 30000, maxTokens: 0 }, ...overrides,
  };
}

function fixture(initial?: WorkflowRun) {
  let current = initial;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const definition: TemplateDefinition = { id: "saved:local-edit", revision: 3, name: "local-edit", description: "Edit current project", source: "saved", script, args: { file: "src/main.ts" }, allowWrite: true, workspaceMode: "local" };
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-local" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: current ? [current] : [] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return { structuredContent: definition };
    if (name === "workflow_save_template") return { structuredContent: { template: { ...definition, revision: 4 } } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No model catalogue in this UI fixture" }] };
    if (name === "workflow_preview") current = run({ ...args as Partial<WorkflowRun>, id: "wf-new-local" });
    if (name === "workflow_update") current = { ...current!, ...args as Partial<WorkflowRun>, revision: current!.revision + 1 };
    if (name === "workflow_start" || name === "workflow_resume") current = { ...current!, revision: current!.revision + 1, execution: "running" };
    if (name === "workflow_stop") current = { ...current!, revision: current!.revision + 1, execution: "stopped" };
    return { structuredContent: { run: current } };
  };
  return { panel: new WorkflowPanelController(caller, () => {}, () => () => {}), calls };
}

function inputFor(value: WorkflowRun): WorkflowInput {
  return { projectPath: value.projectPath, script: value.script, args: value.args, allowWrite: value.allowWrite, workspaceMode: value.workspaceMode };
}

test("local library definitions round-trip their exact work mode and write scope before creating a new run", async () => {
  const { panel, calls } = fixture();
  await panel.connected();
  panel.selectTemplate("saved:local-edit");
  const definition = await panel.loadTemplate("saved:local-edit");
  assert.equal(definition?.workspaceMode, "local");
  assert.equal(definition?.allowWrite, true);
  await panel.saveTemplate({ script: definition!.script, args: definition!.args, allowWrite: definition!.allowWrite!, workspaceMode: definition!.workspaceMode }, definition!.revision);
  assert.deepEqual(calls.find(call => call.name === "workflow_save_template")?.args, { script, args: { file: "src/main.ts" }, allowWrite: true, workspaceMode: "local", revision: 3 });
  const input = { ...inputFor(run()), sourceDefinition: { id: definition!.id, revision: definition!.revision } };
  await panel.startWithInput(input);
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args, input);
  assert.deepEqual(calls.find(call => call.name === "workflow_start")?.args, { id: "wf-new-local", revision: 1, leaseId: "lease-local" });
  assert.equal(panel.selected?.workspaceMode, "local");
  await panel.teardown();
});

test("changing an untouched draft to local mode updates it once before starting the returned revision", async () => {
  const previous = run({ workspaceMode: "snapshot", revision: 7 });
  const { panel, calls } = fixture(previous);
  await panel.connected();
  await panel.startWithInput({ ...inputFor(previous), workspaceMode: "local" });
  assert.deepEqual(calls.find(call => call.name === "workflow_update")?.args, { id: previous.id, revision: 7, script, args: previous.args, allowWrite: true, workspaceMode: "local" });
  assert.deepEqual(calls.find(call => call.name === "workflow_start")?.args, { id: previous.id, revision: 8, leaseId: "lease-local" });
  assert.equal(calls.some(call => call.name === "workflow_preview"), false);
  await panel.teardown();
});

test("unchanged stopped local runs resume instead of silently switching to snapshot mode", async () => {
  const previous = run({ execution: "stopped", workspacePath: "/project" });
  const { panel, calls } = fixture(previous);
  await panel.connected();
  await panel.startWithInput(inputFor(previous));
  assert.deepEqual(calls.find(call => call.name === "workflow_resume")?.args, { id: previous.id, revision: 1, leaseId: "lease-local" });
  assert.equal(calls.some(call => call.name === "workflow_preview" || call.name === "workflow_update"), false);
  await panel.teardown();
});

test("workspace mode controls lock after preparation, tasks or an execution workspace exists", () => {
  const definition: TemplateDefinition = { id: "saved:local-edit", name: "local-edit", description: "", source: "saved", script, allowWrite: true };
  assert.equal(canChangeWorkspaceMode(definition), true);
  assert.equal(canChangeWorkspaceMode(run()), true);
  assert.equal(canChangeWorkspaceMode(undefined), false);
  for (const overrides of [
    { workspacePath: "/project" }, { startedAt: "2026-10-15T00:00:00Z" },
    { preparation: { startedAt: "2026-10-15T00:00:00Z", stages: [] } },
    { tasks: [{ id: "task_1", index: 0, prompt: "edit", options: {}, mode: "write" as const, status: "completed" as const, cached: false, attempts: [] }] },
    { execution: "running" as const }, { execution: "stopped" as const }, { execution: "failed" as const }, { execution: "completed" as const }, { deletionPending: true },
  ]) assert.equal(canChangeWorkspaceMode(run(overrides)), false, JSON.stringify(overrides));
});

test("local mode cannot grant writes to a readonly workflow or replace Git maintenance isolation", () => {
  assert.match(workspaceModeRestriction(run({ allowWrite: false }), "local"), /写入授权/);
  const maintenance = { steps: [{ id: "fetch", command: ["git", "fetch"] }] };
  assert.match(workspaceModeRestriction(run({ maintenance }), "local"), /维护操作需要 Git 隔离工作区/);
  assert.match(workspaceModeRestriction(run({ maintenance }), "snapshot"), /维护操作需要 Git 隔离工作区/);
  assert.equal(workspaceModeRestriction(run({ maintenance }), "git-worktree"), "");
  assert.equal(workspaceModeRestriction(run(), "local"), "");
});

test("local change reviews disclose immediate writes and never offer delayed application", async () => {
  const completed = run({ execution: "completed", review: "ready", diff: { files: [{ path: "src/main.ts", status: "M" }], text: "changed", fingerprint: "sha", previewTruncated: true, totalBytes: 999 } });
  for (const application of ["none", "partial", "conflict", "failed"] as const) assert.equal(canApply({ ...completed, application }, "diff"), false);
  const html = renderWorkflowDiff(completed);
  assert.match(html, /改动立即生效，无需应用/);
  assert.match(html, /停止或删除运行不会撤销/);
  assert.match(html, /本地改动已直接写入当前项目/);
  assert.doesNotMatch(html, /改动未应用|应用前会检查|应用会处理|重试未完成/);
  assert.match(renderWorkflowDiff({ ...completed, execution: "stopped" }), /已记录的本地差异/);
  const { panel, calls } = fixture(completed);
  await panel.connected();
  panel.state.tab = "diff";
  await panel.perform("apply", true);
  assert.equal(calls.some(call => call.name === "workflow_apply"), false);
  await panel.teardown();
});

test("work mode descriptions retain isolation semantics and distinguish readonly local access", () => {
  assert.equal(workspaceModeLabel(), "只读分析");
  assert.equal(workspaceModeLabel("snapshot", true), "隔离快照");
  assert.equal(workspaceModeLabel("local", true), "本地项目 · 直接修改");
  assert.equal(workspaceModeLabel("local", false), "只读分析");
  assert.equal(workspaceModeLabel("git-worktree", false), "只读分析");
  assert.match(workspaceModeDescription("snapshot", true), /独立文件快照/);
  assert.match(workspaceModeDescription("git-worktree", true), /独立 Git 工作区/);
  assert.match(workspaceModeDescription("local", false), /未授权文件写入/);
});


test("stopped and failed local runs show their recorded changes without offering Apply", () => {
  const diff = { files: [{ path: "src/main.ts", status: "modified" }], text: "- original\n+ edited", fingerprint: "local-sha" };
  for (const execution of ["stopped", "failed", "completed"] as const) {
    const value = run({ execution, diff });
    const html = renderWorkflowDiff(value);
    assert.match(html, /已记录的本地差异/);
    assert.match(html, /src\/main.ts/);
    assert.match(html, /- original\n\+ edited/);
    assert.match(html, /本次运行结束时记录的差异/);
    assert.match(html, /后续编辑不会自动更新/);
    assert.doesNotMatch(html, /完成后统一汇总|改动未应用|应用前会检查/);
    assert.equal(canApply(value, "diff"), false);
  }
});

test("missing local differences do not assert that stopping or failure left no changes", () => {
  for (const execution of ["stopped", "failed", "completed"] as const) {
    const html = renderWorkflowDiff(run({ execution }));
    assert.match(html, /尚未取得本地差异，当前项目可能已有改动/);
    assert.doesNotMatch(html, /没有文件改动|差异为空|完成后统一汇总/);
  }
  const empty = renderWorkflowDiff(run({ execution: "stopped", diff: { text: "", files: [], fingerprint: "empty-sha" } }));
  assert.match(empty, /本次记录的差异为空/);
});

test("local review failures retain recorded changes beside diagnostics while running views avoid old diff claims", () => {
  const diff = { files: [{ path: "src/main.ts", status: "modified" }], text: "edited", fingerprint: "local-sha" };
  const html = renderWorkflowDiff(run({ execution: "failed", diff, error: "Could not verify remaining output", failureContext: { kind: "review" } }));
  assert.match(html, /改动审查失败/);
  assert.match(html, /Could not verify remaining output/);
  assert.match(html, /src\/main.ts/);
  for (const execution of ["draft", "preparing", "running", "stopping"] as const) {
    const pending = renderWorkflowDiff(run({ execution, diff }));
    assert.match(pending, /本次执行结束后汇总本地差异/);
    assert.doesNotMatch(pending, /src\/main.ts|已记录的本地差异/);
  }
});

test("readonly mode descriptions use the original project for analysis instead of claiming isolated edits", () => {
  for (const mode of ["snapshot", "git-worktree", "local"] as const) {
    assert.equal(workspaceModeLabel(mode, false), "只读分析");
    assert.match(workspaceModeDescription(mode, false), /直接读取当前项目用于分析/);
    assert.match(workspaceModeDescription(mode, false), /未授权文件写入/);
    assert.doesNotMatch(workspaceModeDescription(mode, false), /在独立文件快照中执行|使用独立 Git 工作区/);
  }
});


test("readonly workflow scope permits only snapshot default and refuses both writable workspace choices", () => {
  const readonly = run({ allowWrite: false, workspaceMode: "snapshot" });
  assert.equal(workspaceModeRestriction(readonly, "snapshot"), "");
  assert.match(workspaceModeRestriction(readonly, "git-worktree"), /Git 隔离工作区需要写入授权/);
  assert.match(workspaceModeRestriction(readonly, "local"), /本地修改需要写入授权/);
  assert.equal(readonly.allowWrite, false);
  assert.equal(readonly.workspaceMode, "snapshot");
});
