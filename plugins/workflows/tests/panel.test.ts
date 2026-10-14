import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController, applyPanelHostStyles, canApply, escapeHtml, jsonInput, parseToolGrants, partialApplicationMessage, summarizeMaintenanceReview, toolPayload } from "../prototypes/panel.ts";
import type { WorkflowRun, ToolCaller } from "../prototypes/panel.ts";

function draft(): WorkflowRun {
  return {
    id: "run-1", revision: 7, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
    meta: { name: "review", description: "Review a project" }, script: "return await agent('review')", args: {},
    projectPath: "/project", allowWrite: false, execution: "draft", review: "unavailable", application: "none",
    tasks: [], logs: [], limits: { maxReadWorkers: 3, maxCalls: 10, timeoutMs: 30000, maxTokens: 10000 },
  };
}

function fixture(overrides: Partial<WorkflowRun> = {}) {
  let run = { ...draft(), ...overrides };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const timers: Array<{ callback: () => void; milliseconds: number; disposed: boolean }> = [];
  let failure: string | undefined;
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args });
    if (failure) throw new Error(failure);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1", expiresAt: "2026-10-13T00:01:00Z" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: [run] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_start" || name === "workflow_resume") run = { ...run, revision: run.revision + 1, execution: "running" };
    if (name === "workflow_stop") run = { ...run, revision: run.revision + 1, execution: "stopping" };
    if (name === "workflow_apply") run = { ...run, revision: run.revision + 1, application: "applied" };
    return { structuredContent: { run } };
  };
  const panel = new WorkflowPanelController(caller, () => {}, (callback, milliseconds) => {
    const timer = { callback, milliseconds, disposed: false };
    timers.push(timer);
    return () => { timer.disposed = true; };
  });
  return { panel, calls, timers, fail: (message?: string) => { failure = message; }, update: (value: Partial<WorkflowRun>) => { run = { ...run, ...value }; } };
}

test("authorized tool automation carries the displayed revision and the UI live lease", async () => {
  const { panel, calls } = fixture();
  await panel.connected();
  await panel.perform("start", false);
  assert.deepEqual(calls.find(call => call.name === "workflow_start")?.args, { id: "run-1", revision: 7, leaseId: "lease-1" });
  assert.equal(panel.selected?.execution, "running");
  await panel.teardown();
});

test("polling never fabricates worker progress and stop waits for server state", async () => {
  const { panel, timers, update } = fixture();
  await panel.connected();
  assert.deepEqual(timers.map(timer => timer.milliseconds), [5000, 2000]);
  await panel.perform("start", true);
  await panel.refresh();
  assert.deepEqual(panel.selected?.tasks, []);
  await panel.perform("stop", true);
  assert.equal(panel.selected?.execution, "stopping");
  await panel.refresh();
  assert.equal(panel.selected?.execution, "stopping");
  update({ revision: 10, execution: "stopped" });
  await panel.refresh();
  assert.equal(panel.selected?.execution, "stopped");
  await panel.teardown();
});

test("apply is unavailable until completed changes are visible in the difference tab", async () => {
  const { panel, calls } = fixture({ execution: "completed", review: "ready", diff: { files: [{ path: "file.ts", status: "M" }], text: "diff", fingerprint: "sha" } });
  await panel.connected();
  assert.equal(canApply(panel.selected!, "overview"), false);
  await panel.perform("apply", true);
  assert.equal(calls.some(call => call.name === "workflow_apply"), false);
  panel.state.tab = "diff";
  await panel.perform("apply", false);
  assert.deepEqual(calls.find(call => call.name === "workflow_apply")?.args, { id: "run-1", revision: 7 });
  await panel.teardown();
});

test("lost host connection disables mutations without inventing a stopped state", async () => {
  const { panel, calls, fail } = fixture();
  await panel.connected();
  await panel.perform("start", true);
  fail("transport disconnected");
  await panel.refresh();
  assert.equal(panel.state.connection, "degraded");
  assert.equal(panel.selected?.execution, "running");
  await panel.perform("stop", true);
  assert.equal(calls.some(call => call.name === "workflow_stop"), false);
  fail();
  await panel.reconnect();
  await panel.refresh();
  assert.equal(panel.state.connection, "connected");
  assert.equal(panel.state.error, "");
  await panel.teardown();
});

test("teardown stops only panel-owned runs and releases the lease after stop requests", async () => {
  const owned = fixture();
  await owned.panel.connected();
  await owned.panel.perform("start", true);
  await owned.panel.teardown();
  await owned.panel.teardown();
  assert.equal(owned.calls.filter(call => call.name === "workflow_stop").length, 1);
  assert.deepEqual(owned.calls.at(-1), { name: "workflow_panel_lease", args: { leaseId: "lease-1", release: true } });
  assert.ok(owned.timers.every(timer => timer.disposed));
  const other = fixture({ execution: "running" });
  await other.panel.connected();
  await other.panel.teardown();
  assert.equal(other.calls.some(call => call.name === "workflow_stop"), false);
});

test("revision errors remain actionable and do not overwrite the saved run", async () => {
  const { panel, fail } = fixture();
  await panel.connected();
  fail("REVISION_CONFLICT: expected revision 7");
  await panel.perform("start", true);
  assert.equal(panel.selected?.revision, 7);
  assert.match(panel.state.error, /刷新记录并核对当前版本后重试/);
  fail();
  await panel.teardown();
});

test("tool errors and workflow output cannot become executable HTML", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)"> & \'test\''), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;");
  assert.throws(() => toolPayload({ isError: true, content: [{ type: "text", text: "worker failed" }] }), /worker failed/);
  assert.deepEqual(toolPayload({ content: [{ type: "text", text: '{"run":null}' }] }), { run: null });
  assert.throws(() => toolPayload({ content: [{ type: "text", text: "invalid" }] }), /有效 JSON/);
});

test("a lease acquired during teardown is immediately released without starting poll timers", async () => {
  let resolveLease!: (value: { structuredContent: { leaseId: string } }) => void;
  const acquired = new Promise<{ structuredContent: { leaseId: string } }>(resolve => { resolveLease = resolve; });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let timerCount = 0;
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (!args.release) return acquired;
    return { structuredContent: { leaseId: "late-lease" } };
  }, () => {}, () => { timerCount++; return () => {}; });
  const connecting = panel.connected();
  await panel.teardown();
  resolveLease({ structuredContent: { leaseId: "late-lease" } });
  await connecting;
  assert.deepEqual(calls.at(-1), { name: "workflow_panel_lease", args: { leaseId: "late-lease", release: true } });
  assert.equal(timerCount, 0);
  assert.equal(panel.state.connection, "closed");
});

test("an older list response cannot discard a preview saved while polling", async () => {
  const first = draft();
  const created = { ...draft(), id: "run-new", revision: 1 };
  let pendingList: Promise<{ structuredContent: { runs: WorkflowRun[] } }> | undefined;
  let resolveList!: (value: { structuredContent: { runs: WorkflowRun[] } }) => void;
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return pendingList ?? { structuredContent: { runs: [first] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { structuredContent: { run: created } };
  }, () => {}, () => () => {});
  await panel.connected();
  pendingList = new Promise(resolve => { resolveList = resolve; });
  const polling = panel.refresh();
  await panel.save({ projectPath: "/project", script: "return args", args: {}, allowWrite: false });
  resolveList({ structuredContent: { runs: [first] } });
  await polling;
  assert.equal(panel.selected?.id, "run-new");
  assert.equal(panel.state.runs.length, 2);
  await panel.teardown();
});

test("saved definitions load independently and create a fresh run for a different project", async () => {
  const definition = { id: "saved:review", name: "review", description: "Reusable review", source: "saved" as const, revision: 3, script: "return await agent(args.prompt)", args: { prompt: "Review" }, allowWrite: true };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: [draft()] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return { structuredContent: definition };
    return { structuredContent: { run: { ...draft(), id: "second-project-run", projectPath: "/other-project" } } };
  }, () => {}, () => () => {});
  await panel.connected();
  const loaded = await panel.loadTemplate("saved:review");
  assert.equal(loaded?.revision, 3);
  assert.equal(panel.selected?.id, "run-1");
  await panel.save({ projectPath: "/other-project", script: loaded!.script, args: loaded!.args, allowWrite: loaded!.allowWrite! });
  const preview = calls.find(call => call.name === "workflow_preview");
  assert.deepEqual(preview?.args, { projectPath: "/other-project", script: definition.script, args: definition.args, allowWrite: true });
  assert.equal(preview?.args.id, undefined);
  assert.equal(preview?.args.workspacePath, undefined);
  assert.equal(panel.selected?.id, "second-project-run");
  await panel.teardown();
});

test("an explicitly selected workflow remains independent of history polling until a real run is selected", async () => {
  const definition = { id: "saved:review", name: "review", description: "Reusable review", source: "saved", script: "return args", meta: { name: "review", description: "Review", parameters: [{ name: "bugId", label: "Bug ID", type: "string", required: true }] }, args: {} };
  const calls: string[] = [];
  const panel = new WorkflowPanelController(async name => {
    calls.push(name);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: [draft()] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [definition] } };
    if (name === "workflow_get_template") return { structuredContent: definition };
    return { structuredContent: { run: draft() } };
  }, () => {}, () => () => {});
  await panel.connected();
  panel.selectTemplate(definition.id);
  await panel.loadTemplate(definition.id);
  await panel.refresh();
  assert.equal(panel.selected, undefined);
  assert.deepEqual(panel.state.definition?.meta, definition.meta);
  assert.deepEqual(panel.state.definition?.args, {});
  assert.equal(calls.includes("workflow_preview"), false);
  assert.equal(calls.includes("workflow_start"), false);
  const external = { ...draft(), id: "external-run", args: { bugId: "original-id" } };
  panel.receive({ structuredContent: { run: external } });
  assert.equal(panel.selected?.id, "external-run");
  assert.deepEqual(panel.selected?.args, external.args);
  panel.selectTemplate(undefined);
  await panel.refreshTemplates();
  await panel.refresh();
  assert.equal(panel.state.selectedTemplate, undefined);
  assert.equal(panel.selected, undefined);
  await panel.teardown();
});

test("a template response cannot overwrite a later workflow selection or closed panel", async () => {
  for (const close of [false, true]) {
    let respond!: (response: { structuredContent: Record<string, unknown> }) => void;
    const response = new Promise<{ structuredContent: Record<string, unknown> }>(resolve => { respond = resolve; });
    const panel = new WorkflowPanelController(async name => {
      if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
      if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
      if (name === "workflow_list_runs") return { structuredContent: { runs: [] } };
      if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
      if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Execution settings unavailable in this delayed-template fixture." }] };
      return response;
    }, () => {}, () => () => {});
    await panel.connected();
    panel.selectTemplate("first");
    const loading = panel.loadTemplate("first");
    if (close) await panel.teardown();
    else panel.selectTemplate("second");
    respond({ structuredContent: { id: "first", script: "return args", args: { old: true } } });
    assert.equal(await loading, undefined);
    assert.equal(panel.state.definition, undefined);
    assert.equal(panel.state.selectedTemplate, close ? "first" : "second");
    assert.equal(panel.state.connection, close ? "closed" : "connected");
    if (!close) await panel.teardown();
  }
});

test("saving a loaded definition includes its revision and refreshes the workflow library", async () => {
  const saved = { id: "saved:review", name: "review", description: "Reusable review", source: "saved" as const, revision: 4 };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let listCount = 0;
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args });
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: [] } };
    if (name === "workflow_list_templates") { listCount++; return { structuredContent: { templates: listCount > 1 ? [saved] : [] } }; }
    return { structuredContent: { template: saved } };
  }, () => {}, () => () => {});
  await panel.connected();
  await panel.saveTemplate({ script: "return args", args: [1, 2], allowWrite: false }, 3);
  assert.deepEqual(calls.find(call => call.name === "workflow_save_template")?.args, { script: "return args", args: [1, 2], allowWrite: false, revision: 3 });
  assert.equal(listCount, 2);
  assert.equal(panel.state.selectedTemplate, "saved:review");
  assert.equal(panel.state.templates[0]?.revision, 4);
  assert.equal(calls.some(call => call.name === "workflow_preview"), false);
  await panel.teardown();
});

test("a duplicate definition name asks for loading the existing revision before saving", async () => {
  const panel = new WorkflowPanelController(async name => {
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease-1" } };
    if (name === "workflow_get_projects") return { structuredContent: { available: true, projects: [] } };
    if (name === "workflow_list_runs") return { structuredContent: { runs: [] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    return { isError: true, content: [{ type: "text", text: "REVISION_CONFLICT: definition already exists" }] };
  }, () => {}, () => () => {});
  await panel.connected();
  assert.equal(await panel.saveTemplate({ script: "return args", args: null, allowWrite: false }), undefined);
  assert.match(panel.state.error, /从工作流库载入当前定义后再修改/);
  assert.equal(panel.state.runs.length, 0);
  await panel.teardown();
});

test("host context changes immediately update theme, fonts and supplied style variables", () => {
  let theme = "";
  let fonts = "";
  const properties: Record<string, string | undefined> = {};
  const effects = { theme: (value: string) => { theme = value; }, variables: (values: Record<string, string | undefined>) => { Object.assign(properties, values); }, fonts: (value: string) => { fonts = value; } };
  applyPanelHostStyles({ theme: "dark", styles: { variables: { "--color-background-primary": "#181818", "--font-text-sm-size": "14px", "--font-sans": "system-ui" }, css: { fonts: "@font-face{font-family:HostFont}" } } }, effects);
  assert.equal(theme, "dark");
  assert.equal(properties["--color-background-primary"], "#181818");
  assert.equal(properties["--font-text-sm-size"], "14px");
  assert.match(fonts, /HostFont/);
  applyPanelHostStyles({ theme: "light", styles: { variables: { "--color-background-primary": "#ffffff", "--font-text-sm-size": "15px", "--border-radius-md": "10px" } } }, effects);
  assert.equal(theme, "light");
  assert.equal(properties["--color-background-primary"], "#ffffff");
  assert.equal(properties["--font-text-sm-size"], "15px");
  assert.equal(properties["--font-sans"], "system-ui");
  assert.equal(properties["--border-radius-md"], "10px");
});

test("editor JSON preserves null, strings, arrays and primitive workflow inputs", () => {
  for (const value of [null, "a string input", [1, "second"], true, 12, { files: ["src/index.ts"] }]) {
    assert.deepEqual(JSON.parse(jsonInput(value)), value);
  }
});

test("preview and edit preserve the declared network, MCP, workspace and maintenance scope", async () => {
  const { panel, calls } = fixture();
  await panel.connected();
  const input = {
    projectPath: "/project", script: "return await operation('build')", args: {}, allowWrite: true,
    networkAccess: true, allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["binary_session"] }, workspaceMode: "git-worktree" as const,
    maintenance: { steps: [{ id: "build", command: ["npm", "run", "build"], networkAccess: false }], activation: { serverName: "rea", command: "node", args: ["${WORKSPACE}/runtime/index.js"] } },
  };
  await panel.save(input);
  assert.deepEqual(calls.find(call => call.name === "workflow_preview")?.args, input);
  await panel.save(input, { id: "run-1", revision: 7 });
  assert.deepEqual(calls.find(call => call.name === "workflow_update")?.args, {
    id: "run-1", revision: 7, script: input.script, args: {}, allowWrite: true,
    networkAccess: true, allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["binary_session"] }, workspaceMode: "git-worktree", maintenance: input.maintenance,
  });
  await panel.teardown();
});

test("completed maintenance reviews can be applied from the difference tab without fabricated file diffs", () => {
  const run = { ...draft(), execution: "completed" as const, maintenanceReview: { steps: [{ id: "build", exitCode: 0 }], diff: { files: [] } } };
  assert.equal(canApply(run, "overview"), false);
  assert.equal(canApply(run, "diff"), true);
  assert.equal(canApply({ ...run, execution: "running" }, "diff"), false);
});

test("activation failure after repository application remains reviewable for an activation-only retry", () => {
  const run = { ...draft(), execution: "completed" as const, application: "partial" as const, activation: { status: "failed" as const, serverName: "target" } };
  assert.equal(canApply(run, "overview"), false);
  assert.equal(canApply(run, "diff"), true);
  assert.equal(canApply({ ...run, application: "applied" }, "diff"), false);
});

test("partial application without an activation failure reports unfinished submodule steps", () => {
  const run = { ...draft(), execution: "completed" as const, application: "partial" as const, maintenanceReview: { submodules: [] } };
  assert.equal(canApply(run, "diff"), true);
  assert.match(partialApplicationMessage(run), /子模块.*未完成步骤/);
  assert.doesNotMatch(partialApplicationMessage(run), /激活失败|仅处理激活/);
  assert.match(partialApplicationMessage({ ...run, activation: { status: "failed", serverName: "target" } }), /激活失败.*仅处理激活/);
  assert.equal(partialApplicationMessage({ ...run, application: "applied" }), "");
});

test("MCP grant input accepts exact name arrays and rejects malformed or prototype keys", () => {
  assert.deepEqual(parseToolGrants('{"rea":["binary_session"],"other":[]}'), { rea: ["binary_session"], other: [] });
  for (const value of ['[]', 'null', '{"rea":"all"}', '{"rea":[" "]}', '{"__proto__":["unsafe"]}']) assert.throws(() => parseToolGrants(value), /MCP/);
});

test("maintenance presentation bounds large artifact manifests while preserving review identifiers", () => {
  const artifacts = Array.from({ length: 100000 }, (_, index) => ({ path: `node_modules/pkg-${index}/file.js`, size: index, kind: "file", hash: "full-manifest-hash" }));
  const summary = summarizeMaintenanceReview({ base: "base", target: "target", branch: "main", artifacts, artifactFingerprint: "artifact-pin", fingerprint: "review-pin", preparedClean: true, diff: { text: "source changes" } });
  assert.equal(summary.artifactCount, 100000);
  assert.equal(summary.artifacts.length, 30);
  assert.equal(summary.artifactFingerprint, "artifact-pin");
  assert.equal(summary.fingerprint, "review-pin");
  assert.equal(summary.preparedClean, true);
  assert.equal(JSON.stringify(summary).includes("pkg-99999"), false);
  assert.equal(JSON.stringify(summary).includes("full-manifest-hash"), false);
  assert.ok(JSON.stringify(summary).length < 5000);
});

test("unsupported workspace preparation reports the actual boundary without a misleading refresh suggestion", async () => {
  const { panel, fail } = fixture();
  await panel.connected();
  fail("Unsupported workspace entry: third_party/binwalk");
  await panel.perform("start");
  assert.match(panel.state.error, /third_party\/binwalk/);
  assert.match(panel.state.error, /准备未完成.*未启动新 worker/);
  assert.doesNotMatch(panel.state.error, /刷新|重试/);
  fail();
  await panel.teardown();
});

test("ordinary validation failures do not suggest refreshing or reloading an unrelated saved definition", async () => {
  const { panel, fail } = fixture();
  await panel.connected();
  fail("Maintenance operations require git-worktree isolation and allowWrite");
  await panel.save({ projectPath: "/project", script: "return args", args: {}, allowWrite: false });
  assert.doesNotMatch(panel.state.error, /刷新|重试/);
  await panel.saveTemplate({ script: "return args", args: {}, allowWrite: false });
  assert.doesNotMatch(panel.state.error, /刷新|重试|从工作流库载入/);
  fail();
  await panel.teardown();
});
