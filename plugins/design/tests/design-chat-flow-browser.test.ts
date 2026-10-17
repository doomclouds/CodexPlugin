import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { browserExecutable } from '../src/browser.ts';
import { CodeProjectStore, codeFileHash, summarizeCodeFiles } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { createDesignServer } from '../src/server.ts';
import { DESIGN_REFERENCE_IDS } from '../src/design-references.ts';
import { createExportPngFixture } from './export-image-fixture.ts';

class ChatFlowCdp {
  socket: WebSocket;
  ready: Promise<void>;
  next = 0;
  errors: string[] = [];
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', () => resolve(), { once: true }); this.socket.addEventListener('error', () => reject(new Error('Chat-flow browser connection failed')), { once: true }); });
    this.socket.addEventListener('message', event => {
      const item = JSON.parse(String(event.data));
      if (item.id) { const pending = this.pending.get(item.id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(item.id); item.error ? pending.reject(new Error(item.error.message)) : pending.resolve(item.result); }
      else if (item.method === 'Runtime.exceptionThrown') this.errors.push(item.params.exceptionDetails.exception?.description ?? item.params.exceptionDetails.text);
    });
    this.socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Chat-flow browser connection closed')); } this.pending.clear(); });
  }
  async call(method: string, params: unknown = {}): Promise<any> {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chromium ${method} timed out`)); }, 15_000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(label: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000; let last: unknown;
  while (true) { try { const value = await read(); last = value; if (matches(value)) return value; } catch (error) { last = error instanceof Error ? error.message : String(error); } if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(last)}`); await pause(20); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Gate = { name: string; projectId: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> };

async function harness(executable: string, manyPages = false) {
  const directory = await mkdtemp(join(tmpdir(), 'design-chat-flow-')), store = new CodeProjectStore({ dataDir: join(directory, 'data') });
  let project = await store.create({ name: 'Current-chat task and exact export fixture', template: 'html' });
  if (manyPages) {
    const pages = Array.from({ length: 32 }, (_, i) => { const n = String(i).padStart(2, '0'); return { id: `page_${n}`, name: (`Actual page ${n}`).padEnd(200, 'N'), entry: 'p/'.repeat(124) + 'x' + n + '.html', route: '/' + 'r'.repeat(252) + '/' + n }; });
    project = await store.update(project.id, project.revision, {
      files: [...project.files.map(file => ({ path: file.path, expectedHash: codeFileHash(file) })), ...pages.map((page, i) => ({ path: page.entry, content: `<!doctype html><html><body><h1>Actual page ${i}</h1><input aria-label="Real prototype input"></body></html>`, expectedHash: null }))],
      pages, defaultPageId: pages[0]!.id, viewports: [{ id: 'task_phone', name: 'Task fixture viewport', width: 390, height: 400 }], designSystem: { components: [], notes: 'The source MCP fixture contains 32 actual standalone HTML pages.' },
      comments: Array.from({ length: 6 }, (_, i) => ({ id: `long_comment_${i}`, file: pages[0]!.entry, text: `Actual comment ${i}: ` + 'Comment detail '.repeat(600), status: 'open' as const, createdAt: project.createdAt })),
    });
  }
  const other = await store.create({ name: 'Independent destination task draft', template: 'html' });
  const instance = await createDesignServer({ codeStore: store, panelHtml: '<!doctype html><div>Source MCP chat-flow fixture</div>' });
  const client = new Client({ name: 'design-chat-flow-browser', version: '1' }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  let panel = '', nextGate: Gate | undefined, failure: string | undefined, child: ReturnType<typeof spawn> | undefined, cdp: ChatFlowCdp | undefined;
  const gates: Gate[] = [], calls: Array<{ name: string; args: Record<string, any>; result?: Record<string, any>; error?: boolean }> = [], unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    let gate: Gate | undefined;
    try {
      if (request.url !== '/tool') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(panel); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const { name, args } = JSON.parse(body), record: typeof calls[number] = { name, args }; calls.push(record);
      assert.ok(!/generation|models/.test(name), 'This regression cannot invoke an independent model or real chat');
      if (failure === name) { failure = undefined; record.error = true; response.statusCode = 503; response.end(JSON.stringify({ error: 'Controlled guidance transport failure; no inference was attempted.' })); return; }
      if (nextGate && nextGate.name === name && nextGate.projectId === args.projectId) { gate = nextGate; nextGate = undefined; }
      const result = await client.callTool({ name, arguments: args }); record.error = !!result.isError; record.result = result.structuredContent as Record<string, any>;
      assert.ok(record.result, 'Actual source MCP tools must return structured results');
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      response.setHeader('Content-Type', 'application/json'); if (result.isError) response.statusCode = 409;
      response.end(JSON.stringify(result.isError ? { error: record.result.error?.message ?? JSON.stringify(record.result) } : record.result));
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); unexpected.push(detail); response.statusCode = 500; response.end(JSON.stringify({ error: detail })); }
    finally { gate?.finished.resolve(); }
  });
  try {
    const ui = await build({ stdin: { contents: `import{mountCodeEditor}from'./ui/code-editor.ts';globalThis.bridgeStatus='not-sent';globalThis.bridgeCalls=[];globalThis.downloadCalls=[];globalThis.downloadDelay=false;globalThis.downloadResult={saved:false,unsupported:true};globalThis.taskApp=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,args})});const result=await response.json();if(!response.ok)throw Error(result.error);return result},async prompt(text,context,intent){bridgeCalls.push({text,context,current:intent?.isCurrent()});return{status:bridgeStatus,reason:'Controlled browser receipt only; no native host delivery or model invocation'}},async download(file){downloadCalls.push(file);if(downloadDelay)return await new Promise(resolve=>globalThis.downloadRelease=resolve);return downloadResult}});taskApp.connected().then(()=>taskApp.setProjectId(${JSON.stringify(project.id)}));`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'chat-flow-harness.js' }, outfile: 'chat-flow.js', bundle: true, platform: 'browser', format: 'iife', write: false, target: 'es2022', logLevel: 'silent' });
    const js = ui.outputFiles.find(file => file.path.endsWith('.js'))!.text.replace(/<\/script/gi, '<\\/script'), css = ui.outputFiles.find(file => file.path.endsWith('.css'))!.text;
    panel = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';frame-src 'self' about:;img-src data:;font-src data:;form-action 'none'"><style>html,body,#editor{margin:0;height:100%}${css}</style></head><body><div id="editor"></div><input id="outside" aria-label="Outside destroyed chat fixture"><script>${js}</script></body></html>`;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
    child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'browser')}`, 'about:blank'], { stdio: 'ignore' });
    const port = await until('Chromium port', async () => (await readFile(join(directory, 'browser/DevToolsActivePort'), 'utf8')).split('\n')[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    cdp = new ChatFlowCdp(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable'); await cdp.call('Page.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true }); await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await cdp.call('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await until('actual initial project', () => cdp!.evaluate("document.querySelector('[data-setting=project]')?.value"), value => value === project.id);
    await until('compiled real prototype', () => cdp!.evaluate("!!document.querySelector('.dc-frame iframe')"), Boolean);
    const browser = cdp;
    return {
      cdp: browser, project, other, store, calls, unexpected,
      async ai() { await browser.evaluate("document.querySelector('[data-action=ai]').click()"); await until('AI request editor', () => browser.evaluate("!!document.querySelector('[data-ai-prompt]')"), Boolean); },
      async prompt(value: string) { await browser.evaluate(`(()=>{const field=document.querySelector('[data-ai-prompt]');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}))})()`); },
      async switchTo(projectId: string) { await browser.evaluate(`taskApp.setProjectId(${JSON.stringify(projectId)})`); await until('destination project', () => browser.evaluate("document.querySelector('[data-setting=project]')?.value"), value => value === projectId); },
      async publish(next: CodeProject) { await browser.evaluate(`taskApp.receive(${JSON.stringify({ project: next, files: summarizeCodeFiles(next) })})`); await until('published revision', () => browser.evaluate("document.querySelector('[data-revision]')?.textContent"), value => value === `修订 ${next.revision}`); },
      failNext(name: string) { failure = name; },
      hold(name: string, projectId = project.id) { const gate = { name, projectId, entered: deferred(), release: deferred(), finished: deferred() }; nextGate = gate; gates.push(gate); return gate; },
      async close() { for (const gate of gates) gate.release.resolve(); await browser.evaluate("globalThis.downloadRelease?.({saved:false,reason:'Fixture cleanup'});taskApp.teardown()").catch(() => {}); browser.socket.close(); if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill('SIGTERM'); const timer = setTimeout(() => child!.kill('SIGKILL'), 1000); await closed; clearTimeout(timer); } await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { for (const gate of gates) gate.release.resolve(); cdp?.socket.close(); child?.kill('SIGTERM'); await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test('current-chat preparation retains the full 10k request across 32 real pages, preparation failure and an unknown delivery', { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; current-chat UI behavior is unverified.'); return; }
  const h = await harness(executable, true), { cdp } = h; let phase = 'large current-chat request';
  try {
    const brief = '完整需求'.repeat(2500); await h.ai();
    await until('real reference catalog options', () => cdp.evaluate("document.querySelector('[data-ai-reference]')?.options.length"), value => value === DESIGN_REFERENCE_IDS.length + 2);
    await cdp.evaluate("const reference=document.querySelector('[data-ai-reference]');reference.value='editorial-atlas';reference.dispatchEvent(new Event('change',{bubbles:true}))");
    if (process.env.DESIGN_REFERENCE_SCREENSHOT_DIR) {
      await cdp.evaluate("document.querySelector('[data-ai-reference]').focus()");
      const capture = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await mkdir(process.env.DESIGN_REFERENCE_SCREENSHOT_DIR, { recursive: true });
      await writeFile(join(process.env.DESIGN_REFERENCE_SCREENSHOT_DIR, 'reference-selector.png'), Buffer.from(capture.data, 'base64'));
    }
    await h.prompt(brief); await cdp.evaluate("document.querySelector('[data-action=generate]').click()");
    await until('controlled bridge receipt', () => cdp.evaluate('bridgeCalls.length'), value => value === 1);
    const call = h.calls.find(call => call.name === 'design_code_guidance')!; assert.equal(call.args.prompt, brief); assert.equal(call.args.prompt.length, 10_000); assert.equal(call.args.referenceId, 'editorial-atlas');
    const observation = await cdp.evaluate('bridgeCalls[0]'); assert.equal(observation.current, true); assert.equal(observation.text.split(brief).length - 1, 1); assert.ok(observation.text.length < 30_000); assert.equal(observation.context.pageCount, 32); assert.equal(observation.context.omittedPageCount, 31); assert.equal('pages' in observation.context, false); assert.equal(observation.context.comments.length, 4); assert.equal(observation.context.omittedCommentCount, 2);
    assert.equal(observation.context.referenceChoice, 'editorial-atlas'); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), brief);
    phase = 'preparation failure retains a complete fallback';
    h.failNext('design_code_guidance'); await cdp.evaluate("document.querySelector('[data-action=generate]').click()");
    await until('preparation error', () => cdp.evaluate("document.querySelector('.dc-ai-state.error')?.textContent"), value => value?.includes('Controlled guidance transport failure'));
    assert.equal(await cdp.evaluate('bridgeCalls.length'), 1); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), brief); assert.equal(await cdp.evaluate(`document.querySelector('.dc-fallback textarea').value.includes(${JSON.stringify(brief)})`), true);
    phase = 'unknown receipt blocks automatic resend and copy';
    await cdp.evaluate("bridgeStatus='unknown';document.querySelector('[data-action=generate]').click()");
    await until('unknown receipt controls', () => cdp.evaluate("!!document.querySelector('[data-action=confirm-prompt-missing]')"), Boolean);
    assert.equal(await cdp.evaluate("document.querySelector('[data-action=generate]').disabled&&document.querySelector('[data-action=copy-prompt]').disabled"), true);
    await cdp.evaluate("document.querySelector('[data-action=generate]').click();document.querySelector('[data-action=copy-prompt]').click()"); assert.equal(await cdp.evaluate('bridgeCalls.length'), 2);
    await cdp.evaluate("document.querySelector('[data-action=confirm-prompt-missing]').click()");
    assert.equal(await cdp.evaluate("document.querySelector('[data-action=generate]').disabled||document.querySelector('[data-action=copy-prompt]').disabled"), false); assert.equal(await cdp.evaluate('bridgeCalls.length'), 2);
    await cdp.evaluate("bridgeStatus='not-sent';document.querySelector('[data-action=generate]').click()"); await until('explicit retry receipt', () => cdp.evaluate('bridgeCalls.length'), value => value === 3);
    assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), brief); assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic('Actual source MCP guidance and 32-page store were used; delivery was a controlled browser receipt, not a native host message or model invocation.');
  } catch (error) { context.diagnostic(`phase=${phase}; calls=${JSON.stringify(h.calls.slice(-5).map(call => ({ name: call.name, promptLength: call.args.prompt?.length, error: call.error })))}`); throw error; }
  finally { await h.close(); }
});

test('late current-chat preparation preserves per-project drafts and cannot deliver after switching or teardown', { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; current-chat lifecycle is unverified.'); return; }
  const h = await harness(executable), { cdp } = h;
  try {
    const original = 'Only the original project: retain this complete request.'; await h.ai();
    await until('source reference catalog', () => cdp.evaluate("document.querySelector('[data-ai-reference]')?.options.length"), value => value === DESIGN_REFERENCE_IDS.length + 2);
    await cdp.evaluate("const reference=document.querySelector('[data-ai-reference]');reference.value='operations-console';reference.dispatchEvent(new Event('change',{bubbles:true}));const direction=document.querySelector('[data-ai-direction]');direction.value='precision';direction.dispatchEvent(new Event('change',{bubbles:true}))");
    await h.prompt(original);
    let gate = h.hold('design_code_guidance'); await cdp.evaluate("document.querySelector('[data-action=generate]').click()"); await gate.entered.promise;
    await h.switchTo(h.other.id); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), ''); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-reference]').value"), 'auto'); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-direction]').value"), 'auto'); await h.prompt('Keep the destination draft.');
    gate.release.resolve(); await gate.finished.promise; await until('old request finishes', () => cdp.evaluate("!document.querySelector('[data-action=generate]').disabled"), Boolean);
    assert.equal(await cdp.evaluate('bridgeCalls.length'), 0); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), 'Keep the destination draft.'); assert.equal(await cdp.evaluate("!!document.querySelector('.dc-fallback')"), false);
    await h.switchTo(h.project.id); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-prompt]').value"), original); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-reference]').value"), 'operations-console'); assert.equal(await cdp.evaluate("document.querySelector('[data-ai-direction]').value"), 'precision'); assert.equal(await cdp.evaluate(`document.querySelector('.dc-fallback textarea').value.includes(${JSON.stringify(original)})`), true);
    gate = h.hold('design_code_guidance'); await cdp.evaluate("document.querySelector('[data-action=generate]').click()"); await gate.entered.promise;
    await cdp.evaluate("globalThis.detachedEditor=document.getElementById('editor');globalThis.closedTaskEditor=taskApp.teardown();detachedEditor.remove();globalThis.detachedMutations=0;globalThis.detachObserver=new MutationObserver(records=>detachedMutations+=records.length);detachObserver.observe(detachedEditor,{subtree:true,childList:true,attributes:true,characterData:true});document.getElementById('outside').focus();true");
    gate.release.resolve(); await gate.finished.promise; await cdp.evaluate('closedTaskEditor'); await pause(100);
    assert.equal(await cdp.evaluate('bridgeCalls.length'), 0); assert.equal(await cdp.evaluate('detachedMutations'), 0); assert.equal(await cdp.evaluate('document.activeElement.id'), 'outside'); assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic('Actual MCP guidance responses were withheld; switching and teardown were checked in Chromium without sending any chat message.');
  } finally { await h.close(); }
});

test('unsupported host download saves the originally exported bytes after the real project changes', { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; exact export fallback is unverified.'); return; }
  const h = await harness(executable), { cdp, store } = h;
  try {
    await cdp.evaluate("downloadDelay=true;document.querySelector('[data-action=export]').click()"); await until('export dialog', () => cdp.evaluate("!!document.querySelector('[data-export=html]')"), Boolean); await cdp.evaluate("document.querySelector('[data-export=html]').click()");
    await until('original bytes presented to the host', () => cdp.evaluate('downloadCalls.length'), value => value === 1);
    const exported = h.calls.find(call => call.name === 'design_code_export')!.result!, originalBytes = Buffer.from(exported.dataBase64, 'base64'); assert.equal(exported.revision, h.project.revision);
    const current = await store.get(h.project.id), entry = current.files.find(file => file.path === current.pages[0]!.entry)!;
    const changed = await store.update(current.id, current.revision, { files: [{ path: entry.path, expectedHash: codeFileHash(entry), content: entry.content + '\n<!-- Newer source must not replace the pending export. -->' }] }); await h.publish(changed);
    await cdp.evaluate('downloadRelease({saved:false,unsupported:true})');
    const savedCall = await until('actual artifact save', async () => h.calls.find(call => call.name === 'design_code_save_export' && call.result), Boolean);
    assert.deepEqual(savedCall!.args, { artifactId: exported.artifactId }); const saved = savedCall!.result!; assert.equal(saved.revision, exported.revision); assert.equal(saved.projectId, h.project.id); assert.equal(saved.sha256, createHash('sha256').update(originalBytes).digest('hex')); assert.deepEqual(await readFile(saved.path), originalBytes);
    assert.equal(h.calls.filter(call => call.name === 'design_code_export').length, 1); assert.equal((await store.get(h.project.id)).revision, changed.revision); assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic('The actual MCP exporter, server artifact cache and disk save were used; unsupported download was controlled and no native-host download is claimed.');
  } finally { await h.close(); }
});


test('large artifact exports bypass host download and save the exact snapshot despite a later project revision', { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; large artifact UI delivery is unverified.'); return; }
  const h = await harness(executable), { cdp, store } = h;
  try {
    const entry = h.project.files.find(file => file.path === h.project.pages[0]!.entry)!;
    const image = createExportPngFixture(), original = await store.update(h.project.id, h.project.revision, { files: [
      { path: entry.path, expectedHash: codeFileHash(entry), content: '<!doctype html><html><body><h1>Original large browser snapshot</h1><img src="photo.png" alt="Local transport fixture"></body></html>' },
      { path: 'photo.png', expectedHash: null, encoding: 'base64', content: image.toString('base64') },
    ] });
    await h.publish(original);
    const gate = h.hold('design_code_export');
    await cdp.evaluate("document.querySelector('[data-action=export]').click()"); await until('large export dialog', () => cdp.evaluate("!!document.querySelector('[data-export=html]')"), Boolean); await cdp.evaluate("document.querySelector('[data-export=html]').click()");
    await gate.entered.promise;
    const exported = h.calls.find(call => call.name === 'design_code_export')!.result!;
    assert.equal(exported.delivery, 'artifact'); assert.equal(Object.hasOwn(exported, 'dataBase64'), false); assert.ok(exported.bytes > 3 * 1024 * 1024); assert.equal(exported.revision, original.revision);
    const currentEntry = original.files.find(file => file.path === entry.path)!;
    const changed = await store.update(original.id, original.revision, { files: [{ path: entry.path, expectedHash: codeFileHash(currentEntry), content: '<h1>Newer source during artifact delivery</h1>' }] }); await h.publish(changed);
    gate.release.resolve(); await gate.finished.promise;
    const savedCall = await until('large snapshot actually saved', async () => h.calls.find(call => call.name === 'design_code_save_export' && call.result), Boolean);
    assert.deepEqual(savedCall!.args, { artifactId: exported.artifactId }); const saved = savedCall!.result!, bytes = await readFile(saved.path);
    assert.equal(saved.revision, original.revision); assert.equal(saved.sha256, exported.sha256); assert.equal(saved.bytes, exported.bytes); assert.equal(bytes.length, exported.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), exported.sha256);
    assert.ok(bytes.toString().includes('Original large browser snapshot')); assert.ok(!bytes.toString().includes('Newer source during artifact delivery'));
    assert.equal(await cdp.evaluate('downloadCalls.length'), 0); assert.equal(h.calls.filter(call => call.name === 'design_code_export').length, 1);
    await until('actual saved path visible', () => cdp.evaluate("document.querySelector('.dc-toast')?.textContent"), value => value?.includes(saved.path));
    assert.equal((await store.get(h.project.id)).revision, changed.revision); assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
    context.diagnostic('Actual source MCP, artifact bytes, disk save and browser UI were used. The host bridge was controlled; no native-host download is claimed.');
  } finally { await h.close(); }
});

test('cancelled small inline downloads keep cancellation and never silently save a local fallback', { timeout: 75_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; inline cancellation is unverified.'); return; }
  const h = await harness(executable), { cdp } = h;
  try {
    await cdp.evaluate("downloadResult={saved:false,reason:'用户取消下载'};document.querySelector('[data-action=export]').click()"); await until('small export dialog', () => cdp.evaluate("!!document.querySelector('[data-export=html]')"), Boolean); await cdp.evaluate("document.querySelector('[data-export=html]').click()");
    await until('cancellation visible', () => cdp.evaluate("document.querySelector('.dc-toast')?.textContent"), value => value === '用户取消下载');
    const exported = h.calls.find(call => call.name === 'design_code_export')!.result!;
    assert.equal(exported.delivery, 'inline'); assert.equal(await cdp.evaluate('downloadCalls.length'), 1); assert.equal(h.calls.filter(call => call.name === 'design_code_save_export').length, 0);
    assert.equal((await h.store.get(h.project.id)).revision, h.project.revision); assert.deepEqual(h.unexpected, []); assert.deepEqual(cdp.errors, []);
  } finally { await h.close(); }
});
