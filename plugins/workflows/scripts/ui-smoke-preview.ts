// Development-only host simulator. All runs, files and settings are disposable
// fixtures; production tools are routed through their actual MCP server.
import http from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { createServer } from "../src/server.ts";
import type { WorkflowRun } from "../src/types.ts";
import type { WorkerAdapter, WorkerResult } from "../src/adapter.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-ui-smoke-")));
const project = path.join(root, "project"); await mkdir(project);
const store = new RunStore(path.join(root, "state"));
const demonstrateControlFlow = process.env.WORKFLOWS_PREVIEW_CONTROL_FLOW === "1";
const fixtureAbort = new AbortController();
let reachedSecondRepair!: () => void;
const secondRepair = new Promise<void>(resolve => { reachedSecondRepair = resolve; });
const interrupted = () => Object.assign(new Error("Development fixture execution was interrupted"), { name: "AbortError" });
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(interrupted());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(interrupted()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
const adapter: WorkerAdapter = {
  executionEnvironment: async () => ({ defaults: { model: "preview-model", reasoningEffort: "medium" }, models: [{ id: "preview-model", displayName: "开发预览模型", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }] }),
  run: async (request, signal, emit) => {
    if (!demonstrateControlFlow) throw new Error("The UI fixture never invokes a real model");
    const started = Date.now(), active = AbortSignal.any([signal, fixtureAbort.signal]);
    const marker = /\[fixture:([a-z-]+)(?::(\d+))?\]/.exec(request.prompt);
    if (!marker) throw new Error("Unknown control-flow fixture task");
    const kind = marker[1], round = Number(marker[2] ?? 0);
    const label = ({ preflight: "检查开发验收目录", current: "没有新提交，使用当前代码", pull: "模拟拉取代码", build: "模拟构建完成", test: `第 ${round} 轮测试：发现待修复问题`, repair: `第 ${round} 轮修复` } as Record<string, string>)[kind!]!;
    const threadId = `development-fixture-${request.id}`, turnId = `${threadId}-turn`;
    emit({ type: "identity", threadId, turnId });
    emit({ type: "log", message: `开发替身执行器：${label}。未调用模型、命令或外部工具。` });
    const activity = (id: string, kind: "files" | "command", label: string, status: "running" | "completed", startedAt = new Date().toISOString()) => emit({ type: "activity", activity: { id: `${request.id}:${id}`, kind, label, status, startedAt, ...(status === "completed" ? { endedAt: new Date().toISOString() } : {}) } });
    const began = new Date().toISOString();
    activity("fixture", "files", label, "running", began);
    if (kind === "repair" && round === 2) {
      activity("fixture", "files", "准备第 2 轮修复", "completed", began);
      activity("inspect", "files", "读取失败测试涉及的实现", "running");
      activity("diagnostic", "command", "查看第 2 轮测试摘要（替身）", "running");
      reachedSecondRepair();
      let sequence = 0;
      while (!active.aborted) {
        await pause(1600, active);
        const label = ["核对失败用例与相关实现", "定位需要调整的逻辑", "准备修复并等待本轮验证"][sequence++ % 3]!;
        activity("repair", "files", label, "running", began);
        emit({ type: "log", message: `开发替身过程：${label}；第 2/3 轮，等待测试端停止。` });
      }
      throw interrupted();
    }
    await pause(120, active);
    activity("fixture", "files", label, "completed", began);
    const result: WorkerResult = { output: kind === "test" ? '{"passed":false}' : `开发替身已完成：${label}`, threadId, turnId, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: Date.now() - started, toolsUsed: [], ...(kind === "test" ? { data: { passed: false } } : {}) };
    return result;
  },
  close: async () => { fixtureAbort.abort(); },
};
const engine = new WorkflowEngine({ store, adapter });
let fixtureLock: () => Promise<void> = async () => {};
const demonstrateRunning = process.env.WORKFLOWS_PREVIEW_RUNNING === "1";
const demonstratePreparing = process.env.WORKFLOWS_PREVIEW_PREPARING === "1";
try {
if (demonstrateControlFlow) {
  await writeFile(path.join(project, "README.md"), "Disposable control-flow UI fixture. No real build, model or MCP calls.\n");
  const script = `export const meta = { name: "rea-control-flow-preview", description: "使用当前代码构建，最多三轮测试与修复", parameters: [{ name: "hasUpdates", label: "远端有新提交", type: "boolean", required: true }] };
await agent("[fixture:preflight] 核对当前项目", {label: "预检"});
// @flow-label: 远端有新提交？
if (args.hasUpdates) {
  await agent("[fixture:pull] 拉取更新", {label: "拉取代码", mode: "write"});
} else {
  await agent("[fixture:current] 没有新提交，使用当前代码继续构建", {label: "使用当前代码"});
}
await agent("[fixture:build] 构建当前代码", {label: "构建", mode: "write"});
let passed = false;
// @flow-label: 验证与修复
for (let round = 1; round <= 3; round++) {
  const report = await agent("[fixture:test:" + round + "] 执行本轮测试", {label: "测试", schema: {type: "object", properties: {passed: {type: "boolean"}}, required: ["passed"], additionalProperties: false}});
  // @flow-label: 测试通过？
  if (report.passed) {
    passed = true;
    break;
  } else {
    await agent("[fixture:repair:" + round + "] 修复本轮失败项", {label: "修复", mode: "write"});
  }
}
return {passed};`;
  const created = await engine.preview({ projectPath: project, script, args: { hasUpdates: false }, allowWrite: true, workspaceMode: "local", approvalMode: "never", limits: { timeoutMs: 30 * 60 * 1000, maxCalls: 20, maxReadWorkers: 2 } });
  await engine.start({ id: created.id, revision: created.revision });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([secondRepair, engine.wait(created.id).then(run => { throw new Error(`Control-flow fixture ended before the second repair: ${run.error ?? run.execution}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Control-flow fixture did not reach its second repair within 30 seconds")), 30000); })]);
  } finally { if (timer) clearTimeout(timer); }
  const run = await engine.get(created.id);
  if (run.execution !== "running" || !run.tasks.some(task => task.label === "修复" && task.status === "running") || !run.flowEvents?.some(event => event.kind === "iteration" && event.iteration === 2)) throw new Error("Control-flow fixture did not persist the expected real engine state");
} else {
const fixtureScript = 'export const meta={name:"rea-update-verify",description:"REA 更新与验收",phases:[{title:"预检"},{title:"拉取并固定提交"},{title:"依赖与构建"},{title:"MCP 验收"},{title:"审查交付"}],parameters:[{name:"branch",label:"目标分支",type:"string",required:true}]}; return args;';
const created = await engine.preview({ projectPath: project, script: fixtureScript, args: { branch: "main" } });
const at = Date.now(), time = (seconds: number) => new Date(at - seconds * 1000).toISOString();
const fixture = { ...created, execution: demonstrateRunning ? "running" : "stopped", startedAt: time(162), ...(demonstrateRunning ? {} : { endedAt: time(0) }), preparation: { startedAt: time(170), endedAt: time(162), stages: ["settings", "project", "workspace", "validation"].map((id, index) => ({ id, label: ["核对执行环境", "检查项目", "准备工作区", "完成校验"][index], status: "completed", startedAt: time(170 - index * 2), endedAt: time(168 - index * 2) })) },
  tasks: ["工具链已确认", "提交已固定", "正在运行构建"].map((label, index) => ({ id: `task_${index + 1}`, index, label, phase: created.meta.phases![index]!.title, prompt: "Private development fixture prompt", options: {}, mode: "read", status: index === 2 ? "running" : "completed", cached: false, currentActivity: { id: `activity_${index + 1}`, kind: index === 2 ? "command" : "files", label, status: index === 2 ? "running" : "completed", startedAt: time(index === 2 ? 78 : 160 - index * 15), ...(index === 2 ? {} : { endedAt: time(148 - index * 15) }) }, attempts: [{ id: `attempt_${index + 1}`, status: index === 2 ? "running" : "completed", startedAt: time(index === 2 ? 78 : 160 - index * 15), ...(index === 2 ? {} : { endedAt: time(148 - index * 15) }), activities: [{ id: `activity_${index + 1}`, kind: "command", label, status: index === 2 ? "running" : "completed", startedAt: time(78) }] }] })),
  logs: [{ at: time(5), level: "info", taskId: "task_3", message: "Development diagnostic: build started" }],
} as WorkflowRun;
if (demonstratePreparing) {
  fixture.execution = "preparing";
  fixture.startedAt = fixture.preparation!.startedAt;
  delete fixture.endedAt;
  delete fixture.preparation!.endedAt;
  const validation = fixture.preparation!.stages.at(-1)!;
  validation.label = "验证工作区与执行范围";
  validation.status = "running";
  delete validation.endedAt;
  fixture.tasks = [];
  fixture.logs = [{ at: time(5), level: "info", message: "Development UI fixture: preparation validation is displayed as running; no worker, model or command was invoked." }];
}
if (!demonstrateRunning) for (const task of fixture.tasks) if (task.status === "running") { task.status = "interrupted"; if (task.currentActivity) { task.currentActivity.status = "interrupted"; task.currentActivity.endedAt = time(0); } const attempt = task.attempts.at(-1)!; attempt.status = "interrupted"; attempt.endedAt = time(0); for (const activity of attempt.activities ?? []) { activity.status = "interrupted"; activity.endedAt = time(0); } }
await store.save(fixture);
fixtureLock = demonstrateRunning || demonstratePreparing ? await store.acquire(fixture.id) : async () => {};
}
} catch (error) {
  fixtureAbort.abort();
  try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); }
  throw error;
}
let global = false;
const server = createServer(engine, { projects: { getProjects: async () => ({ available: true, projects: [{ projectId: "preview-project", label: demonstrateControlFlow ? "示例项目" : "REA", path: project, hostId: "local" }], ...(global ? {} : { currentProjectId: "preview-project" }), contextSource: global ? "global-or-unassigned" : "thread" }) }, readDeletionConfig: async () => ({ mcp_servers: {} }) });
const client = new Client({ name: "workflows_ui_fixture", version: "0.5.0" });
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
const host = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#181818}iframe{border:0;width:100%;height:100%}.fixture{position:fixed;right:16px;top:5px;padding:6px 12px;background:#413421;border:1px solid #efc48255;border-radius:8px;color:#efc482;font:12px system-ui;pointer-events:none;z-index:999}</style></head><body><iframe src="/panel"></iframe><div class="fixture">${demonstrateControlFlow ? "流程引擎验收 · 替身执行器 · 未调用模型" : "界面示例 · 不是真实任务执行"}</div><script>const f=document.querySelector('iframe');addEventListener('message',async e=>{if(e.source!==f.contentWindow)return;const m=e.data;if(!m||m.jsonrpc!=='2.0'||m.id===undefined)return;let result;try{if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'isolated-development-host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:new URL(location.href).searchParams.get('theme')||'dark',displayMode:'fullscreen',styles:{variables:{'--color-background-primary':'#181818','--color-background-secondary':'#222222','--color-text-primary':'#ececec','--font-sans':'-apple-system,BlinkMacSystemFont,PingFang SC,system-ui','--font-text-sm-size':'14px'}}}};else if(m.method==='tools/call')result=await(await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.params)})).json();else result={};f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);}catch(error){f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:String(error)}},location.origin);}});</script></body></html>`;
const web = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url?.startsWith("/panel")) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await readFile(new URL("../runtime/panel.html", import.meta.url), "utf8")); return; }
    if (request.method === "POST" && request.url === "/tool") { let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Fixture request exceeds 1 MiB"); } const input = JSON.parse(body); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(await client.callTool(input))); return; }
    if (request.method === "GET" && request.url?.startsWith("/")) { global = request.url.includes("global=1"); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(host); return; }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500); response.end(error instanceof Error ? error.message : String(error)); }
});
web.listen(Number(process.env.WORKFLOWS_PREVIEW_PORT ?? 58825), "127.0.0.1", () => { const address = web.address(); console.log(`Workflows UI fixture: http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`); });
let closing: Promise<void> | undefined;
const cleanup = (exitCode = 0) => closing ??= (async () => { const closed = new Promise<void>(resolve => web.close(() => resolve())); fixtureAbort.abort(); try { await client.close(); await server.close(); await fixtureLock(); await engine.close(); await closed; } finally { await rm(root, { recursive: true, force: true }); } process.exit(exitCode); })().catch(error => { console.error("Development fixture cleanup failed:", error instanceof Error ? error.message : String(error)); process.exit(1); });
process.once("SIGINT", () => { void cleanup(); }); process.once("SIGTERM", () => { void cleanup(); });
web.once("error", error => { console.error("Development fixture HTTP failed:", error.message); void cleanup(1); });
