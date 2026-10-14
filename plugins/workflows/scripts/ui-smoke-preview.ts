// Development-only host simulator. All runs, files and settings are disposable
// fixtures; production tools are routed through their actual MCP server.
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { createServer } from "../src/server.ts";
import type { WorkflowRun } from "../src/types.ts";

const root = await mkdtemp(path.join(tmpdir(), "workflows-ui-smoke-"));
const project = path.join(root, "project"); await mkdir(project);
const store = new RunStore(path.join(root, "state"));
const engine = new WorkflowEngine({ store, adapter: {
  executionEnvironment: async () => ({ defaults: { model: "preview-model", reasoningEffort: "medium" }, models: [{ id: "preview-model", displayName: "开发预览模型", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }] }),
  run: async () => { throw new Error("The UI fixture never invokes a real model"); }, close: async () => {},
} });
const fixtureScript = 'export const meta={name:"rea-update-verify",description:"REA 更新与验收",phases:[{title:"预检"},{title:"拉取并固定提交"},{title:"依赖与构建"},{title:"MCP 验收"},{title:"审查交付"}],parameters:[{name:"branch",label:"目标分支",type:"string",required:true}]}; return args;';
const created = await engine.preview({ projectPath: project, script: fixtureScript, args: { branch: "main" } });
const at = Date.now(), time = (seconds: number) => new Date(at - seconds * 1000).toISOString();
const demonstrateRunning = process.env.WORKFLOWS_PREVIEW_RUNNING === "1";
const fixture = { ...created, execution: demonstrateRunning ? "running" : "stopped", startedAt: time(162), ...(demonstrateRunning ? {} : { endedAt: time(0) }), preparation: { startedAt: time(170), endedAt: time(162), stages: ["settings", "project", "workspace", "validation"].map((id, index) => ({ id, label: ["核对执行环境", "检查项目", "准备工作区", "完成校验"][index], status: "completed", startedAt: time(170 - index * 2), endedAt: time(168 - index * 2) })) },
  tasks: ["工具链已确认", "提交已固定", "正在运行构建"].map((label, index) => ({ id: `task_${index + 1}`, index, label, phase: created.meta.phases![index]!.title, prompt: "Private development fixture prompt", options: {}, mode: "read", status: index === 2 ? "running" : "completed", cached: false, currentActivity: { id: `activity_${index + 1}`, kind: index === 2 ? "command" : "files", label, status: index === 2 ? "running" : "completed", startedAt: time(index === 2 ? 78 : 160 - index * 15), ...(index === 2 ? {} : { endedAt: time(148 - index * 15) }) }, attempts: [{ id: `attempt_${index + 1}`, status: index === 2 ? "running" : "completed", startedAt: time(index === 2 ? 78 : 160 - index * 15), ...(index === 2 ? {} : { endedAt: time(148 - index * 15) }), activities: [{ id: `activity_${index + 1}`, kind: "command", label, status: index === 2 ? "running" : "completed", startedAt: time(78) }] }] })),
  logs: [{ at: time(5), level: "info", taskId: "task_3", message: "Development diagnostic: build started" }],
} as WorkflowRun;
if (!demonstrateRunning) for (const task of fixture.tasks) if (task.status === "running") { task.status = "interrupted"; if (task.currentActivity) { task.currentActivity.status = "interrupted"; task.currentActivity.endedAt = time(0); } const attempt = task.attempts.at(-1)!; attempt.status = "interrupted"; attempt.endedAt = time(0); for (const activity of attempt.activities ?? []) { activity.status = "interrupted"; activity.endedAt = time(0); } }
await store.save(fixture);
const fixtureLock = demonstrateRunning ? await store.acquire(fixture.id) : async () => {};
let global = false;
const server = createServer(engine, { projects: { getProjects: async () => ({ available: true, projects: [{ projectId: "preview-project", label: "REA", path: project, hostId: "local" }], ...(global ? {} : { currentProjectId: "preview-project" }), contextSource: global ? "global-or-unassigned" : "thread" }) }, readDeletionConfig: async () => ({ mcp_servers: {} }) });
const client = new Client({ name: "workflows_ui_fixture", version: "0.5.0" });
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
const host = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#181818}iframe{border:0;width:100%;height:100%}.fixture{position:fixed;right:16px;top:5px;padding:6px 12px;background:#413421;border:1px solid #efc48255;border-radius:8px;color:#efc482;font:12px system-ui;pointer-events:none;z-index:999}</style></head><body><iframe src="/panel"></iframe><div class="fixture">界面示例 · 不是真实任务执行</div><script>const f=document.querySelector('iframe');addEventListener('message',async e=>{if(e.source!==f.contentWindow)return;const m=e.data;if(!m||m.jsonrpc!=='2.0'||m.id===undefined)return;let result;try{if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'isolated-development-host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:new URL(location.href).searchParams.get('theme')||'dark',displayMode:'fullscreen',styles:{variables:{'--color-background-primary':'#181818','--color-background-secondary':'#222222','--color-text-primary':'#ececec','--font-sans':'-apple-system,BlinkMacSystemFont,PingFang SC,system-ui','--font-text-sm-size':'14px'}}}};else if(m.method==='tools/call')result=await(await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.params)})).json();else result={};f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);}catch(error){f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:String(error)}},location.origin);}});</script></body></html>`;
const web = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url?.startsWith("/panel")) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await readFile(new URL("../runtime/panel.html", import.meta.url), "utf8")); return; }
    if (request.method === "POST" && request.url === "/tool") { let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Fixture request exceeds 1 MiB"); } const input = JSON.parse(body); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(await client.callTool(input))); return; }
    if (request.method === "GET" && request.url?.startsWith("/")) { global = request.url.includes("global=1"); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(host); return; }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500); response.end(error instanceof Error ? error.message : String(error)); }
});
web.listen(Number(process.env.WORKFLOWS_PREVIEW_PORT ?? 58825), "127.0.0.1", () => { const address = web.address(); console.log(`Workflows UI fixture: http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`); });
const cleanup = async () => { web.close(); await client.close(); await server.close(); await fixtureLock(); await engine.close(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", () => { void cleanup(); }); process.once("SIGTERM", () => { void cleanup(); });
