import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController } from "../prototypes/panel.ts";
import type { ToolCaller, ToolResponse, WorkflowInput, WorkflowRun } from "../prototypes/panel.ts";

function savedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-existing", revision: 7, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z",
    meta: { name: "inspect", description: "Inspect supplied input" }, script: "return await agent(JSON.stringify(args))", args: { bugId: "0012", url: "https://example.test/12", text: "first\nsecond", count: 0, includeClosed: false },
    projectPath: "/project", allowWrite: false, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [],
    limits: { maxReadWorkers: 4, maxCalls: 20, timeoutMs: 30000, maxTokens: 0 }, ...overrides,
  };
}

function inputFor(run: WorkflowRun, overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return { projectPath: run.projectPath, script: run.script, args: structuredClone(run.args), allowWrite: run.allowWrite, ...overrides };
}

function fixture(initial?: WorkflowRun, intercept?: (name: string, args: Record<string, unknown>) => Promise<ToolResponse | undefined>) {
  let current = initial;
  let previews = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    const intercepted = await intercept?.(name, args);
    if (intercepted) return intercepted;
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-test" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: current ? [current] : [] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Execution settings are unavailable in this start-input fixture." }] };
    if (name === "workflow_preview") current = savedRun({ ...args as Partial<WorkflowRun>, id: `wf-new-${++previews}`, revision: 1, execution: "draft", tasks: [], logs: [] });
    else if (name === "workflow_update") current = { ...current!, ...args, revision: current!.revision + 1, execution: "draft" } as WorkflowRun;
    else if (name === "workflow_start" || name === "workflow_resume") current = { ...current!, revision: current!.revision + 1, execution: "running" };
    else if (name === "workflow_stop" && current) current = { ...current, execution: "stopped" };
    return { structuredContent: { run: current } };
  };
  const panel = new WorkflowPanelController(caller, () => {}, () => () => {});
  const mutations = () => calls.filter(call => !["workflow_panel_lease", "workflow_get_projects", "workflow_list_runs", "workflow_list_templates", "workflow_get_execution_settings"].includes(call.name));
  return { panel, calls, mutations };
}

test("starting supplied input creates the exact preview then starts its returned revision without generating a workflow", async () => {
  const { panel, mutations } = fixture();
  await panel.connected();
  const input = inputFor(savedRun(), { networkAccess: true, allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["inspect_binary"] }, workspaceMode: "snapshot" });
  await panel.startWithInput(input);
  assert.deepEqual(mutations(), [
    { name: "workflow_preview", args: input },
    { name: "workflow_start", args: { id: "wf-new-1", revision: 1, leaseId: "lease-test" } },
  ]);
  assert.deepEqual(panel.selected?.args, input.args);
  assert.equal(panel.selected?.execution, "running");
  await panel.teardown();
});

test("changed draft parameters are updated exactly before starting the new revision", async () => {
  const draft = savedRun();
  const { panel, mutations } = fixture(draft);
  await panel.connected();
  const input = inputFor(draft, { args: { bugId: "0099", url: "https://example.test/99?a=1&b=2", text: "中文\n说明", includeClosed: false, count: 0 } });
  await panel.startWithInput(input);
  assert.deepEqual(mutations(), [
    { name: "workflow_update", args: { id: draft.id, revision: draft.revision, script: input.script, args: input.args, allowWrite: input.allowWrite } },
    { name: "workflow_start", args: { id: draft.id, revision: 8, leaseId: "lease-test" } },
  ]);
  assert.deepEqual(panel.selected?.args, input.args);
  await panel.teardown();
});

test("changed stopped or failed parameters create a fresh run instead of resuming old task results", async () => {
  for (const execution of ["stopped", "failed"] as const) {
    const previous = savedRun({ execution });
    const { panel, mutations } = fixture(previous);
    await panel.connected();
    const input = inputFor(previous, { args: { bugId: "new-id", includeClosed: false, count: 0 } });
    await panel.startWithInput(input);
    assert.deepEqual(mutations(), [
      { name: "workflow_preview", args: input },
      { name: "workflow_start", args: { id: "wf-new-1", revision: 1, leaseId: "lease-test" } },
    ]);
    assert.deepEqual(panel.selected?.args, input.args);
    assert.notEqual(panel.selected?.id, previous.id);
    await panel.teardown();
  }
});

test("identical stopped or failed input resumes its existing run and retains exact arguments", async () => {
  for (const execution of ["stopped", "failed"] as const) {
    const previous = savedRun({ execution, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot" });
    const { panel, mutations } = fixture(previous);
    await panel.connected();
    await panel.startWithInput(inputFor(previous));
    assert.deepEqual(mutations(), [{ name: "workflow_resume", args: { id: previous.id, revision: previous.revision, leaseId: "lease-test" } }]);
    assert.deepEqual(panel.selected?.args, previous.args);
    assert.equal(panel.selected?.id, previous.id);
    await panel.teardown();
  }
});

test("running and stopping runs ignore replacement input", async () => {
  for (const execution of ["running", "stopping"] as const) {
    const previous = savedRun({ execution });
    const { panel, mutations } = fixture(previous);
    await panel.connected();
    await panel.startWithInput(inputFor(previous, { args: { changed: true } }));
    assert.deepEqual(mutations(), []);
    assert.deepEqual(panel.selected?.args, previous.args);
    assert.equal(panel.selected?.execution, execution);
    await panel.teardown();
  }
});

test("a preview failure never dispatches start and retains the prior stopped run", async () => {
  const previous = savedRun({ execution: "stopped" });
  const { panel, mutations } = fixture(previous, async name => name === "workflow_preview" ? { isError: true, content: [{ type: "text", text: "Invalid workflow input" }] } : undefined);
  await panel.connected();
  await panel.startWithInput(inputFor(previous, { args: { bugId: "invalid-new" } }));
  assert.deepEqual(mutations().map(call => call.name), ["workflow_preview"]);
  assert.equal(panel.selected?.id, previous.id);
  assert.equal(panel.selected?.execution, "stopped");
  assert.match(panel.state.error, /Invalid workflow input/);
  await panel.teardown();
});

test("closing the panel while preview is pending prevents subsequent worker execution", async () => {
  let respond!: (value: ToolResponse) => void;
  let previewStarted!: () => void;
  const requested = new Promise<void>(resolve => { previewStarted = resolve; });
  const pending = new Promise<ToolResponse>(resolve => { respond = resolve; });
  const { panel, mutations } = fixture(undefined, async name => {
    if (name !== "workflow_preview") return undefined;
    previewStarted();
    return pending;
  });
  await panel.connected();
  const starting = panel.startWithInput(inputFor(savedRun()));
  await requested;
  await panel.teardown();
  respond({ structuredContent: { run: savedRun({ id: "wf-after-close", revision: 1 }) } });
  await starting;
  assert.deepEqual(mutations().map(call => call.name), ["workflow_preview"]);
  assert.equal(panel.state.connection, "closed");
});

test("an existing run cannot be moved to a different project through replacement input", async () => {
  const previous = savedRun();
  const { panel, mutations } = fixture(previous);
  await panel.connected();
  await panel.startWithInput(inputFor(previous, { projectPath: "/other-project" }));
  assert.deepEqual(mutations(), []);
  assert.equal(panel.selected?.projectPath, previous.projectPath);
  assert.match(panel.state.error, /所属项目固定/);
  await panel.teardown();
});

test("explicitly changed limits create a fresh run rather than updating or resuming an existing budget", async () => {
  for (const execution of ["draft", "stopped", "failed"] as const) {
    const previous = savedRun({ execution });
    const { panel, mutations } = fixture(previous);
    await panel.connected();
    const input = inputFor(previous, { limits: { ...previous.limits, maxReadWorkers: 2, maxTokens: 100 } });
    await panel.startWithInput(input);
    assert.deepEqual(mutations(), [
      { name: "workflow_preview", args: input },
      { name: "workflow_start", args: { id: "wf-new-1", revision: 1, leaseId: "lease-test" } },
    ]);
    assert.deepEqual(panel.selected?.limits, input.limits);
    await panel.teardown();
  }
});

test("omitting limits retains the saved run's budget when resuming identical parameters", async () => {
  const limits = { maxReadWorkers: 2, maxCalls: 12, timeoutMs: 42000, maxTokens: 1234 };
  const previous = savedRun({ execution: "stopped", limits });
  const { panel, mutations } = fixture(previous);
  await panel.connected();
  await panel.startWithInput(inputFor(previous));
  assert.deepEqual(mutations(), [{ name: "workflow_resume", args: { id: previous.id, revision: previous.revision, leaseId: "lease-test" } }]);
  assert.deepEqual(panel.selected?.limits, limits);
  await panel.teardown();
});
