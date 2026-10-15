import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController } from "../prototypes/panel.ts";
import type { ApprovalMode, ToolCaller, WorkflowInput, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-approval", revision: 7, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
    meta: { name: "inspect", description: "Inspect the project" }, script: 'return await agent("inspect");',
    args: { branch: "main", count: 0 }, projectPath: "/project", allowWrite: true, networkAccess: false,
    workspaceMode: "local", allowedMcpServers: ["fixture"], allowedMcpTools: { fixture: ["inspect"] },
    execution: "stopped", review: "unavailable", application: "none", tasks: [], logs: [],
    limits: { maxReadWorkers: 2, maxCalls: 12, timeoutMs: 60000, maxTokens: 2000 }, ...overrides,
  };
}

function inputFor(value: WorkflowRun, approvalMode?: ApprovalMode): WorkflowInput {
  return {
    projectPath: value.projectPath, script: value.script, args: structuredClone(value.args), allowWrite: value.allowWrite,
    networkAccess: value.networkAccess, workspaceMode: value.workspaceMode, allowedMcpServers: value.allowedMcpServers,
    allowedMcpTools: value.allowedMcpTools, ...(approvalMode !== undefined ? { approvalMode } : {}),
  };
}

function fixture(initial: WorkflowRun) {
  let current = structuredClone(initial);
  const mutations: { name: string; args: Record<string, unknown> }[] = [];
  const caller: ToolCaller = async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse(current.projectPath);
    if (name === "workflow_list_runs") return { structuredContent: { runs: [current] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No settings in fixture" }] };
    mutations.push({ name, args: structuredClone(args) });
    if (name === "workflow_update" || name === "workflow_resume") current = { ...current, ...args, revision: current.revision + 1 } as WorkflowRun;
    if (name === "workflow_resume" || name === "workflow_start") current = { ...current, execution: "running" };
    if (name === "workflow_preview") current = run({ ...args as Partial<WorkflowRun>, id: "wf-new", revision: 1, execution: "draft", error: undefined, failureContext: undefined });
    return { structuredContent: { run: current } };
  };
  return { panel: new WorkflowPanelController(caller, () => {}, () => () => {}), mutations };
}

test("an explicit automatic-review selection resumes the same plan without replacing its authorization scope", async () => {
  for (const execution of ["stopped", "failed"] as const) {
    const previous = run({ execution });
    const { panel, mutations } = fixture(previous);
    await panel.connected();
    await panel.startWithInput(inputFor(previous, "auto-review"));
    assert.deepEqual(mutations, [{ name: "workflow_resume", args: { id: previous.id, revision: 7, leaseId: "lease", approvalMode: "auto-review" } }]);
    assert.deepEqual(panel.selected?.script, previous.script);
    assert.deepEqual(panel.selected?.args, previous.args);
    assert.deepEqual(panel.selected?.allowedMcpTools, previous.allowedMcpTools);
    assert.equal(panel.selected?.networkAccess, false);
    assert.equal(panel.selected?.approvalMode, "auto-review");
    await panel.teardown();
  }
});

test("legacy resume retains its recorded behavior unless the caller explicitly chooses an approval mode", async () => {
  const { panel, mutations } = fixture(run());
  await panel.connected();
  await panel.perform("resume", true);
  assert.deepEqual(mutations, [{ name: "workflow_resume", args: { id: "wf-approval", revision: 7, leaseId: "lease" } }]);
  assert.equal(panel.selected?.approvalMode, undefined);
  await panel.teardown();
});

test("changing a draft approval mode is persisted before starting its new revision", async () => {
  const previous = run({ execution: "draft", approvalMode: "never" });
  const { panel, mutations } = fixture(previous);
  await panel.connected();
  const input = inputFor(previous, "auto-review");
  await panel.startWithInput(input);
  const { projectPath: _projectPath, ...update } = input;
  assert.deepEqual(mutations, [
    { name: "workflow_update", args: { id: previous.id, revision: 7, ...update } },
    { name: "workflow_start", args: { id: previous.id, revision: 8, leaseId: "lease" } },
  ]);
  assert.equal(panel.selected?.approvalMode, "auto-review");
  await panel.teardown();
});

test("retrying a selected node carries the approval choice and keeps the explicit retry boundary", async () => {
  const previous = run({ execution: "failed", tasks: [{ id: "task_1", index: 0, prompt: "inspect", options: {}, mode: "read", status: "failed", cached: false, attempts: [] }] });
  const { panel, mutations } = fixture(previous);
  await panel.connected();
  await panel.perform("resume", true, "task_1", "auto-review");
  assert.deepEqual(mutations, [{ name: "workflow_resume", args: { id: previous.id, revision: 7, leaseId: "lease", retryFromTaskId: "task_1", approvalMode: "auto-review" } }]);
  await panel.teardown();
});

test("unsupported approval choices cannot dispatch a resume mutation", async () => {
  const { panel, mutations } = fixture(run());
  await panel.connected();
  await panel.perform("resume", true, undefined, "approve-everything" as ApprovalMode);
  assert.deepEqual(mutations, []);
  assert.match(panel.state.error, /不支持的审批模式/);
  await panel.teardown();
});

test("a fresh local checkpoint preview carries an explicit approval choice without executing", async () => {
  const previous = run({ execution: "failed", error: "Local project or build artifacts changed since the last checkpoint. Create a new preview; cached results cannot safely replay.", failureContext: { kind: "preparation", recovery: "new-preview" } });
  const { panel, mutations } = fixture(previous);
  await panel.connected();
  await panel.recheckFromCurrent("auto-review");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.name, "workflow_preview");
  assert.equal(mutations[0]?.args.approvalMode, "auto-review");
  assert.equal(mutations[0]?.args.script, previous.script);
  assert.deepEqual(mutations[0]?.args.allowedMcpTools, previous.allowedMcpTools);
  assert.equal(panel.selected?.execution, "draft");
  await panel.teardown();
});
