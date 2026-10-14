import { projectFixtureResponse } from "./panel-project-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController, bindObservedNodeChoice, effortSelectOptions, executionSettingsPayload, modelSelectOptions } from "../prototypes/panel.ts";
import type { ExecutionSettingsResponse, ToolCaller, WorkflowRun, WorkflowTask } from "../prototypes/panel.ts";

const models = [{ id: "available-model", displayName: "Available model", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }];
function settings(revision = 0, available = true): ExecutionSettingsResponse {
  return {
    settings: { revision }, models, source: "codex-config", mainAgentContextAvailable: false,
    codexDefaults: { model: available ? "available-model" : "removed-model", reasoningEffort: "low" },
    defaultsStatus: available ? { available: true } : { available: false, reason: "Configured model is no longer available." },
    ...(available ? { effectiveDefaults: { model: "available-model", reasoningEffort: "low", source: "codex-config" } } : {}),
  };
}
function run(): WorkflowRun {
  return { id: "old-run", revision: 1, createdAt: "", updatedAt: "", meta: { name: "no-parameters", description: "No user input is needed.", parameters: [], phases: ["Review"] }, script: "return args", args: {}, projectPath: "/project", allowWrite: false, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [], limits: { maxReadWorkers: 2, maxCalls: 8, timeoutMs: 10000, maxTokens: 0 } };
}

test("valid model catalogue stays available for repairing invalid defaults, and CAS updates preserve run snapshots", async () => {
  const original = { ...run(), executionSettings: { model: "old-model", reasoningEffort: "low", source: "codex-config" as const } };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [original] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: settings(0, false) };
    const revision = Number(args.revision) + 1;
    const response = settings(revision, !!args.model);
    response.settings = { revision, ...(typeof args.model === "string" ? { model: args.model } : {}), ...(typeof args.reasoningEffort === "string" ? { reasoningEffort: args.reasoningEffort } : {}) };
    if (args.model) response.effectiveDefaults = { model: String(args.model), reasoningEffort: String(args.reasoningEffort), source: "workflow-settings" };
    return { structuredContent: response };
  }, () => {}, () => () => {});
  await panel.connected();
  assert.deepEqual(panel.state.settings?.models, models);
  assert.equal(panel.state.settings?.effectiveDefaults, undefined);
  assert.match(panel.state.settings?.defaultsStatus.reason ?? "", /no longer available/);
  assert.equal(panel.state.settingsError, "");
  await panel.saveExecutionSettings({ model: "available-model", reasoningEffort: "high" });
  await panel.saveExecutionSettings({});
  assert.deepEqual(calls.filter(call => call.name === "workflow_update_execution_settings").map(call => call.args), [
    { revision: 0, model: "available-model", reasoningEffort: "high", projectPath: "/project" },
    { revision: 1, projectPath: "/project" },
  ]);
  assert.deepEqual(panel.selected?.executionSettings, original.executionSettings);
  assert.equal(panel.state.settings?.settings.revision, 2);
  await panel.teardown();
});

test("missing catalogue reports its real error and refresh retries without inventing options", async () => {
  let available = false;
  const mutations: string[] = [];
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return available ? { structuredContent: settings() } : { isError: true, content: [{ type: "text", text: "model/list unavailable" }] };
    mutations.push(name);
    return { structuredContent: settings() };
  }, () => {}, () => () => {});
  await panel.connected();
  assert.match(panel.state.settingsError, /model\/list unavailable/);
  assert.equal(panel.state.settings, undefined);
  await panel.saveExecutionSettings({ model: "invented" });
  assert.deepEqual(mutations, []);
  available = true;
  await panel.refreshExecutionSettings();
  assert.deepEqual(panel.state.settings?.models, models);
  assert.equal(panel.state.settingsError, "");
  await panel.teardown();
});

test("selector options derive solely from catalogue and retain unsupported choices without silently substituting", () => {
  assert.match(modelSelectOptions(models, "<old-model>", "继承 Codex 配置"), /&lt;old-model&gt;.*selected disabled/);
  assert.match(modelSelectOptions(models, "", "继承 Codex 配置"), /available-model/);
  assert.match(effortSelectOptions(models, "available-model", "unsupported", "继承上级配置"), /unsupported.*selected disabled/);
  assert.match(effortSelectOptions(models, "available-model", "", "继承上级配置"), /value="low"/);
  assert.doesNotMatch(effortSelectOptions(models, "available-model", "", "继承上级配置"), /value="medium"/);
  assert.equal(executionSettingsPayload(settings(0, false)).defaultsStatus.available, false);
  assert.throws(() => executionSettingsPayload({ ...settings(), models: [{ id: "bad", supportedReasoningEfforts: [42] }] }), /模型目录/);
});

test("node overrides survive preview and definition saving, and changed stopped nodes cannot resume cached workers", async () => {
  let current = { ...run(), execution: "stopped" as WorkflowRun["execution"], nodeSettings: { "phase:Review": { model: "available-model", reasoningEffort: "low" } } };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [current] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: settings() };
    if (name === "workflow_save_template") return { structuredContent: { template: { id: "saved:no-parameters", name: "no-parameters", source: "saved", revision: 1 } } };
    if (name === "workflow_preview") current = { ...current, id: "new-run", revision: 2, execution: "draft", nodeSettings: args.nodeSettings as typeof current.nodeSettings };
    if (name === "workflow_start") current = { ...current, revision: 3, execution: "running" };
    return { structuredContent: { run: current } };
  };
  const panel = new WorkflowPanelController(caller, () => {}, () => () => {});
  await panel.connected();
  const nodeSettings = { "phase:Review": { model: "available-model", reasoningEffort: "high" }, "task:0": { reasoningEffort: "low" } };
  const input = { projectPath: current.projectPath, script: current.script, args: {}, allowWrite: false, nodeSettings };
  await panel.startWithInput(input);
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args.nodeSettings, nodeSettings);
  assert.equal(calls.some(call => call.name === "workflow_resume"), false);
  await panel.saveTemplate({ script: input.script, args: {}, allowWrite: false, nodeSettings });
  assert.deepEqual(calls.find(call => call.name === "workflow_save_template")?.args.nodeSettings, nodeSettings);
  await panel.teardown();
});

test("a workflow declaring no parameters starts with its existing empty defaults without editing JSON", async () => {
  const original = run();
  const calls: string[] = [];
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [original] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: settings() };
    return { structuredContent: { run: { ...original, execution: "running", revision: 2 } } };
  }, () => {}, () => () => {});
  await panel.connected();
  await panel.startWithInput({ projectPath: original.projectPath, script: original.script, args: original.args, allowWrite: false });
  assert.equal(calls.includes("workflow_start"), true);
  assert.equal(calls.includes("workflow_update"), false);
  assert.equal(calls.includes("workflow_preview"), false);
  assert.deepEqual(panel.selected?.args, {});
  await panel.teardown();
});

test("observed task choices copy producer identity, refuse legacy records and exclude fixed commands", () => {
  const task: WorkflowTask = { id: "observed", index: 0, prompt: "Caller input is not an identity", options: {}, phase: "Review", mode: "read", status: "completed", cached: false, attempts: [], configurationTarget: "ab".repeat(32) };
  const choice = { model: "available-model", reasoningEffort: "high" };
  assert.deepEqual(bindObservedNodeChoice("task:0", choice, [task]), { ...choice, identity: task.configurationTarget });
  assert.deepEqual(bindObservedNodeChoice("phase:Review", choice, [task]), choice);
  const legacy = { ...task }; delete legacy.configurationTarget;
  assert.throws(() => bindObservedNodeChoice("task:0", choice, [legacy]), /绑定标识.*阶段或默认/);
  assert.throws(() => bindObservedNodeChoice("task:1", choice, [task]), /绑定标识/);
  assert.throws(() => bindObservedNodeChoice("task:0", choice, [{ ...task, options: { operation: { id: "build", command: ["node", "--version"] } } }]), /固定命令.*不使用模型/);
});

test("task binding survives parameter preview and a producer-reported dispatch mismatch remains visible", async () => {
  const identity = "cd".repeat(32);
  const original = { ...run(), execution: "stopped" as const, nodeSettings: { "task:0": { model: "available-model", identity } } };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let current: WorkflowRun = original;
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [current] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: settings() };
    if (name === "workflow_preview") current = { ...original, id: "fresh-run", revision: 2, args: args.args, nodeSettings: args.nodeSettings as WorkflowRun["nodeSettings"], execution: "draft" };
    if (name === "workflow_start") current = { ...current, execution: "failed", revision: 3, error: "Task configuration identity changed; inspect the observed task.", tasks: [{ id: "mismatch", index: 0, prompt: "New task", options: {}, mode: "read", status: "failed", cached: false, attempts: [], configurationTarget: "ef".repeat(32) }] };
    return { structuredContent: { run: current } };
  }, () => {}, () => () => {});
  await panel.connected();
  const input = { projectPath: original.projectPath, script: original.script, args: { newParameter: true }, allowWrite: false, nodeSettings: original.nodeSettings };
  await panel.startWithInput(input);
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args, input);
  assert.equal(calls.some(call => call.name === "workflow_start"), true);
  assert.equal(calls.some(call => call.name === "workflow_resume"), false);
  assert.equal(panel.selected?.execution, "failed");
  assert.match(panel.selected?.error ?? "", /identity changed/);
  assert.notEqual(panel.selected?.tasks[0]?.configurationTarget, identity);
  assert.deepEqual(panel.selected?.nodeSettings, original.nodeSettings);
  await panel.teardown();
});
