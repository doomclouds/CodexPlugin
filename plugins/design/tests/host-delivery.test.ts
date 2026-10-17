import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deliverHostPrompt, requestHostDisplayMode } from '../ui/host-delivery.ts';
import { browserExecutable } from '../src/browser.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type HostCapabilities = NonNullable<ReturnType<App['getHostCapabilities']>>;
type MessageParameters = Parameters<App['sendMessage']>[0];
type MessageResult = Awaited<ReturnType<App['sendMessage']>>;
async function fixture(capabilities: HostCapabilities = { message: { text: {} }, updateModelContext: { text: {} } }) {
  const app = new App({ name: 'Self-owned delivery protocol fixture', version: '1' }, {}, { autoResize: false });
  const host = new AppBridge(null, { name: 'In-memory test host only', version: '1' }, capabilities);
  const messages: MessageParameters[] = [], contextCalls: unknown[] = [];
  let receive: (params: MessageParameters) => Promise<MessageResult> = async () => ({});
  host.onmessage = async params => { messages.push(params); return receive(params); };
  host.onupdatemodelcontext = async params => { contextCalls.push(params); throw new Error('Context update fixture deliberately unavailable'); };
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  await host.connect(hostTransport); await app.connect(appTransport);
  return { app, host, messages, contextCalls, setReceive(handler: typeof receive) { receive = handler; }, async disconnect() { await appTransport.close(); }, async close() { await appTransport.close(); await hostTransport.close(); } };
}

test('one self-contained ui/message preserves complete intent without depending on mutable model context', async () => {
  const h = await fixture();
  try {
    const text = `请修改明确项目和页面。\n${'完整用户需求。'.repeat(1000)}\nprojectId=fixture_project revision=27 pageId=fixture_page\n组件和CSS的实际内容请从源码工具读取，按原修订校验。`;
    const result = await deliverHostPrompt(h.app, text, { isCurrent: () => true });
    assert.deepEqual(result, { status: 'sent' });
    assert.deepEqual(h.messages, [{ role: 'user', content: [{ type: 'text', text }] }], 'The actual SDK request must contain every character once');
    assert.deepEqual(h.contextCalls, [], 'The sending path must not call a separate context method which can fail or overwrite another project context');
  } finally { await h.close(); }
});

test('missing text capability and explicit failed delivery remain distinct from uncertain transport outcomes', async () => {
  const missing = await fixture({});
  try {
    const result = await deliverHostPrompt(missing.app, 'Own fixture only');
    assert.equal(result.status, 'not-sent'); assert.match(result.reason!, /未声明/); assert.deepEqual(missing.messages, []);
  } finally { await missing.close(); }
  const rejected = await fixture();
  try {
    rejected.setReceive(async () => ({ isError: true }));
    const result = await deliverHostPrompt(rejected.app, 'Own fixture rejected');
    assert.equal(result.status, 'not-sent'); assert.match(result.reason!, /明确报告/); assert.equal(rejected.messages.length, 1);
  } finally { await rejected.close(); }
});

test('pre-dispatch stale intent cancels without any host message or context side effect', async () => {
  const h = await fixture();
  try {
    assert.equal((await deliverHostPrompt(h.app, 'Already stale fixture', { isCurrent: () => false })).status, 'cancelled');
    assert.equal((await deliverHostPrompt(h.app, 'Unverifiable fixture', { isCurrent() { throw new Error('Editor destroyed'); } })).status, 'cancelled');
    let current = true;
    const preflightChanged = { getHostCapabilities() { const capabilities = h.app.getHostCapabilities(); current = false; return capabilities; }, sendMessage: h.app.sendMessage.bind(h.app) };
    assert.equal((await deliverHostPrompt(preflightChanged, 'Project changed during preflight', { isCurrent: () => current })).status, 'cancelled');
    assert.deepEqual(h.messages, []); assert.deepEqual(h.contextCalls, []);
  } finally { await h.close(); }
});

test('a host that accepted a message but withholds its acknowledgement produces unknown and no automatic duplicate', async () => {
  const h = await fixture(), entered = deferred(), release = deferred(), finished = deferred();
  try {
    h.setReceive(async () => { entered.resolve(); await release.promise; finished.resolve(); return {}; });
    let current = true;
    const pending = deliverHostPrompt(h.app, 'Accepted by self-owned timeout fixture', { isCurrent: () => current }, 50);
    await entered.promise; current = false;
    const result = await pending;
    assert.equal(result.status, 'unknown'); assert.match(result.reason!, /可能已收到/); assert.match(result.reason!, /避免重复/);
    assert.equal(h.messages.length, 1, 'Timeout must not retry an operation the host may already have accepted');
    release.resolve(); await finished.promise; assert.equal(h.messages.length, 1);
  } finally { release.resolve(); await h.close(); }
});

test('lost connection after dispatch is unknown, while successful acknowledgement remains sent after local intent changes', async () => {
  const h = await fixture(), entered = deferred(), release = deferred();
  try {
    h.setReceive(async () => { entered.resolve(); await release.promise; return {}; });
    const pending = deliverHostPrompt(h.app, 'Connection loss self-owned fixture'); await entered.promise; await h.disconnect();
    assert.equal((await pending).status, 'unknown'); assert.equal(h.messages.length, 1);
  } finally { release.resolve(); await h.close(); }
  const acknowledged = await fixture(), accepted = deferred(), finish = deferred();
  try {
    acknowledged.setReceive(async () => { accepted.resolve(); await finish.promise; return {}; });
    let current = true; const pending = deliverHostPrompt(acknowledged.app, 'Successful old intent must not be described as unsent', { isCurrent: () => current });
    await accepted.promise; current = false; finish.resolve(); assert.deepEqual(await pending, { status: 'sent' }); assert.equal(acknowledged.messages.length, 1);
  } finally { finish.resolve(); await acknowledged.close(); }
});

test('a protocol exception cannot establish non-delivery and never triggers fallback retry', async () => {
  const h = await fixture();
  try {
    h.setReceive(async () => { throw new Error('Self-owned host handler failed after observing content'); });
    const result = await deliverHostPrompt(h.app, 'Protocol exception self-owned fixture');
    assert.equal(result.status, 'unknown'); assert.match(result.reason!, /Self-owned host handler failed/); assert.equal(h.messages.length, 1);
  } finally { await h.close(); }
});

test('display requests handle host refusal and report the actual mode without an unhandled rejection', async () => {
  const h = await fixture();
  try {
    let calls = 0, denied = true;
    h.host.onrequestdisplaymode = async () => { calls++; if (denied) throw new Error('Self-owned host denied expanded display'); return { mode: 'inline' }; };
    const refused = await requestHostDisplayMode(h.app, 'fullscreen');
    assert.equal(refused.status, 'unknown'); assert.match(refused.reason!, /显示切换未确认/); assert.match(refused.reason!, /Self-owned host denied/);
    denied = false;
    assert.deepEqual(await requestHostDisplayMode(h.app, 'fullscreen'), { status: 'not-changed', mode: 'inline', reason: '宿主保留了当前显示方式。可继续使用当前工作区。' });
    assert.deepEqual(await requestHostDisplayMode(h.app, 'fullscreen', { isCurrent: () => false }), { status: 'cancelled' });
    assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('actual app handles display protocol errors visibly, merges partial host context and ignores a late display result after teardown', { timeout: 45_000 }, async context => {
  const executable = await browserExecutable(); if (!executable) { context.skip('Local Chromium unavailable; app display DOM lifecycle remains unverified.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'design-host-delivery-'));
  let child: ReturnType<typeof spawn> | undefined, socket: WebSocket | undefined, sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let ready: Promise<void>, phase = 'real app handshake';
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../ui/app.ts', import.meta.url))], outfile: 'host-delivery-app.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent' });
  const js = bundled.outputFiles.find(file => file.path.endsWith('.js'))!.text.replace(/<\/script/gi, '<\\/script'), css = bundled.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const appHtml = `<!doctype html><html><head><style>${css}</style></head><body><div id="design-editor"></div><script>globalThis.unhandled=[];addEventListener('unhandledrejection',event=>unhandled.push(String(event.reason)))</script><script>${js}</script></body></html>`;
  const hostHtml = `<!doctype html><html><body><iframe id="studio" src="/app" style="width:1440px;height:1000px;border:0"></iframe><script>
  globalThis.messages=[];globalThis.displayPolicy='deny';globalThis.displayRequests=[];globalThis.responses=[];globalThis.heldDisplay=null;
  const studio=document.getElementById('studio');globalThis.reply=(id,result)=>studio.contentWindow.postMessage({jsonrpc:'2.0',id,result},'*');globalThis.contextUpdate=update=>studio.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:update},'*');
  addEventListener('message',event=>{if(event.source!==studio.contentWindow)return;const message=event.data;if(message?.jsonrpc!=='2.0')return;messages.push(message);if(message.id===undefined)return;
  if(message.method==='ui/initialize')return reply(message.id,{protocolVersion:'2026-01-26',hostInfo:{name:'Own protocol fixture only',version:'1'},hostCapabilities:{message:{text:{}},serverTools:{}},hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen'],theme:'light'}});
  if(message.method==='tools/call'){const name=message.params.name;if(name!=='design_code_list'&&name!=='design_get_guidance')throw Error('Unexpected fixture tool '+name);const structuredContent=name==='design_code_list'?{projects:[],unsupported:[]}:{directions:[]};return reply(message.id,{content:[{type:'text',text:JSON.stringify(structuredContent)}],structuredContent})}
  if(message.method==='ui/request-display-mode'){displayRequests.push(message.params.mode);if(displayPolicy==='hold'){heldDisplay=message;return}if(displayPolicy==='deny')return studio.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Own fixture denied display'}},'*');return reply(message.id,{mode:message.params.mode})}
  if(message.method==='ui/message'||message.method==='ui/update-model-context')throw Error('This display fixture must not initiate chat or context');
  if(message.method===undefined){responses.push(message);return}
  studio.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported own fixture request'}},'*');
  });</script></body></html>`;
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.url === '/app' ? appHtml : hostHtml); });
  const command = async (method: string, params: unknown = {}): Promise<any> => { await ready; const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Display fixture CDP timeout ${method}`)); }, 10_000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); }); };
  const evaluate = async (expression: string) => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  const until = async (label: string, read: () => Promise<any>, matches: (value: any) => boolean) => { const deadline = Date.now() + 10_000; let last: unknown; while (true) { try { last = await read(); if (matches(last)) return last; } catch (error) { last = String(error); } if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(last)}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const documentExpression = "document.getElementById('studio').contentDocument";
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
    child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'browser')}`, 'about:blank'], { stdio: 'ignore' });
    const port = await until('Chromium port', async () => (await readFile(join(directory, 'browser/DevToolsActivePort'), 'utf8')).split('\n')[0]!, value => /^\d+$/.test(value));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl);
    ready = new Promise((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('Own display fixture connection failed')), { once: true }); });
    socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)), request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); } });
    await command('Runtime.enable'); await command('Page.enable'); await command('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await until('App handshake and available toolbar', () => evaluate(`${documentExpression}.documentElement.dataset.designHostConnected==='true'&&!${documentExpression}.querySelector('.design-host-toolbar').hidden`), Boolean);
    phase = 'actual rejected ui/request-display-mode';
    await evaluate(`${documentExpression}.querySelector('.design-expand').click()`);
    await until('Readable display refusal', () => evaluate(`({text:${documentExpression}.querySelector('.design-host-toolbar [role=status]').textContent,hidden:${documentExpression}.querySelector('.design-host-toolbar [role=status]').hidden,disabled:${documentExpression}.querySelector('.design-expand').disabled})`), value => value.text.includes('Own fixture denied display') && !value.hidden && !value.disabled);
    assert.deepEqual(await evaluate("document.getElementById('studio').contentWindow.unhandled"), []);
    phase = 'partial host theme notification preserves display capability';
    await evaluate("contextUpdate({theme:'dark'})");
    await until('Partial theme update', () => evaluate(`${documentExpression}.documentElement.dataset.hostTheme`), value => value === 'dark');
    assert.equal(await evaluate(`${documentExpression}.querySelector('.design-host-toolbar').hidden`), false); assert.equal(await evaluate(`${documentExpression}.querySelector('.design-expand').disabled`), false);
    phase = 'actual mode acknowledgement updates local controls without requiring another notification';
    await evaluate(`displayPolicy='accept';${documentExpression}.querySelector('.design-expand').click()`);
    await until('Acknowledged fullscreen button', () => evaluate(`${documentExpression}.querySelector('.design-expand').textContent`), value => value === '返回聊天');
    await evaluate(`${documentExpression}.querySelector('.design-expand').click()`);
    await until('Acknowledged inline button', () => evaluate(`${documentExpression}.querySelector('.design-expand').textContent`), value => value === '展开工作区');
    assert.deepEqual(await evaluate('displayRequests'), ['fullscreen', 'fullscreen', 'inline']);
    phase = 'teardown with pending display response';
    await evaluate(`displayPolicy='hold';${documentExpression}.querySelector('.design-expand').click()`); await until('Withheld display request', () => evaluate('!!heldDisplay'), Boolean);
    await evaluate("studio.contentWindow.postMessage({jsonrpc:'2.0',id:'teardown-fixture',method:'ui/resource-teardown',params:{}},'*')");
    await until('Actual SDK teardown response', () => evaluate("responses.some(message=>message.id==='teardown-fixture')"), Boolean);
    assert.equal(await evaluate(`${documentExpression}.querySelectorAll('.design-host-toolbar').length`), 0);
    await evaluate("reply(heldDisplay.id,{mode:'fullscreen'})");
    await until('Late request settled without recreating toolbar', () => evaluate(`${documentExpression}.querySelectorAll('.design-host-toolbar').length===0&&document.getElementById('studio').contentWindow.unhandled.length===0`), Boolean);
    assert.equal(await evaluate("messages.some(message=>message.method==='ui/message'||message.method==='ui/update-model-context')"), false);
    context.diagnostic('Actual app bundle, ext-apps handshake, postMessage requests/responses and DOM teardown verified against a self-owned fixture; no native host or model delivery is claimed.');
  } catch (error) { context.diagnostic(`phase=${phase}; ${JSON.stringify(await evaluate("({requests:displayRequests,messages:messages.map(item=>item.method??item.id),unhandled:document.getElementById('studio').contentWindow.unhandled})").catch(() => 'Browser state unavailable'))}`); throw error; }
  finally {
    if (socket) { await evaluate("studio.contentWindow.dispatchEvent(new Event('pagehide'))").catch(() => {}); socket.close(); }
    for (const request of pending.values()) clearTimeout(request.timer); pending.clear();
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill('SIGTERM'); const force = setTimeout(() => child!.kill('SIGKILL'), 1000); await closed; clearTimeout(force); }
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});
