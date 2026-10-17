import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { browserExecutable } from "../src/browser.ts";
import { CodeProjectStore, codeFileHash, summarizeCodeFiles } from "../src/code-project.ts";
import type { CodeProject } from "../src/code-project.ts";
import { createDesignServer } from "../src/server.ts";

interface BrowserContext { id: number; sessionId?: string; frameId?: string; isDefault?: boolean }
class TokenCdp {
  socket: WebSocket;
  ready: Promise<void>;
  next = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  contexts = new Map<string, BrowserContext>();
  errors: string[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener("open", () => resolve(), { once: true }); this.socket.addEventListener("error", () => reject(new Error("Token test Chromium connection failed")), { once: true }); });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else if (message.method === "Target.attachedToTarget") void this.call("Runtime.enable", {}, message.params.sessionId).catch(() => {});
      else if (message.method === "Runtime.executionContextCreated") this.contexts.set(`${message.sessionId ?? ""}:${message.params.context.id}`, { id: message.params.context.id, sessionId: message.sessionId, ...message.params.context.auxData });
      else if (message.method === "Runtime.executionContextDestroyed") this.contexts.delete(`${message.sessionId ?? ""}:${message.params.executionContextId}`);
      else if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    this.socket.addEventListener("close", () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Token test Chromium connection closed")); } this.pending.clear(); });
  }
  async call(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chromium ${method} did not complete`)); }, 15_000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  async evaluate(expression: string, context?: BrowserContext): Promise<any> {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(context ? { contextId: context.id } : {}) }, context?.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async frame(pageId: string): Promise<BrowserContext> {
    const tree = await this.call("DOM.getDocument"), node = await this.call("DOM.querySelector", { nodeId: tree.root.nodeId, selector: `.dc-frame[data-page-id="${pageId}"]:not([hidden]) iframe` });
    if (!node.nodeId) throw new Error(`Missing real page ${pageId}`);
    const description = await this.call("DOM.describeNode", { nodeId: node.nodeId });
    const found = [...this.contexts.values()].find(context => context.frameId === description.node.frameId && context.isDefault);
    if (!found) throw new Error(`Real page context not ready: ${pageId}`); return found;
  }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(label: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000; let last: unknown;
  while (true) { try { const value = await read(); last = value; if (matches(value)) return value; } catch (error) { last = error instanceof Error ? error.message : String(error); } if (Date.now() > deadline) throw new Error(`${label} was not observed: ${JSON.stringify(last)}`); await pause(20); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Gate = { name: string; projectId: string; before: boolean; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> };
const inputExpression = (name: string) => `([...document.querySelectorAll('[data-token-card]')].find(card=>card.querySelector('.dc-token-title code').textContent===${JSON.stringify(name)})?.querySelector('[data-token-value]'))`;
function contrast(foreground: string, background: string) {
  const luminance = (value: string) => { const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(channel => { const normalized = Number(channel) / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; }); assert.equal(channels?.length, 3, `Expected computed RGB color: ${value}`); return channels![0]! * .2126 + channels![1]! * .7152 + channels![2]! * .0722; };
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function html(title: string) { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="./shared.css"><style>:root { --inline-note: 1px; }</style></head><body><h1>${title}</h1><section class="sample">实际设计系统<input id="remember" aria-label="保留原型输入"></section></body></html>`; }

async function harness(executable: string) {
  const directory = await mkdtemp(join(tmpdir(), "design-css-token-browser-")), store = new CodeProjectStore({ dataDir: join(directory, "data") });
  const other = await store.create({ name: "Independent token destination", template: "html" });
  let project = await store.create({ name: "CSS source tokens across two pages", template: "html" });
  const shared = `/* Preserve source formatting and comments. */\n:root {\n  --brand: #165d79;\n  --space: 12px;\n${Array.from({ length: 55 }, (_, i) => `  --scale-${String(i).padStart(2, "0")}: ${i}px;`).join("\n")}\n}\nbody {font:16px sans-serif;margin:0} .sample {color:var(--brand);padding:var(--space)}\n`;
  project = await store.update(project.id, project.revision, { files: [
    { path: "index.html", content: html("第一真实页面"), expectedHash: codeFileHash(project.files.find(file => file.path === "index.html")!) },
    { path: "second.html", content: html("第二真实页面"), expectedHash: null },
    { path: "shared.css", content: shared, expectedHash: null },
    { path: "extra.css", content: ":root { --extra: 9px; }", expectedHash: null }
  ], pages: [{ id: "page_first", name: "第一页", entry: "index.html", route: "/" }, { id: "page_second", name: "第二页", entry: "second.html", route: "/second" }], defaultPageId: "page_first", viewports: [{ id: "token_phone", name: "真实测试尺寸", width: 390, height: 440 }] });
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>Source token protocol fixture</div>" }), client = new Client({ name: "css-token-browser", version: "1" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair(); await instance.server.connect(serverSide); await client.connect(clientSide);
  let gate: Gate | undefined, panel = "", child: ReturnType<typeof spawn> | undefined, cdp: TokenCdp | undefined;
  const gates: Gate[] = [], calls: Array<{ name: string; args: Record<string, any>; error?: boolean }> = [], unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/tool") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(panel); return; }
      let body = ""; for await (const chunk of request) body += chunk;
      const { name, args } = JSON.parse(body), record = { name, args, error: false }; calls.push(record);
      assert.ok(!/generation|models/.test(name), "Token checks must never invoke a model");
      const pending = gate && gate.name === name && gate.projectId === args.projectId ? gate : undefined; if (pending) gate = undefined;
      if (pending?.before) { pending.entered.resolve(); await pending.release.promise; }
      const result = await client.callTool({ name, arguments: args });
      if (pending && !pending.before) { pending.entered.resolve(); await pending.release.promise; }
      record.error = !!result.isError;
      const value = result.structuredContent as Record<string, any>; assert.ok(value, "The real MCP tool must return structured data");
      response.setHeader("Content-Type", "application/json"); if (result.isError) response.statusCode = 409;
      response.end(JSON.stringify(result.isError ? { error: value.error?.message ?? JSON.stringify(value) } : value)); pending?.finished.resolve();
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); unexpected.push(detail); response.statusCode = 500; response.end(JSON.stringify({ error: detail })); }
  });
  try {
    const built = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.tokenApp=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const result=await response.json();if(!response.ok)throw Error(result.error);return result},async prompt(){throw Error('No inference is part of source token browser verification')}});tokenApp.connected().then(()=>tokenApp.setProjectId(${JSON.stringify(project.id)}));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "token-ui-harness.js" }, outfile: "token-ui.js", bundle: true, platform: "browser", format: "iife", write: false, target: "es2022", logLevel: "silent" });
    const js = built.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = built.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;font-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}</style></head><body><div id="editor"></div><input id="outside" aria-label="Outside the destroyed editor"><script>${js}</script></body></html>`;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: "ignore" });
    const port = await until("Chromium port", async () => (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new TokenCdp(targets.find(target => target.type === "page")!.webSocketDebuggerUrl); await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await cdp.call("Runtime.enable"); await cdp.call("Page.enable"); await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true }); await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await until("actual project", () => cdp!.evaluate(`document.querySelector('[data-setting=project]')?.value`), value => value === project.id);
    await until("actual initial iframe", () => cdp!.frame("page_first"), Boolean);
    const browser = cdp;
    return {
      cdp: browser, store, project, other, calls, unexpected,
      async publish(next: CodeProject) { await browser.evaluate(`tokenApp.receive(${JSON.stringify({ project: next, files: summarizeCodeFiles(next) })})`); await until("published revision", () => browser.evaluate("document.querySelector('[data-revision]')?.textContent"), value => value === `修订 ${next.revision}`); },
      hold(name: string, projectId = project.id, before = false) { const next = { name, projectId, before, entered: deferred(), release: deferred(), finished: deferred() }; gate = next; gates.push(next); return next; },
      async close() { for (const item of gates) item.release.resolve(); await browser.evaluate("tokenApp.teardown()").catch(() => {}); browser.socket.close(); if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGTERM"); const force = setTimeout(() => child!.kill("SIGKILL"), 1000); await closed; clearTimeout(force); } await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); }
    };
  } catch (error) {
    for (const item of gates) item.release.resolve(); cdp?.socket.close(); child?.kill("SIGTERM"); await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

test("CSS token UI edits actual shared CSS once, updates two real pages and retains source-bound drafts through metadata and conflicts", { timeout: 90_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; real CSS token UI remains unverified."); return; }
  const h = await harness(executable), { cdp, store } = h; let phase = "initial actual preview";
  const tokenValue = (name: string) => cdp.evaluate(`${inputExpression(name)}?.value`);
  const stage = async (name: string, value: string) => { await cdp.evaluate(`(()=>{const field=${inputExpression(name)};if(!field)throw Error('Missing token field');field.focus();field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.setSelectionRange(1,3)})()`); };
  const filter = async (file: string) => { await cdp.evaluate(`(()=>{const field=document.querySelector('[data-token-file]');field.value=${JSON.stringify(file)};field.dispatchEvent(new Event('change',{bubbles:true}))})()`); await until("token filter loaded", () => cdp.evaluate("!document.querySelector('[data-token-loading]')&&document.querySelector('[data-token-file]')?.value"), value => value === file); };
  const sample = async (pageId: string) => { const frame = await cdp.frame(pageId); return cdp.evaluate("(()=>{const style=getComputedStyle(document.querySelector('.sample'));return{color:style.color,padding:style.paddingTop,input:document.getElementById('remember').value}})()", frame); };
  try {
    await cdp.evaluate("document.querySelector('[data-action=page-overview]').click();document.querySelector('[data-left-tab=system]').click()");
    await until("two actual live pages", async () => { await cdp.frame("page_first"); await cdp.frame("page_second"); return true; }, Boolean);
    await until("source token catalogue", () => tokenValue("--brand"), value => value === "#165d79");
    for (const page of ["page_first", "page_second"]) assert.deepEqual(await sample(page), { color: "rgb(22, 93, 121)", padding: "12px", input: "" });
    await cdp.evaluate("globalThis.beforeFrames=[...document.querySelectorAll('.dc-frame iframe')]");
    for (const page of ["page_first", "page_second"]) await cdp.evaluate(`document.getElementById('remember').value=${JSON.stringify(page)}`, await cdp.frame(page));
    phase = "metadata-only update preserves focused token draft and real documents";
    await stage("--brand", "#a34c16");
    for (const theme of ["light", "dark"]) {
      await cdp.evaluate(`document.documentElement.dataset.hostTheme=${JSON.stringify(theme)};${inputExpression("--brand")}.scrollIntoView({block:'center'});${inputExpression("--brand")}.focus()`);
      const controls = await cdp.evaluate(`(()=>{const input=${inputExpression("--brand")},apply=document.querySelector('[data-action=apply-tokens]');const colors=element=>{const style=getComputedStyle(element);return{color:style.color,background:style.backgroundColor,outline:style.outlineColor,width:style.outlineWidth}};return{input:colors(input),apply:colors(apply),focused:document.activeElement===input}})()`);
      assert.equal(controls.focused, true); assert.ok(contrast(controls.input.color, controls.input.background) >= 4.5, `${theme} token input text must remain readable`); assert.ok(contrast(controls.input.outline, controls.input.background) >= 3, `${theme} focused token boundary must remain visible`); assert.equal(controls.input.width, "3px"); assert.ok(contrast(controls.apply.color, controls.apply.background) >= 4.5, `${theme} enabled apply action must remain readable`);
      if (process.env.DESIGN_TOKEN_SCREENSHOT_DIR) { await mkdir(process.env.DESIGN_TOKEN_SCREENSHOT_DIR, { recursive: true }); const capture = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const path = join(process.env.DESIGN_TOKEN_SCREENSHOT_DIR, `token-panel-${theme}.png`); await writeFile(path, Buffer.from(capture.data, "base64")); context.diagnostic(`Actual focused ${theme} token panel screenshot: ${path}`); }
      context.diagnostic(`${theme} actual token input contrast=${contrast(controls.input.color, controls.input.background).toFixed(2)}, focus=${contrast(controls.input.outline, controls.input.background).toFixed(2)}, apply=${contrast(controls.apply.color, controls.apply.background).toFixed(2)}`);
    }
    await cdp.evaluate("document.documentElement.dataset.hostTheme='light'");
    let current = await store.get(h.project.id); const notesOnly = await store.update(current.id, current.revision, { designSystem: { ...current.designSystem, notes: "New brand guidance only; actual CSS is unchanged." } });
    await h.publish(notesOnly); await until("metadata token refresh", () => cdp.evaluate("!document.querySelector('[data-token-loading]')"), Boolean);
    assert.deepEqual(await cdp.evaluate(`({value:${inputExpression("--brand")}?.value,focused:document.activeElement===${inputExpression("--brand")},start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,sameFrames:beforeFrames.every(frame=>frame.isConnected),apply:document.querySelector('[data-action=apply-tokens]').disabled})`), { value: "#a34c16", focused: true, start: 1, end: 3, sameFrames: true, apply: false });
    for (const page of ["page_first", "page_second"]) assert.equal((await sample(page)).input, page);
    phase = "single actual MCP batch changes both pages";
    await stage("--space", "28px"); const beforeApply = (await store.get(h.project.id)).revision;
    await cdp.evaluate("document.querySelector('[data-action=apply-tokens]').focus();document.querySelector('[data-action=apply-tokens]').click()");
    current = await until("one token CAS", () => store.get(h.project.id), value => value.revision === beforeApply + 1);
    await until("token UI applied", () => tokenValue("--brand"), value => value === "#a34c16");
    for (const page of ["page_first", "page_second"]) await until(`computed CSS ${page}`, () => sample(page), value => value.color === "rgb(163, 76, 22)" && value.padding === "28px");
    assert.equal(h.calls.filter(call => call.name === "design_code_edit_tokens").length, 1); assert.equal(h.calls.find(call => call.name === "design_code_edit_tokens")!.args.edits.length, 2);
    assert.ok(current.files.find(file => file.path === "shared.css")!.content.startsWith("/* Preserve source formatting and comments. */\n:root {\n  --brand: #a34c16;\n  --space: 28px;"));
    assert.equal(await cdp.evaluate("document.querySelector('[data-token-draft-count]').textContent"), "没有未应用的修改");
    phase = "pagination, filtering, per-token cancel and actual source selection";
    await cdp.evaluate("document.querySelector('[data-action=tokens-next]').click()"); await until("next token page", () => cdp.evaluate("document.querySelector('.dc-token-pages span')?.textContent"), value => value?.startsWith("51–"));
    await filter("extra.css"); assert.equal(await cdp.evaluate("document.querySelectorAll('[data-token-card]').length"), 1); assert.equal(await tokenValue("--extra"), "9px");
    await stage("--extra", "14px"); await cdp.evaluate(`(()=>{const field=${inputExpression("--extra")};field.closest('[data-token-card]').querySelector('[data-token-cancel]').click()})()`);
    assert.equal(await tokenValue("--extra"), "9px"); assert.equal(await cdp.evaluate(`document.activeElement===${inputExpression("--extra")}`), true);
    await filter("shared.css"); await until("shared first page", () => tokenValue("--brand"), value => value === "#a34c16");
    await cdp.evaluate(`(${inputExpression("--brand")}).closest('[data-token-card]').querySelector('[data-token-source]').click()`);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-code-head code').textContent"), "shared.css");
    assert.equal(await cdp.evaluate("document.querySelector('[data-source-input]').value.slice(document.querySelector('[data-source-input]').selectionStart,document.querySelector('[data-source-input]').selectionEnd).includes('--brand: #a34c16')"), true);
    phase = "real revision conflict retains input without writing stale source";
    await cdp.evaluate("document.querySelector('[data-view=design]').click()"); await stage("--brand", "#7f226a");
    const held = h.hold("design_code_edit_tokens", h.project.id, true); await cdp.evaluate("document.querySelector('[data-action=apply-tokens]').click()"); await held.entered.promise;
    current = await store.get(h.project.id); const css = current.files.find(file => file.path === "shared.css")!;
    const external = await store.update(current.id, current.revision, { files: [{ path: css.path, content: css.content.replace("#a34c16", "#20582f"), expectedHash: codeFileHash(css) }] });
    held.release.resolve(); await held.finished.promise;
    await until("actual stale save error", () => cdp.evaluate("document.querySelector('[data-token-error]')?.textContent"), value => value?.includes("暂存保留"));
    assert.equal(await tokenValue("--brand"), "#7f226a"); assert.equal((await store.get(h.project.id)).revision, external.revision); assert.ok(h.calls.some(call => call.name === "design_code_edit_tokens" && call.error));
    await h.publish(external); await until("fresh changed source list", () => cdp.evaluate("!document.querySelector('[data-token-loading]')&&document.querySelector('[data-token-actions]')?.textContent"), value => !!value);
    assert.equal(await cdp.evaluate("document.querySelector('[data-action=apply-tokens]').disabled"), true); assert.equal(await tokenValue("--brand"), "#20582f");
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.dc-token-retained [data-token-value]')].some(input=>input.value==='#7f226a')"), true, "The stale source-bound draft must remain visible separately, never silently rebind by name");
    await cdp.evaluate("document.querySelector('[data-action=cancel-tokens]').click()"); assert.equal(await cdp.evaluate("document.querySelectorAll('.dc-token-retained [data-token-card]').length"), 0);
    assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic("Actual source MCP tools, CSS parser, store CAS, compilation and two Chromium computed styles verified; native host integration is not claimed.");
  } catch (error) { context.diagnostic(`phase=${phase}; calls=${JSON.stringify(h.calls.slice(-10))}; errors=${JSON.stringify(cdp.errors)}`); throw error; }
  finally { await h.close(); }
});

test("late token lists and successful saves cannot adopt a different project or touch a destroyed editor", { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; token request ownership remains unverified."); return; }
  const h = await harness(executable), { cdp, store } = h; let phase = "withheld real list";
  const readProject = () => cdp.evaluate("document.querySelector('[data-setting=project]')?.value");
  const switchTo = async (projectId: string) => { await cdp.evaluate(`tokenApp.setProjectId(${JSON.stringify(projectId)})`); await until("selected destination project", readProject, value => value === projectId); };
  const stage = async (name: string, value: string) => cdp.evaluate(`(()=>{const input=${inputExpression(name)};input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  try {
    let held = h.hold("design_code_list_tokens"); await cdp.evaluate("document.querySelector('[data-left-tab=system]').click()"); await held.entered.promise;
    await switchTo(h.other.id); await until("destination real token list", () => cdp.evaluate("!document.querySelector('[data-token-loading]')"), Boolean);
    const destinationNames = await cdp.evaluate("[...document.querySelectorAll('.dc-token-title code')].map(code=>code.textContent)"); assert.ok(!destinationNames.includes("--brand"));
    held.release.resolve(); await held.finished.promise; await pause(50); assert.equal(await readProject(), h.other.id); assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.dc-token-title code')].map(code=>code.textContent)"), destinationNames);
    phase = "withheld successful old-project token save";
    await switchTo(h.project.id); await until("original actual tokens", () => cdp.evaluate(`${inputExpression("--brand")}?.value`), value => value === "#165d79"); await stage("--brand", "#b24718");
    held = h.hold("design_code_edit_tokens"); await cdp.evaluate("document.querySelector('[data-action=apply-tokens]').click()"); await held.entered.promise;
    assert.equal((await store.get(h.project.id)).revision, h.project.revision + 1, "The withheld response follows a real successful old-project write");
    await switchTo(h.other.id); await until("destination actual preview", () => cdp.frame(h.other.defaultPageId), Boolean);
    await cdp.evaluate("document.querySelector('[data-view=source]').click();const source=document.querySelector('[data-source-input]');globalThis.destinationDraft=source.value+'\\n<!-- Preserve new project source draft -->';source.value=destinationDraft;source.dispatchEvent(new Event('input',{bubbles:true}));source.focus();source.setSelectionRange(2,7)");
    held.release.resolve(); await held.finished.promise;
    await until("old save cleared busy only", () => cdp.evaluate("!document.querySelector('.dc-save-state').classList.contains('saving')"), Boolean);
    assert.deepEqual(await cdp.evaluate("({project:document.querySelector('[data-setting=project]').value,value:document.querySelector('[data-source-input]').value,expected:destinationDraft,focused:document.activeElement.matches('[data-source-input]'),start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})"), { project: h.other.id, value: await cdp.evaluate("destinationDraft"), expected: await cdp.evaluate("destinationDraft"), focused: true, start: 2, end: 7 });
    assert.equal((await store.get(h.other.id)).revision, h.other.revision, "Only the explicitly submitted original project changes");
    phase = "destroyed editor ignores successful token response";
    await cdp.evaluate("document.querySelector('[data-view=design]').click();document.querySelector('[data-view=source]').click();document.querySelector('[data-action=reset-source]').click()"); await switchTo(h.project.id);
    await until("saved original source tokens", () => cdp.evaluate(`${inputExpression("--brand")}?.value`), value => value === "#b24718");
    await cdp.evaluate("document.querySelector('[data-action=cancel-tokens]').click()"); await stage("--brand", "#31218a");
    held = h.hold("design_code_edit_tokens"); await cdp.evaluate("document.querySelector('[data-action=apply-tokens]').click()"); await held.entered.promise;
    await cdp.evaluate("globalThis.closedTokenEditor=tokenApp.teardown();document.getElementById('editor').remove();document.getElementById('outside').focus();true"); held.release.resolve(); await held.finished.promise; await cdp.evaluate("closedTokenEditor");
    assert.equal(await cdp.evaluate("document.activeElement.id"), "outside"); assert.equal(await cdp.evaluate("document.querySelectorAll('.dc-app,.dc-toast').length"), 0);
    assert.ok((await store.get(h.project.id)).files.find(file => file.path === "shared.css")!.content.includes("--brand: #31218a;"));
    assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic("Withheld real MCP list/save responses, project changes, active source caret and teardown verified without replacing token tools or compiler.");
  } catch (error) { context.diagnostic(`phase=${phase}; calls=${JSON.stringify(h.calls.slice(-10))}; errors=${JSON.stringify(cdp.errors)}`); throw error; }
  finally { await h.close(); }
});
