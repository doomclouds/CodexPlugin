import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController, primaryWorkflowAction, requiresNewLocalPreview } from "../prototypes/panel.ts";
import type { ToolCaller, WorkflowInput, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

const checkpointError = "Local project or build artifacts changed since the last checkpoint. Create a new preview; cached results cannot safely replay.";
const script = 'export const meta = { name: "recheck", description: "Check project before changing files" }; return await agent("inspect");';
function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-old", revision: 8, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:01:00Z",
    projectPath: "/project", script, args: { branch: "main", options: ["pinned"] },
    meta: { name: "recheck", description: "Check project before changing files" },
    allowWrite: true, workspaceMode: "local", networkAccess: true,
    allowedMcpServers: ["fixture"], allowedMcpTools: { fixture: ["inspect"] },
    nodeSettings: { "phase:verify": { model: "test-model", reasoningEffort: "max" } },
    sourceDefinition: { id: "saved:recheck", revision: 6 },
    execution: "failed", application: "none", review: "unavailable", error: checkpointError,
    failureContext: { kind: "preparation" },
    tasks: [{ id: "task_1", index: 0, prompt: "inspect", options: {}, mode: "read", status: "completed", cached: false, attempts: [{ id: "attempt_1", status: "completed", output: { checked: true } }] }],
    logs: [{ at: "2026-10-15T00:01:00Z", level: "error", message: checkpointError }],
    limits: { maxReadWorkers: 2, maxCalls: 9, timeoutMs: 60000, maxTokens: 2000 },
    ...overrides,
  };
}

function fixture(initial = run(), previewError?: string, previewGate?: Promise<void>) {
  const records = new Map([[initial.id, structuredClone(initial)]]);
  let projectPath = initial.projectPath;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse(projectPath);
    if (name === "workflow_list_runs") return { structuredContent: { runs: [...records.values()] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No model catalogue in this UI fixture" }] };
    if (name === "workflow_get_run") return { structuredContent: { run: records.get(String(args.id)) } };
    if (name === "workflow_preview") {
      await previewGate;
      if (previewError) return { isError: true, content: [{ type: "text", text: previewError }] };
      const fresh = run({ ...structuredClone(args) as Partial<WorkflowRun>, id: "wf-new", revision: 1, execution: "draft", tasks: [], logs: [], error: undefined, failureContext: undefined });
      records.set(fresh.id, fresh);
      return { structuredContent: { run: fresh } };
    }
    if (name === "workflow_start" || name === "workflow_resume") {
      const updated = { ...records.get(String(args.id))!, execution: "running" as const };
      records.set(updated.id, updated);
      return { structuredContent: { run: updated } };
    }
    return { structuredContent: {} };
  };
  return { panel: new WorkflowPanelController(caller, () => {}, () => () => {}), calls, records, setProjectPath: (value: string) => { projectPath = value; } };
}

function inputFor(value: WorkflowRun): WorkflowInput {
  return {
    projectPath: value.projectPath, script: value.script, args: value.args, allowWrite: value.allowWrite,
    workspaceMode: value.workspaceMode, networkAccess: value.networkAccess,
    allowedMcpServers: value.allowedMcpServers, allowedMcpTools: value.allowedMcpTools,
    nodeSettings: value.nodeSettings, sourceDefinition: value.sourceDefinition, limits: value.limits,
  };
}

test("local checkpoint refusal offers a fresh preview instead of an endless resume action", () => {
  assert.deepEqual(primaryWorkflowAction(run()), { action: "recheck", label: "重新检查" });
  const structured = run({ error: "A revised diagnostic", failureContext: { kind: "preparation", recovery: "new-preview" } });
  assert.deepEqual(primaryWorkflowAction(structured), { action: "recheck", label: "重新检查" });
  for (const value of [run({ workspaceMode: "snapshot" }), run({ execution: "running" }), run({ error: "worker command failed" })]) {
    assert.equal(requiresNewLocalPreview(value), false);
    assert.notEqual(primaryWorkflowAction(value).action, "recheck");
  }
});

test("rechecking preserves the entire authorized plan in a separate draft without executing or changing history", async () => {
  const previous = run();
  const { panel, calls, records } = fixture(previous);
  await panel.connected();
  const fresh = await panel.recheckFromCurrent();
  assert.equal(fresh?.id, "wf-new");
  assert.equal(panel.selected?.execution, "draft");
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args, inputFor(previous));
  assert.equal(calls.some(call => ["workflow_start", "workflow_resume", "workflow_update", "workflow_delete"].includes(call.name)), false);
  assert.deepEqual(records.get(previous.id), previous);
  assert.equal(panel.state.runs.some(value => value.id === previous.id), true);
  assert.equal(panel.state.error, "");
  assert.deepEqual(primaryWorkflowAction(fresh), { action: "start", label: "启动" });
  await panel.startWithInput(inputFor(fresh!));
  assert.deepEqual(calls.find(call => call.name === "workflow_start")?.args, { id: "wf-new", revision: 1, leaseId: "lease" });
  await panel.teardown();
});

test("ordinary resume and start routes cannot replay an invalid local checkpoint", async () => {
  const previous = run();
  const { panel, calls } = fixture(previous);
  await panel.connected();
  await panel.startWithInput(inputFor(previous));
  await panel.perform("resume", true, "task_1");
  assert.equal(calls.some(call => ["workflow_preview", "workflow_resume", "workflow_start"].includes(call.name)), false);
  assert.match(panel.state.error, /重新检查.*新预览/);
  await panel.teardown();
});

test("definition compare-and-swap failure retains the old run and directs users to the current library definition", async () => {
  const previous = run();
  const { panel, calls, records } = fixture(previous, "Workflow definition changed or does not match the planned script; reload it before creating a run.");
  await panel.connected();
  assert.equal(await panel.recheckFromCurrent(), undefined);
  assert.equal(panel.selected?.id, previous.id);
  assert.equal(records.size, 1);
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args.sourceDefinition, previous.sourceDefinition);
  assert.match(panel.state.error, /库中的定义已更新.*最新版本/);
  assert.equal(calls.some(call => ["workflow_start", "workflow_resume"].includes(call.name)), false);
  await panel.teardown();
});

test("recheck remains disabled during disconnection, project uncertainty or unfinished deletion", async () => {
  for (const condition of ["offline", "unbound", "deletion"] as const) {
    const { panel, calls } = fixture(run({ deletionPending: condition === "deletion" }));
    await panel.connected();
    if (condition === "offline") panel.disconnected(new Error("connection lost"));
    if (condition === "unbound") panel.state.projectPath = "/another-project";
    assert.equal(await panel.recheckFromCurrent(), undefined);
    assert.equal(calls.some(call => call.name === "workflow_preview"), false);
    await panel.teardown();
  }
});

test("recheck never creates a replacement for a normal stopped run", async () => {
  const { panel, calls } = fixture(run({ execution: "stopped", error: undefined, failureContext: undefined }));
  await panel.connected();
  assert.equal(await panel.recheckFromCurrent(), undefined);
  assert.equal(calls.some(call => call.name === "workflow_preview"), false);
  await panel.teardown();
});

test("a pending recheck response cannot adopt an old project's draft after authoritative ownership changes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { panel, calls, records, setProjectPath } = fixture(run(), undefined, gate);
  await panel.connected();
  const pending = panel.recheckFromCurrent();
  setProjectPath("/another-project");
  await panel.refreshProjects();
  release();
  assert.equal(await pending, undefined);
  assert.equal(panel.state.projectPath, "/another-project");
  assert.equal(panel.selected, undefined);
  assert.equal(panel.state.runs.length, 0);
  assert.equal(records.get("wf-new")?.projectPath, "/project");
  assert.match(panel.state.error, /属于其他项目/);
  assert.equal(calls.some(call => ["workflow_start", "workflow_resume"].includes(call.name)), false);
  await panel.teardown();
});
