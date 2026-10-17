import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PAGE_PREVIEW_LIMITS, PagePreviewPool, limitLiveBoards, pagePreviewKey, previewResourceBytes } from '../ui/page-previews.ts';

interface Resource {
  projectId: string;
  revision: number;
  pageId: string;
  html: string;
  sources: Array<{ id: string; file: string; start: number; end: number }>;
  fileHashes: Record<string, string>;
}
function resource(pageId: string, options: { projectId?: string; revision?: number; html?: string } = {}): Resource {
  return { projectId: options.projectId ?? 'project', revision: options.revision ?? 1, pageId, html: options.html ?? `<h1>${pageId} 页面</h1>`, sources: [{ id: `source-${pageId}`, file: `${pageId}.tsx`, start: 0, end: 20 }], fileHashes: { [`${pageId}.tsx`]: 'a'.repeat(64) } };
}
function key(value: Resource) { return pagePreviewKey(value.projectId, value.revision, value.pageId); }
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function outcome<T>(promise: Promise<T>) { return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error })); }

test('published budgets allocate four live boards without confusing them with page or viewport counts', () => {
  assert.deepEqual(PAGE_PREVIEW_LIMITS, { concurrent: 2, liveFrames: 4, cacheBytes: 64 * 1024 * 1024 });
  const boards = Array.from({ length: 32 }, (_, index) => ({ pageId: `page-${index}`, viewportId: 'shared-desktop' }));
  const allocated = limitLiveBoards(boards);
  assert.deepEqual(allocated.allowed, boards.slice(0, 4));
  assert.deepEqual(allocated.rejected, boards.slice(4));
  assert.equal(allocated.allowed[0], boards[0], 'Allocation keeps the actual page binding; it does not synthesize a viewport alias.');
  assert.equal(boards.length, 32, 'Allocation must not mutate the project page list.');
});

test('the default 64 MiB cache rejects an oversized resource and accounts for UTF-8 source registry metadata', () => {
  const ordinary = resource('中文', { html: '页面🙂' });
  const fullBytes = previewResourceBytes(ordinary), registryBytes = previewResourceBytes(ordinary, true);
  assert.equal(fullBytes - registryBytes, Buffer.byteLength(ordinary.html), 'HTML costs its UTF-8 bytes, including multibyte characters.');
  assert.ok(registryBytes >= Buffer.byteLength(JSON.stringify(ordinary.sources)) + Buffer.byteLength(JSON.stringify(ordinary.fileHashes)), 'Source registries and hashes consume the cache budget too.');
  const pool = new PagePreviewPool<Resource>(); pool.setScope('project:1');
  const oversized = resource('large', { html: 'x'.repeat(PAGE_PREVIEW_LIMITS.cacheBytes) });
  assert.ok(previewResourceBytes(oversized) > PAGE_PREVIEW_LIMITS.cacheBytes, 'Registry overhead prevents a nominal 64 MiB HTML file from fitting.');
  assert.throws(() => pool.put(key(oversized), oversized), { name: 'PreviewBudgetError' });
  assert.equal(pool.stats().cachedBytes, 0); assert.equal(pool.stats().cachedEntries, 0);
});

test('cache pressure evicts background resources, protects every visible board, and refuses an impossible visible set', () => {
  const a = resource('a', { html: 'a'.repeat(2048) }), b = resource('b', { html: 'b'.repeat(2048) }), c = resource('c', { html: 'c'.repeat(2048) }), d = resource('d', { html: 'd'.repeat(2048) });
  const budget = previewResourceBytes(a) + previewResourceBytes(b);
  const evicted: string[] = [];
  const pool = new PagePreviewPool<Resource>({ maxBytes: budget, onEvict: (entry: string) => { evicted.push(entry); } });
  pool.setScope('project:1'); pool.put(key(a), a); pool.put(key(b), b); pool.setProtected([key(a)]);
  pool.put(key(c), c);
  assert.deepEqual(pool.get(key(a)), a); assert.equal(pool.get(key(b)), undefined); assert.deepEqual(pool.get(key(c)), c);
  assert.ok(evicted.includes(key(b)), 'The unprotected cached page is the eviction candidate.');
  pool.setProtected([key(a), key(c)]);
  const before = pool.stats();
  assert.throws(() => pool.put(key(d), d), { name: 'PreviewBudgetError' });
  assert.deepEqual(pool.get(key(a)), a); assert.deepEqual(pool.get(key(c)), c); assert.equal(pool.get(key(d)), undefined);
  assert.equal(pool.stats().cachedBytes, before.cachedBytes, 'An impossible insertion does not quietly evict a visible page.');
  assert.ok(pool.stats().cachedBytes <= budget);
});

test('32 background registry requests remain bounded and a visible request promotes the existing queued task', async () => {
  const pool = new PagePreviewPool<Resource>(); pool.setScope('project:1');
  const values = Array.from({ length: 32 }, (_, index) => resource(`page-${index}`));
  const gates = values.map(() => gate<Resource>()), started: number[] = [];
  const pending = values.map((value, index) => outcome(pool.request(key(value), async () => { started.push(index); return gates[index]!.promise; }, { scope: 'project:1', priority: 'background', registryOnly: true })));
  await nextTurn();
  assert.deepEqual(started, [0, 1]); assert.equal(pool.stats().active, 2); assert.equal(pool.stats().queued, 30);
  let duplicateLoads = 0;
  const visible = outcome(pool.request(key(values[20]!), async () => { duplicateLoads++; return values[20]!; }, { scope: 'project:1', priority: 'visible' }));
  gates[0]!.resolve(values[0]!); await pending[0]; await nextTurn();
  assert.deepEqual(started, [0, 1, 20], 'The user-visible board runs ahead of older background comment registries.');
  assert.equal(duplicateLoads, 0, 'Promotion reuses the original RPC and does not run the replacement loader.');
  gates[20]!.resolve(values[20]!);
  assert.deepEqual((await visible).value, values[20]); await pending[20];
  assert.equal(pool.get(key(values[20]!))?.html, values[20]!.html, 'A promoted registry task retains full HTML for the visible board.');
  assert.equal(pool.get(key(values[0]!)), undefined, 'A background comment registry cannot masquerade as a runnable preview.');
  assert.equal(pool.getRegistry(key(values[0]!))?.html, '', 'Background cache storage omits large HTML.');
  pool.setScope('other-project:1');
  for (let index = 0; index < gates.length; index++) gates[index]!.resolve(values[index]!);
  const completed = await Promise.all(pending);
  assert.ok(completed.slice(2).filter((_, index) => index + 2 !== 20).every(result => result.error?.name === 'PreviewStaleError'), 'Changing scope cancels old queued tasks and discards any already-started late result.');
  assert.equal(pool.stats().queued, 0); assert.equal(pool.stats().active, 0); assert.equal(pool.stats().cachedEntries, 0);
});

test('old in-flight RPCs occupy global concurrency slots after scope change while queued work is cancelled', async () => {
  const pool = new PagePreviewPool<Resource>(); pool.setScope('project:1');
  const old = [resource('old-a'), resource('old-b'), resource('old-queued')], oldGates = old.map(() => gate<Resource>());
  const starts: string[] = [];
  const oldPending = old.map((value, index) => outcome(pool.request(key(value), async () => { starts.push(value.pageId); return oldGates[index]!.promise; }, { scope: 'project:1' })));
  await nextTurn(); assert.deepEqual(starts, ['old-a', 'old-b']);
  pool.setScope('project:2');
  const fresh = [resource('fresh-a', { revision: 2 }), resource('fresh-b', { revision: 2 })], freshGates = fresh.map(() => gate<Resource>());
  const freshPending = fresh.map((value, index) => outcome(pool.request(key(value), async () => { starts.push(value.pageId); return freshGates[index]!.promise; }, { scope: 'project:2', priority: 'visible' })));
  await nextTurn();
  assert.deepEqual(starts, ['old-a', 'old-b'], 'Uncancellable old RPCs still consume both actual compile slots.');
  assert.equal((await oldPending[2]!).error?.name, 'PreviewStaleError');
  assert.equal(pool.stats().active, 2); assert.equal(pool.stats().queued, 2);
  oldGates[0]!.resolve(old[0]!); await oldPending[0]; await nextTurn();
  assert.deepEqual(starts, ['old-a', 'old-b', 'fresh-a']);
  assert.equal(pool.get(key(old[0]!)), undefined, 'A late old response cannot populate the current cache.');
  oldGates[1]!.resolve(old[1]!); await oldPending[1]; await nextTurn();
  assert.deepEqual(starts, ['old-a', 'old-b', 'fresh-a', 'fresh-b']);
  freshGates.forEach((item, index) => item.resolve(fresh[index]!));
  const results = await Promise.all(freshPending);
  assert.ok(results.every(result => result.value && !result.error));
  assert.ok((await Promise.all(oldPending)).every(result => result.error?.name === 'PreviewStaleError'));
  assert.equal(pool.stats().active, 0); assert.equal(pool.stats().queued, 0); assert.equal(pool.stats().cachedEntries, 2);
});

test('a running registry task can become visible, while an already stripped registry requires fresh HTML', async () => {
  const pool = new PagePreviewPool<Resource>(); pool.setScope('project:1');
  const value = resource('shared'), running = gate<Resource>(); let loads = 0;
  const background = pool.request(key(value), async () => { loads++; return running.promise; }, { scope: 'project:1', priority: 'background', registryOnly: true });
  await nextTurn();
  const visible = pool.request(key(value), async () => { loads++; return value; }, { scope: 'project:1', priority: 'visible' });
  running.resolve(value); await Promise.all([background, visible]);
  assert.equal(loads, 1); assert.equal(pool.get(key(value))?.html, value.html, 'An in-flight promotion keeps the returned HTML rather than a stale registry-only flag.');
  pool.delete(key(value));
  await pool.request(key(value), async () => { loads++; return value; }, { scope: 'project:1', priority: 'background', registryOnly: true });
  assert.equal(pool.get(key(value)), undefined); assert.equal(pool.getRegistry(key(value))?.html, '');
  const current = await pool.request(key(value), async () => { loads++; return value; }, { scope: 'project:1', priority: 'visible' });
  assert.equal(current.html, value.html); assert.equal(loads, 3, 'Discarded background HTML is not a runnable preview; the visible request really loads it.');
});

test('a result bound to another project, page, or revision is never cached under the requested page key', async () => {
  const expected = resource('correct');
  const pool = new PagePreviewPool<Resource>(); pool.setScope('project:1');
  for (const invalid of [resource('correct', { projectId: 'different' }), resource('different'), resource('correct', { revision: 2 })]) {
    assert.throws(() => pool.put(key(expected), invalid));
    await assert.rejects(pool.request(key(expected), async () => invalid, { scope: 'project:1' }));
    assert.equal(pool.get(key(expected)), undefined); assert.equal(pool.stats().cachedEntries, 0);
  }
});
