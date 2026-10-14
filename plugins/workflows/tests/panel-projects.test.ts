import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkflowPanelController, projectsPayload } from "../prototypes/panel.ts";
import type { ProjectsResponse, TemplateDefinition, ToolResponse, WorkflowRun } from "../prototypes/panel.ts";

const projectIds = [
  "7322ae72-12df-49e3-a8e5-dc44d38245c6",
  "234bcb7f-0e0e-416c-a515-2132b6659071",
  "7dbedfdc-3762-4455-bd76-ef89b75e0fc2",
  "1959afac-1759-41bb-9cb8-11de55c54efa",
];

function catalogue(currentProjectId?: string, revision = "initial"): ProjectsResponse {
  return {
    available: true, contextSource: currentProjectId ? "thread" : "global-or-unassigned",
    projects: projectIds.map((projectId, index) => ({
      projectId, label: `Repository ${index + 1}`, hostId: "local",
      path: path.join(tmpdir(), "workflows-panel-project-fixture", revision, `repository-${index + 1}`),
    })),
    ...(currentProjectId ? { currentProjectId } : {}),
  };
}

const definition: TemplateDefinition = {
  id: "saved:review", name: "review", description: "Review the selected project", source: "saved", revision: 3,
  script: "return await agent(args.request)", args: { request: "Review" }, allowWrite: false,
  meta: { name: "review", description: "Review the selected project", parameters: [{ name: "request", label: "Request", type: "string" }] },
};

function savedRun(projectPath: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "review-run", revision: 1, createdAt: "", updatedAt: "", meta: definition.meta!, script: definition.script,
    args: definition.args, projectPath, allowWrite: false, execution: "draft", review: "unavailable", application: "none",
    tasks: [], logs: [], limits: { maxReadWorkers: 2, maxCalls: 8, timeoutMs: 10000, maxTokens: 0 }, ...overrides,
  };
}

function fixture(initial: ToolResponse = { structuredContent: catalogue() }) {
  let projects = initial;
  let intercept: ((name: string, args: Record<string, unknown>) => Promise<ToolResponse | undefined>) | undefined;
  const runs = new Map<string, WorkflowRun[]>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    const response = await intercept?.(name, args);
    if (response) return response;
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "projects-lease" } };
    if (name === "workflow_get_projects") return structuredClone(projects);
    if (name === "workflow_list_runs") return { structuredContent: { runs: runs.get(String(args.projectPath ?? "")) ?? [] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return { structuredContent: definition };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Model settings are outside this project fixture." }] };
    throw new Error(`Unexpected tool in read-only project fixture: ${name}`);
  }, () => {}, () => () => {});
  return {
    panel, calls, runs,
    setProjects: (response: ToolResponse) => { projects = response; },
    intercept: (handler: typeof intercept) => { intercept = handler; },
  };
}

test("the authoritative calling project selects its catalogue path before the first run query", async t => {
  const projects = catalogue(projectIds[1]);
  const { panel, calls } = fixture({ structuredContent: projects });
  t.after(() => panel.teardown());
  await panel.connected();
  assert.deepEqual(panel.state.projects, projects.projects);
  assert.equal(panel.state.currentProjectId, projectIds[1]);
  assert.equal(panel.state.selectedProjectId, projectIds[1]);
  assert.equal(panel.state.projectPath, projects.projects[1]!.path);
  assert.deepEqual(calls.find(call => call.name === "workflow_list_runs")?.args, { projectPath: projects.projects[1]!.path });
  assert.ok(calls.findIndex(call => call.name === "workflow_get_projects") < calls.findIndex(call => call.name === "workflow_list_runs"));
});

test("a global entry keeps four real catalogue choices without choosing a project or starting work", async t => {
  const { panel, calls } = fixture();
  t.after(() => panel.teardown());
  await panel.connected();
  assert.equal(panel.state.projects.length, 4);
  assert.equal(panel.state.selectedProjectId, undefined);
  assert.equal(panel.state.currentProjectId, undefined);
  assert.equal(panel.state.projectPath, "");
  assert.deepEqual(calls.find(call => call.name === "workflow_list_runs")?.args, {});
  assert.equal(calls.some(call => ["workflow_preview", "workflow_start", "workflow_resume"].includes(call.name)), false);
});

test("a global new run can reuse a definition in a separately selected project", async t => {
  const projects = catalogue();
  const { panel, calls } = fixture({ structuredContent: projects });
  t.after(() => panel.teardown());
  await panel.connected();
  panel.selectTemplate(definition.id);
  await panel.loadTemplate(definition.id);
  const loaded = structuredClone(panel.state.definition);
  await panel.selectProject(projectIds[2]!);
  assert.equal(panel.state.selectedProjectId, projectIds[2]);
  assert.equal(panel.state.projectPath, projects.projects[2]!.path);
  assert.equal(panel.state.selectedTemplate, definition.id);
  assert.deepEqual(panel.state.definition, loaded);
  assert.deepEqual(calls.filter(call => call.name === "workflow_list_runs").at(-1)?.args, { projectPath: projects.projects[2]!.path });
  assert.deepEqual(calls.filter(call => call.name === "workflow_get_execution_settings").at(-1)?.args, { projectPath: projects.projects[2]!.path });
  assert.equal(calls.some(call => ["workflow_preview", "workflow_start", "workflow_resume"].includes(call.name)), false);
});

test("running and stopping runs refuse project changes without querying another project", async t => {
  for (const execution of ["running", "stopping"] as const) {
    const projects = catalogue(projectIds[0]);
    const { panel, calls, runs } = fixture({ structuredContent: projects });
    t.after(() => panel.teardown());
    runs.set(projects.projects[0]!.path, [savedRun(projects.projects[0]!.path, { execution })]);
    await panel.connected();
    const before = structuredClone(calls);
    await panel.selectProject(projectIds[1]!);
    assert.equal(panel.state.selectedProjectId, projectIds[0]);
    assert.equal(panel.state.projectPath, projects.projects[0]!.path);
    assert.equal(panel.selected?.execution, execution);
    assert.deepEqual(calls, before);
  }
});

test("a global definition selection allows a new project while a prior history poll is pending", async t => {
  const projects = catalogue();
  const oldPath = projects.projects[0]!.path, newPath = projects.projects[1]!.path;
  const { panel, calls, runs, intercept } = fixture({ structuredContent: projects });
  t.after(() => panel.teardown());
  const oldRun = savedRun(oldPath, { id: "old-project-run" });
  const newRun = savedRun(newPath, { id: "new-project-run" });
  runs.set(oldPath, [oldRun]);
  runs.set(newPath, [newRun]);
  await panel.connected();
  await panel.selectProject(projectIds[0]!);
  panel.selectTemplate(definition.id);
  let reply!: (response: ToolResponse) => void;
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  const delayed = new Promise<ToolResponse>(resolve => { reply = resolve; });
  intercept(async (name, args) => {
    if (name !== "workflow_list_runs" || args.projectPath !== oldPath) return undefined;
    requested();
    return delayed;
  });
  const oldPolling = panel.refresh();
  await started;
  await panel.selectProject(projectIds[1]!);
  const changedScopeQueried = calls.some(call => call.name === "workflow_list_runs" && call.args.projectPath === newPath);
  reply({ structuredContent: { runs: [{ ...oldRun, revision: 99 }] } });
  await oldPolling;
  assert.equal(changedScopeQueried, true);
  assert.equal(panel.state.selectedProjectId, projectIds[1]);
  assert.equal(panel.state.projectPath, newPath);
  assert.deepEqual(panel.state.runs, [newRun]);
  assert.equal(panel.state.runs.some(run => run.projectPath === oldPath), false);
});

test("unavailable and failed discovery can recover the current project without inventing fallback paths", async t => {
  for (const initial of [
    { structuredContent: { available: false, projects: [], reason: "Desktop project discovery is unavailable." } },
    { isError: true, content: [{ type: "text", text: "The desktop pipe closed." }] },
  ] satisfies ToolResponse[]) {
    const { panel, setProjects } = fixture(initial);
    t.after(() => panel.teardown());
    await panel.connected();
    assert.match(panel.state.projectsError, /unavailable|pipe closed/);
    assert.equal(panel.state.projectPath, "");
    assert.equal(panel.state.selectedProjectId, undefined);
    const recovered = catalogue(projectIds[3], "recovered");
    setProjects({ structuredContent: recovered });
    await panel.refreshProjects();
    assert.equal(panel.state.projectsError, "");
    assert.deepEqual(panel.state.projects, recovered.projects);
    assert.equal(panel.state.selectedProjectId, projectIds[3]);
    assert.equal(panel.state.projectPath, recovered.projects[3]!.path);
  }
});

test("refreshing host projects preserves a user's selection and uses its fresh root path", async t => {
  const { panel, setProjects, calls } = fixture({ structuredContent: catalogue() });
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.selectProject(projectIds[2]!);
  const moved = catalogue(undefined, "host-relocated-root");
  setProjects({ structuredContent: moved });
  await panel.refreshProjects();
  await panel.refresh();
  assert.equal(panel.state.currentProjectId, undefined);
  assert.equal(panel.state.selectedProjectId, projectIds[2]);
  assert.equal(panel.state.projectPath, moved.projects[2]!.path);
  assert.equal(panel.state.projects[2]!.path, moved.projects[2]!.path);
  assert.deepEqual(calls.filter(call => call.name === "workflow_list_runs").at(-1)?.args, { projectPath: moved.projects[2]!.path });
});

test("malformed, duplicate and foreign current-project identities are rejected at the response boundary", () => {
  const valid = catalogue(projectIds[0]);
  assert.deepEqual(projectsPayload(valid as unknown as Record<string, unknown>), valid);
  for (const invalid of [
    { ...valid, projects: [valid.projects[0], valid.projects[0]] },
    { ...valid, projects: [{ ...valid.projects[0], projectId: "" }] },
    { ...valid, projects: [{ ...valid.projects[0], projectId: 12 }] },
    { ...valid, projects: [{ ...valid.projects[0], path: "" }] },
    { ...valid, projects: [{ ...valid.projects[0], hostId: null }] },
    { ...valid, currentProjectId: "not-a-catalogue-project" },
  ]) assert.throws(() => projectsPayload(invalid), /项目/);
});

test("an unknown global project choice does not change scope and a valid choice is recoverable", async t => {
  const projects = catalogue();
  const { panel, calls } = fixture({ structuredContent: projects });
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.selectProject(projectIds[0]!);
  const before = structuredClone(calls);
  await panel.selectProject("deleted-project");
  assert.match(panel.state.projectsError, /不在 Codex 项目列表/);
  assert.equal(panel.state.selectedProjectId, projectIds[0]);
  assert.equal(panel.state.projectPath, projects.projects[0]!.path);
  assert.deepEqual(calls, before);
  await panel.refreshProjects();
  await panel.selectProject(projectIds[1]!);
  assert.equal(panel.state.projectsError, "");
  assert.equal(panel.state.selectedProjectId, projectIds[1]);
});


test("thread-owned workflows cannot switch project at any execution state", async t => {
  for (const execution of ["draft", "preparing", "running", "stopping", "stopped", "failed", "completed"] as const) {
    const projects = catalogue(projectIds[0]);
    const { panel, calls, runs } = fixture({ structuredContent: projects });
    t.after(() => panel.teardown());
    runs.set(projects.projects[0]!.path, [savedRun(projects.projects[0]!.path, { execution })]);
    await panel.connected();
    const before = structuredClone(calls);
    await panel.selectProject(projectIds[1]!);
    assert.deepEqual(calls, before);
    assert.equal(panel.state.projectPath, projects.projects[0]!.path);
    assert.match(panel.state.projectsError, /目录固定/);
  }
});

test("a selected historical run stays fixed in a global panel even when its name matches a library definition", async t => {
  const projects = catalogue();
  const { panel, calls, runs } = fixture({ structuredContent: projects });
  t.after(() => panel.teardown());
  runs.set("", [savedRun(projects.projects[0]!.path)]);
  await panel.connected();
  const before = structuredClone(calls);
  await panel.selectProject(projectIds[2]!);
  assert.deepEqual(calls, before);
  assert.equal(panel.selected?.projectPath, projects.projects[0]!.path);
  assert.equal(panel.state.definition, undefined);
  assert.match(panel.state.projectsError, /目录固定/);
});
