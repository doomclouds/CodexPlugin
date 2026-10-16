import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkflowEngine } from "../src/engine.ts";
import { createServer } from "../src/server.ts";
import { projectStructuredRun } from "../src/structured-projection.ts";
import { compileDefinition } from "../src/definition.ts";
import type { WorkflowDefinition } from "../src/definition.ts";
import type { ActivityDriver, StructuredRun } from "../src/structured-types.ts";

// Development-only, explicitly labelled stand-in activities. No native worker or user project is opened.
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-rendering-preview-")));
const project = path.join(temporary, "project"); await mkdir(project); await writeFile(path.join(project, "README.txt"), "Disposable rendering verification project.\n");
const driver: ActivityDriver = {
  captureCheckpoint: async () => "rendering-preview-stand-in-v1",
  validateCheckpoint: async () => {},
  async execute({ node, env, instance }, signal, emit) {
    emit({ type: "activity", activity: { id: instance.id, kind: "waiting", label: "演示活动（替身，无真实工具调用）", status: "running", startedAt: new Date().toISOString() } });
    emit({ type: "log", message: `STAND-IN activity ${node.id}; iteration=${env.iteration ?? "none"}; no model, command, file write or network.` });
    await new Promise<void>((resolve, reject) => { const finish = () => { signal.removeEventListener("abort", abort); resolve(); }; const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Preview stopped")); }; const timer = setTimeout(finish, 1200); signal.addEventListener("abort", abort, { once: true }); });
    signal.throwIfAborted();
    if (node.id === "expectedFailure") throw new Error("演示活动的预期失败（替身，无外部副作用）");
    if (node.type === "expand") return { schemaVersion: 1, name: "generated-preview", description: "Frozen stand-in expansion", steps: [{ id: "inspect", type: "agent", task: "演示子流程检查（替身）", label: "动态检查（替身）" }, { id: "result", type: "transform", value: "动态结构已冻结" }] };
    if (node.id === "quality") return { passed: (env.iteration ?? 0) >= 1 };
    return { demonstration: true, node: node.id };
  },
};
const engine = new WorkflowEngine({ root: path.join(temporary, "state"), driver });
const demo: WorkflowDefinition = { schemaVersion: 1, name: "renderer-nested-demo", description: "渲染验收：真实状态机、替身活动，不调用模型或修改用户项目", parameters: [{ name: "hasUpdates", label: "演示：是否存在更新", type: "boolean", default: true }], steps: [
  { id: "inspect", type: "agent", label: "检查输入与环境（替身）", task: "演示读取" },
  { id: "route", type: "choice", label: "是否存在需要处理的更新？", cases: [{ id: "updates", label: "有更新", when: { ref: "args.hasUpdates" }, steps: [{ id: "checks", type: "parallel", label: "并行核对", policy: "fail-fast", branches: [
    { id: "code", label: "代码", steps: [{ id: "types", type: "agent", label: "类型与接口检查（替身）", task: "演示类型检查" }, { id: "lint", type: "transform", label: "记录代码检查结果", value: true }] },
    { id: "docs", label: "文档", steps: [{ id: "docs", type: "agent", label: "检查中文长标题在不同字号下是否正确换行（替身）", task: "演示文档检查" }] },
  ] }] }], default: [{ id: "noChange", type: "transform", label: "无需拉取，继续后续验证", value: false }] },
  { id: "verify", type: "repeat", label: "验证与改进", maxIterations: 3, until: { ref: "steps.quality.output.passed" }, steps: [
    { id: "quality", type: "agent", label: "执行本轮检查（替身）", task: "演示循环检查", schema: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"], additionalProperties: false } },
    { id: "qualityRoute", type: "choice", label: "本轮检查是否通过？", cases: [{ id: "passed", label: "通过", when: { ref: "steps.quality.output.passed" }, steps: [{ id: "accepted", type: "transform", label: "本轮通过", value: true }] }], default: [
      { id: "improve", type: "parallel", label: "并行分析改进方向", policy: "all-settled", branches: [{ id: "reason", steps: [{ id: "analyze", type: "agent", label: "分析原因（替身）", task: "演示原因分析" }] }, { id: "nested", steps: [{ id: "nestedLoop", type: "repeat", label: "嵌套检查", maxIterations: 2, steps: [{ id: "nestedValue", type: "transform", label: "记录子轮次", value: { ref: "iteration" } }] }] }] },
    ] },
  ] },
  { id: "guard", type: "try", label: "异常与收尾演示", steps: [{ id: "expectedFailure", type: "agent", label: "演示可处理错误（替身）", task: "演示错误" }], catch: [{ id: "explain", type: "transform", label: "保留并说明实际错误", value: { ref: "error.message" } }], finally: [{ id: "cleanup", type: "transform", label: "完成演示收尾", value: true }] },
  { id: "sub", type: "subflow", label: "固定子流程", definition: { schemaVersion: 1, name: "fixed-preview", description: "Inline rendering fixture", steps: [{ id: "inspect", type: "transform", label: "读取子流程输入", value: 1 }, { id: "result", type: "agent", label: "子流程检查（替身）", task: "演示子流程" }] } },
  { id: "expand", type: "expand", label: "动态展开子流程", task: "演示生成冻结子结构（替身）" },
  { id: "deliver", type: "transform", label: "展示执行摘要", value: "渲染演示结束；以上工具活动均为明确标注的替身。" },
] };
const saved = engine.saveDefinition({ definition: demo });
let mainRun = await engine.preview({ projectPath: project, definition: demo, sourceDefinition: { id: saved.id, revision: saved.revision } });
const sizes = new Map<number, StructuredRun>();
for (const count of [20, 100, 500]) {
  const definition: WorkflowDefinition = { schemaVersion: 1, name: `renderer-scale-${count}`, description: "Layout benchmark only; pure transforms", steps: Array.from({ length: count }, (_, index) => ({ id: `step${index}`, type: "transform", label: `检查步骤 ${index + 1}`, value: index })) };
  sizes.set(count, await engine.preview({ projectPath: project, definition }));
}
const server = createServer(engine, { projects: { async getProjects() { return { available: true, contextSource: "thread", currentProjectId: "render-preview", projects: [{ projectId: "render-preview", label: "渲染验收 · 替身活动", path: project, hostId: "local" }] }; } } });
const client = new Client({ name: "rendering-preview-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
const workerBuild = await build({ absWorkingDir: pluginRoot, entryPoints: ["prototypes/graph-layout-worker.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", define: { self: "undefined", global: "globalThis" }, supported: { "template-literal": false }, minify: true, write: false });
const define = { __WORKFLOW_LAYOUT_WORKER__: JSON.stringify(workerBuild.outputFiles[0]!.text) };
const uiBuild = await build({ absWorkingDir: pluginRoot, stdin: { contents: `import {mountPanel} from './prototypes/panel.ts';const panel=mountPanel(document.getElementById('workflow-panel-prototype'),async(name,args)=>{const reply=await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});if(!reply.ok)throw new Error(await reply.text());return await reply.json();});document.documentElement.dataset.preview='true';panel.connected();window.addEventListener('pagehide',()=>panel.teardown());`, resolveDir: pluginRoot }, bundle: true, platform: "browser", format: "iife", target: "es2022", define, write: false });
const comparisonBuild = await build({ absWorkingDir: pluginRoot, entryPoints: ["prototypes/rendering-comparison.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true, define, write: false });
const icons = await readFile(path.join(pluginRoot, "prototypes/icons.css"), "utf8");
let iconStyles = icons;
for (const [target, filename] of [...icons.matchAll(/\.\.\/assets\/icons\/([a-z0-9-]+\.svg)/g)].map(match => [match[0], match[1]!] as const)) iconStyles = iconStyles.replaceAll(target, `data:image/svg+xml;base64,${(await readFile(path.join(pluginRoot, "assets/icons", filename))).toString("base64")}`);
const graphStyles = await readFile(path.join(pluginRoot, "prototypes/graph.css"), "utf8");
let fragment = await readFile(path.join(pluginRoot, "prototypes/workflow-panel.html"), "utf8");
fragment = fragment.replaceAll("../assets/workflow-canvas.png", `data:image/png;base64,${(await readFile(path.join(pluginRoot, "assets/workflow-canvas.png"))).toString("base64")}`);
const previewControls = `
window.addEventListener('error',event=>{const box=document.getElementById('preview-errors');box.hidden=false;box.textContent=(event.error?.stack??event.message).slice(0,6000)});
document.getElementById('preview-theme').addEventListener('click',()=>{const light=document.documentElement.style.colorScheme!=='light';document.documentElement.style.colorScheme=light?'light':'dark'});
document.getElementById('preview-font').addEventListener('click',()=>{const style=document.documentElement.style;style.setProperty('--font-text-sm-size',style.getPropertyValue('--font-text-sm-size')==='20px'?'14px':'20px')});`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作流渲染原型</title><style>html{color-scheme:dark}body{margin:0;color:light-dark(#202020,#eee);font:14px system-ui;display:flex;flex-direction:column;height:100dvh}.preview-banner{padding:8px 22px;background:#49380e;color:#ffe5a8;flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.preview-banner a{color:inherit}.preview-banner button{font:inherit;background:transparent;color:inherit;border:1px solid #a78a4b;border-radius:5px;padding:3px 8px}#workflow-panel-prototype{height:0!important;flex:1;min-height:0}#preview-errors{white-space:pre-wrap;max-height:160px;overflow:auto;color:#d33}</style></head><body><div class="preview-banner">开发验收：真实状态机＋替身活动 · 不调用模型或修改用户项目 · <a href="/compare">绘图方案对照</a><button id="preview-theme" type="button">切换明暗</button><button id="preview-font" type="button">切换字号 14 / 20</button></div><pre id="preview-errors" role="alert" hidden></pre>${fragment}<style>${iconStyles}\n${graphStyles}</style><script>${previewControls}</script><script>${uiBuild.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
const comparison = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作流绘图方案对照</title><style>body{margin:0;padding:20px;background:#181818;color:#eee;font:14px system-ui}button,select{font:inherit;color:inherit;background:#242424;border:1px solid #555;padding:8px;border-radius:6px}a{color:#ccc}.comparison-panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}.comparison-canvas{height:65vh;border:1px solid #444;position:relative;overflow:hidden}.metrics{white-space:pre-wrap}svg text{font-family:system-ui}</style></head><body><h1>绘图方案对照</h1><p>开发验收 · 同一份结构化投影 · 不运行真实模型或工具</p><p><a href="/">完整交互面板</a></p><label>规模 <select id="comparison-size"><option value="0">嵌套复杂流程</option><option value="20">20 节点</option><option value="100">100 节点</option><option value="500">500 节点</option></select></label><button id="comparison-fit">适应画布</button><div id="comparison-error" role="alert"></div><div class="comparison-panels"><section><h2>X6 ＋ ELK</h2><pre id="x6-metrics" class="metrics"></pre><div id="x6-canvas" class="comparison-canvas"></div></section><section><h2>G6 对照</h2><pre id="g6-metrics" class="metrics"></pre><div id="g6-canvas" class="comparison-canvas"></div></section></div><pre id="comparison-selection"></pre><style>${graphStyles}</style><script>${comparisonBuild.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
const allowed = new Set(["workflow_get_projects", "workflow_list_templates", "workflow_get_template", "workflow_list_runs", "workflow_get_run", "workflow_get_node_process", "workflow_get_checkpoints", "workflow_get_events", "workflow_start", "workflow_pause", "workflow_stop", "workflow_preview_recovery", "workflow_resume", "workflow_retry_node", "workflow_resolve_wait", "workflow_preview", "workflow_get_execution_settings"]);
let origin = "";
const web = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src data:; worker-src blob:; object-src 'none'; base-uri 'none'; frame-src 'self'");
    if (request.method === "GET" && url.pathname === "/sandbox") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>工作流 sandbox 验收</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe title="工作流沙箱原型" sandbox="allow-scripts allow-same-origin" src="/"></iframe></body></html>'); return; }
    if (request.method === "GET" && ["/", "/compare"].includes(url.pathname)) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(url.pathname === "/" ? html : comparison); return; }
    if (request.method === "GET" && url.pathname === "/fixture") { const count = Number(url.searchParams.get("size") ?? 0), run = count ? sizes.get(count) : engine.get(mainRun.id); if (!run) throw new Error("Unknown fixture size"); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ run: engine.transport(run), projection: projectStructuredRun(run), plan: compileDefinition(run.definition).plan })); return; }
    if (request.method !== "POST" || url.pathname !== "/tool" || request.headers.origin !== origin || request.headers["content-type"] !== "application/json") { response.writeHead(404); response.end(); return; }
    let body = ""; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Preview input too large"); }
    const { name, args = {} } = JSON.parse(body) as { name: string; args: Record<string, unknown> };
    if (!allowed.has(name)) throw new Error("This development preview does not expose that operation.");
    if (args.projectPath !== undefined && args.projectPath !== project) throw new Error("Preview project is fixed.");
    if (name === "workflow_get_execution_settings") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ structuredContent: { settings: { revision: 0 }, models: [], defaults: {}, preview: true } })); return; }
    const value = await client.callTool({ name, arguments: args });
    if (name === "workflow_preview" && value.structuredContent && typeof value.structuredContent.run === "object") mainRun = value.structuredContent.run as StructuredRun;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value));
  } catch (error) { response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); response.end(error instanceof Error ? error.message : String(error)); }
});
web.listen(0, "127.0.0.1", () => { const address = web.address(); if (address && typeof address !== "string") { origin = `http://127.0.0.1:${address.port}`; console.log(JSON.stringify({ preview: origin, comparison: `${origin}/compare`, standInActivities: true, nativeModelCalls: 0 })); } });
let closing = false;
async function close() { if (closing) return; closing = true; web.close(); await client.close(); await server.close(); await engine.close(); await rm(temporary, { recursive: true, force: true }); }
process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
