import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { browserExecutable } from "../src/browser.ts";
import { CodeProjectStore, codeFileHash, summarizeCodeFiles } from "../src/code-project.ts";
import { compileCodeProject } from "../src/code-preview.ts";
import { exportCodeProject } from "../src/code-export.ts";
import { createDesignServer } from "../src/server.ts";
import { zipFiles } from "../src/zip.ts";

interface BrowserContext { id: number; sessionId?: string; frameId?: string; isDefault?: boolean }
class ArchiveCdp {
  socket: WebSocket;
  ready: Promise<void>;
  next = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  contexts = new Map<string, BrowserContext>();
  errors: string[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener("open", () => resolve(), { once: true }); this.socket.addEventListener("error", () => reject(new Error("Test Chromium connection failed")), { once: true }); });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else if (message.method === "Target.attachedToTarget") void this.call("Runtime.enable", {}, message.params.sessionId).catch(() => {});
      else if (message.method === "Runtime.executionContextCreated") this.contexts.set(`${message.sessionId ?? ""}:${message.params.context.id}`, { id: message.params.context.id, sessionId: message.sessionId, ...message.params.context.auxData });
      else if (message.method === "Runtime.executionContextDestroyed") this.contexts.delete(`${message.sessionId ?? ""}:${message.params.executionContextId}`);
      else if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    this.socket.addEventListener("close", () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Test Chromium connection closed")); } this.pending.clear(); });
  }
  async call(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chromium ${method} did not complete.`)); }, 15_000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  async evaluate(expression: string, context?: BrowserContext): Promise<any> {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(context ? { contextId: context.id } : {}) }, context?.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async frame(selector: string): Promise<BrowserContext> {
    const tree = await this.call("DOM.getDocument"), node = await this.call("DOM.querySelector", { nodeId: tree.root.nodeId, selector });
    if (!node.nodeId) throw new Error(`Missing actual iframe: ${selector}`);
    const description = await this.call("DOM.describeNode", { nodeId: node.nodeId });
    const found = [...this.contexts.values()].find(context => context.frameId === description.node.frameId && context.isDefault);
    if (!found) throw new Error(`Actual iframe execution context is not ready: ${selector}`);
    return found;
  }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(label: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000; let last: unknown;
  while (true) {
    try { const value = await read(); last = value; if (matches(value)) return value; } catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (Date.now() > deadline) throw new Error(`${label} was not observed: ${JSON.stringify(last)}`);
    await pause(20);
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("native ZIP picker opens a real independent project and preserves current drafts on invalid or late completion", { timeout: 120_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; native archive UI remains unverified."); return; }
  const directory = await mkdtemp(join(tmpdir(), "design-archive-browser-")), store = new CodeProjectStore({ dataDir: join(directory, "data") });
  let source = await store.create({ name: "真实归档原工程", template: "html" });
  const card = 'export function ArchiveCard(){return <strong data-design-id="archive-card">真实组件与源码</strong>}';
  const reader = `import React,{useState} from 'react';import{ArchiveCard}from './Card.tsx';export default function Reader(){const[count,setCount]=useState(0);return <main><h1 data-design-id="archive-title">归档阅读页</h1><ArchiveCard/><input id="remember" aria-label="真实输入"/><button id="counter" onClick={()=>setCount(count+1)}>{count}</button><a href="/home?from=archive#read">真实首页导航</a></main>}`;
  source = await store.update(source.id, source.revision, {
    files: [{ path: "src/Reader.tsx", content: reader, expectedHash: null }, { path: "src/Card.tsx", content: card, expectedHash: null }],
    pages: [{ ...source.pages[0]!, id: "page_home", name: "实际首页", route: "/home" }, { id: "page_reader", name: "独立阅读页", entry: "src/Reader.tsx", route: "/read" }], defaultPageId: "page_reader",
    viewports: [{ id: "shared", name: "共享尺寸", width: 400, height: 400 }, { id: "reader_phone", name: "阅读手机", width: 360, height: 480, pageId: "page_reader" }],
    designSystem: { components: [{ name: "ArchiveCard", path: "src/Card.tsx", exportName: "ArchiveCard", usage: "<ArchiveCard/>" }], notes: "实际源文件，不是文档占位。" }
  });
  const compiled = await compileCodeProject(source), title = compiled.sources.find(item => item.tag === "h1")!;
  source = await store.update(source.id, source.revision, { comments: [{ id: "comment_archive", file: title.file, sourceId: title.id, text: "稳定锚评论原样恢复。", status: "open", createdAt: source.createdAt }] });
  const connectedDirectory = join(directory, "original-source"); await mkdir(connectedDirectory);
  for (const file of source.files) { const path = join(connectedDirectory, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(file.content, file.encoding)); }
  await store.connectSource(source.id, source.revision, connectedDirectory);
  const beforeRecord = await readFile(join(store.dataDir, source.id + ".json"), "utf8"), other = await store.create({ name: "当前项目不能被迟到结果接管", template: "html" });
  const exported = await exportCodeProject(source, "zip"), zip = join(directory, "真实工程.zip"), bad = join(directory, "损坏.zip"), oversized = join(directory, "过大.zip"), medium = join(directory, "大小显示.zip");
  await writeFile(zip, Buffer.from(exported.dataBase64, "base64")); await writeFile(bad, Buffer.alloc(50, 0x62)); await writeFile(oversized, ""); await truncate(oversized, 32 * 1024 * 1024 + 1); await writeFile(medium, ""); await truncate(medium, 1024 * 1024);
  // The delivery prototype is deliberately hostile; importing must compile source instead of executing it.
  const poisoned = join(directory, "带独立交付页.zip");
  await writeFile(poisoned, zipFiles([...source.files.map(file => ({ name: "source/" + file.path, data: Buffer.from(file.content, file.encoding) })), { name: "design-project.json", data: Buffer.from(JSON.stringify(source)) }, { name: "prototype.html", data: Buffer.from('<script>throw Error("ARCHIVED_PROTOTYPE_MUST_NOT_EXECUTE")</script>') }]));
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>Real archive UI protocol fixture</div>" });
  const client = new Client({ name: "archive-browser-test", version: "1" }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [], imported: string[] = [], unexpectedErrors: string[] = [];
  let failAfterImport = false;
  let panel = "", hold: ReturnType<typeof deferred> | undefined, holdGet: ReturnType<typeof deferred> | undefined, holdGetId = "", readHeld = false, holdUpdate: ReturnType<typeof deferred> | undefined, updateHeld = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/tool") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(panel); return; }
      let body = ""; for await (const chunk of request) body += chunk;
      const { name, args } = JSON.parse(body); calls.push({ name, args });
      assert.ok(!/generation|models/.test(name), "Archive UI must not invoke a model");
      const gate = name === "design_code_import_project" ? hold : undefined;
      const readGate = name === "design_code_get" && args.projectId === holdGetId ? holdGet : undefined;
      const updateGate = name === "design_code_update" ? holdUpdate : undefined;
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) { response.statusCode = 400; response.end(JSON.stringify({ error: JSON.stringify(result.structuredContent) })); return; }
      const data = result.structuredContent as Record<string, any>;
      if (name === "design_code_import_project") { imported.push(data.project.id); if (gate) await gate.promise; if (failAfterImport) { failAfterImport = false; response.statusCode = 503; response.end(JSON.stringify({error:"Archive response delivery intentionally lost after actual saved copy."})); return; } }
      if (readGate) { readHeld = true; await readGate.promise; }
      if (updateGate) { updateHeld = true; await updateGate.promise; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(data));
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); unexpectedErrors.push(detail); response.statusCode = 500; response.end(JSON.stringify({ error: detail })); }
  });
  let child: ReturnType<typeof spawn> | undefined, cdp: ArchiveCdp | undefined, phase = "startup";
  try {
    const bundled = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.archiveApp=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const data=await response.json();if(!response.ok)throw Error(data.error);return data},async prompt(){throw Error('No inference is authorized by this regression')}});archiveApp.connected().then(()=>archiveApp.setProjectId(${JSON.stringify(other.id)}));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "archive-harness.js" }, bundle: true, platform: "browser", format: "iife", target: "es2022", write: false, outfile: "archive-harness.js", logLevel: "silent" });
    const js = bundled.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = bundled.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}</style></head><body><div id="editor"></div><script>${js}</script></body></html>`;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: "ignore" });
    const port = await until("Chromium debugger", async () => (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new ArchiveCdp(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
    await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    const click = (selector: string) => cdp!.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing control '+${JSON.stringify(selector)});el.focus();el.click();return true})()`);
    const value = (selector: string, text: string) => cdp!.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const selectedProject = () => cdp!.evaluate("document.querySelector('[data-setting=project]')?.value");
    // A store commit precedes browser response delivery and draft reconciliation.
    // Switch intents require the editor's own saved baseline, not only disk state.
    const savedSourceAccepted = (projectId: string, revision: number, content: string) => until("editor adopted its actual saved source and cleared the draft", () => cdp!.evaluate("({project:document.querySelector('[data-setting=project]')?.value,revision:document.querySelector('[data-revision]')?.textContent,label:document.querySelector('.dc-code-head small')?.textContent,disabled:document.querySelector('[data-action=save-source]')?.disabled,saving:document.querySelector('.dc-save-state')?.classList.contains('saving'),content:document.querySelector('[data-source-input]')?.value})"), state => state.project === projectId && state.revision === `修订 ${revision}` && state.label === "已保存" && state.disabled === true && state.saving === false && state.content === content);
    const selectFile = async (file: string) => { const document = await cdp!.call("DOM.getDocument"), node = await cdp!.call("DOM.querySelector", { nodeId: document.root.nodeId, selector: "input[data-project-archive]" }); assert.ok(node.nodeId); await cdp!.call("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] }); };
    const close = () => click('.dc-modal [data-action="close-modal"]');
    const importCount = () => calls.filter(call => call.name === "design_code_import_project").length;
    await until("initial actual project", selectedProject, id => id === other.id);
    phase = "native file selection and real metadata roundtrip";
    await click('.dc-header [data-action="project-archive-view"]'); await selectFile(poisoned);
    assert.equal(importCount(), 0, "Selecting a native File must not send any ZIP or create a project");
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-selection]').textContent"), /带独立交付页.*KiB$/);
    await click('[data-action="import-project-archive"]');
    const copyId = await until("new independent project adopted", selectedProject, id => typeof id === "string" && id !== other.id && id !== source.id);
    const copy = await store.get(copyId); assert.equal(copy.revision, 1); assert.equal(copy.name, source.name);
    for (const key of ["files", "pages", "defaultPageId", "viewports", "designSystem", "comments"] as const) assert.deepEqual(copy[key], source[key], `Archive must restore actual ${key}`);
    assert.deepEqual(summarizeCodeFiles(copy), summarizeCodeFiles(source)); assert.equal((await store.sourceStatus(copyId)).connected, false); assert.equal((await store.history(copyId)).versions.length, 1);
    assert.equal(await readFile(join(store.dataDir, source.id + ".json"), "utf8"), beforeRecord);
    assert.equal(await cdp.evaluate("document.querySelector('[data-setting=page]').value"), "page_reader");
    const iframe = '.dc-frame[data-page-id="page_reader"]:not([hidden]) iframe';
    const actual = await until("actual imported React document", () => cdp!.frame(iframe), Boolean);
    await until("actual imported component rendered", () => cdp!.evaluate("document.querySelector('[data-design-id=archive-card]')?.textContent", actual), text => text === "真实组件与源码");
    await click('[data-mode="preview"]'); await cdp.evaluate("document.getElementById('remember').value='独立副本原型状态';document.getElementById('counter').click()", actual);
    assert.equal(await cdp.evaluate("document.getElementById('counter').textContent", actual), "1");
    await click('[data-file="src/Reader.tsx"]'); await value('[data-source-input]', reader.replace("归档阅读页", "归档源码实际修改")); await click('[data-action="save-source"]');
    await until("actual imported source revision saved", () => store.get(copyId), p => p.revision === 2 && p.files.some(file => file.content.includes("归档源码实际修改")));
    await savedSourceAccepted(copyId, 2, reader.replace("归档阅读页", "归档源码实际修改"));
    await click('[data-view="design"]');
    await until("actual modified React title", async () => cdp!.evaluate("document.querySelector('h1')?.textContent", await cdp!.frame(iframe)), text => text === "归档源码实际修改");
    phase = "dirty draft, invalid package and size limits";
    await click('[data-file="src/Reader.tsx"]'); const savedSource = (await store.get(copyId)).files.find(file => file.path === "src/Reader.tsx")!.content;
    await value('[data-source-input]', savedSource + "\n// private unsaved draft"); await click('.dc-header [data-action="project-archive-view"]');
    assert.equal(await cdp.evaluate("!!document.querySelector('.dc-modal')"), false); assert.equal(importCount(), 1);
    assert.match(await cdp.evaluate("document.querySelector('[data-source-input]').value"), /private unsaved draft/);
    await click('[data-view="design"]'); await click('[data-view="source"]'); await click('[data-action="reset-source"]'); await click('.dc-header [data-action="project-archive-view"]'); await selectFile(oversized);
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-error]').textContent"), /32 MiB/); assert.equal(importCount(), 1);
    assert.equal(await cdp.evaluate("document.querySelector('[data-action=import-project-archive]').disabled"), true);
    await selectFile(medium); assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-selection]').textContent"), /1\.00 MiB$/); assert.equal(importCount(), 1);
    await selectFile(bad);
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-selection]').textContent"), /50 B$/);
    assert.doesNotMatch(await cdp.evaluate("document.querySelector('[data-project-archive-selection]').textContent"), /0\.00 MiB/);
    await click('[data-action="import-project-archive"]');
    await until("real parser rejection displayed", () => cdp!.evaluate("document.querySelector('[data-project-archive-error]')?.textContent"), text => /Invalid Design project archive/.test(text ?? ""));
    assert.equal(await cdp.evaluate("document.querySelector('[data-project-archive-error-main]').textContent"), "尚未确认工程已打开。当前项目、源码和草稿已保留。");
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-error]').innerText"), /完整的 Design 工程 ZIP/);
    assert.doesNotMatch(await cdp.evaluate("document.querySelector('[data-project-archive-error]').innerText"), /ZIP end record|Invalid Design project archive/);
    assert.equal(await cdp.evaluate("document.querySelector('[data-project-archive-error] details').open"), false);
    await click('[data-project-archive-error] summary');
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-error] details').innerText"), /Invalid Design project archive/);
    assert.equal(await selectedProject(), copyId); assert.equal((await store.list()).projects.length, 3); assert.equal(await cdp.evaluate("document.querySelector('[data-source-input]').value"), savedSource);
    await close(); assert.equal(await cdp.evaluate("document.activeElement.matches('.dc-header [data-action=project-archive-view]')"), true);
    phase = "changed file makes a real completed creation require explicit opening";
    await click('.dc-header [data-action="project-archive-view"]'); await selectFile(zip); hold = deferred(); await value('[data-project-archive-name]', "迟到文件选择副本"); await click('[data-action="import-project-archive"]');
    await until("real first background copy persisted", async () => imported.length, count => count === 2);
    await selectFile(bad); hold.resolve(); hold = undefined;
    await until("explicit background copy entry", () => cdp!.evaluate("document.querySelector('.dc-modal [data-archive-open]')?.dataset.archiveOpen"), id => id === imported[1]);
    assert.equal(await selectedProject(), copyId); assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-selection]').textContent"), /损坏/);
    assert.equal(await cdp.evaluate("document.querySelector('[data-project-archive-name]').value"), "迟到文件选择副本"); await close();
    phase = "close, switch project and draft before actual late MCP response";
    await click('.dc-header [data-action="project-archive-view"]'); await selectFile(zip); hold = deferred(); await value('[data-project-archive-name]', "后台完成的新副本"); await click('[data-action="import-project-archive"]');
    await until("real second background copy persisted", async () => imported.length, count => count === 3);
    assert.match(await cdp.evaluate("document.querySelector('.dc-modal [data-action=close-modal]').textContent"), /后台继续/);
    await close(); await cdp.evaluate(`archiveApp.setProjectId(${JSON.stringify(other.id)})`); await until("explicit other project selected", selectedProject, id => id === other.id);
    await click('[data-view="source"]'); const otherSource = (await store.get(other.id)).files.find(file => file.path === "index.html")!.content;
    const draft = otherSource + "\n<!-- current project draft during background creation -->"; await value('[data-source-input]', draft);
    await cdp.evaluate("globalThis.keptSource=document.querySelector('[data-source-input]')"); hold.resolve(); hold = undefined;
    await until("actual background completion notice", () => cdp!.evaluate("document.querySelector('.dc-header [data-archive-open]')?.dataset.archiveOpen"), id => id === imported[2]);
    assert.equal(await selectedProject(), other.id); assert.equal(await cdp.evaluate("document.querySelector('[data-source-input]').value"), draft);
    await click('.dc-header [data-archive-open]'); assert.equal(await selectedProject(), other.id, "Explicit open still protects a current dirty draft");
    await click('[data-action="save-source"]'); await until("original current hash baseline remains valid", () => store.get(other.id), p => p.revision === 2 && p.files.some(file => file.content === draft));
    await savedSourceAccepted(other.id, 2, draft);
    phase = "explicit open protects new input while the real get response is delayed";
    holdGetId = imported[2]!; holdGet = deferred(); await click('.dc-header [data-archive-open]');
    await until("real target read completed but not delivered", async () => readHeld, Boolean);
    const continuedDraft = draft + "\n<!-- continued input while target read is pending -->";
    await value('[data-source-input]', continuedDraft); holdGet.resolve(); holdGet = undefined; holdGetId = "";
    await until("delayed open refused current new draft", () => cdp!.evaluate("document.querySelector('.dc-toast')?.textContent"), text => /读取期间出现了新的源码草稿/.test(text ?? ""));
    assert.equal(await selectedProject(), other.id); assert.equal(await cdp.evaluate("document.querySelector('[data-source-input]').value"), continuedDraft);
    holdUpdate = deferred(); await click('[data-action="save-source"]');
    await until("continued source saved against its own current hash", () => store.get(other.id), p => p.revision === 3 && p.files.some(file => file.content === continuedDraft));
    await until("real successful source response deliberately withheld", async () => updateHeld, Boolean);
    const targetReadsBeforePendingOpen = calls.filter(call => call.name === "design_code_get" && call.args.projectId === imported[2]).length;
    assert.equal(await cdp.evaluate("document.querySelector('.dc-code-head small').textContent"), "未保存", "A disk commit alone does not clear the editor's pending draft");
    assert.equal(await cdp.evaluate("document.querySelector('.dc-save-state').classList.contains('saving')"), true);
    await click('.dc-header [data-archive-open]');
    assert.equal(await selectedProject(), other.id); assert.equal(calls.filter(call => call.name === "design_code_get" && call.args.projectId === imported[2]).length, targetReadsBeforePendingOpen, "Pending dirty source must block a new project read even after the store commit");
    assert.equal(await cdp.evaluate("document.querySelector('[data-source-input]').value"), continuedDraft);
    holdUpdate.resolve(); holdUpdate = undefined;
    await savedSourceAccepted(other.id, 3, continuedDraft);
    await click('.dc-header [data-archive-open]'); await until("user explicitly opened the real background copy", selectedProject, id => id === imported[2]);
    assert.equal((await store.get(imported[2]!)).name, "后台完成的新副本");
    phase = "unconfirmed delivery reports possible real background creation without claiming rollback";
    const beforeLostReply = (await store.list()).projects.length;
    await click('.dc-header [data-action="project-archive-view"]'); await selectFile(zip); failAfterImport = true; await click('[data-action="import-project-archive"]');
    await until("unconfirmed real persisted request explained", () => cdp!.evaluate("document.querySelector('[data-project-archive-error]')?.innerText"), text => /后台可能已创建新副本/.test(text ?? ""));
    assert.equal((await store.list()).projects.length, beforeLostReply + 1); assert.equal(await selectedProject(), imported[2]);
    assert.equal(await cdp.evaluate("document.querySelector('[data-project-archive-error-main]').textContent"), "尚未确认工程已打开。当前项目、源码和草稿已保留。");
    await click('[data-project-archive-error] summary');
    assert.match(await cdp.evaluate("document.querySelector('[data-project-archive-error] details').innerText"), /delivery intentionally lost after actual saved copy/);
    assert.deepEqual(unexpectedErrors, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic("Real Chromium DOM.setFileInputFiles → actual FileReader bytes → MCP SDK → parser/store/compiler verified; full source metadata, React interaction/edit, invalid ZIP/size/drafts and late creation isolation passed. No native host file transport ceiling, model, or third-party archive code execution is claimed.");
  } catch (error) {
    context.diagnostic(`Archive UI failed phase=${phase}; calls=${JSON.stringify(calls.map(call => call.name).slice(-15))}; browser=${JSON.stringify(cdp?.errors ?? [])}; bridge=${JSON.stringify(unexpectedErrors)}`);
    if (cdp) context.diagnostic(`UI=${JSON.stringify(await cdp.evaluate("({project:document.querySelector('[data-setting=project]')?.value,revision:document.querySelector('[data-revision]')?.textContent,saving:document.querySelector('.dc-save-state')?.className,sourceLabel:document.querySelector('.dc-code-head small')?.textContent,saveDisabled:document.querySelector('[data-action=save-source]')?.disabled,dialog:document.querySelector('.dc-modal')?.textContent,toast:document.querySelector('.dc-toast')?.textContent})").catch(() => "unavailable"))}`);
    throw error;
  } finally {
    hold?.resolve(); holdGet?.resolve(); holdUpdate?.resolve();
    if (cdp) { await cdp.evaluate("archiveApp.teardown()").catch(() => {}); await cdp.call("Browser.close").catch(() => {}); cdp.socket.close(); }
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGTERM"); await stopped; }
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
