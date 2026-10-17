import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { browserExecutable } from "../src/browser.ts";
import { CodeProjectStore, codeFileHash, summarizeCodeFiles } from "../src/code-project.ts";
import { anchorCodeElement, compileCodeProject } from "../src/code-preview.ts";

interface TestContext { id: number; sessionId?: string; frameId?: string; isDefault?: boolean }
class TestCdp {
  socket: WebSocket;
  ready: Promise<void>;
  next = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  contexts = new Map<string, TestContext>();
  errors: string[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener("open", () => resolve(), { once: true }); this.socket.addEventListener("error", () => reject(new Error("Test Chromium connection failed")), { once: true }); });
    this.socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.id) { const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } } else if (message.method === "Target.attachedToTarget") { void this.call("Runtime.enable", {}, message.params.sessionId).catch(() => {}); } else if (message.method === "Runtime.executionContextCreated") this.contexts.set(`${message.sessionId ?? ""}:${message.params.context.id}`, { id: message.params.context.id, sessionId: message.sessionId, ...message.params.context.auxData }); else if (message.method === "Runtime.executionContextDestroyed") this.contexts.delete(`${message.sessionId ?? ""}:${message.params.executionContextId}`); else if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text); });
  }
  async call(method: string, params: unknown = {}, sessionId?: string): Promise<any> { await this.ready; const id = ++this.next; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  async evaluate(expression: string, context?: TestContext): Promise<any> { const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(context ? { contextId: context.id } : {}) }, context?.sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; }
  async childContext(): Promise<TestContext> { const tree = await this.call("DOM.getDocument"); const node = await this.call("DOM.querySelector", {nodeId:tree.root.nodeId,selector:".dc-frame iframe"}); const description=await this.call("DOM.describeNode", {nodeId:node.nodeId}); const frameId=description.node.frameId; const found = [...this.contexts.values()].find(context => context.frameId === frameId && context.isDefault); if (!found) throw new Error("Prototype execution context is not ready"); return found; }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 15000; while (true) { try { const value = await read(); if (matches(value)) return value; } catch { /* Wait for the real page or frame to finish loading. */ } if (Date.now() > deadline) throw new Error("The requested real browser state was not observed"); await pause(20); } }

test("comment-only saves retain prototype state while source changes replace the document and invalidate old anchors", { timeout: 45000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; comment revision state is unverified."); return; }
  const directory = await mkdtemp(join(tmpdir(), "design-comment-state-")), store = new CodeProjectStore({ dataDir: join(directory, "data") });
  let project = await store.create({ name: "Comment state", template: "html" });
  const html = '<html><body><h1 data-design-id="title">Stable title</h1><input id="remember" aria-label="Prototype input"><button id="counter" onclick="counter++;this.textContent=String(counter)">0</button><script>var counter=0;</script></body></html>';
  project = await store.update(project.id, project.revision, { files: [{ path: "index.html", content: html, expectedHash: codeFileHash(project.files.find(file => file.path === "index.html")!) }] });
  const initial = await compileCodeProject(project), title = initial.sources.find(source => source.tag === "h1")!;
  project = await store.update(project.id, project.revision, { comments: [{ id: "existing_comment", file: title.file, sourceId: title.id, text: "Resolve this real comment", status: "resolved", createdAt: project.createdAt }] });
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/tool") {
        let body = ""; for await (const chunk of request) body += chunk;
        const { name, args } = JSON.parse(body); calls.push(name); let result: unknown;
        if (name === "design_code_list") result = await store.list();
        else if (name === "design_get_guidance") result = { directions: [] };
        else if (name === "design_code_get") { const current = await store.get(args.projectId); result = { project: current, files: summarizeCodeFiles(current) }; }
        else if (name === "design_code_history") result = await store.history(args.projectId);
        else if (name === "design_code_preview") result = await compileCodeProject(await store.get(args.projectId), { pageId: args.pageId });
        else if (name === "design_code_update") { const current = await store.update(args.projectId, args.expectedRevision, args.changes); result = { project: current, files: summarizeCodeFiles(current) }; }
        else if (name === "design_code_add_comment") { const current = await store.get(args.projectId), anchor = anchorCodeElement(current, args); const next = await store.update(args.projectId, args.expectedRevision, { files: [{ path: anchor.file, content: anchor.content, encoding: "utf8", expectedHash: anchor.expectedHash }], comments: [...current.comments, { id: "added_comment", file: anchor.file, sourceId: anchor.sourceId, text: args.text, status: "open", createdAt: new Date().toISOString() }] }); result = { project: next, files: summarizeCodeFiles(next) }; }
        else throw new Error("Unexpected UI test tool: " + name);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result)); return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(panel);
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
    const ui = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.revisionAcks=[];addEventListener('message',event=>{if(event.source===document.querySelector('.dc-frame iframe')?.contentWindow&&event.data?.type==='design:revision-synced')revisionAcks.push({from:event.data.previousRevision,to:event.data.revision})});const app=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value},async prompt(){return{status:'not-sent'}}});app.connected();`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "comment-state-harness.js" }, outfile: "comment-state.js", bundle: true, platform: "browser", format: "iife", write: false, target: "es2022", logLevel: "silent" });
  const js = ui.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = ui.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  const panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}</style></head><body><div id="editor"></div><script>${js}</script></body></html>`;
  let child: ReturnType<typeof spawn> | undefined, cdp: TestCdp | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: "ignore" });
    const port = await until(async () => (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new TestCdp(targets.find(target => target.type === "page")!.webSocketDebuggerUrl); await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true }); await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await until(() => cdp!.evaluate("!!document.querySelector('.dc-frame iframe')"), Boolean);
    let childContext = await until(() => cdp!.childContext(), Boolean);
    await cdp.evaluate("document.querySelector('[data-mode=preview]').click();globalThis.originalFrame=document.querySelector('.dc-frame iframe');");
    await cdp.evaluate("document.getElementById('remember').value='Keep prototype input';document.getElementById('counter').click();", childContext);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "Keep prototype input", count: "1" });
    await cdp.evaluate("document.querySelector('[data-right-tab=comments]').click();globalThis.commentKeys=[];addEventListener('keydown',event=>{const target=event.target.closest('[data-comment-resolve],[data-comment-anchor]');if(target)commentKeys.push({key:event.key,shift:event.shiftKey,trusted:event.isTrusted,id:target.dataset.commentResolve??target.dataset.commentAnchor,action:target.hasAttribute('data-comment-resolve')?'resolve':'source'})},true);");
    await cdp.call("Page.bringToFront");
    await until(() => cdp!.evaluate("document.querySelector('[data-comment-location=existing_comment]')?.dataset.anchorState"), state => state === "live");
    await cdp.evaluate("document.querySelector('[data-comment-anchor=existing_comment]').focus();");
    assert.equal(await cdp.evaluate("document.hasFocus()&&document.activeElement.hasAttribute('data-comment-anchor')"), true, "The keyboard traversal must start on the actual focused source action");
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await cdp.evaluate("document.activeElement.dataset.commentResolve"), "existing_comment", "Real Shift+Tab must reach the resolved comment action");
    assert.equal(await cdp.evaluate("document.activeElement.getAttribute('aria-label')"), "重新打开评论");
    let keyboardRevision = project.revision;
    for (const expected of [{ status: "open", label: "标记评论为已解决", text: "待处理" }, { status: "resolved", label: "重新打开评论", text: "已解决" }]) {
      const previousRevision = keyboardRevision;
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      const saved = await until(() => store.get(project.id), current => current.revision === previousRevision + 1 && current.comments.find(comment => comment.id === "existing_comment")?.status === expected.status);
      keyboardRevision = saved.revision;
      await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${keyboardRevision}`);
      await until(() => cdp!.evaluate(`revisionAcks.some(ack=>ack.from===${previousRevision}&&ack.to===${keyboardRevision})`), Boolean);
      const action = await cdp.evaluate("(()=>{const button=document.querySelector('[data-comment-resolve=existing_comment]');return{focused:document.activeElement===button,id:document.activeElement.dataset.commentResolve,label:button.getAttribute('aria-label'),text:button.closest('.dc-comment').querySelector('.dc-comment-status').innerText,disabled:button.disabled,sameFrame:document.querySelector('.dc-frame iframe')===originalFrame}})()");
      assert.deepEqual(action, { focused: true, id: "existing_comment", label: expected.label, text: expected.text, disabled: false, sameFrame: true }, "The same comment action must retain focus when its accessible label changes");
      assert.deepEqual(summarizeCodeFiles(saved), summarizeCodeFiles(project), "Keyboard comment state changes cannot rewrite source bytes");
      assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "Keep prototype input", count: "1" });
    }
    assert.equal(await cdp.evaluate("commentKeys.filter(event=>event.key==='Enter'&&event.action==='resolve'&&event.id==='existing_comment'&&event.trusted).length"), 2, "Both saves must come from trusted keyboard activation, without refocusing between toggles");
    assert.equal(await cdp.evaluate("commentKeys.some(event=>event.key==='Tab'&&event.shift&&event.trusted&&event.action==='source')"), true);
    context.diagnostic(`Actual comment keyboard events: ${JSON.stringify(await cdp.evaluate("commentKeys"))}`);
    childContext = await until(() => cdp!.childContext(), Boolean);
    const evidence = { sameFrame: await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.originalFrame"), state: await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext) };
    assert.deepEqual(evidence, { sameFrame: true, state: { value: "Keep prototype input", count: "1" } }, JSON.stringify(evidence));
    await cdp.evaluate("document.querySelector('[data-mode=select]').click();"); await pause(30);
    await cdp.evaluate("document.querySelector('h1').click();", childContext);
    await until(() => cdp!.evaluate("!!document.querySelector('[data-action=comment-selection]')"), Boolean);
    await cdp.evaluate("document.querySelector('[data-action=comment-selection]').click();const draft=document.querySelector('[data-comment-draft]');draft.value='Added on the existing stable source';draft.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=add-comment]').click();");
    let beforeSourceChange = await until(() => store.get(project.id), current => current.revision === project.revision + 3);
    await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${beforeSourceChange.revision}`); await pause(100);
    assert.deepEqual(summarizeCodeFiles(beforeSourceChange), summarizeCodeFiles(project), "Adding a comment on an existing marker must not alter source bytes");
    assert.equal(beforeSourceChange.comments.length, 2);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.originalFrame"), true);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "Keep prototype input", count: "1" });
    await cdp.evaluate("document.querySelector('h1').click();", childContext);
    await until(() => cdp!.evaluate("!!document.querySelector('[data-selection-text]')"), Boolean);
    // Keep the real child thread busy while two actual UI saves advance the parent.
    const waitingForChild = cdp.evaluate("(()=>{const deadline=Date.now()+500;while(Date.now()<deadline){}return true})()", childContext);
    await cdp.evaluate("document.querySelector('[data-right-tab=comments]').click();document.querySelector('[data-comment-resolve=existing_comment]').click();document.querySelector('[data-comment-resolve=existing_comment]').click();");
    const continuous = await until(() => store.get(project.id), current => current.revision === beforeSourceChange.revision + 2);
    await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${continuous.revision}`);
    await cdp.evaluate("document.querySelector('[data-right-tab=inspect]').click();globalThis.retainedInspectorInput=document.querySelector('[data-selection-text]');const field=globalThis.retainedInspectorInput;field.value='Keep this unapplied title draft';field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();field.setSelectionRange(5,11,'backward');");
    assert.equal(await cdp.evaluate("!document.querySelector('[data-selection-stale]').hidden&&document.querySelector('[data-action=apply-selection]').disabled"), true, "The unconfirmed selection must be visibly stale and disabled");
    await waitingForChild;
    await until(() => cdp!.evaluate("globalThis.revisionAcks.slice(-1)[0]?.to"), revision => revision === continuous.revision);
    await until(() => cdp!.evaluate("document.querySelector('[data-selection-stale]').hidden&&!document.querySelector('[data-action=apply-selection]').disabled"), Boolean);
    assert.deepEqual(await cdp.evaluate("({same:document.querySelector('[data-selection-text]')===globalThis.retainedInspectorInput,focused:document.activeElement===globalThis.retainedInspectorInput,value:globalThis.retainedInspectorInput.value,start:globalThis.retainedInspectorInput.selectionStart,end:globalThis.retainedInspectorInput.selectionEnd,direction:globalThis.retainedInspectorInput.selectionDirection})"), { same: true, focused: true, value: "Keep this unapplied title draft", start: 5, end: 11, direction: "backward" }, "Acknowledgement must update the stale notice without rebuilding the field or losing its caret");
    assert.deepEqual(await cdp.evaluate("globalThis.revisionAcks.slice(-2)"), [{ from: beforeSourceChange.revision, to: beforeSourceChange.revision + 1 }, { from: beforeSourceChange.revision + 1, to: continuous.revision }], "Continuous revisions must confirm each in-flight child binding before advancing again");
    beforeSourceChange = continuous;
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.originalFrame"), true);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "Keep prototype input", count: "1" });
    const waitingForAiBinding = cdp.evaluate("(()=>{const deadline=Date.now()+500;while(Date.now()<deadline){}return true})()", childContext);
    await cdp.evaluate("document.querySelector('[data-right-tab=comments]').click();document.querySelector('[data-comment-resolve=existing_comment]').click();");
    const aiRevision = await until(() => store.get(project.id), current => current.revision === beforeSourceChange.revision + 1);
    await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${aiRevision.revision}`);
    await cdp.evaluate("document.querySelector('[data-right-tab=ai]').click();globalThis.retainedAiInput=document.querySelector('[data-ai-prompt]');const aiField=globalThis.retainedAiInput;aiField.value='Keep the current-chat AI prompt draft';aiField.dispatchEvent(new Event('input',{bubbles:true}));aiField.focus();aiField.setSelectionRange(3,10);");
    assert.equal(await cdp.evaluate("!document.querySelector('[data-selection-ai-stale]').hidden"), true);
    await waitingForAiBinding; await until(() => cdp!.evaluate("document.querySelector('[data-selection-ai-stale]').hidden"), Boolean);
    assert.deepEqual(await cdp.evaluate("({same:document.querySelector('[data-ai-prompt]')===globalThis.retainedAiInput,focused:document.activeElement===globalThis.retainedAiInput,value:globalThis.retainedAiInput.value,start:globalThis.retainedAiInput.selectionStart,end:globalThis.retainedAiInput.selectionEnd})"), { same: true, focused: true, value: "Keep the current-chat AI prompt draft", start: 3, end: 10 });
    beforeSourceChange = aiRevision; await cdp.evaluate("document.querySelector('[data-right-tab=comments]').click();");
    await cdp.evaluate(`document.querySelector('[data-file="index.html"]').click();const input=document.querySelector('[data-source-input]');input.value=input.value.replace(' data-design-id="title"','');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=save-source]').click();`);
    const sourceChanged = await until(() => store.get(project.id), current => current.revision === beforeSourceChange.revision + 1);
    await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${sourceChanged.revision}`);
    await until(() => cdp!.evaluate("document.querySelector('[data-comment-location=existing_comment]')?.dataset.anchorState"), value => value === "missing");
    // This is a real old-document click, not a fabricated host message. Its revision/hash must stay rejected.
    await cdp.evaluate("document.querySelector('h1').click();", childContext); await pause(30);
    assert.equal(await cdp.evaluate("document.querySelector('[data-right-tab=comments]').classList.contains('active')"), true);
    await cdp.evaluate("document.querySelector('[data-view=design]').click();"); await pause(50);
    childContext = await until(() => cdp!.childContext(), Boolean);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.originalFrame"), false);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "", count: "0" });
    await cdp.evaluate("document.querySelector('h1').click();", childContext);
    await until(() => cdp!.evaluate("!!document.querySelector('[data-action=comment-selection]')"), Boolean);
    // Hold a real child beyond the production timeout. Source view leaves that
    // document alive long enough to observe its genuine late acknowledgement.
    await cdp.evaluate("document.querySelector('[data-mode=preview]').click();"); await pause(30);
    await cdp.evaluate("document.getElementById('remember').value='State before the announced fallback';document.getElementById('counter').click();", childContext);
    const stateBeforeTimeout = { value: "State before the announced fallback", count: "1" };
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), stateBeforeTimeout);
    await cdp.evaluate("globalThis.timeoutFrame=document.querySelector('.dc-frame iframe');document.querySelector('[data-mode=select]').click();document.querySelector('[data-file=\"index.html\"]').click();document.querySelector('[data-right-tab=comments]').click();");
    const previewCallsBeforeTimeout = calls.filter(name => name === "design_code_preview").length, timeoutStarted = Date.now();
    const stalledChild = cdp.evaluate("(()=>{const deadline=Date.now()+3000;while(Date.now()<deadline){}return true})()", childContext);
    await cdp.evaluate("document.querySelector('[data-comment-resolve=existing_comment]').click();");
    const delayedRevision = await until(() => store.get(project.id), current => current.revision === sourceChanged.revision + 1);
    await until(() => cdp!.evaluate("document.querySelector('[data-revision]').textContent"), value => value === `修订 ${delayedRevision.revision}`);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.timeoutFrame&&!document.querySelector('.dc-toast')?.textContent.includes('预览未确认当前修订')"), true, "State must not reset silently while the genuine acknowledgement is still pending");
    await until(() => cdp!.evaluate("document.querySelector('.dc-toast')?.textContent.includes('预览未确认当前修订，已重新编译')"), Boolean);
    assert.ok(Date.now() - timeoutStarted >= 1900, "The fault must reach the actual two-second timeout rather than an immediate failure");
    await until(async () => calls.filter(name => name === "design_code_preview").length, count => count > previewCallsBeforeTimeout);
    await stalledChild;
    await until(() => cdp!.evaluate("globalThis.revisionAcks.slice(-1)[0]?.to"), revision => revision === delayedRevision.revision);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), stateBeforeTimeout, "The still-hidden old document remains intact until the announced replacement is displayed");
    await cdp.evaluate("document.querySelector('h1').click();", childContext); await pause(30);
    assert.equal(await cdp.evaluate("document.querySelector('[data-right-tab=comments]').classList.contains('active')"), true, "A real click from the late, unconfirmed document must remain rejected");
    await cdp.evaluate("document.querySelector('[data-view=design]').click();"); await pause(50);
    childContext = await until(() => cdp!.childContext(), Boolean);
    assert.equal(await cdp.evaluate("document.querySelector('.dc-frame iframe')===globalThis.timeoutFrame"), false, "The announced fallback must display a freshly compiled document");
    assert.equal(await cdp.evaluate("document.querySelector('.dc-toast')?.textContent.includes('预览未确认当前修订')"), true);
    assert.deepEqual(await cdp.evaluate("({value:document.getElementById('remember').value,count:document.getElementById('counter').textContent})", childContext), { value: "", count: "0" });
    await cdp.evaluate("document.querySelector('h1').click();", childContext);
    await until(() => cdp!.evaluate("!!document.querySelector('[data-action=comment-selection]')&&!document.querySelector('[data-action=apply-selection]').disabled"), Boolean);
    assert.ok(calls.includes("design_code_add_comment"));
    assert.deepEqual(cdp.errors, []); assert.ok(calls.includes("design_code_update"));
  } catch (error) {
    context.diagnostic(`Comment state failure: ${JSON.stringify({ calls: calls.slice(-12), storedRevision: (await store.get(project.id)).revision, storedStatus: (await store.get(project.id)).comments.find(comment => comment.id === "existing_comment")?.status })}`);
    if (cdp) context.diagnostic(`Actual keyboard/UI: ${JSON.stringify(await cdp.evaluate("({keys:globalThis.commentKeys,focus:document.activeElement?.outerHTML?.slice(0,450),hasFocus:document.hasFocus(),revision:document.querySelector('[data-revision]')?.textContent,toast:document.querySelector('.dc-toast')?.textContent})").catch(() => "unavailable"))}`);
    throw error;
  } finally {
    cdp?.socket.close(); if (child && child.exitCode === null) { const closed = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGTERM"); const force = setTimeout(() => child!.kill("SIGKILL"), 1000); await closed; clearTimeout(force); }
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});

test("history keyboard focus survives busy metadata and respects later user focus, modal, project and teardown ownership", { timeout: 60000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip("A local Chromium browser is unavailable; history focus lifecycle remains unverified."); return; }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js"), { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"), { createDesignServer } = await import("../src/server.ts");
  const directory = await mkdtemp(join(tmpdir(), "design-history-focus-")), store = new CodeProjectStore({ dataDir: join(directory, "data") });
  let project = await store.create({ name: "History focus source", template: "html" });
  project = await store.update(project.id, project.revision, { comments: [{ id: "history_comment", file: project.pages[0]!.entry, text: "Actual comment-only history", status: "open", createdAt: project.createdAt }] });
  project = await store.update(project.id, project.revision, { comments: project.comments.map(comment => ({ ...comment, status: "resolved" })) });
  const originalHashes = summarizeCodeFiles(project), other = await store.create({ name: "Independent project during history", template: "html" });
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>History focus actual protocol fixture</div>" });
  const client = new Client({ name: "history-focus-browser", version: "1" }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair(); await instance.server.connect(serverSide); await client.connect(clientSide);
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  type Gate = { method: string; revision?: number; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  const makeGate = (method: string, revision?: number): Gate => ({ method, revision, entered: deferred(), release: deferred() });
  let mutationGate: Gate | undefined, metadataGate: Gate | undefined, panel = "", phase = "startup";
  const gates: Gate[] = [], calls: Array<{ name: string; projectId?: string }> = [], bridgeErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/tool") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(panel); return; }
      let body = ""; for await (const chunk of request) body += chunk;
      const { name, args } = JSON.parse(body); calls.push({ name, projectId: args.projectId });
      assert.ok(!/generation|models/.test(name), "This focus regression must not invoke inference");
      const pendingMutation = name === mutationGate?.method && args.projectId === project.id ? mutationGate : undefined;
      const pendingMetadata = name === "design_code_history" && args.projectId === project.id ? metadataGate : undefined;
      const result = await client.callTool({ name, arguments: args }); if (result.isError || !result.structuredContent) throw Error(JSON.stringify(result.structuredContent ?? result.content));
      const value = result.structuredContent as Record<string, any>;
      if (pendingMutation) { pendingMutation.entered.resolve(); await pendingMutation.release.promise; }
      if (pendingMetadata && value.revision === pendingMetadata.revision) { pendingMetadata.entered.resolve(); await pendingMetadata.release.promise; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value));
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); bridgeErrors.push(detail); response.statusCode = 500; response.end(JSON.stringify({ error: detail })); }
  });
  let child: ReturnType<typeof spawn> | undefined, cdp: TestCdp | undefined;
  try {
    const bundled = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.historyKeys=[];addEventListener('keydown',event=>{const el=document.activeElement;historyKeys.push({key:event.key,trusted:event.isTrusted,action:el?.dataset.action??null,group:el?.hasAttribute('data-history-focus')??false})},true);globalThis.historyApp=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const result=await response.json();if(!response.ok)throw Error(result.error);return result},async prompt(){throw Error('No model or native host prompt is part of this test')}});historyApp.connected().then(()=>historyApp.setProjectId(${JSON.stringify(project.id)}));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "history-focus-harness.js" }, outfile: "history-focus.js", bundle: true, platform: "browser", format: "iife", write: false, target: "es2022", logLevel: "silent" });
    const js = bundled.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = bundled.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;font-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}#outside{position:fixed;bottom:0;left:0;width:140px;z-index:100}</style></head><body><div id="editor"></div><input id="outside" aria-label="Outside the closed editor"><script>${js}</script></body></html>`;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: "ignore" });
    const port = await until(async () => (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new TestCdp(targets.find(target => target.type === "page")!.webSocketDebuggerUrl); await cdp.call("Runtime.enable"); await cdp.call("Page.enable"); await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true }); await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    const state = () => cdp!.evaluate("({project:document.querySelector('[data-setting=project]')?.value,revision:document.querySelector('[data-revision]')?.textContent,focus:document.activeElement?.dataset.action??null,group:document.activeElement?.hasAttribute('data-history-focus')??false,tag:document.activeElement?.tagName,undo:document.querySelector('[data-action=undo]')?.disabled,redo:document.querySelector('[data-action=redo]')?.disabled,saving:document.querySelector('.dc-save-state')?.classList.contains('saving'),modal:!!document.querySelector('.dc-modal')})");
    const key = async (name: "Enter" | "Tab" | "Escape", modifiers = 0) => { const virtual = { Enter: 13, Tab: 9, Escape: 27 }[name]; await cdp!.call("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: virtual, modifiers, ...(name === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) }); await cdp!.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: virtual }); };
    const arm = (method: "design_code_undo" | "design_code_redo") => { const gate = makeGate(method); mutationGate = gate; gates.push(gate); return gate; };
    const settled = (revision: number, focus: string) => until(state, value => value.project === project.id && value.revision === `修订 ${revision}` && value.focus === focus && !value.saving && !(focus === "undo" ? value.undo : value.redo));
    await until(state, value => value.project === project.id && !value.undo && value.redo);
    phase = "busy and metadata focus with continuous real keyboard history";
    await cdp.evaluate("document.querySelector('[data-action=undo]').focus()");
    const first = arm("design_code_undo"); metadataGate = makeGate("design_code_history", 4); gates.push(metadataGate);
    await key("Enter"); await first.entered.promise;
    assert.equal((await store.get(project.id)).revision, 4, "The withheld response must follow a real successful history operation");
    assert.deepEqual(await state().then(value => ({ group: value.group, undo: value.undo, redo: value.redo, saving: value.saving })), { group: true, undo: true, redo: true, saving: true }, "A genuinely disabled history trigger must park focus visibly in its owned operation group, not BODY");
    await key("Enter"); first.release.resolve(); mutationGate = undefined; await metadataGate.entered.promise;
    assert.equal((await state()).group, true, "Focus must wait for actual new-revision history availability");
    metadataGate.release.resolve(); metadataGate = undefined; await settled(4, "undo");
    await key("Enter"); await settled(5, "redo");
    await key("Enter"); await settled(6, "redo");
    await key("Enter"); await settled(7, "undo");
    assert.equal(calls.filter(call => call.name === "design_code_undo").length, 2); assert.equal(calls.filter(call => call.name === "design_code_redo").length, 2, "Busy Enter must not queue a duplicate history action");
    const nativeHistoryKeys = await cdp.evaluate("historyKeys.filter(event=>event.key==='Enter'&&event.action).map(event=>({action:event.action,trusted:event.trusted}))");
    assert.deepEqual(nativeHistoryKeys, [{ action: "undo", trusted: true }, { action: "undo", trusted: true }, { action: "redo", trusted: true }, { action: "redo", trusted: true }], "Only the first trigger was focused explicitly; each later native Enter uses the prior operation's returned focus");
    phase = "user Tab intent wins over a delayed response";
    const moved = arm("design_code_undo"); await key("Enter"); await moved.entered.promise; await key("Tab");
    const userTarget = (await state()).focus; assert.ok(userTarget && !["undo", "redo"].includes(userTarget), "Tab from the busy group must reach a real available non-history toolbar control");
    assert.equal(await cdp.evaluate("document.activeElement.closest('[data-history-focus]')!==null&&!document.activeElement.matches(':disabled')"), true);
    moved.release.resolve(); mutationGate = undefined; await until(state, value => value.revision === "修订 8" && !value.saving && value.redo === false);
    assert.equal((await state()).focus, userTarget, "History completion must preserve the user's new semantic header focus across repaint");
    phase = "project switch and focused source win over old-project completion";
    await cdp.evaluate("document.querySelector('[data-action=undo]').focus()"); const switched = arm("design_code_undo"); await key("Enter"); await switched.entered.promise;
    await cdp.evaluate(`(()=>{const choice=document.querySelector('[data-setting=project]');choice.focus();choice.value=${JSON.stringify(other.id)};choice.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until(state, value => value.project === other.id);
    // Let the destination's real preview finish before testing only the old
    // history response; its independent initial render can rebuild source DOM.
    await until(() => cdp!.evaluate("!!document.querySelector('.dc-frame iframe')"), Boolean);
    const userDraft = other.files.find(file => file.path === other.pages[0]!.entry)!.content + "\n<!-- User continues editing the destination during old history -->";
    await cdp.evaluate(`document.querySelector('[data-view=source]').click();const source=document.querySelector('[data-source-input]');source.focus();source.value=${JSON.stringify(userDraft)};source.dispatchEvent(new Event('input',{bubbles:true}));source.setSelectionRange(2,7);globalThis.userSource=source`);
    switched.release.resolve(); mutationGate = undefined; await until(state, value => value.project === other.id && !value.saving);
    const sourceFocus = await cdp.evaluate("({focusedSource:document.activeElement.matches('[data-source-input]'),file:document.querySelector('.dc-code-head code')?.textContent,value:document.activeElement.value,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,sameNode:document.activeElement===userSource})");
    assert.deepEqual({ ...sourceFocus, sameNode: undefined }, { focusedSource: true, file: other.pages[0]!.entry, value: userDraft, start: 2, end: 7, sameNode: undefined }, "The user's actual destination source, draft and caret must survive old-project completion; a local render's node identity is not focus ownership");
    context.diagnostic(`Destination source after delayed old history: ${JSON.stringify({ focusedSource: sourceFocus.focusedSource, file: sourceFocus.file, start: sourceFocus.start, end: sourceFocus.end, sameNode: sourceFocus.sameNode })}`);
    await cdp.evaluate("document.querySelector('[data-view=design]').click();document.querySelector('[data-view=source]').click();document.querySelector('[data-action=reset-source]').click()");
    phase = "opening and closing a modal revokes the previous history focus claim";
    await cdp.evaluate(`historyApp.setProjectId(${JSON.stringify(project.id)})`); await until(state, value => value.project === project.id && value.revision === "修订 9" && !value.redo);
    await cdp.evaluate("document.querySelector('[data-action=redo]').focus()"); const modal = arm("design_code_redo"); await key("Enter"); await modal.entered.promise;
    await cdp.evaluate("document.querySelector('.dc-header [data-action=new]').focus();document.querySelector('.dc-header [data-action=new]').click()");
    assert.equal(await cdp.evaluate("document.activeElement.matches('[data-new-name]')"), true); await key("Escape");
    assert.equal((await state()).focus, "new"); modal.release.resolve(); mutationGate = undefined;
    await until(state, value => value.revision === "修订 10" && !value.saving && !value.redo);
    assert.equal((await state()).focus, "new", "A modal closed before the late response must not revive the old history claim");
    phase = "teardown before the late history result cannot focus the closed editor";
    await cdp.evaluate("document.querySelector('[data-action=redo]').focus()"); const closed = arm("design_code_redo"); await key("Enter"); await closed.entered.promise;
    await cdp.evaluate("globalThis.closedEditor=historyApp.teardown();document.getElementById('editor').remove();document.getElementById('outside').focus();true");
    closed.release.resolve(); mutationGate = undefined; await cdp.evaluate("closedEditor");
    assert.equal(await cdp.evaluate("document.activeElement.id"), "outside");
    assert.deepEqual(summarizeCodeFiles(await store.get(project.id)), originalHashes, "History-only focus handling must not change source bytes");
    assert.equal((await store.get(other.id)).revision, other.revision); assert.deepEqual(bridgeErrors, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic(`Actual history keyboard events: ${JSON.stringify(await cdp.evaluate("historyKeys"))}`);
    context.diagnostic("Real MCP store history, held successful responses/metadata and native CDP Enter/Tab/Escape verified; no native host, model or CSS snapshot comparison is claimed.");
  } catch (error) {
    context.diagnostic(`History focus phase=${phase}; recent tools=${JSON.stringify(calls.slice(-12))}; bridge=${JSON.stringify(bridgeErrors)}; browser=${JSON.stringify(cdp?.errors ?? [])}`);
    if (cdp) context.diagnostic(`History focus state=${JSON.stringify(await cdp.evaluate("({focus:document.activeElement?.outerHTML?.slice(0,300),keys:globalThis.historyKeys,revision:document.querySelector('[data-revision]')?.textContent,project:document.querySelector('[data-setting=project]')?.value})").catch(() => "unavailable"))}`);
    throw error;
  } finally {
    for (const gate of gates) gate.release.resolve();
    if (cdp) { await cdp.evaluate("historyApp.teardown()").catch(() => {}); cdp.socket.close(); }
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGTERM"); const force = setTimeout(() => child!.kill("SIGKILL"), 1000); await closed; clearTimeout(force); }
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
