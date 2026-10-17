import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeProjectStore, codeFileHash } from '../src/code-project.ts';
import { ExportArtifacts, EXPORT_ARTIFACT_LIMITS, EXPORT_INLINE_MAX_BYTES } from '../src/export-artifacts.ts';
import type { InlineExportArtifact, SavedExportArtifact } from '../src/export-artifacts.ts';
import { createDesignServer } from '../src/server.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const identity = { projectId: 'code_test', revision: 1, pageId: 'page_main', format: 'html' as const };
const generated = (content: string) => ({ filename: 'real.html', mimeType: 'text/html', dataBase64: Buffer.from(content).toString('base64') });

async function workspace(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'design-export-artifacts-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function protocol(directory: string, options: { now?: () => number; ttlMs?: number } = {}) {
  const store = new CodeProjectStore({ dataDir: join(directory, 'data') });
  const artifacts = new ExportArtifacts({ dataDir: store.dataDir, ...options });
  const instance = await createDesignServer({ codeStore: store, exportArtifacts: artifacts, panelHtml: '<!doctype html><div>Exact export artifact protocol fixture</div>' });
  const client = new Client({ name: 'exact-export-artifact-test', version: '1' }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await raw(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.structuredContent as unknown as T;
  };
  return { store, artifacts, client, raw, call, close: async () => { await client.close(); await instance.dispose(); } };
}

test('real MCP download fallback saves the original revision and exact ZIP bytes after the project changes', async () => workspace(async directory => {
  const connection = await protocol(directory);
  try {
    const first = await connection.store.create({ name: 'Original export snapshot', template: 'html' });
    const exported = await connection.call<InlineExportArtifact>('design_code_export', { projectId: first.id, format: 'zip' });
    const original = Buffer.from(exported.dataBase64, 'base64');
    assert.equal(exported.projectId, first.id); assert.equal(exported.revision, 1); assert.equal(exported.pageId, first.defaultPageId); assert.equal(exported.format, 'zip');
    assert.equal(exported.sha256, hash(original)); assert.match(exported.artifactId, /^export_[a-f0-9]{32}$/);
    assert.ok(Date.parse(exported.expiresAt) > Date.now());
    const source = first.files.find(file => file.path === 'index.html')!;
    await connection.store.update(first.id, 1, { name: 'A newer project', files: [{ path: source.path, content: '<h1>Changed after download began</h1>', expectedHash: codeFileHash(source) }] });
    const saved = await connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: exported.artifactId });
    assert.deepEqual(await readFile(saved.path), original);
    assert.equal(saved.sha256, exported.sha256); assert.equal(saved.projectId, exported.projectId); assert.equal(saved.revision, exported.revision); assert.equal(saved.pageId, exported.pageId); assert.equal(saved.format, 'zip');
    assert.equal(saved.filename, exported.filename); assert.equal(Object.hasOwn(saved, 'dataBase64'), false);
    assert.ok(saved.path.startsWith(join(connection.store.dataDir, 'exports') + '/'));
    const again = await connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: exported.artifactId });
    assert.equal(again.path, saved.path); assert.equal((await readdir(join(connection.store.dataDir, 'exports'))).length, 1);
    const obsolete = await connection.raw('design_code_save_export', { projectId: first.id, format: 'zip' });
    assert.equal(obsolete.isError, true, 'The old regenerate-current-project API must not remain as a compatibility path');
    assert.equal((await connection.store.get(first.id)).revision, 2);
  } finally { await connection.close(); }
}));

test('concurrent real MCP exports keep distinct page identities and reverse-order saves cannot mix snapshots', async () => workspace(async directory => {
  const connection = await protocol(directory);
  try {
    const first = await connection.store.create({ name: 'Two pages', template: 'html' });
    const project = await connection.store.update(first.id, 1, {
      files: [{ path: 'settings.html', content: '<h1>Actual settings source</h1>', expectedHash: null }],
      pages: [...first.pages, { id: 'page_settings', name: 'Settings', entry: 'settings.html', route: '/settings' }],
      viewports: [...first.viewports, { id: 'settings_phone', name: 'Settings phone', width: 390, height: 844, pageId: 'page_settings' }],
    });
    const [home, settings] = await Promise.all([
      connection.call<InlineExportArtifact>('design_code_export', { projectId: project.id, pageId: project.defaultPageId, format: 'html' }),
      connection.call<InlineExportArtifact>('design_code_export', { projectId: project.id, viewportId: 'settings_phone', format: 'html' }),
    ]);
    assert.notEqual(home.artifactId, settings.artifactId); assert.notEqual(home.sha256, settings.sha256);
    assert.equal(home.pageId, project.defaultPageId); assert.equal(settings.pageId, 'page_settings');
    assert.equal(home.revision, 2); assert.equal(settings.revision, 2);
    await connection.store.update(project.id, 2, { name: 'Saved during host download' });
    const [savedSettings, savedHome] = await Promise.all([
      connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: settings.artifactId }),
      connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: home.artifactId }),
    ]);
    for (const [exported, saved] of [[settings, savedSettings], [home, savedHome]] as const) {
      assert.equal(saved.artifactId, exported.artifactId); assert.equal(saved.pageId, exported.pageId); assert.equal(saved.revision, 2);
      assert.deepEqual(await readFile(saved.path), Buffer.from(exported.dataBase64, 'base64')); assert.equal(hash(await readFile(saved.path)), exported.sha256);
    }
    const retries = await Promise.all(Array.from({ length: 4 }, () => connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: home.artifactId })));
    assert.ok(retries.every(saved => saved.path === savedHome.path));
    assert.equal((await readdir(join(connection.store.dataDir, 'exports'))).length, 2);
  } finally { await connection.close(); }
}));

test('failed real filesystem saves retain the artifact for a same-byte retry without another project export', async () => workspace(async directory => {
  const connection = await protocol(directory);
  try {
    const project = await connection.store.create({ name: 'Retry original bytes', template: 'html' });
    const exported = await connection.call<InlineExportArtifact>('design_code_export', { projectId: project.id, format: 'html' });
    const blocked = join(connection.store.dataDir, 'exports'); await writeFile(blocked, 'A user file must not be overwritten');
    const attempts = await Promise.all([connection.raw('design_code_save_export', { artifactId: exported.artifactId }), connection.raw('design_code_save_export', { artifactId: exported.artifactId })]);
    for (const attempt of attempts) { assert.equal(attempt.isError, true); assert.equal((attempt.structuredContent as { error: { code: string } }).error.code, 'EXPORT_SAVE_FAILED'); }
    assert.equal(await readFile(blocked, 'utf8'), 'A user file must not be overwritten');
    assert.deepEqual(connection.artifacts.usage, { entries: 1, bytes: Buffer.from(exported.dataBase64, 'base64').length });
    const source = project.files.find(file => file.path === 'index.html')!;
    await connection.store.update(project.id, 1, { files: [{ path: source.path, content: '<h1>A later revision must not replace the retry</h1>', expectedHash: codeFileHash(source) }] });
    await rm(blocked);
    const [first, second] = await Promise.all([connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: exported.artifactId }), connection.call<SavedExportArtifact>('design_code_save_export', { artifactId: exported.artifactId })]);
    assert.equal(first.path, second.path); assert.equal(first.revision, 1); assert.equal(hash(await readFile(first.path)), exported.sha256);
    assert.deepEqual(await readFile(first.path), Buffer.from(exported.dataBase64, 'base64'));
    assert.equal((await readdir(blocked)).length, 1);
  } finally { await connection.close(); }
}));

test('real MCP expiry rejects the original artifact explicitly and releases cached bytes', async () => workspace(async directory => {
  let now = 1_000;
  const connection = await protocol(directory, { now: () => now, ttlMs: 1_000 });
  try {
    const project = await connection.store.create({ name: 'TTL snapshot', template: 'html' });
    const exported = await connection.call<InlineExportArtifact>('design_code_export', { projectId: project.id, format: 'html' });
    assert.equal(Date.parse(exported.expiresAt), 2_000); assert.equal(connection.artifacts.usage.entries, 1);
    now = 2_000;
    const expired = await connection.raw('design_code_save_export', { artifactId: exported.artifactId });
    assert.equal(expired.isError, true); assert.equal((expired.structuredContent as { error: { code: string } }).error.code, 'EXPORT_ARTIFACT_EXPIRED');
    assert.deepEqual(connection.artifacts.usage, { entries: 0, bytes: 0 });
    assert.deepEqual(await readdir(connection.store.dataDir), [project.id + '.json']);
    assert.equal((await connection.store.get(project.id)).revision, 1);
  } finally { await connection.close(); }
}));

test('automatic TTL cleanup, entry and byte limits keep the cache bounded and eviction never regenerates bytes', async () => workspace(async directory => {
  const automatic = new ExportArtifacts({ dataDir: directory, ttlMs: 20 });
  const item = automatic.register(identity, generated('real bytes'));
  await delay(70);
  assert.deepEqual(automatic.usage, { entries: 0, bytes: 0 });
  await assert.rejects(automatic.save(item.artifactId), isCode('EXPORT_ARTIFACT_EXPIRED')); automatic.dispose();
  const bounded = new ExportArtifacts({ dataDir: directory, maxEntries: 2, maxBytes: 8 });
  try {
    const first = bounded.register(identity, generated('aaaa')), second = bounded.register({ ...identity, revision: 2 }, generated('bbbb'));
    const third = bounded.register({ ...identity, revision: 3 }, generated('cccc'));
    assert.deepEqual(bounded.usage, { entries: 2, bytes: 8 });
    await assert.rejects(bounded.save(first.artifactId), isCode('EXPORT_ARTIFACT_UNAVAILABLE'));
    assert.equal((await bounded.save(second.artifactId)).revision, 2); assert.equal((await bounded.save(third.artifactId)).revision, 3);
    assert.throws(() => bounded.register(identity, generated('oversized')), isCode('EXPORT_ARTIFACT_LIMIT'));
    assert.deepEqual(bounded.usage, { entries: 2, bytes: 8 });
  } finally { bounded.dispose(); }
}));

test('a save in progress pins its original bytes within the budget, even across expiry', async () => workspace(async directory => {
  let now = 1_000;
  const cache = new ExportArtifacts({ dataDir: directory, maxEntries: 1, maxBytes: 4, ttlMs: 10, now: () => now });
  try {
    const item = cache.register(identity, generated('abcd')), pending = cache.save(item.artifactId);
    now = 1_010;
    assert.throws(() => cache.register({ ...identity, revision: 2 }, generated('next')), isCode('EXPORT_ARTIFACT_LIMIT'));
    await assert.rejects(cache.save(item.artifactId), isCode('EXPORT_ARTIFACT_EXPIRED'));
    const saved = await pending;
    assert.equal(hash(await readFile(saved.path)), item.sha256); assert.deepEqual(cache.usage, { entries: 0, bytes: 0 });
    await assert.rejects(cache.save(item.artifactId), isCode('EXPORT_ARTIFACT_EXPIRED'));
  } finally { cache.dispose(); }
}));

test('dispose releases retained bytes, refuses new operations and interrupts a save before opening a file', async () => workspace(async directory => {
  const cache = new ExportArtifacts({ dataDir: directory });
  const item = cache.register(identity, generated('same server-owned bytes')), pending = cache.save(item.artifactId);
  cache.dispose(); cache.dispose();
  assert.deepEqual(cache.usage, { entries: 0, bytes: 0 });
  assert.throws(() => cache.register(identity, generated('new')), isCode('EXPORT_ARTIFACT_DISPOSED'));
  await assert.rejects(cache.save(item.artifactId), isCode('EXPORT_ARTIFACT_DISPOSED'));
  await assert.rejects(pending, isCode('EXPORT_ARTIFACT_DISPOSED'));
  assert.deepEqual(await readdir(join(directory, 'exports')), []);
}));

test('the cache accepts only bounded canonical generated bytes and server-controlled relative filenames', async () => workspace(async directory => {
  const cache = new ExportArtifacts({ dataDir: directory });
  try {
    for (const filename of ['../outside.html', '/outside.html', 'nested/file.html', '..\\outside.html']) assert.throws(() => cache.register(identity, { ...generated('x'), filename }));
    for (const dataBase64 of ['!!!!', 'YQ', 'YR==']) assert.throws(() => cache.register(identity, { ...generated('x'), dataBase64 }));
    assert.deepEqual(cache.usage, { entries: 0, bytes: 0 });
    assert.equal(EXPORT_ARTIFACT_LIMITS.bytes, 67_108_864); assert.equal(EXPORT_ARTIFACT_LIMITS.entries, 16); assert.equal(EXPORT_ARTIFACT_LIMITS.ttlMs, 600_000);
    await assert.rejects(cache.save('export_' + '0'.repeat(32)), isCode('EXPORT_ARTIFACT_UNAVAILABLE'));
  } finally { cache.dispose(); }
}));


test('inline delivery ends at exactly 3 MiB while larger snapshots retain complete immutable bytes without base64 replies', async () => workspace(async directory => {
  const cache = new ExportArtifacts({ dataDir: directory });
  try {
    const content = 'x'.repeat(EXPORT_INLINE_MAX_BYTES), inline = cache.register(identity, generated(content));
    assert.equal(EXPORT_INLINE_MAX_BYTES, 3 * 1024 * 1024); assert.equal(inline.delivery, 'inline');
    assert.equal(inline.bytes, EXPORT_INLINE_MAX_BYTES); assert.ok('dataBase64' in inline); assert.equal(Buffer.from(inline.dataBase64, 'base64').length, inline.bytes);
    const artifact = cache.register({ ...identity, revision: 2 }, generated(content + 'y'));
    assert.equal(artifact.delivery, 'artifact'); assert.equal(artifact.bytes, EXPORT_INLINE_MAX_BYTES + 1); assert.equal(Object.hasOwn(artifact, 'dataBase64'), false); assert.ok(JSON.stringify(artifact).length < 1024);
    assert.deepEqual(cache.usage, { entries: 2, bytes: EXPORT_INLINE_MAX_BYTES * 2 + 1 });
    const saved = await cache.save(artifact.artifactId), actual = await readFile(saved.path);
    assert.equal(actual.length, artifact.bytes); assert.equal(hash(actual), artifact.sha256); assert.equal(actual.toString(), content + 'y'); assert.equal(saved.bytes, artifact.bytes);
    assert.equal(EXPORT_ARTIFACT_LIMITS.artifactBytes, 32 * 1024 * 1024);
  } finally { cache.dispose(); }
}));
