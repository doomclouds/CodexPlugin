import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowPanelController } from "../prototypes/panel.ts";
import type { ToolResponse, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

function detail(id: string, revision = 7): WorkflowRun {
  return {
    id, revision, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:01:00Z",
    meta: { name: id, description: "A persisted project workflow" },
    script: 'export const meta={name:"fixture",description:"A persisted project workflow"}; return args;',
    args: {}, projectPath: "/project", allowWrite: false, execution: "failed", review: "unavailable",
    application: "none", tasks: [], logs: [], error: "Old recorded failure",
    limits: { maxReadWorkers: 1, maxCalls: 3, timeoutMs: 10000, maxTokens: 0 },
  };
}

function summary(run: WorkflowRun) {
  return {
    id: run.id, revision: run.revision, meta: run.meta, projectPath: run.projectPath,
    execution: run.execution, review: run.review, application: run.application,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

test("an authoritative empty summary list removes deleted selected and historical runs", async t => {
  const a = detail("run-a"), b = detail("run-b");
  let removed = false;
  const panel = new WorkflowPanelController(async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: removed ? [] : [summary(a), summary(b)], totalRuns: removed ? 0 : 2 } };
    if (name === "workflow_get_run") return { structuredContent: { run: args.id === a.id ? a : b } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.select(b.id);
  assert.equal(panel.selected?.id, b.id);
  removed = true;
  await panel.refresh();
  assert.deepEqual(panel.state.runs, [], "A missing selected row must not survive a complete authoritative listing.");
  assert.equal(panel.state.selectedRun, undefined);
  assert.equal(panel.selected, undefined);
  assert.equal(panel.state.runTotal, 0);
});

test("a complete first page prunes an absent cached historical row and selects a remaining run", async t => {
  const a = detail("run-a"), b = detail("run-b");
  let removed = false;
  const panel = new WorkflowPanelController(async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: args.offset ? [summary(b)] : [summary(a)], totalRuns: removed ? 1 : 2, ...(!removed && !args.offset ? { nextOffset: 1 } : {}) } };
    if (name === "workflow_get_run") return { structuredContent: { run: args.id === a.id ? a : b } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.loadMoreRuns();
  await panel.select(b.id);
  removed = true;
  await panel.refresh();
  assert.deepEqual(panel.state.runs.map(run => run.id), [a.id]);
  assert.equal(panel.state.selectedRun, a.id);
  assert.equal(panel.state.runNextOffset, undefined);
});

test("a run created while a complete listing is in flight survives that older listing", async t => {
  const a = detail("run-a"), created = detail("run-created", 1);
  const requested = deferred<void>(), response = deferred<ToolResponse>();
  let held = false;
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") {
      if (held) { requested.resolve(); return response.promise; }
      return { structuredContent: { listSummary: true, runs: [summary(a)], totalRuns: 1 } };
    }
    if (name === "workflow_get_run") return { structuredContent: { run: a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  held = true;
  const polling = panel.refresh();
  await requested.promise;
  panel.receive({ structuredContent: { run: created } });
  response.resolve({ structuredContent: { listSummary: true, runs: [], totalRuns: 0 } });
  await polling;
  assert.deepEqual(panel.state.runs.map(run => run.id), [created.id]);
  assert.equal(panel.selected?.id, created.id);
});

test("an off-page selected run is re-read instead of retaining its old failure indefinitely", async t => {
  const a = detail("run-a"), b = detail("run-b");
  let current = b;
  const calls: string[] = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(args.offset ? b : a)], totalRuns: 2, ...(!args.offset ? { nextOffset: 1 } : {}) } };
    if (name === "workflow_get_run") return { structuredContent: { run: args.id === b.id ? current : a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.loadMoreRuns();
  await panel.select(b.id);
  current = { ...b, revision: 9, execution: "completed", review: "ready", error: undefined };
  const reads = calls.filter(name => name === "workflow_get_run").length;
  await panel.refresh();
  assert.equal(panel.selected?.id, b.id);
  assert.equal(panel.selected?.revision, 9);
  assert.equal(panel.selected?.execution, "completed");
  assert.ok(calls.filter(name => name === "workflow_get_run").length > reads);
});

test("a failed off-page detail check keeps the cached display but fences mutations", async t => {
  const a = detail("run-a"), b = detail("run-b");
  let unavailable = false;
  const calls: string[] = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(args.offset ? b : a)], totalRuns: 2, ...(!args.offset ? { nextOffset: 1 } : {}) } };
    if (name === "workflow_get_run") return unavailable && args.id === b.id
      ? { isError: true, content: [{ type: "text", text: "Workflow no longer exists" }] }
      : { structuredContent: { run: args.id === b.id ? b : a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    throw new Error(`Unexpected mutation ${name}`);
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.loadMoreRuns();
  await panel.select(b.id);
  assert.equal(panel.canAct, true);
  unavailable = true;
  await panel.refresh();
  assert.equal(panel.selected?.id, b.id, "A missing off-page detail is not proof that the full listing deleted it.");
  assert.equal(panel.canAct, false, "An unconfirmed cached record must not be resumed or applied.");
  assert.match(panel.state.error, /读取运行详情失败/);
  await panel.perform("resume", true);
  await panel.perform("apply", true);
  assert.equal(calls.includes("workflow_resume"), false);
  assert.equal(calls.includes("workflow_apply"), false);
});

test("a late historical page cannot resurrect deleted runs after a complete empty refresh", async t => {
  const a = detail("run-a"), b = detail("run-b");
  const requested = deferred<void>(), response = deferred<ToolResponse>();
  let removed = false;
  const panel = new WorkflowPanelController(async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") {
      if (args.offset) { requested.resolve(); return response.promise; }
      return { structuredContent: { listSummary: true, runs: removed ? [] : [summary(a)], totalRuns: removed ? 0 : 2, ...(!removed ? { nextOffset: 1 } : {}) } };
    }
    if (name === "workflow_get_run") return { structuredContent: { run: a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture models" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  const paging = panel.loadMoreRuns();
  await requested.promise;
  removed = true;
  await panel.refresh();
  assert.deepEqual(panel.state.runs, []);
  assert.equal(panel.state.runTotal, 0);
  response.resolve({ structuredContent: { listSummary: true, runs: [summary(b)], totalRuns: 2 } });
  await paging;
  assert.deepEqual(panel.state.runs, [], "A page requested before authoritative deletion must not restore a removed run.");
  assert.equal(panel.state.runTotal, 0, "The stale page total must not replace the complete fresh listing.");
  assert.equal(panel.state.runNextOffset, undefined);
  assert.equal(panel.state.selectedRun, undefined);
  assert.equal(panel.state.historyBusy, false);
});
