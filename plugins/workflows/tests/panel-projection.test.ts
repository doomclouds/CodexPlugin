import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowPanelController, renderMaintenanceArtifacts, summarizeMaintenanceReview } from "../prototypes/panel.ts";
import type { ToolResponse, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

function detail(id = "run-a"): WorkflowRun {
  return { id, revision: 7, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:01:00Z", meta: { name: id, description: "Actual delegated scope" }, script: 'export const meta={name:"scope",description:"Actual delegated scope"}; return args;', args: { keep: "original arguments" }, projectPath: "/project", allowWrite: true, networkAccess: true, workspaceMode: "git-worktree", allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["inspect"] }, maintenance: { steps: [{ id: "build", command: ["node", "build.mjs"], protectedPaths: [".agents/skills"] }] }, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [], limits: { maxReadWorkers: 2, maxCalls: 9, timeoutMs: 10000, maxTokens: 2000 } };
}
function summary(run: WorkflowRun) {
  return { id: run.id, revision: run.revision, createdAt: run.createdAt, updatedAt: run.updatedAt, meta: { name: run.meta.name, description: "List summary" }, projectPath: run.projectPath, execution: run.execution, review: run.review, application: run.application };
}

test("a selected list summary loads real detail and never substitutes an empty execution scope", async t => {
  const run = detail(), calls: string[] = [];
  let requested!: () => void, reply!: (value: ToolResponse) => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  const pending = new Promise<ToolResponse>(resolve => { reply = resolve; });
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(run)], totalRuns: 1 } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
    if (name === "workflow_get_run") { requested(); return pending; }
    throw new Error(`Unexpected mutation ${name}`);
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  const connecting = panel.connected();
  await started;
  assert.equal(panel.selected, undefined);
  assert.equal(panel.selectedSummary?.id, run.id);
  assert.equal(Object.hasOwn(panel.selectedSummary!, "script"), false);
  assert.equal(panel.canAct, false);
  await panel.perform("start", true);
  assert.equal(calls.includes("workflow_start"), false);
  reply({ structuredContent: { run } });
  await connecting;
  assert.deepEqual(panel.selected, run);
  assert.equal(panel.canAct, true);
  const reads = calls.filter(name => name === "workflow_get_run").length;
  await panel.refresh();
  assert.deepEqual(panel.selected?.maintenance, run.maintenance);
  assert.deepEqual(panel.selected?.args, run.args);
  assert.equal(panel.selected?.script, run.script);
  assert.equal(calls.filter(name => name === "workflow_get_run").length, reads, "Same-revision summaries must not overwrite or refetch complete scope.");
});

test("history pages retain loaded rows and selection detail without silently hiding the next page", async t => {
  const a = detail(), b = detail("run-b"), calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(args.offset ? b : a)], totalRuns: 2, ...(args.offset ? {} : { nextOffset: 1 }) } };
    if (name === "workflow_get_run") return { structuredContent: { run: args.id === b.id ? b : a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  assert.equal(panel.state.runNextOffset, 1);
  await panel.loadMoreRuns();
  assert.equal(panel.state.runs.length, 2);
  assert.equal(panel.selected?.id, a.id);
  assert.deepEqual(calls.filter(call => call.name === "workflow_list_runs").at(-1)?.args, { projectPath: "/project", offset: 1, limit: 100 });
  await panel.select(b.id);
  assert.deepEqual(panel.selected, b);
  await panel.refresh();
  assert.equal(panel.state.runs.length, 2);
  assert.deepEqual(panel.selected, b);
  assert.equal(panel.state.runNextOffset, undefined);
});

test("artifact pages report the real total and cannot replace the main run or its control scope", async t => {
  const artifacts = (offset: number, count: number) => Array.from({ length: count }, (_, index) => ({ path: `artifact-${offset + index}.js`, size: 12, kind: "file" }));
  const run = { ...detail(), execution: "completed" as const, review: "ready" as const, maintenanceReview: { artifacts: artifacts(0, 20), artifactCount: 22547, artifactOffset: 0, nextArtifactOffset: 20, artifactFingerprint: "all-artifacts", fingerprint: "review-fingerprint" } };
  let changed = false;
  const panel = new WorkflowPanelController(async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [run] } };
    if (name === "workflow_get_run") return { structuredContent: { run: { ...run, script: "Page response scope must not replace the selected run", args: { page: true }, maintenanceReview: { ...run.maintenanceReview, artifacts: artifacts(Number(args.artifactOffset), 100), artifactOffset: args.artifactOffset, nextArtifactOffset: 120, fingerprint: changed ? "changed" : "review-fingerprint" } } } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  const original = structuredClone(panel.selected);
  const page = await panel.readArtifactPage(20);
  assert.equal(page.artifactCount, 22547);
  assert.equal(page.artifacts.length, 100);
  assert.deepEqual(panel.selected, original);
  const initial = summarizeMaintenanceReview(run.maintenanceReview);
  assert.equal(initial.artifactCount, 22547); assert.equal(initial.artifacts.length, 20);
  assert.match(renderMaintenanceArtifacts(run.maintenanceReview), /当前 20 项 \/ 共 22547 项/);
  assert.match(renderMaintenanceArtifacts(page, 200), /第 21—120 项，共 22547 项/);
  changed = true;
  await assert.rejects(panel.readArtifactPage(20), /清单已变化/);
  assert.deepEqual(panel.selected, original);
});

test("an accepted start with summary-only output cannot reuse the old draft or dispatch a second start", async t => {
  const original = detail(), calls: string[] = [];
  let current = original;
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [original] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_start" || name === "workflow_stop") {
      current = { ...current, revision: current.revision + 1, execution: name === "workflow_start" ? "running" : "stopped" };
      return { structuredContent: { operationAccepted: true, listSummary: true, run: summary(current), projectionError: { code: "RESPONSE_BUDGET", message: "Full view exceeds transport budget" } } };
    }
    return { isError: true, content: [{ type: "text", text: "Full view unavailable in fixture" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.perform("start", true);
  assert.equal(panel.selected, undefined);
  assert.equal(panel.selectedSummary?.execution, "running");
  assert.equal(panel.selectedSummary?.revision, 8);
  assert.equal(panel.canAct, false);
  assert.match(panel.state.error, /操作已接受/);
  await panel.perform("start", true);
  await panel.perform("apply", true);
  await panel.startWithInput({ projectPath: original.projectPath, script: original.script, args: original.args, allowWrite: original.allowWrite });
  assert.equal(calls.filter(name => name === "workflow_start").length, 1);
  assert.equal(calls.includes("workflow_apply"), false);
  await panel.perform("stop", true);
  assert.equal(calls.filter(name => name === "workflow_stop").length, 1);
  assert.equal(panel.selectedSummary?.execution, "stopped");
});

test("an accepted preview does not automatically start while its complete scope is unavailable", async t => {
  const run = detail(), calls: string[] = [];
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [], totalRuns: 0 } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_preview") return { structuredContent: { operationAccepted: true, listSummary: true, run: summary(run), projectionError: { message: "Full preview unavailable" } } };
    return { isError: true, content: [{ type: "text", text: "Full view unavailable" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  const input = { projectPath: run.projectPath, script: run.script, args: run.args, allowWrite: run.allowWrite };
  await panel.startWithInput(input);
  await panel.startWithInput(input);
  assert.equal(calls.filter(name => name === "workflow_preview").length, 1);
  assert.equal(calls.includes("workflow_start"), false);
  assert.equal(panel.selectedSummary?.id, run.id);
  assert.match(panel.state.error, /操作已接受/);
});

test("newer list revisions cannot re-enable a stale draft when detail synchronization fails", async t => {
  const original = detail(), calls: string[] = [];
  let newer = false, available = false, detailRevision = 8;
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return newer ? { structuredContent: { listSummary: true, runs: [summary({ ...original, revision: 9, execution: "running" })], totalRuns: 1 } } : { structuredContent: { runs: [original] } };
    if (name === "workflow_get_run" && available) return { structuredContent: { run: { ...original, revision: detailRevision, execution: "running" } } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "Detail unavailable" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  newer = true;
  await panel.refresh();
  assert.equal(panel.selected?.script, original.script, "Keep the last real detail for display.");
  assert.equal(panel.canAct, false, "A stale real scope must not become actionable after the request finishes.");
  await panel.perform("start", true);
  assert.equal(calls.includes("workflow_start"), false);
  assert.equal(panel.stopTarget?.revision, 9);
  assert.equal(panel.stopTarget?.execution, "running");
  await panel.perform("stop", true);
  assert.equal(calls.includes("workflow_stop"), true, "Stopping must use the newer trusted state, rather than the stale draft.");
  available = true;
  await panel.refresh();
  assert.equal(panel.canAct, false, "An older detail response must not clear the newer summary's unresolved flag.");
  detailRevision = 9;
  await panel.refresh();
  assert.equal(panel.selected?.revision, 9);
  assert.equal(panel.canAct, true);
});
