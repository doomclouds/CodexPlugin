import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowPanelController, workflowSelectOptions } from "../prototypes/panel.ts";
import type { PanelState, TemplateDefinition, ToolResponse, WorkflowRun, WorkflowRunSummary } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

function run(id: string, execution: WorkflowRun["execution"] = "completed"): WorkflowRun {
  return {
    id, revision: 3, createdAt: "2026-10-15T08:00:00Z", updatedAt: "2026-10-15T08:01:00Z",
    meta: { name: "project-update", description: "Project workflow" }, script: "return args;", args: { record: id },
    projectPath: "/project", allowWrite: false, execution, review: "unavailable", application: "none", tasks: [], logs: [],
    limits: { maxReadWorkers: 2, maxCalls: 8, timeoutMs: 10000, maxTokens: 0 },
  };
}

function summary(value: WorkflowRun): WorkflowRunSummary {
  return { listSummary: true, id: value.id, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt, meta: value.meta, projectPath: value.projectPath, execution: value.execution, review: value.review, application: value.application };
}

const definition: TemplateDefinition = { id: "saved:reusable", name: "Reusable workflow", description: "Independent library definition", source: "saved", revision: 4, script: "return args;", args: { source: "library" } };
type SelectorState = Pick<PanelState, "runs" | "templates" | "selectedRun" | "selectedTemplate" | "runNextOffset" | "historyBusy" | "projectPath">;
function optionState(overrides: Partial<SelectorState> = {}): SelectorState {
  return { runs: [], templates: [definition], selectedRun: undefined, selectedTemplate: undefined, projectPath: "/project", ...overrides };
}
function options(markup: string): Array<{ attributes: string; text: string }> {
  return [...markup.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(match => ({ attributes: match[1]!, text: match[2]! }));
}
function selected(markup: string) { return options(markup).filter(option => /\bselected\b/.test(option.attributes)); }

test("workflow choices keep all project records beside reusable definitions and disambiguate equal names", () => {
  const a = run("wf_11111111aaaaaaaa11111111"), b = run("wf_22222222bbbbbbbb22222222");
  const foreign = { ...run("other-project-run"), projectPath: "/other-project" };
  const markup = workflowSelectOptions(optionState({ runs: [a, summary(b), foreign], selectedRun: b.id, selectedTemplate: definition.id }));
  assert.match(markup, /<optgroup\b[^>]*label="本项目运行"/);
  assert.match(markup, /<optgroup\b[^>]*label="工作流库"/);
  assert.match(markup, new RegExp(`value="run:${a.id}"`));
  assert.match(markup, new RegExp(`value="run:${b.id}"`));
  assert.match(markup, /value="template:saved:reusable"/);
  assert.doesNotMatch(markup, /other-project-run/);
  const records = options(markup).filter(option => /value="run:/.test(option.attributes));
  assert.equal(records.length, 2);
  assert.notEqual(records[0]!.text, records[1]!.text, "Same-name, same-time records require distinct visible identifiers.");
  for (const record of records) { assert.match(record.text, /project-update/); assert.match(record.text, /完成/); assert.match(record.text, /2026/); }
  assert.equal(selected(markup).length, 1, "A summary selection must not also select its previous library definition.");
  assert.match(selected(markup)[0]!.attributes, new RegExp(`value="run:${b.id}"`));
  const placeholder = options(markup).find(option => /value=""/.test(option.attributes));
  assert.ok(placeholder && /\bdisabled\b/.test(placeholder.attributes));
});

test("workflow choice text and identities are escaped without hiding saved records after a library selection", () => {
  const value = { ...run('wf_<tag>"&'), meta: { name: '<img src=x onerror="bad"> & workflow', description: "Untrusted metadata" } };
  const library = { ...definition, id: 'saved:<item>"&', name: '<script>alert("bad")</script>' };
  const markup = workflowSelectOptions(optionState({ runs: [value], templates: [library], selectedTemplate: library.id }));
  assert.doesNotMatch(markup, /<img|<script|<tag>|<item>/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /value="run:wf_&lt;tag&gt;&quot;&amp;"/);
  assert.match(markup, /value="template:saved:&lt;item&gt;&quot;&amp;"/);
  assert.equal(selected(markup).length, 1);
  assert.match(selected(markup)[0]!.attributes, /value="template:/);
});

test("switching project records through the main selector never creates or starts a workflow", async t => {
  const records = [run("run-a"), run("run-b", "failed"), run("run-c", "draft"), run("run-d", "stopped")];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "selector-fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: records.map(summary), totalRuns: records.length } };
    if (name === "workflow_get_run") return { structuredContent: { run: records.find(record => record.id === args.id) } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return { structuredContent: definition };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "No fixture model catalogue" }] };
    throw new Error(`Unexpected mutation: ${name}`);
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  assert.equal(panel.selected?.id, "run-a");
  await panel.selectWorkflow("");
  assert.equal(panel.selected?.id, "run-a", "The disabled placeholder must not clear the existing workflow.");
  await panel.selectWorkflow(`template:${definition.id}`);
  await panel.loadTemplate(definition.id);
  assert.equal(panel.selected, undefined);
  await panel.refresh();
  const markup = workflowSelectOptions(panel.state);
  for (const record of records) assert.match(markup, new RegExp(`value="run:${record.id}"`));
  await panel.selectWorkflow("run:run-d");
  assert.deepEqual(panel.selected?.args, records[3]!.args);
  assert.equal(panel.state.definition, undefined);
  const reads = calls.filter(call => call.name === "workflow_get_run");
  assert.equal(reads.at(-1)?.args.id, "run-d");
  await panel.selectWorkflow("run:unknown-record");
  await panel.selectWorkflow("template:unknown-definition");
  await panel.selectWorkflow("run:foreign-record");
  assert.equal(panel.selected?.id, "run-d");
  assert.equal(calls.filter(call => call.name === "workflow_get_run").length, reads.length);
  assert.equal(calls.some(call => ["workflow_preview", "workflow_start", "workflow_resume", "workflow_apply", "workflow_save_template"].includes(call.name)), false);
});

test("a failed selected detail blocks mutations while the selector can recover to another actual record", async t => {
  const a = run("run-a", "draft"), b = run("run-b", "draft"), calls: string[] = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "selector-fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(a), summary(b)], totalRuns: 2 } };
    if (name === "workflow_get_run") return args.id === a.id ? { isError: true, content: [{ type: "text", text: "Detail unavailable" }] } : { structuredContent: { run: b } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "Unexpected tool in selector fixture" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  assert.equal(panel.selected, undefined);
  assert.equal(panel.selectedSummary?.id, a.id);
  assert.equal(panel.canAct, false);
  assert.equal(panel.canSelectWorkflow, true);
  await panel.perform("start", true);
  await panel.perform("apply", true);
  assert.equal(calls.includes("workflow_start"), false);
  assert.equal(calls.includes("workflow_apply"), false);
  await panel.selectWorkflow(`run:${b.id}`);
  assert.deepEqual(panel.selected, b);
  assert.equal(panel.canAct, true);
});

test("selector pagination retains the current detail and exposes newly loaded project records", async t => {
  const a = run("first-page"), b = run("next-page"), foreign = { ...run("foreign-page"), projectPath: "/other-project" };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "selector-fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: (args.offset ? [b, foreign] : [a]).map(summary), totalRuns: 2, ...(args.offset ? {} : { nextOffset: 1 }) } };
    if (name === "workflow_get_run") return { structuredContent: { run: args.id === b.id ? b : a } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "No fixture model catalogue" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  assert.match(workflowSelectOptions(panel.state), /value="more-runs"/);
  await panel.selectWorkflow("more-runs");
  assert.deepEqual(panel.selected, a);
  assert.equal(panel.state.runNextOffset, undefined);
  const markup = workflowSelectOptions(panel.state);
  assert.match(markup, /value="run:next-page"/);
  assert.doesNotMatch(markup, /foreign-page|value="more-runs"/);
  assert.equal(calls.filter(call => call.name === "workflow_get_run").length, 1, "Loading choice summaries must not fetch every record's execution detail.");
  await panel.selectWorkflow(`run:${b.id}`);
  await panel.refresh();
  assert.deepEqual(panel.selected, b);
  assert.match(workflowSelectOptions(panel.state), /value="run:next-page"/);
});

test("a late library response cannot overwrite the later project-run selection", async t => {
  const actual = run("actual-record");
  let reply!: (value: ToolResponse) => void;
  const pending = new Promise<ToolResponse>(resolve => { reply = resolve; });
  const panel = new WorkflowPanelController(async (name, args) => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "selector-fixture" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { listSummary: true, runs: [summary(actual)], totalRuns: 1 } };
    if (name === "workflow_get_run") return { structuredContent: { run: actual } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return pending;
    return { isError: true, content: [{ type: "text", text: "No fixture model catalogue" }] };
  }, () => {}, () => () => {});
  t.after(() => panel.teardown());
  await panel.connected();
  await panel.selectWorkflow(`template:${definition.id}`);
  const loading = panel.loadTemplate(definition.id);
  await panel.select(actual.id);
  reply({ structuredContent: definition });
  assert.equal(await loading, undefined);
  assert.deepEqual(panel.selected, actual);
  assert.equal(panel.state.definition, undefined);
  assert.notEqual(panel.state.selectedTemplate, definition.id);
  assert.equal(selected(workflowSelectOptions(panel.state)).length, 1);
});
