import test from "node:test";
import assert from "node:assert/strict";
import { compileDefinition } from "../src/definition.ts";
import type { WorkflowDefinition } from "../src/definition.ts";
import type { StructuredRun } from "../src/structured-types.ts";
import { projectStructuredRun } from "../src/structured-projection.ts";
import { WorkflowPanelController, NodeProcessReader, PanelDialogLifecycle, applyPanelHostStyles, panelInputSignature, parseRun, panelCanvasInput, renderNodeProcess, renderPreparation, instanceDisplayLabel, renderScopeOptions, toolPayload } from "../prototypes/panel.ts";
import type { ToolCaller, ToolResponse } from "../prototypes/panel.ts";
import { readParameters, renderParameterFields } from "../prototypes/panel-parameters.ts";
const definition: WorkflowDefinition = { schemaVersion: 1, name: "control-demo", description: "Structured view fixture", parameters: [{ name: "enabled", type: "boolean", default: false }], steps: [{ id: "choose", type: "choice", label: "分支", cases: [{ id: "yes", when: { ref: "args.enabled" }, steps: [{ id: "inside", type: "transform", value: true }] }], default: [] }, { id: "loop", type: "repeat", label: "循环", maxIterations: 3, steps: [{ id: "body", type: "transform", value: { ref: "iteration" } }] }, { id: "after", type: "transform", value: "done" }] };
function run(revision = 1): StructuredRun { const compiled = compileDefinition(definition); return { format: "structured-v1", id: "wf_demo", revision, definition: compiled.definition, definitionHash: compiled.hash, compiled, args: { enabled: false }, projectPath: "/project", grants: { allowWrite: false, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot", approvalMode: "never" }, limits: { maxReadWorkers: 2, maxCalls: 8, timeoutMs: 30000, maxTokens: 10000, maxInstances: 100 }, status: "draft", instances: [], events: [], createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z" }; }
const reply = (data: unknown): ToolResponse => ({ structuredContent: data });
function fixture(override?: ToolCaller) {
    let value = run();
    const calls: Array<{
        name: string;
        args: Record<string, unknown>;
    }> = [];
    const caller: ToolCaller = async (name, args) => {
        calls.push({ name, args });
        if (override) {
            const response = await override(name, args);
            if (response.structuredContent !== undefined)
                return response;
        }
        if (name === "workflow_get_projects")
            return reply({ available: true, currentProjectId: "p", projects: [{ projectId: "p", path: "/project", label: "Project", hostId: "local" }] });
        if (name === "workflow_list_runs")
            return reply({ runs: [{ id: value.id, revision: value.revision, name: value.definition.name, status: value.status, projectPath: value.projectPath, createdAt: value.createdAt }] });
        if (name === "workflow_list_templates")
            return reply({ templates: [] });
        if (name === "workflow_get_run")
            return reply({ run: value, projection: projectStructuredRun(value, args.scopeInstanceId ? { scopeInstanceId: String(args.scopeInstanceId) } : {}) });
        if (name === "workflow_preview")
            value = { ...run(value.revision + 1), id: "wf_new", args: args.args as StructuredRun["args"] };
        if (name === "workflow_start")
            value = { ...value, revision: value.revision + 1, status: "running" };
        return reply({ run: value, projection: projectStructuredRun(value) });
    };
    const panel = new WorkflowPanelController(caller, () => { }, () => () => { });
    return { panel, calls, set: (next: StructuredRun) => { value = next; } };
}
function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} { let resolve!: (value: T) => void; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
test("old JavaScript records are rejected without a compatibility path", () => { assert.throws(() => parseRun({ id: "old", revision: 1, meta: { name: "old" }, script: "return 1", tasks: [], logs: [] }), /旧脚本/); assert.equal(parseRun(run()).format, "structured-v1"); });
test("tool errors are inspected before JSON result parsing", () => { assert.throws(() => toolPayload({ isError: true, content: [{ type: "text", text: "permission denied" }] }), /permission denied/); assert.deepEqual(toolPayload({ content: [{ type: "text", text: '{"ok":true}' }] }), { ok: true }); });
test("progress revisions do not change the parameter draft signature", () => { const initial = run(); assert.equal(panelInputSignature(initial), panelInputSignature({ ...initial, revision: 5, status: "running", events: [{ sequence: 1, at: initial.createdAt, type: "started" }] })); assert.notEqual(panelInputSignature(initial), panelInputSignature({ ...initial, args: { enabled: true } })); });
test("authoritative project binding cannot be replaced by panel arguments", async () => { const { panel } = fixture(); panel.setProjectPath("/other"); await panel.connected(); assert.equal(panel.state.project?.path, "/project"); assert.match(panel.state.error, /宿主确认/); await panel.teardown(); });
test("a missing current project does not fall back to a recent project", async () => { const { panel } = fixture(async (name) => name === "workflow_get_projects" ? reply({ available: true, projects: [{ projectId: "p", path: "/project", label: "Project", hostId: "local" }] }) : {}); await panel.connected(); assert.equal(panel.state.project, undefined); assert.match(panel.state.projectsError, /项目聊天/); await panel.teardown(); });
test("foreign run is never adopted into the current project panel", async () => { const { panel } = fixture(async (name) => name === "workflow_get_run" ? reply({ run: { ...run(), projectPath: "/other" } }) : {}); await panel.connected(); await panel.selectRun("foreign"); assert.equal(panel.state.run, undefined); assert.match(panel.state.error, /不属于当前聊天项目/); await panel.teardown(); });
test("parameter edits create an independent preview with a frozen definition", async () => { const { panel, calls } = fixture(); await panel.connected(); await panel.selectRun("wf_demo"); await panel.createPreview({ enabled: true }); const call = calls.find(item => item.name === "workflow_preview")!; assert.deepEqual(call.args.args, { enabled: true }); assert.deepEqual(call.args.definition, run().definition); assert.equal(panel.selected?.id, "wf_new"); assert.equal(calls.some(item => item.name === "workflow_update"), false); await panel.teardown(); });
test("a failed start response is not automatically resent", async () => {
    const { panel, calls } = fixture(async (name) => {
        if (name === "workflow_start")
            throw new Error("transport closed after dispatch");
        return {};
    });
    await panel.connected();
    await panel.selectRun("wf_demo");
    await assert.rejects(panel.perform("start"), /transport/);
    assert.equal(calls.filter(item => item.name === "workflow_start").length, 1);
    assert.match(panel.state.error, /不会自动重复发送/);
    assert.equal(panel.state.busy, false);
    await panel.teardown();
});
test("stale snapshot responses do not replace a newer selection", async () => { const pending = deferred<ToolResponse>(); let block = false; const { panel } = fixture(async (name) => name === "workflow_get_run" && block ? pending.promise : {}); await panel.connected(); await panel.selectRun("wf_demo"); block = true; const old = panel.refresh(); await panel.selectTemplate("missing"); pending.resolve(reply({ run: { ...run(4), id: "old" }, projection: projectStructuredRun({ ...run(4), id: "old" }) })); await old; assert.notEqual(panel.selected?.id, "old"); await panel.teardown(); });
test("node log reads can complete while a run snapshot is blocked", async () => { const snapshot = deferred<ToolResponse>(); let block = false; const { panel } = fixture(async (name) => name === "workflow_get_run" && block ? snapshot.promise : {}); await panel.connected(); await panel.selectRun("wf_demo"); block = true; const polling = panel.refresh(); const results: unknown[] = []; const reader = new NodeProcessReader(async () => reply({ process: { output: "ok" } }), (_, process) => results.push(process), () => { }); reader.select({ runId: "wf_demo", instanceId: "i1", detail: "brief" }); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(results, [{ output: "ok" }]); snapshot.resolve(reply({ run: run(), projection: projectStructuredRun(run()) })); await polling; reader.select(); await panel.teardown(); });
test("late log responses cannot overwrite a newly selected attempt", async () => { const first = deferred<ToolResponse>(), received: string[] = []; const reader = new NodeProcessReader(async (_name, args) => args.attemptId === "a1" ? first.promise : reply({ process: { output: "second" } }), (target) => received.push(target.attemptId ?? ""), () => { }); reader.select({ runId: "r", instanceId: "i", attemptId: "a1", detail: "brief" }); reader.select({ runId: "r", instanceId: "i", attemptId: "a2", detail: "brief" }); await new Promise(resolve => setTimeout(resolve, 0)); first.resolve(reply({ process: { output: "first" } })); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(received, ["a2"]); reader.select(); });
test("brief node logs show the selected attempt, not an unrelated historical error", () => { const process = { selectedAttemptId: "new", attempts: [{ id: "old", status: "failed" as const, startedAt: "now", activities: [], logs: [], error: "old failure" }, { id: "new", status: "completed" as const, startedAt: "now", activities: [], logs: [], output: "new result" }] }; const html = renderNodeProcess(process); assert.match(html, /new result/); assert.doesNotMatch(html, /old failure/); });
test("dialog generation invalidates old save callbacks only when closed or reopened", () => { let onClose = () => { }; const dialog = { open: true, addEventListener: (_event: string, fn: () => void) => { onClose = fn; } } as unknown as HTMLDialogElement; const lifecycle = new PanelDialogLifecycle(dialog); lifecycle.opened(); const old = lifecycle.current(); assert.equal(old(), true); onClose(); assert.equal(old(), false); lifecycle.opened(); assert.equal(old(), false); assert.equal(lifecycle.current()(), true); });
test("parameter defaults, numeric types and structured values follow the declared schema", () => { const parameters = [{ name: "rounds", label: "轮次", type: "integer" as const, required: true }, { name: "options", type: "object" as const }, { name: "enabled", type: "boolean" as const, default: false }]; assert.deepEqual(readParameters(parameters, new Map([["rounds", "3"], ["options", '{"x":1}']])), { rounds: 3, options: { x: 1 }, enabled: false }); assert.throws(() => readParameters(parameters, { rounds: "3.2" }), /格式/); assert.match(renderParameterFields(parameters, { rounds: 3 }), /data-parameter-type="integer"/); assert.doesNotMatch(renderParameterFields(parameters, {}), /value="undefined"/); });
test("host theme variables and fonts are inherited including native menu scheme", () => { const calls: unknown[] = []; applyPanelHostStyles({ styles: { variables: { "--color-background-primary": "#181818" }, css: { fonts: "@font-face{}" } } }, { theme: value => calls.push(value), variables: value => calls.push(value), fonts: value => calls.push(value) }); assert.equal(calls[0], "dark"); assert.equal(calls[2], "@font-face{}"); });
test("completed runs are executed again through a fresh preview", async () => {
    const { panel, calls, set } = fixture();
    set({ ...run(), status: "completed" });
    await panel.connected();
    await panel.selectRun("wf_demo");
    await panel.perform("start");
    assert.ok(calls.findIndex(call => call.name === "workflow_preview") < calls.findIndex(call => call.name === "workflow_start"));
    assert.equal(calls.find(call => call.name === "workflow_start")?.args.id, "wf_new");
    await panel.teardown();
});
test("a mutation acknowledgment cannot replace a later run selection", async () => {
    const pending = deferred<ToolResponse>();
    const { panel } = fixture(async (name, args) => name === "workflow_start" ? pending.promise : name === "workflow_get_run" && args.id === "other" ? reply({ run: { ...run(), id: "other" } }) : {});
    await panel.connected();
    await panel.selectRun("wf_demo");
    const start = panel.perform("start");
    await panel.selectRun("other");
    pending.resolve(reply({ run: { ...run(4), status: "running" } }));
    await start;
    assert.equal(panel.selected?.id, "other");
    await panel.teardown();
});
test("scope reads pass an activation identity and ignore older in-flight projections", async () => {
    const pending = deferred<ToolResponse>();
    let block = false;
    const { panel, calls, set } = fixture(async (name) => name === "workflow_get_run" && block ? pending.promise : {});
    const value = run();
    value.instances.push({ id: "scope-1", nodeId: "loop", type: "scope", label: "第一轮", path: "loop/0", iteration: 0, status: "completed", attempts: [] });
    set(value);
    await panel.connected();
    await panel.selectRun(value.id);
    block = true;
    const old = panel.refresh();
    await panel.selectScope("scope-1");
    pending.resolve(reply({ run: run(2), projection: projectStructuredRun(run(2)) }));
    await old;
    assert.equal(panel.selected?.revision, 1);
    block = false;
    await panel.refresh();
    assert.equal(calls.at(-1)?.args.scopeInstanceId, "scope-1");
    await panel.teardown();
});
test("a mismatched projection revision is rejected instead of silently painting it", async () => {
    const { panel } = fixture(async (name) => name === "workflow_get_run" ? reply({ run: run(2), projection: projectStructuredRun(run(1)) }) : {});
    await panel.connected();
    await panel.selectRun("wf_demo");
    assert.match(panel.state.error, /投影版本不一致/);
    await panel.teardown();
});
test("structured parameters are preserved without asking users to edit JSON", () => {
    const parameters = [{ name: "objects", type: "object" as const, required: true }];
    const html = renderParameterFields(parameters, { objects: { version: 2 } });
    assert.match(html, /由 AI 维护/);
    assert.doesNotMatch(html, /textarea/);
    assert.deepEqual(readParameters(parameters, {}, { objects: { version: 2 } }), { objects: { version: 2 } });
});
test("an attempt without an output cannot inherit another attempt's instance output", () => {
    const html = renderNodeProcess({ selectedAttemptId: "old", instance: { ...run().instances[0], output: "new output" } as never, attempts: [{ id: "old", status: "failed", startedAt: "now", error: "old error", activities: [], logs: [] }] });
    assert.match(html, /old error/);
    assert.doesNotMatch(html, /new output/);
});
test("run history pages append without replacing the current selection", async () => {
    const { panel, calls } = fixture(async (name, args) => name === "workflow_list_runs" ? reply({ runs: [{ id: args.offset ? "older" : "wf_demo", revision: 1, status: "draft", name: "fixture", projectPath: "/project", createdAt: "now" }], ...(args.offset ? {} : { nextOffset: 1 }) }) : {});
    await panel.connected();
    await panel.selectRun("wf_demo");
    await panel.moreRuns();
    assert.deepEqual(panel.state.runs.map(run => run.id), ["wf_demo", "older"]);
    assert.equal(panel.selected?.id, "wf_demo");
    assert.equal(panel.state.runNextOffset, undefined);
    assert.equal(calls.filter(call => call.name === "workflow_list_runs").at(-1)?.args.offset, 1);
    await panel.teardown();
});
test("preparation renders only reported stages, including waiting and real failure", () => {
    assert.equal(renderPreparation(), "");
    const html = renderPreparation([{ id: "settings", label: "读取执行配置", status: "completed" }, { id: "workspace", label: "等待项目写入锁", status: "running" }]);
    assert.match(html, /data-status="completed"/);
    assert.match(html, /等待项目写入锁/);
    assert.match(html, /is-spinning/);
    assert.doesNotMatch(html, /checkpoint|验证成功/);
});
test("a selected attempt outside the loaded history page cannot inherit current failure", () => {
    const html = renderNodeProcess({ selectedAttemptId: "older-than-page", attempts: [], instance: { error: "current failure" } as never, output: "historical success" });
    assert.match(html, /historical success/);
    assert.doesNotMatch(html, /current failure/);
});
test("pause and stop pin the displayed execution owner without retrying control requests", async () => {
    const { panel, calls, set } = fixture(async (name) => { if (name === "workflow_pause" || name === "workflow_stop")
        throw new Error("control acknowledgment interrupted"); return {}; });
    set({ ...run(), status: "running", ownerToken: "current-execution-token" });
    await panel.connected();
    await panel.selectRun("wf_demo");
    for (const action of ["pause", "stop"] as const) {
        await assert.rejects(panel.perform(action), /interrupted/);
        const controls = calls.filter(call => call.name === `workflow_${action}`);
        assert.equal(controls.length, 1);
        assert.equal(controls[0]!.args.expectedOwnerToken, "current-execution-token");
        assert.equal(controls[0]!.args.revision, 1);
    }
    await panel.teardown();
});
test("start and resume do not broaden CAS by forwarding an owner token", async () => {
    const { panel, calls, set } = fixture();
    set({ ...run(), ownerToken: "not-for-start-or-resume" });
    await panel.connected();
    await panel.selectRun("wf_demo");
    await panel.perform("start");
    await panel.perform("resume", { recoveryFingerprint: "f".repeat(64) });
    assert.equal(calls.find(call => call.name === "workflow_start")!.args.expectedOwnerToken, undefined);
    assert.equal(calls.find(call => call.name === "workflow_resume")!.args.expectedOwnerToken, undefined);
    assert.equal(calls.filter(call => call.name === "workflow_resume").length, 1);
    await panel.teardown();
});
test("the scope picker names the authoritative selected iteration and keeps sibling options", () => {
    const scopes = [0, 1].map(iteration => ({ id: `scope-${iteration}`, nodeId: "loop", type: "scope" as const, label: `第 ${iteration + 1} 轮`, path: `loop/${iteration}`, status: "completed" as const, attempts: [], iteration }));
    const html = renderScopeOptions(scopes, "scope-0");
    assert.match(html, /value="scope-0" selected/);
    assert.match(html, /value="scope-1"/);
    assert.match(html, /value="">整个运行/);
    assert.equal((instanceDisplayLabel(scopes[0]!).match(/第\s*1\s*轮/g) ?? []).length, 1);
    assert.match(renderScopeOptions(scopes), /value="" selected>整个运行/);
});
test("canvas input keeps semantic projection and execution identity through progress updates", () => {
    const value=run(),projection=projectStructuredRun(value),collapsed=new Set(["loop"]);
    const initial=panelCanvasInput({run:value,projection},"body",collapsed);
    const progressed=panelCanvasInput({run:{...value,revision:value.revision+5},projection:{...projection,revision:projection.revision+5}},"inside",collapsed);
    assert.equal(initial.plan,projection);assert.equal(initial.projection,projection);assert.equal(initial.identity,progressed.identity);
    assert.equal(initial.selectedNodeId,"body");assert.equal(progressed.selectedNodeId,"inside");
    collapsed.add("choose");assert.deepEqual([...initial.collapsed],["loop"]);
});
test("switching a run or saved definition resets canvas identity without adding runtime semantics",()=>{
    const initial=run(),other={...initial,id:"wf_other"};
    assert.notEqual(panelCanvasInput({run:initial},undefined,new Set()).identity,panelCanvasInput({run:other},undefined,new Set()).identity);
    const empty=panelCanvasInput({},undefined,new Set());assert.equal(empty.plan,undefined);assert.equal(empty.projection,undefined);assert.equal(empty.identity,"empty");
    const record={id:"def",revision:1,definition:initial.definition,hash:initial.definitionHash,createdAt:initial.createdAt,updatedAt:initial.updatedAt,plan:initial.compiled.plan};
    const first=panelCanvasInput({template:record},undefined,new Set()),second=panelCanvasInput({template:{...record,revision:2}},undefined,new Set());
    assert.notEqual(first.identity,second.identity);assert.equal(first.plan,record.plan);
});
test("a lost host connection retains the authoritative canvas snapshot and selection identity",async()=>{
    const {panel}=fixture();await panel.connected();await panel.selectRun("wf_demo");
    const before=panelCanvasInput(panel.state,"body",new Set(["loop"]));
    panel.disconnected(new Error("host connection closed"));
    const after=panelCanvasInput(panel.state,"body",new Set(["loop"]));
    assert.equal(panel.state.connection,"degraded");assert.equal(after.identity,before.identity);assert.equal(after.projection,before.projection);assert.equal(after.plan,before.plan);assert.equal(after.selectedNodeId,"body");
    await panel.teardown();
});

test("a node or attempt identity switch clears old content before the new read can fail",async()=>{
    let body="old node result",developer="old node logs",loading="",failure="",changes=0;
    const pending=deferred<ToolResponse>();
    const reader=new NodeProcessReader(async()=>pending.promise,()=>{},error=>{failure=String(error);},target=>{changes++;body="";developer="";loading=`${target.runId}/${target.instanceId}/${target.attemptId??"current"}/${target.detail}`;});
    reader.select({runId:"r",instanceId:"node-b",attemptId:"attempt-b",detail:"developer"});
    assert.equal(body,"");assert.equal(developer,"");assert.match(loading,/node-b\/attempt-b\/developer/);
    pending.resolve({isError:true,content:[{type:"text",text:"read failed"}]});await new Promise(resolve=>setTimeout(resolve,0));
    assert.match(failure,/read failed/);assert.equal(body,"");assert.equal(developer,"");assert.equal(changes,1);reader.select();
});
test("same-subject polling and history paging do not repeatedly clear visible logs",async()=>{
    let changes=0;
    const reader=new NodeProcessReader(async()=>reply({process:{activities:[]}}),()=>{},()=>{},()=>{changes++;});
    const target={runId:"r",instanceId:"i",detail:"brief" as const};
    reader.select(target);await new Promise(resolve=>setTimeout(resolve,0));await reader.refresh();
    reader.select({...target,attemptOffset:30});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(changes,1);
    reader.select({...target,attemptId:"old-attempt"});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(changes,2);reader.select();
});
test("a control acknowledgment keeps the chosen iteration and reads its new scoped projection once",async()=>{
    let current={...run(),status:"running" as const};
    current.instances.push({id:"round-1",nodeId:"loop",type:"scope",label:"第 1 轮",path:"loop/0",iteration:0,status:"completed",attempts:[]});
    const f=fixture(async(name)=>{
        if(name==="workflow_pause"){current={...current,revision:current.revision+1,status:"paused"} as typeof current;f.set(current);return reply({run:current,projection:projectStructuredRun(current)});}
        return {};
    });
    f.set(current);await f.panel.connected();await f.panel.selectRun(current.id);await f.panel.selectScope("round-1");await f.panel.perform("pause");
    assert.equal(f.panel.state.run?.status,"paused");assert.equal(f.panel.state.projection?.scopeInstanceId,"round-1");
    assert.equal(f.calls.filter(call=>call.name==="workflow_pause").length,1);assert.equal(f.calls.at(-1)?.args.scopeInstanceId,"round-1");await f.panel.teardown();
});
test("a failed scoped read after an accepted control does not resend that control",async()=>{
    let current={...run(),status:"running" as const},acknowledged=false,readFailure=true;
    current.instances.push({id:"round-1",nodeId:"loop",type:"scope",label:"第 1 轮",path:"loop/0",iteration:0,status:"completed",attempts:[]});
    const f=fixture(async(name)=>{
        if(name==="workflow_pause"){acknowledged=true;current={...current,revision:current.revision+1,status:"paused"} as typeof current;f.set(current);return reply({run:current,projection:projectStructuredRun(current)});}
        if(name==="workflow_get_run"&&acknowledged&&readFailure)throw new Error("snapshot temporarily unavailable");
        return {};
    });
    f.set(current);await f.panel.connected();await f.panel.selectRun(current.id);await f.panel.selectScope("round-1");await f.panel.perform("pause");
    assert.equal(f.panel.state.projection?.scopeInstanceId,"round-1");assert.match(f.panel.state.error,/操作已受理/);assert.equal(f.panel.state.connection,"degraded");
    readFailure=false;await f.panel.refresh();assert.equal(f.panel.state.projection?.scopeInstanceId,"round-1");assert.equal(f.panel.state.run?.status,"paused");assert.equal(f.panel.state.error,"");assert.equal(f.calls.filter(call=>call.name==="workflow_pause").length,1);await f.panel.teardown();
});
test("successful reconnect clears only the connection error and preserves business failures",async()=>{
    const {panel}=fixture();await panel.connected();await panel.selectRun("wf_demo");
    panel.disconnected(new Error("temporary pipe failure"));assert.match(panel.state.error,/连接异常/);await panel.refresh();assert.equal(panel.state.error,"");assert.equal(panel.state.connection,"connected");
    panel.state.error="业务结果检查未通过";panel.disconnected(new Error("second pipe failure"));assert.equal(panel.state.error,"业务结果检查未通过");await panel.refresh();assert.equal(panel.state.error,"业务结果检查未通过");assert.equal(panel.state.connection,"connected");await panel.teardown();
});
