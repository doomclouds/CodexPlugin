import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeProjectStore, createCodeTemplate, summarizeCodeFiles, validateCodeProject } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { CODE_METADATA_RESPONSE_BYTES, listCodeFilesPage, planCodeCommentUpdate, readCodeMetadata } from '../src/code-metadata.ts';
import type { CodeFilePage, CodeMetadataItemsPage, CodeMetadataTextPage } from '../src/code-metadata.ts';

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
function bounded<T>(page: T): T { assert.ok(byteLength(page) <= CODE_METADATA_RESPONSE_BYTES, `Structured response used ${byteLength(page)} bytes`); return page; }
function smallProject(): CodeProject {
  const project = createCodeTemplate('Metadata protocol', 'html');
  project.comments = [0, 1, 2].map(index => ({ id: 'comment_' + index, file: project.files[index % 2]!.path, sourceId: 'anchor_' + index, text: 'Original comment ' + index, status: 'open', createdAt: project.createdAt }));
  return validateCodeProject(project);
}
function fullLength(seed: string, length: number): string { assert.ok(seed.length <= length); return seed + 'x'.repeat(length - seed.length); }
function maximumProject(): CodeProject {
  const base = createCodeTemplate('Maximum bounded metadata', 'html');
  const files = Array.from({ length: 500 }, (_, index) => {
    const prefix = `src/${String(index).padStart(3, '0')}/` + ['界'.repeat(50) + 'a'.repeat(50), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)].join('/') + '/';
    const extension = index < 32 ? '.html' : '.tsx', path = prefix + 's'.repeat(512 - prefix.length - extension.length) + extension;
    return { path, encoding: 'utf8' as const, content: index < 32 ? `<h1>Actual source ${index}</h1>` : `export const source${index} = ${index};` };
  });
  const pages = Array.from({ length: 32 }, (_, index) => ({ id: 'page_' + index, name: fullLength(`Page ${index} / `, 200), entry: files[index]!.path, route: '/page/' + index }));
  const comments = Array.from({ length: 2000 }, (_, index) => ({ id: 'comment_' + index, file: files[index % files.length]!.path, sourceId: fullLength(`source_${index}_`, 500), text: fullLength(`COMMENT_SENTINEL_${index} / ` + '界'.repeat(800) + '🌱'.repeat(100), 10_000), status: index % 2 ? 'resolved' as const : 'open' as const, createdAt: base.createdAt }));
  const components = files.map((file, index) => ({ name: fullLength(`COMPONENT_SENTINEL_${index}_`, 200), path: file.path, exportName: fullLength(`Component${index}`, 200), usage: fullLength(`USAGE_SENTINEL_${index} / `, 10_000) }));
  return validateCodeProject({ ...base, files, pages, defaultPageId: pages[0]!.id, viewports: Array.from({ length: 12 }, (_, index) => ({ id: 'viewport_' + index, name: fullLength('Viewport ' + index, 200), width: 1440, height: 1000 })), comments, designSystem: { components, notes: fullLength('NOTE_SENTINEL / ' + '🌱a\n"\\'.repeat(10_000), 100_000) } });
}
async function workspace(run: (store: CodeProjectStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'design-code-metadata-'));
  try { await run(new CodeProjectStore({ dataDir: join(directory, 'data') }), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function protocol(store: CodeProjectStore) {
  const { createDesignServer } = await import('../src/server.ts');
  const instance = await createDesignServer({ codeStore: store, panelHtml: '<!doctype html><div>Bounded metadata protocol fixture</div>' });
  const client = new Client({ name: 'metadata-protocol-test', version: '1' }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => { const result = await raw(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); return bounded(result.structuredContent as unknown as T); };
  return { raw, call, close: async () => { await client.close(); await instance.dispose(); } };
}

test('maximum valid metadata can be completely reconstructed from bounded pages without flooding file listings', { timeout: 120_000 }, async context => {
  const project = maximumProject(), originalHash = hash(project);
  assert.equal(project.pages.length, 32); assert.equal(project.comments.length, 2000); assert.equal(project.designSystem.components.length, 500); assert.equal(project.designSystem.notes.length, 100_000);
  assert.ok(byteLength(project) > 28 * 1024 * 1024); assert.ok(byteLength(project) < 32 * 1024 * 1024);
  const firstFiles = bounded(listCodeFilesPage(project)); assert.equal(firstFiles.files.length, 50);
  assert.equal(firstFiles.project.schemaVersion, 3); assert.equal(firstFiles.project.commentCount, 2000); assert.equal(firstFiles.project.componentCount, 500);
  assert.equal(firstFiles.project.noteCharacters, Array.from(project.designSystem.notes).length);
  for (const field of ['pages', 'viewports', 'comments', 'designSystem']) assert.equal(Object.hasOwn(firstFiles.project, field), false);
  assert.doesNotMatch(JSON.stringify(firstFiles), /COMMENT_SENTINEL|USAGE_SENTINEL|NOTE_SENTINEL/);
  const files = []; let offset: number | null = 0;
  while (offset !== null) { const page: CodeFilePage = bounded(listCodeFilesPage(project, { offset, limit: 100, expectedRevision: 1 })); assert.ok(page.files.length < 100, 'The actual JSON byte budget can shorten an explicit maximum page'); files.push(...page.files); offset = page.nextOffset; }
  assert.deepEqual(files, summarizeCodeFiles(project));
  const pagesBySection: Record<string, number> = {};
  for (const section of ['pages', 'viewports', 'components', 'comments'] as const) {
    const items = []; offset = 0; let count = 0;
    while (offset !== null) { const page = bounded(readCodeMetadata(project, { section, offset, limit: 50, expectedRevision: 1 })) as CodeMetadataItemsPage; assert.equal(page.offset, offset); assert.equal(page.returned, page.items.length); assert.ok(page.returned > 0); items.push(...page.items); offset = page.nextOffset; count++; }
    const source = section === 'components' ? project.designSystem.components : project[section];
    assert.deepEqual(items, source); pagesBySection[section] = count;
  }
  let notes = ''; offset = 0;
  while (offset !== null) { const page = bounded(readCodeMetadata(project, { section: 'notes', offset, expectedRevision: 1 })) as CodeMetadataTextPage; assert.equal(page.unit, 'unicode-code-points'); assert.equal(page.returned, Array.from(page.text).length); notes += page.text; offset = page.nextOffset; }
  assert.equal(notes, project.designSystem.notes); assert.equal(hash(project), originalHash, 'Reading all pages cannot mutate the source project');
  context.diagnostic(JSON.stringify({ projectBytes: byteLength(project), firstListFilesBytes: byteLength(firstFiles), pagesBySection }));
});

test('maximum valid project uses real store and MCP bounded first, continuation, final and exact-key reads', { timeout: 120_000 }, async context => workspace(async store => {
  const original = maximumProject(), project = await store.importProject(original), connection = await protocol(store);
  try {
    const first = await connection.call<CodeFilePage>('design_code_list_files', { projectId: project.id });
    const next = await connection.call<CodeFilePage>('design_code_list_files', { projectId: project.id, offset: first.nextOffset, limit: 100, expectedRevision: first.revision });
    assert.deepEqual([...first.files, ...next.files], summarizeCodeFiles(project).slice(0, first.returned + next.returned));
    const defaults = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'comments' });
    assert.ok(defaults.returned < 10); assert.deepEqual(defaults.items, project.comments.slice(0, defaults.returned));
    const continuation = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'comments', offset: defaults.nextOffset, limit: 50, expectedRevision: defaults.revision });
    assert.deepEqual(continuation.items, project.comments.slice(defaults.returned, defaults.returned + continuation.returned));
    const final = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'comments', offset: 1999, expectedRevision: 1 });
    assert.deepEqual(final.items, [project.comments.at(-1)]); assert.equal(final.nextOffset, null);
    const component = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'components', key: project.designSystem.components.at(-1)!.name, expectedRevision: 1 });
    assert.deepEqual(component.items, [project.designSystem.components.at(-1)]); assert.equal(component.total, 1);
    const notePage = await connection.call<CodeMetadataTextPage>('design_code_read_metadata', { projectId: project.id, section: 'notes', limit: 8000, expectedRevision: 1 });
    assert.equal(notePage.text, Array.from(project.designSystem.notes).slice(0, 8000).join(''));
    const noteNext = await connection.call<CodeMetadataTextPage>('design_code_read_metadata', { projectId: project.id, section: 'notes', offset: notePage.nextOffset, limit: 8000, expectedRevision: 1 });
    assert.equal(notePage.text + noteNext.text, Array.from(project.designSystem.notes).slice(0, 16000).join(''));
    assert.equal((await store.get(project.id)).revision, 1);
    const updated = await connection.call<{ revision: number; comment: CodeProject['comments'][number]; unchanged: boolean }>('design_code_update_comment', { projectId: project.id, expectedRevision: defaults.revision, commentId: project.comments[0]!.id, changes: { status: 'resolved' } });
    assert.equal(updated.revision, 2); assert.equal(updated.unchanged, false);
    const saved = await store.get(project.id);
    assert.deepEqual(saved.comments[0], { ...project.comments[0]!, status: 'resolved' });
    assert.equal(hash(saved.comments.slice(1)), hash(project.comments.slice(1)), 'A narrow maximum-project write cannot replace its 1999 unseen comments');
    assert.equal(hash(saved.designSystem), hash(project.designSystem)); assert.deepEqual(saved.files, project.files); assert.deepEqual(saved.pages, project.pages); assert.deepEqual(saved.viewports, project.viewports);
    context.diagnostic(JSON.stringify({ projectBytes: byteLength(project), filePageBytes: byteLength(first), commentPageBytes: byteLength(defaults), commentReturned: defaults.returned, componentBytes: byteLength(component), notePageBytes: byteLength(notePage) }));
  } finally { await connection.close(); }
}));

test('notes page by Unicode code points so a one-character page never splits surrogate pairs', () => {
  const project = smallProject(); project.designSystem.notes = 'a'.repeat(3999) + '🌱' + 'b\n"\\\0' + '\ud800' + '终';
  const first = readCodeMetadata(project, { section: 'notes' }) as CodeMetadataTextPage;
  assert.equal(first.returned, 4000); assert.equal(first.text.length, 4001); assert.equal(first.text.at(-2), '\ud83c'); assert.equal(first.text.at(-1), '\udf31');
  const single = readCodeMetadata(project, { section: 'notes', offset: 3999, limit: 1 }) as CodeMetadataTextPage;
  assert.equal(single.text, '🌱'); assert.equal(single.returned, 1); assert.equal(single.nextOffset, 4000);
  let text = '', offset: number | null = 0;
  while (offset !== null) { const page = readCodeMetadata(project, { section: 'notes', offset, limit: 1 }) as CodeMetadataTextPage; text += page.text; offset = page.nextOffset; }
  assert.equal(text, project.designSystem.notes, 'Original controls and even an existing unpaired source unit must be retained, not repaired implicitly');
});

test('array items remain whole under escaped-JSON budgets and exact keys cannot guess ambiguous components', () => {
  const original = smallProject(), prefix = ['甲', '乙', '丙', '丁'].map(character => character.repeat(100)).join('/') + '/', file = prefix + '戊'.repeat(512 - prefix.length - 4) + '.tsx';
  original.files.push({ path: file, encoding: 'utf8', content: 'export default null;' });
  original.comments[0]!.id = 'c'.repeat(80); original.comments[0]!.file = file; original.comments[0]!.text = '\0'.repeat(10_000); original.comments[0]!.sourceId = '\0'.repeat(500); original.comments[0]!.createdAt = '2026-10-17T00:00:00.' + '1'.repeat(43) + 'Z';
  original.designSystem.components = [{ name: '\0'.repeat(200), path: file, exportName: '\0'.repeat(200), usage: '\0'.repeat(10_000) }];
  const project = validateCodeProject(original);
  const comment = bounded(readCodeMetadata(project, { section: 'comments', key: project.comments[0]!.id })) as CodeMetadataItemsPage;
  assert.deepEqual(comment.items, [project.comments[0]]);
  const component = bounded(readCodeMetadata(project, { section: 'components', key: project.designSystem.components[0]!.name })) as CodeMetadataItemsPage;
  assert.deepEqual(component.items, project.designSystem.components);
  project.designSystem.components.push({ ...project.designSystem.components[0]! });
  assert.throws(() => readCodeMetadata(project, { section: 'components', key: project.designSystem.components[0]!.name }), /multiple entries/);
  assert.equal((readCodeMetadata(project, { section: 'components', offset: 1, limit: 1 }) as CodeMetadataItemsPage).items.length, 1);
  project.comments[0]!.text = 'x'.repeat(70_000);
  assert.throws(() => readCodeMetadata(project, { section: 'comments', key: project.comments[0]!.id }), /complete metadata item exceeds/);
});

test('filters, exact keys, EOF and invalid combinations have explicit results', () => {
  const project = smallProject();
  assert.deepEqual((readCodeMetadata(project, { section: 'pages', key: project.defaultPageId }) as CodeMetadataItemsPage).items, [project.pages[0]]);
  assert.deepEqual((readCodeMetadata(project, { section: 'viewports', key: project.viewports[1]!.id }) as CodeMetadataItemsPage).items, [project.viewports[1]]);
  assert.deepEqual((readCodeMetadata(project, { section: 'comments', file: project.files[0]!.path }) as CodeMetadataItemsPage).items, [project.comments[0], project.comments[2]]);
  assert.deepEqual((readCodeMetadata(project, { section: 'comments', file: project.files[0]!.path, key: 'comment_2' }) as CodeMetadataItemsPage).items, [project.comments[2]]);
  for (const section of ['pages', 'viewports', 'components', 'comments', 'notes'] as const) {
    const initial = readCodeMetadata(project, { section }), eof = readCodeMetadata(project, { section, offset: initial.total });
    assert.equal(eof.returned, 0); assert.equal(eof.nextOffset, null);
    assert.throws(() => readCodeMetadata(project, { section, offset: initial.total + 1 }), isCode('VALIDATION'));
    assert.throws(() => readCodeMetadata(project, { section, expectedRevision: 2 }), isCode('REVISION_CONFLICT'));
  }
  const bad = [
    { section: 'notes', key: 'anything' }, { section: 'pages', file: project.files[0]!.path }, { section: 'comments', key: 'comment_0', offset: 0 },
    { section: 'comments', key: 'comment_0', limit: 1 }, { section: 'comments', limit: 51 }, { section: 'notes', limit: 8001 }, { section: 'notes', offset: -1 },
    { section: 'comments', offset: 1.5 }, { section: 'comments', key: '' }, { section: 'notes', limit: 0 },
  ];
  for (const options of bad) assert.throws(() => readCodeMetadata(project, options as Parameters<typeof readCodeMetadata>[1]), isCode('VALIDATION'));
  for (const options of [{ section: 'comments', key: 'missing' }, { section: 'comments', file: 'missing.html' }, { section: 'comments', key: 'comment_1', file: project.files[0]!.path }]) assert.throws(() => readCodeMetadata(project, options as Parameters<typeof readCodeMetadata>[1]), isCode('NOT_FOUND'));
  assert.equal(listCodeFilesPage(project, { offset: project.files.length }).returned, 0);
  assert.throws(() => listCodeFilesPage(project, { offset: project.files.length + 1 }), isCode('VALIDATION'));
  assert.throws(() => listCodeFilesPage(project, { limit: 101 }), isCode('VALIDATION'));
  assert.throws(() => listCodeFilesPage(project, { expectedRevision: 2 }), isCode('REVISION_CONFLICT'));
});

test('real MCP locks continuation reads to a revision and rejects unsupported input combinations', async () => workspace(async store => {
  const project = await store.importProject(smallProject()), connection = await protocol(store);
  try {
    const first = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'comments', limit: 1 });
    await store.update(project.id, 1, { name: 'Saved between metadata pages' });
    for (const name of ['design_code_read_metadata', 'design_code_list_files']) {
      const failed = await connection.raw(name, { projectId: project.id, ...(name.endsWith('metadata') ? { section: 'comments' } : {}), offset: first.nextOffset, expectedRevision: first.revision });
      assert.equal(failed.isError, true); assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'REVISION_CONFLICT');
    }
    const fresh = await connection.call<CodeMetadataItemsPage>('design_code_read_metadata', { projectId: project.id, section: 'comments', key: 'comment_1' });
    assert.equal(fresh.revision, 2); assert.equal(fresh.returned, 1);
    for (const args of [{ section: 'comments', key: 'comment_0', offset: 0 }, { section: 'pages', file: project.files[0]!.path }, { section: 'comments', limit: 51 }, { section: 'notes', limit: 8001 }, { section: 'comments', key: 'unknown' }]) assert.equal((await connection.raw('design_code_read_metadata', { projectId: project.id, ...args })).isError, true);
  } finally { await connection.close(); }
}));

test('narrow comment plans preserve anchors and unrelated objects, reject empty patches and do not mutate inputs', () => {
  const project = smallProject(), snapshot = structuredClone(project);
  const plan = planCodeCommentUpdate(project, { expectedRevision: 1, commentId: 'comment_1', changes: { text: '  Exact new text  ', status: 'resolved' } });
  assert.equal(plan.unchanged, false); assert.equal(plan.comment.text, '  Exact new text  '); assert.equal(plan.comment.sourceId, 'anchor_1'); assert.equal(plan.comment.createdAt, project.comments[1]!.createdAt);
  assert.deepEqual(plan.comments!.filter(comment => comment.id !== 'comment_1'), project.comments.filter(comment => comment.id !== 'comment_1')); assert.deepEqual(project, snapshot);
  const same = planCodeCommentUpdate(project, { expectedRevision: 1, commentId: 'comment_1', changes: { text: project.comments[1]!.text, status: 'open' } });
  assert.equal(same.unchanged, true); assert.equal(same.comments, undefined);
  for (const changes of [{}, { text: '' }, { text: '  \n' }, { text: 'x'.repeat(10_001) }, { status: 'unknown' }, { sourceId: 'other' }]) assert.throws(() => planCodeCommentUpdate(project, { expectedRevision: 1, commentId: 'comment_1', changes: changes as Parameters<typeof planCodeCommentUpdate>[1]['changes'] }), isCode('VALIDATION'));
  assert.throws(() => planCodeCommentUpdate(project, { expectedRevision: 2, commentId: 'comment_1', changes: { status: 'resolved' } }), isCode('REVISION_CONFLICT'));
  assert.throws(() => planCodeCommentUpdate(project, { expectedRevision: 1, commentId: 'unknown', changes: { status: 'resolved' } }), isCode('NOT_FOUND'));
});

test('real narrow comment writes are atomic, no-op retries keep history and competing writers cannot lose comments or source', async () => workspace(async store => {
  const project = await store.importProject(smallProject()), connection = await protocol(store);
  try {
    const before = await readFile(join(store.dataDir, project.id + '.json'), 'utf8');
    const unchanged = await connection.call<{ projectId: string; revision: number; comment: CodeProject['comments'][number]; unchanged: boolean }>('design_code_update_comment', { projectId: project.id, expectedRevision: 1, commentId: 'comment_1', changes: { status: 'open' } });
    assert.equal(unchanged.unchanged, true); assert.equal(unchanged.revision, 1); assert.equal(await readFile(join(store.dataDir, project.id + '.json'), 'utf8'), before);
    const writes = await Promise.all([
      connection.raw('design_code_update_comment', { projectId: project.id, expectedRevision: 1, commentId: 'comment_1', changes: { text: 'First racing intention' } }),
      connection.raw('design_code_update_comment', { projectId: project.id, expectedRevision: 1, commentId: 'comment_2', changes: { status: 'resolved' } }),
    ]);
    assert.equal(writes.filter(result => !result.isError).length, 1); assert.equal(writes.filter(result => result.isError).length, 1);
    assert.equal((writes.find(result => result.isError)!.structuredContent as { error: { code: string } }).error.code, 'REVISION_CONFLICT');
    const winner = writes.find(result => !result.isError)!.structuredContent as { projectId: string; revision: number; comment: CodeProject['comments'][number]; unchanged: boolean };
    bounded(winner); assert.equal(winner.revision, 2); assert.equal(Object.hasOwn(winner, 'project'), false); assert.equal(Object.hasOwn(winner, 'comments'), false);
    const saved = await store.get(project.id); assert.equal(saved.comments.length, 3); assert.deepEqual(saved.files, project.files); assert.deepEqual(saved.pages, project.pages); assert.deepEqual(saved.designSystem, project.designSystem); assert.deepEqual(saved.viewports, project.viewports);
    for (const comment of saved.comments) { const previous = project.comments.find(item => item.id === comment.id)!; assert.equal(comment.file, previous.file); assert.equal(comment.sourceId, previous.sourceId); assert.equal(comment.createdAt, previous.createdAt); if (comment.id !== winner.comment.id) assert.deepEqual(comment, previous); }
    const retry = await connection.call<{ revision: number; unchanged: boolean }>('design_code_update_comment', { projectId: project.id, expectedRevision: 2, commentId: winner.comment.id, changes: { text: winner.comment.text, status: winner.comment.status } });
    assert.equal(retry.unchanged, true); assert.equal(retry.revision, 2); assert.equal((await store.history(project.id)).versions.length, 2);
    const oldRead = await connection.raw('design_code_read_metadata', { projectId: project.id, section: 'comments', expectedRevision: 1 }); assert.equal(oldRead.isError, true);
    const oldWrite = await connection.raw('design_code_update_comment', { projectId: project.id, expectedRevision: 1, commentId: 'comment_0', changes: { status: 'resolved' } }); assert.equal(oldWrite.isError, true);
    for (const changes of [{}, { text: ' ' }, { sourceId: 'forged' }]) assert.equal((await connection.raw('design_code_update_comment', { projectId: project.id, expectedRevision: 2, commentId: 'comment_0', changes })).isError, true);
    assert.deepEqual(await store.get(project.id), saved);
  } finally { await connection.close(); }
}));
