import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { browserExecutable } from "../src/browser.ts";
import { CodeProjectStore, codeFileHash, summarizeCodeFiles } from "../src/code-project.ts";
import { compileCodeProject } from "../src/code-preview.ts";
import { createDesignServer } from "../src/server.ts";
import { VERSION } from "../src/version.ts";

interface BrowserContext { id: number; sessionId?: string; frameId?: string; isDefault?: boolean }
class CanvasCdp {
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
const board = (pageId: string) => `.dc-frame[data-page-id="${pageId}"]:not([hidden])`;
const frame = (pageId: string) => `${board(pageId)} iframe`;
const state = "({input:document.getElementById('remember').value,count:document.getElementById('counter').textContent})";
const runtimeProbe = "Intentional non-active page runtime probe";
function pageHtml(title: string, accent: string, link: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:20px;font:16px sans-serif;background:${accent}}h1{font-size:24px}input{width:180px}button,a{display:block;margin-top:12px}</style></head><body><h1 data-design-id="page-title">${title}</h1><input id="remember" aria-label="页面输入"><button id="counter" onclick="counter++;this.textContent=String(counter)">0</button><a id="next-page" href="${link}">打开另一真实页</a><section id="members">成员位置</section><script>var counter=0;globalThis.fixtureMode='select';globalThis.fixtureInputEvents=[];for(const type of ['pointerdown','focusin'])addEventListener(type,event=>fixtureInputEvents.push({type,id:event.target.id,trusted:event.isTrusted,hasFocus:document.hasFocus()}),true);addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='design:mode')globalThis.fixtureMode=event.data.mode});</script></body></html>`;
}
async function fixture(store: CodeProjectStore) {
  const other = await store.create({ name: "Independent second project", template: "html" });
  let project = await store.create({ name: "Actual multi-page canvas", template: "html" });
  const extras = Array.from({ length: 29 }, (_, index) => ({ id: `page_extra_${index}`, name: `其他方案 ${index + 1}`, entry: `extra-${index}.html`, route: `/extra-${index}` }));
  const pages = [{ id: "page_home", name: "中文工作台", entry: "index.html", route: "/" }, { id: "page_details", name: "中文阅读页", entry: "details.html", route: "/details" }, ...extras, { id: "page_broken", name: "独立失败页", entry: "broken.tsx", route: "/broken" }];
  project = await store.update(project.id, project.revision, {
    files: [
      { path: "index.html", content: pageHtml("工作台：待处理事项", "#fff0dd", "./details.html?tab=team#members"), expectedHash: codeFileHash(project.files.find(file => file.path === "index.html")!) },
      { path: "details.html", content: pageHtml("阅读页：独立方案", "#dcecef", "./index.html?from=reader#members"), expectedHash: null },
      ...extras.map(page => ({ path: page.entry, content: pageHtml(page.name, "#ece6f1", "/"), expectedHash: null })),
      { path: "broken.tsx", content: "export default function Broken(){return <", expectedHash: null }
    ], pages, defaultPageId: "page_home", viewports: [{ id: "shared-small", name: "共享测试尺寸", width: 360, height: 380 }, { id: "details-phone", name: "阅读页手机", width: 240, height: 380, pageId: "page_details" }]
  });
  return { project, other };
}

test("multi-page fixtures compile distinct real entries and isolate an actual failed entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-multi-page-fixture-"));
  try {
    const store = new CodeProjectStore({ dataDir: join(directory, "data") }), { project } = await fixture(store);
    assert.equal(project.pages.length, 32);
    const [home, details, broken] = await Promise.all(["page_home", "page_details", "page_broken"].map(pageId => compileCodeProject(project, { pageId })));
    assert.deepEqual(home!.diagnostics.filter(value => value.level === "error"), []); assert.deepEqual(details!.diagnostics.filter(value => value.level === "error"), []);
    assert.equal(home!.sources.find(source => source.tag === "h1")!.file, "index.html"); assert.equal(details!.sources.find(source => source.tag === "h1")!.file, "details.html");
    assert.ok(broken!.diagnostics.some(value => value.level === "error"));
    assert.notEqual(home!.html, details!.html, "Different pages must not be copies of one viewport's HTML");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real multi-page canvas preserves each live document, edits its actual source and rejects foreign or stale frame identities", { timeout: 120_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; multi-page editor behavior remains unverified."); return; }
  const directory = await mkdtemp(join(tmpdir(), "design-multi-page-canvas-")), store = new CodeProjectStore({ dataDir: join(directory, "data") });
  const { project: original, other } = await fixture(store);
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>In-memory multi-page protocol test</div>" });
  const client = new Client({ name: "multi-page-canvas-test", version: "1" }); const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  const calls: Array<{ name: string; projectId?: string; pageId?: string; revision?: number }> = [];
  const bridgeErrors: string[] = [];
  let activeCompiles = 0, maxCompiles = 0, panel = "";
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/tool") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(panel); return; }
      let body = ""; for await (const chunk of request) body += chunk;
      const { name, args } = JSON.parse(body); const recorded = { name, projectId: args.projectId, pageId: args.pageId, revision: undefined as number | undefined }; calls.push(recorded); let result: unknown;
      assert.ok(!["design_list_models", "design_code_request_generation", "design_code_resume_generation"].includes(name), "This regression must not start Codex or a model");
      const compiling = name === "design_code_preview";
      if (compiling) { recorded.revision = (await store.get(args.projectId)).revision; activeCompiles++; maxCompiles = Math.max(maxCompiles, activeCompiles); }
      try {
        const response = await client.callTool({ name, arguments: args }); result = response.structuredContent;
        if (response.isError) throw new Error(JSON.stringify(result));
      } finally { if (compiling) activeCompiles--; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
    } catch (error) { const message = error instanceof Error ? error.message : String(error); bridgeErrors.push(message); response.statusCode = 500; response.end(JSON.stringify({ error: message })); }
  });
  let child: ReturnType<typeof spawn> | undefined, cdp: CanvasCdp | undefined, phase = "browser startup";
  try {
    const bundled = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.canvasMessages=[];globalThis.promptObservations=[];addEventListener('message',event=>{if(event.data?.type?.startsWith('design:'))canvasMessages.push({data:event.data,registeredPage:[...document.querySelectorAll('.dc-frame')].find(frame=>frame.querySelector('iframe')?.contentWindow===event.source)?.dataset.pageId,registeredViewport:[...document.querySelectorAll('.dc-frame')].find(frame=>frame.querySelector('iframe')?.contentWindow===event.source)?.dataset.viewportId})});globalThis.canvasApp=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value},async prompt(text,context){promptObservations.push({text,context});return{status:'not-sent',reason:'Test bridge captured context only; no native chat delivery or inference occurred.'}}});canvasApp.connected().then(()=>canvasApp.setProjectId(${JSON.stringify(original.id)}));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "multi-page-harness.js" }, outfile: "multi-page-harness.js", bundle: true, platform: "browser", format: "iife", write: false, target: "es2022", logLevel: "silent" });
    const js = bundled.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = bundled.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}</style></head><body><div id="editor"></div><script>${js}</script></body></html>`;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: "ignore" });
    const port = await until("Chromium debugger", async () => (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new CanvasCdp(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
    await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await cdp.call("Page.enable"); await cdp.call("Runtime.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    const click = async (selector: string) => cdp!.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)throw Error('Missing UI control');if(target.matches('[data-overview-page]')){const picker=target.closest('details');if(picker&&!picker.open)picker.querySelector('summary').click()}target.click();return true})()`);
    const selectedPage = () => cdp!.evaluate("document.querySelector('[data-setting=page]')?.value");
    const childFor = (pageId: string) => until(`actual ${pageId} document`, () => cdp!.frame(frame(pageId)), Boolean);
    const visibleCount = () => cdp!.evaluate("[...document.querySelectorAll('.dc-frame iframe')].filter(frame=>frame.getClientRects().length&&getComputedStyle(frame).visibility!=='hidden').length");
    const visiblePages = () => cdp!.evaluate("[...new Set([...document.querySelectorAll('.dc-frame iframe')].filter(frame=>frame.getClientRects().length&&getComputedStyle(frame).visibility!=='hidden').map(frame=>frame.closest('.dc-frame').dataset.pageId))]");
    const viewportSelect = '.dc-board-caption[data-page-id=page_details]:not([hidden]) [data-board-viewport=page_details]';
    const setBoardViewport = async (viewportId: string) => cdp!.evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(viewportSelect)});select.focus();select.value=${JSON.stringify(viewportId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const clickInside = async (pageId: string, selector: string, childContext: BrowserContext) => {
      // A competing real target reproduces the missing foreground prerequisite.
      // Focus emulation belongs to this private headless browser; it neither
      // creates application protocol messages nor changes production behavior.
      const rival = await cdp!.call("Target.createTarget", { url: "about:blank" });
      try {
        await cdp!.call("Emulation.setFocusEmulationEnabled", { enabled: false });
        await cdp!.call("Target.activateTarget", { targetId: rival.targetId });
        await until("competing browser target takes real page focus", () => cdp!.evaluate("document.hasFocus()"), value => value === false);
        await cdp!.call("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (childContext.sessionId) await cdp!.call("Emulation.setFocusEmulationEnabled", { enabled: true }, childContext.sessionId);
        await cdp!.call("Page.bringToFront");
        // Steal the foreground again after bringToFront, as another desktop
        // browser may do during the whole-workspace check.
        await cdp!.call("Target.activateTarget", { targetId: rival.targetId });
        await until("headless page has its explicit browser focus setting", () => cdp!.evaluate("document.hasFocus()"), Boolean);
        const inside = await cdp!.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect();return{id:element.id,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:innerWidth,height:innerHeight}})()`, childContext);
        const outside = await cdp!.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(frame(pageId))}).getBoundingClientRect();return{x:rect.left,y:rect.top,width:rect.width,height:rect.height}})()`);
        const point = { x: outside.x + inside.x * outside.width / inside.width, y: outside.y + inside.y * outside.height / inside.height };
        assert.equal(await cdp!.evaluate(`document.elementFromPoint(${point.x},${point.y})===document.querySelector(${JSON.stringify(frame(pageId))})`), true, "The actual input point must hit the intended visible iframe");
        await cdp!.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await cdp!.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await cdp!.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
        const observed = await until("trusted pointer and focus reach the actual child input", () => cdp!.evaluate("({events:fixtureInputEvents,active:document.activeElement?.id,hasFocus:document.hasFocus()})", childContext), value => value.active === inside.id && value.hasFocus
          && value.events.some((event: any) => event.type === "pointerdown" && event.id === inside.id && event.trusted)
          && value.events.some((event: any) => event.type === "focusin" && event.id === inside.id && event.trusted && event.hasFocus));
        context.diagnostic(`Actual input events while a rival target owns foreground: ${JSON.stringify(observed.events.filter((event: any) => event.id === inside.id))}`);
      } finally { await cdp!.call("Target.closeTarget", { targetId: rival.targetId }); }
    };
    const iframeIdentities = () => cdp!.evaluate("[...document.querySelectorAll('.dc-frame:not([hidden]) iframe')].map(frame=>({page:frame.parentElement.dataset.pageId,viewport:frame.parentElement.dataset.viewportId,sandbox:frame.getAttribute('sandbox')}))");
    await until("initial real page", () => cdp!.evaluate(`!!document.querySelector(${JSON.stringify(frame("page_home"))})`), Boolean);
    phase = "overview entry and real page identities";
    assert.equal(await cdp.evaluate("!!document.querySelector('[data-action=page-overview]')"), true, "The real multi-page entry must exist; replicated viewports do not satisfy this regression");
    await click("[data-action=page-overview]");
    await until("two distinct page boards", () => cdp!.evaluate("[...document.querySelectorAll('.dc-frame iframe')].map(frame=>frame.parentElement.dataset.pageId)"), pages => pages.includes("page_home") && pages.includes("page_details"));
    // The page-specific phone is a valid default; explicitly compare both real
    // pages at the same shared size before testing the desktop/phone roundtrip.
    await setBoardViewport("shared-small");
    await until("explicit shared comparison size", () => cdp!.evaluate(`document.querySelector(${JSON.stringify(board("page_details"))})?.dataset.viewportId`), value => value === "shared-small");
    assert.equal(await cdp.evaluate("document.querySelectorAll('[data-overview-page]').length"), 32, "The full project is metadata-indexed without creating 32 documents");
    await click("[data-action=fit]");
    await until("both page boards visibly fit the actual canvas", () => cdp!.evaluate("(()=>{const stage=document.querySelector('.dc-canvas').getBoundingClientRect(),frames=[...document.querySelectorAll('.dc-frame:not([hidden]) iframe')];return frames.length===2&&frames.every(frame=>{const rect=frame.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.left>=stage.left-1&&rect.right<=stage.right+1&&rect.top>=stage.top-1&&rect.bottom<=stage.bottom+1})})()"), Boolean);
    let home = await childFor("page_home"), details = await childFor("page_details");
    assert.equal(await cdp.evaluate("document.querySelector('h1').textContent", home), "工作台：待处理事项");
    assert.equal(await cdp.evaluate("document.querySelector('h1').textContent", details), "阅读页：独立方案");
    assert.deepEqual((await iframeIdentities()).map((item: any) => item.viewport), ["shared-small", "shared-small"]);
    assert.ok((await iframeIdentities()).every((item: any) => {
      const tokens = String(item.sandbox ?? "").split(/\s+/).filter(Boolean);
      return tokens.includes("allow-scripts") && tokens.every(token => ["allow-scripts", "allow-forms"].includes(token));
    }), "Preview sandboxes may run real scripts/forms but cannot gain same-origin, popup or top-navigation privileges");
    assert.ok(calls.filter(call => call.name === "design_code_preview").length <= 2, "A 32-page project must not eagerly compile every page before any comment or explicit board request");
    if (process.env.DESIGN_CANVAS_CAPTURE_DIR) {
      // Optional visual evidence only; never write into a runtime or a developer
      // directory unless the caller explicitly selects an output location.
      try {
        const output = process.env.DESIGN_CANVAS_CAPTURE_DIR;
        if (!isAbsolute(output)) throw new Error("The optional capture directory must be absolute.");
        await mkdir(output, { recursive: true });
        const capture = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
        await writeFile(join(output, "multi-page-overview.png"), Buffer.from(capture.data, "base64"));
        await writeFile(join(output, "multi-page-overview.json"), JSON.stringify({ surface: "Actual headless Chromium test panel; not a native MCP host or an art sample", version: VERSION, projectId: original.id, revision: original.revision, viewport: { width: 1600, height: 1000 }, pages: original.pages.slice(0, 2), boards: await iframeIdentities() }, null, 2) + "\n");
        context.diagnostic("Saved the explicitly requested actual two-page overview screenshot and fixture identity.");
      } catch (error) { context.diagnostic(`Optional overview capture failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await cdp.evaluate("globalThis.originalBoards=new Map([...document.querySelectorAll('.dc-frame:not([hidden])')].map(board=>[board.dataset.pageId,board.querySelector('iframe')]));");
    phase = "preview focus activation and current-chat context observation";
    await click("[data-mode=preview]");
    await until("home receives actual preview mode", () => cdp!.evaluate("globalThis.fixtureMode", home), value => value === "preview");
    await until("details receives actual preview mode", () => cdp!.evaluate("globalThis.fixtureMode", details), value => value === "preview");
    await cdp.evaluate("document.getElementById('remember').value='Home state';document.getElementById('counter').click()", home);
    assert.equal(await selectedPage(), "page_home");
    // Route real pointer/focus events through Chromium. Setting activeElement in
    // an unfocused headless child alone does not produce a genuine focusin.
    await clickInside("page_details", "#remember", details);
    await until("real preview input focus activates its page", selectedPage, page => page === "page_details");
    await cdp.evaluate("document.getElementById('remember').value='Reading state';document.getElementById('counter').click();document.getElementById('counter').click()", details);
    const unchanged = async () => {
      assert.equal(await cdp!.evaluate("[...originalBoards].every(([page,iframe])=>document.querySelector('.dc-frame[data-page-id=\"'+page+'\"]:not([hidden]) iframe')===iframe)"), true);
      assert.deepEqual(await cdp!.evaluate(state, home), { input: "Home state", count: "1" });
      assert.deepEqual(await cdp!.evaluate(state, details), { input: "Reading state", count: "2" });
    };
    phase = "native viewport control roundtrip preserves its original board";
    await setBoardViewport("details-phone");
    await until("actual phone viewport board", () => cdp!.evaluate(`document.querySelector(${JSON.stringify(board("page_details"))})?.dataset.viewportId`), value => value === "details-phone");
    await childFor("page_details");
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(viewportSelect)}).value`), "details-phone");
    assert.match(await cdp.evaluate(`document.querySelector(${JSON.stringify(frame("page_details"))}).title`), /阅读页手机/);
    await setBoardViewport("shared-small");
    await until("original desktop viewport board restored", () => cdp!.evaluate(`document.querySelector(${JSON.stringify(board("page_details"))})?.dataset.viewportId`), value => value === "shared-small");
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(viewportSelect)}).value`), "shared-small", "Reused caption native value must match the real visible viewport");
    assert.equal(await cdp.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(viewportSelect)})`), true, "Viewport changes must retain focus on the current visible caption control instead of a hidden older match");
    assert.match(await cdp.evaluate(`document.querySelector(${JSON.stringify(frame("page_details"))}).title`), /共享测试尺寸/);
    await unchanged();
    phase = "non-active real runtime exception isolation";
    // Fault injection runs in the actual non-active sandbox. The bridge must
    // report its real exception on that board without activating or replacing it.
    await cdp.evaluate(`setTimeout(()=>{throw new Error(${JSON.stringify(runtimeProbe)})},0);true`, home);
    await until("real non-active runtime diagnostic", () => cdp!.evaluate("document.querySelector('[data-board-runtime-errors=page_home]')?.textContent"), value => typeof value === "string" && value.includes(runtimeProbe));
    assert.equal(await selectedPage(), "page_details");
    assert.equal(await cdp.evaluate(`document.querySelector('[data-board-runtime-errors=page_details]')?.textContent.includes(${JSON.stringify(runtimeProbe)})??false`), false);
    await unchanged();
    await click("[data-right-tab=ai]");
    await cdp.evaluate("const request=document.querySelector('[data-ai-prompt]');request.value='只检查实际活动页上下文，不执行模型';request.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=generate]').click()");
    await until("current-chat bridge context observation", () => cdp!.evaluate("promptObservations.length"), value => value === 1);
    assert.equal(await cdp.evaluate("promptObservations[0].context.pageId"), "page_details");
    assert.equal(calls.filter(call => call.name === "design_code_guidance").at(-1)?.pageId, "page_details");
    await unchanged();
    phase = "same-revision selection and comment-only revision confirmations";
    await click("[data-right-tab=inspect]"); await click("[data-action=zoom-in]"); await click("[data-mode=select]");
    await until("details receives actual selection mode", () => cdp!.evaluate("globalThis.fixtureMode", details), value => value === "select");
    await cdp.evaluate("document.querySelector('h1').click()", details);
    await until("non-default board selection", selectedPage, page => page === "page_details");
    await until("literal details Inspector", () => cdp!.evaluate("document.querySelector('[data-selection-text]')?.value"), value => value === "阅读页：独立方案");
    await unchanged();
    phase = "comment focus and overview/single-page roundtrip";
    await click("[data-action=comment-selection]");
    await cdp.evaluate("const draft=document.querySelector('[data-comment-draft]');draft.value='实际阅读页定位评论';draft.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=add-comment]').click()");
    let current = await until("real anchored comment", () => store.get(original.id), project => project.comments.length === 1);
    const commentId = current.comments[0]!.id;
    assert.equal(current.comments[0]!.file, "details.html"); assert.deepEqual(summarizeCodeFiles(current), summarizeCodeFiles(original));
    await until("both real revision confirmations", () => cdp!.evaluate(`canvasMessages.filter(message=>message.data.type==='design:revision-synced'&&message.data.revision===${current.revision}).map(message=>message.registeredPage+':'+message.registeredViewport)`), pages => pages.includes("page_home:shared-small") && pages.includes("page_details:shared-small"));
    await unchanged();
    const commentLocator = `[data-comment-page="${commentId}"][data-page-id=page_details]`;
    await until("comment page locator", () => cdp!.evaluate(`!!document.querySelector(${JSON.stringify(commentLocator)})`), Boolean);
    await click(commentLocator);
    await until("comment focus exact source", () => cdp!.evaluate("document.querySelector('[data-selection-text]')?.value"), value => value === "阅读页：独立方案");
    await unchanged();
    const overviewZoom = await cdp.evaluate("document.querySelector('[data-action=fit]').textContent");
    await click("[data-board-open=page_details]");
    await until("single-page mode", visiblePages, pages => pages.length === 1 && pages[0] === "page_details");
    assert.equal(await selectedPage(), "page_details");
    await click("[data-action=page-overview]");
    await until("overview returns both real pages", visibleCount, count => count === 2);
    assert.equal(await cdp.evaluate("document.querySelector('[data-action=fit]').textContent"), overviewZoom, "Returning to overview must restore its own zoom");
    home = await childFor("page_home"); details = await childFor("page_details");
    await cdp.evaluate("document.querySelector('h1').click()", details);
    await until("restored details selection", () => cdp!.evaluate("document.querySelector('[data-selection-text]')?.value"), value => value === "阅读页：独立方案");
    const indexBefore = current.files.find(file => file.path === "index.html")!.content;
    phase = "source-scoped element save and wrong-page identity rejection";
    await cdp.evaluate("const field=document.querySelector('[data-selection-text]');field.value='阅读页：仅修改此真实文件';field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=apply-selection]').click()");
    current = await until("details source save", () => store.get(original.id), project => project.revision === current.revision + 1);
    assert.equal(current.files.find(file => file.path === "index.html")!.content, indexBefore); assert.match(current.files.find(file => file.path === "details.html")!.content, /仅修改此真实文件/);
    details = await until("new details document after source edit", async () => { const next = await cdp!.frame(frame("page_details")); if (await cdp!.evaluate("document.querySelector('h1').textContent", next) !== "阅读页：仅修改此真实文件") throw new Error("The previous source is still visible"); return next; }, Boolean);
    home = await childFor("page_home");
    await cdp.evaluate("document.querySelector('h1').click()", home);
    await until("home source selection", selectedPage, page => page === "page_home");
    const validHome = await cdp.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection'&&message.data.pageId==='page_home').slice(-1)[0].data");
    await cdp.evaluate("document.querySelector('h1').click()", details);
    await until("new revision selection", () => cdp!.evaluate("document.querySelector('[data-selection-text]')?.value"), value => value === "阅读页：仅修改此真实文件");
    // The details child sends a real home registry entry. A valid source ID and
    // revision cannot authorize a different iframe's page identity.
    await cdp.evaluate(`parent.postMessage({...${JSON.stringify(validHome)},testMarker:'wrong-page'},'*')`, details);
    await until("wrong-page child message delivered", () => cdp!.evaluate("canvasMessages.some(message=>message.data.testMarker==='wrong-page')"), Boolean);
    assert.equal(await cdp.evaluate("document.querySelector('[data-selection-text]')?.value"), "阅读页：仅修改此真实文件");
    assert.equal(await selectedPage(), "page_details");
    phase = "genuine stale-document click and source recompile";
    const staleContext = details, staleRevision = current.revision;
    await cdp.evaluate("document.querySelector('[data-file=\"details.html\"]').click();const source=document.querySelector('[data-source-input]');source.value=source.value.replace('仅修改此真实文件','源码再次修改');source.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=save-source]').click();");
    current = await until("source-view save", () => store.get(original.id), project => project.revision === current.revision + 1);
    await until("latest revision accepted", () => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${current.revision}`);
    await click("[data-right-tab=comments]");
    const staleMessages = await cdp.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection').length");
    await cdp.evaluate("document.querySelector('h1').click()", details);
    await until("genuine stale document click delivered", () => cdp!.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection').length"), count => count > staleMessages);
    assert.equal(await cdp.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection').slice(-1)[0].data.revision"), staleRevision);
    assert.equal(await cdp.evaluate("document.querySelector('[data-right-tab=comments]').classList.contains('active')"), true, "A genuine click from the retained old document must not restore obsolete source selection");
    await click("[data-view=design]");
    details = await until("source revision recompile", async () => { const next = await cdp!.frame(frame("page_details")); if (await cdp!.evaluate("document.querySelector('h1').textContent", next) !== "阅读页：源码再次修改") throw new Error("The previous source is still visible"); return next; }, Boolean);
    assert.notDeepEqual({ id: details.id, sessionId: details.sessionId }, { id: staleContext.id, sessionId: staleContext.sessionId }, "Source changes must use the newly compiled document rather than updating only its revision label");
    phase = "actual project navigation query/hash";
    await click("[data-mode=preview]"); home = await childFor("page_home");
    await until("home navigation receives preview mode", () => cdp!.evaluate("globalThis.fixtureMode", home), value => value === "preview");
    await cdp.evaluate("document.getElementById('next-page').click()", home);
    await until("real navigation enters one target page", async () => ({ pages: await visiblePages(), page: await selectedPage() }), value => value.pages.length === 1 && value.pages[0] === "page_details" && value.page === "page_details");
    details = await childFor("page_details");
    await until("navigation query and fragment", () => cdp!.evaluate("globalThis.designLocation", details), value => value.search === "?tab=team" && value.hash === "#members" && value.pageId === "page_details");
    await click("[data-action=page-overview]");
    await until("overview group after navigation", visibleCount, value => value === 2);
    home = await childFor("page_home");
    phase = "page-specific compile failure and live-frame cap";
    await cdp.evaluate("globalThis.homeBeforeFailure=document.querySelector('.dc-frame[data-page-id=page_home] iframe')");
    await click("[data-overview-page=page_broken]");
    await until("isolated real compile failure", () => cdp!.evaluate("document.querySelector('[data-page-id=page_broken]')?.textContent"), value => typeof value === "string" && /error|错误|编译|Expected/i.test(value));
    await click('.dc-board-caption[data-page-id=page_broken]:not([hidden]) details summary');
    await until("expanded failure details remain outside the board", () => cdp!.evaluate("(()=>{const caption=document.querySelector('.dc-board-caption[data-page-id=page_broken]:not([hidden])'),board=document.querySelector('.dc-frame[data-page-id=page_broken]:not([hidden])');return caption?.querySelector('details')?.open&&board.getBoundingClientRect().top-caption.getBoundingClientRect().bottom>=7})()"), Boolean);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame[data-page-id=page_home] iframe')===homeBeforeFailure"), true);
    assert.equal(await cdp.evaluate("document.querySelector('h1').textContent", home), "工作台：待处理事项");
    await click("[data-overview-page=page_broken]");
    await click("[data-overview-page=page_extra_0]");
    await click("[data-overview-page=page_extra_1]");
    await until("four selected page budget", () => cdp!.evaluate("document.querySelectorAll('[data-overview-page]:checked').length"), value => value === 4);
    await childFor("page_extra_0"); await childFor("page_extra_1");
    assert.equal(await visibleCount(), 4, "The cap must be exercised by four actual running page documents");
    assert.equal(await cdp.evaluate("document.querySelector('[data-overview-page=page_extra_2]').disabled"), true, "A fifth board must require an explicit group change");
    const fifthCalls = calls.filter(call => call.name === "design_code_preview" && call.pageId === "page_extra_2").length;
    await click("[data-overview-page=page_extra_2]");
    assert.equal(await cdp.evaluate("document.querySelectorAll('[data-overview-page]:checked').length"), 4);
    assert.equal(calls.filter(call => call.name === "design_code_preview" && call.pageId === "page_extra_2").length, fifthCalls);
    assert.ok(await cdp.evaluate("document.querySelectorAll('.dc-frame iframe').length<=4"));
    assert.ok(maxCompiles <= 2, `Observed ${maxCompiles} concurrent real compiles`);
    phase = "reloaded caption cannot cover any live preview";
    await click("[data-overview-page=page_home]");
    await click("[data-overview-page=page_extra_2]");
    await childFor("page_extra_2");
    await click("[data-overview-page=page_extra_2]");
    await click("[data-overview-page=page_home]");
    await childFor("page_home");
    await until("actual released-board notice", () => cdp!.evaluate("document.querySelector('.dc-board-caption[data-page-id=page_home]:not([hidden]) .dc-board-released')?.textContent"), value => typeof value === "string" && value.includes("临时状态已重置"));
    const captionsClear = () => cdp!.evaluate("(()=>{const frames=[...document.querySelectorAll('.dc-frame:not([hidden])')].map(el=>el.getBoundingClientRect()),labels=[...document.querySelectorAll('.dc-board-caption:not([hidden])')];return labels.length===4&&labels.every(el=>{const r=el.getBoundingClientRect();return r.height>0&&frames.every(f=>r.right<=f.left||r.left>=f.right||r.bottom<=f.top-7||r.top>=f.bottom)})})()");
    for (const width of [1600, 900, 1600]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await click("[data-action=fit]");
      await until(`captions stay outside every iframe at panel width ${width}`, captionsClear, Boolean);
      await click("[data-action=zoom-in]");
      await until(`zoomed captions stay outside every iframe at panel width ${width}`, captionsClear, Boolean);
    }
    // An unregistered sandbox uses the actual compiled source. Its genuine DOM
    // click cannot impersonate a registered board, including after project switch.
    phase = "real unregistered old-project document click";
    await cdp.evaluate("const rogue=document.createElement('iframe');rogue.id='old-project-document';rogue.setAttribute('sandbox','allow-scripts');rogue.srcdoc=document.querySelector('.dc-frame[data-page-id=page_home] iframe').srcdoc;rogue.hidden=true;document.body.append(rogue)");
    const rogue = await until("unregistered actual document", () => cdp!.frame("#old-project-document"), Boolean);
    await cdp.evaluate(`const choice=document.querySelector('[data-setting=project]');choice.value=${JSON.stringify(other.id)};choice.dispatchEvent(new Event('change',{bubbles:true}))`);
    await until("actual second project document", () => cdp!.frame(frame(other.defaultPageId)), Boolean);
    await until("actual second project selected", () => cdp!.evaluate("document.querySelector('[data-setting=project]').value"), value => value === other.id);
    const oldMessages = await cdp.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection'&&!message.registeredPage).length");
    await cdp.evaluate("document.querySelector('h1').click()", rogue);
    await until("unregistered old-project click delivered", () => cdp!.evaluate("canvasMessages.filter(message=>message.data.type==='design:selection'&&!message.registeredPage).length"), count => count > oldMessages);
    assert.equal(await cdp.evaluate("document.querySelector('[data-setting=project]').value"), other.id);
    assert.equal(await cdp.evaluate("!!document.querySelector('[data-selection-text]')"), false);
    assert.equal((await store.get(original.id)).revision, current.revision); assert.equal((await store.get(other.id)).revision, other.revision);
    assert.deepEqual(bridgeErrors, []);
    assert.ok(cdp.errors.length > 0 && cdp.errors.every(error => error.includes(runtimeProbe)), `Only the explicit real runtime fault is expected: ${JSON.stringify(cdp.errors)}`);
    context.diagnostic(`Real multi-page evidence: 32 source pages, distinct entries, focus activation, source-scoped edit, comment confirmations, one intentional non-active runtime exception, navigation and rejection paths; observed compile peak=${maxCompiles}. Prompt capture is a test bridge observation, not native chat delivery. Native MCP host and model execution are not covered.`);
  } catch (error) {
    context.diagnostic(`Failed phase: ${phase}; recent real tools: ${JSON.stringify(calls.slice(-16))}; bridge errors: ${JSON.stringify(bridgeErrors)}; browser errors: ${JSON.stringify(cdp?.errors ?? [])}`);
    if (cdp) {
      context.diagnostic(`Actual UI state: ${JSON.stringify(await cdp.evaluate("({page:document.querySelector('[data-setting=page]')?.value,revision:document.querySelector('[data-revision]')?.textContent,toast:document.querySelector('.dc-toast')?.textContent,boards:[...document.querySelectorAll('.dc-frame')].map(board=>({page:board.dataset.pageId,viewport:board.dataset.viewportId,iframe:!!board.querySelector('iframe'),visible:!!board.getClientRects().length})),messages:canvasMessages.slice(-12).map(({data,registeredPage})=>({type:data.type,page:data.pageId,registeredPage,revision:data.revision,hashCount:Object.keys(data.fileHashes??{}).length,renderIdentity:data.renderIdentity}))})").catch(() => "unavailable"))}`);
      context.diagnostic(`Details document state: ${JSON.stringify(await cdp.frame(frame("page_details")).then(child => cdp!.evaluate("({focus:document.activeElement?.id,hasFocus:document.hasFocus(),mode:globalThis.fixtureMode,input:document.getElementById('remember')?.value,count:document.getElementById('counter')?.textContent,inputEvents:globalThis.fixtureInputEvents?.slice(-8)})", child)).catch(() => "unavailable"))}`);
    }
    throw error;
  } finally {
    if (cdp) { await cdp.evaluate("canvasApp.teardown()").catch(() => {}); await cdp.call("Browser.close").catch(() => {}); cdp.socket.close(); }
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGTERM"); await stopped; }
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
