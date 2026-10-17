import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodeProjectStore, codeFileHash, createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import type { CodeFile, CodeProject } from '../src/code-project.ts';
import { editCodeTokens, listCodeTokens } from '../src/code-tokens.ts';
import type { CssTokenDefinition, CssTokenEdit } from '../src/code-tokens.ts';

function project(files: Array<{ path: string; content: string }>): CodeProject {
  const base = createCodeTemplate('CSS source tokens', 'html');
  return validateCodeProject({ ...base, files: [{ path: 'index.html', content: '<main>Real source</main>', encoding: 'utf8' }, ...files.map(file => ({ ...file, encoding: 'utf8' }))], designSystem: { components: [], notes: '' } });
}
const edit = (definition: CssTokenDefinition, value: string): CssTokenEdit => ({ sourceId: definition.sourceId, file: definition.file, fileHash: definition.fileHash, value });
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof Error && 'code' in error && error.code === expected;
}

test('catalogue keeps scoped duplicate declarations and reports syntactic references across real source files', () => {
  const original = project([
    { path: 'brand.css', content: ':root{--ink:#111;--space:8px}.dark{--ink:#eee}@media (width > 600px){@supports (display:grid){.card{--space:16px;& .detail{--ink:#222}}}}' },
    { path: 'consumer.css', content: '.title{color:var(--ink,var(--fallback));gap:calc(var(--space) * 2);content:"var(--ink)";--alias:var(/* name */ --ink)}' },
    { path: 'settings.html', content: '<style>:root{--local:12px}.button{color:var(--ink)}</style><script>const fake="--script:1"</script><p style="--inline:1">Text</p><style type="text/less">:root{--less:2}</style>' },
    { path: 'view.tsx', content: 'export default ()=><div style={{"--dynamic":3}}>View</div>' },
  ]);
  const snapshot = JSON.stringify(original), result = listCodeTokens(original);
  assert.equal(result.sourceOnly, true); assert.equal(result.referenceResolution, 'syntactic-name');
  assert.deepEqual(result.definitions.map(item => item.name), ['--ink', '--space', '--ink', '--space', '--ink', '--alias', '--local']);
  const repeated = result.definitions.filter(item => item.name === '--ink');
  assert.equal(new Set(repeated.map(item => item.sourceId)).size, 3);
  assert.deepEqual(repeated.map(item => item.selector), [':root', '.dark', '.card → & .detail']);
  assert.deepEqual(repeated[2]!.atRules, ['@media (width > 600px)', '@supports (display:grid)']);
  assert.equal(repeated[0]!.references.length, 3, 'Quoted text is not a var() reference; declarations and HTML stylesheets are');
  assert.deepEqual(repeated[0]!.references.map(item => [item.file, item.property]), [['consumer.css', 'color'], ['consumer.css', '--alias'], ['settings.html', 'color']]);
  for (const definition of repeated) assert.deepEqual(definition.references, repeated[0]!.references, 'Name references cannot claim to resolve which cascade scope wins');
  for (const reference of repeated[0]!.references) {
    const source = original.files.find(file => file.path === reference.file)!.content;
    const prefix = source.split('\n').slice(0, reference.line - 1).join('\n');
    const offset = (reference.line === 1 ? 0 : prefix.length + 1) + reference.column - 1;
    assert.equal(source.slice(offset, offset + 5), '--ink');
  }
  assert.match(result.diagnostics[0]!.message, /text\/less/);
  assert.deepEqual(listCodeTokens(original, { file: 'brand.css' }).definitions[0]!.references, repeated[0]!.references, 'Filtering definitions must retain cross-file consumers');
  assert.equal(JSON.stringify(original), snapshot);
});

test('batched edits preserve BOM, CRLF, Unicode, comments, importance and every non-target byte', () => {
  const css = '\uFEFF/* 🎨 keep */\r\n:root {\r\n  --paper : /* before */ #fafafa /* after */ !IMPORTANT;\r\n  --gap: 8px; --untouched: "café";\r\n}\r\n';
  const html = '<!doctype html>\r\n<html><head><style data-note="🎨">\r\n:root { --local: 12px }\r\n</style></head><body><style>.card { --local: 24px; }</style><p>Keep</p></body></html>';
  const original = project([{ path: 'brand.css', content: css }, { path: 'settings.htm', content: html }]);
  const before = structuredClone(original), definitions = listCodeTokens(original).definitions;
  const paper = definitions.find(item => item.name === '--paper')!, gap = definitions.find(item => item.name === '--gap')!;
  const local = definitions.filter(item => item.name === '--local')[1]!;
  assert.equal(paper.line, 3); assert.equal(paper.column, 3); assert.equal(paper.important, true);
  assert.equal(css.slice(paper.start, paper.end), '--paper : /* before */ #fafafa /* after */ !IMPORTANT;');
  for (const definition of [paper, gap, local]) {
    assert.equal(definition.editable, true);
    assert.equal(original.files.find(file => file.path === definition.file)!.content.slice(definition.valueStart, definition.valueEnd), definition.value);
  }
  const plan = editCodeTokens(original, { expectedRevision: 1, edits: [edit(paper, '#123456'), edit(gap, 'calc(1rem + 2px)'), edit(local, '32px')] });
  assert.deepEqual(original, before, 'Planning must not mutate files, revision or metadata');
  assert.equal(plan.projectId, original.id); assert.equal(plan.baseRevision, 1);
  assert.equal(plan.files.find(file => file.path === 'brand.css')!.content, '\uFEFF/* 🎨 keep */\r\n:root {\r\n  --paper : /* before */ #123456 /* after */ !IMPORTANT;\r\n  --gap: calc(1rem + 2px); --untouched: "café";\r\n}\r\n');
  assert.equal(plan.files.find(file => file.path === 'settings.htm')!.content, '<!doctype html>\r\n<html><head><style data-note="🎨">\r\n:root { --local: 12px }\r\n</style></head><body><style>.card { --local: 32px; }</style><p>Keep</p></body></html>');
  for (const file of plan.files) assert.equal(file.expectedHash, codeFileHash(original.files.find(source => source.path === file.path)!));
});

test('comments inside nested functions and empty values stay visible but cannot be destructively replaced', () => {
  const original = project([{ path: 'tokens.css', content: ':root{--nested:calc(1px /* preserve */ + 2px);--middle:red /* preserve */ blue;--empty: /* keep */ ;--safe:/*leading*/red/*trailing*/;}' }]);
  const result = listCodeTokens(original), snapshot = JSON.stringify(original);
  assert.deepEqual(result.definitions.map(item => item.editable), [false, false, false, true]);
  assert.match(result.definitions[0]!.diagnostic!, /Comments inside/);
  assert.match(result.definitions[2]!.diagnostic!, /empty|comments-only/i);
  for (const definition of result.definitions.slice(0, 3)) assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(definition, '20px')] }), code('VALIDATION'));
  const plan = editCodeTokens(original, { expectedRevision: 1, edits: [edit(result.definitions[3]!, 'blue')] });
  assert.equal(plan.files[0]!.content, ':root{--nested:calc(1px /* preserve */ + 2px);--middle:red /* preserve */ blue;--empty: /* keep */ ;--safe:/*leading*/blue/*trailing*/;}');
  assert.equal(JSON.stringify(original), snapshot);
});

test('value validation rejects extra declarations, rules, importance, invalid tokens and HTML raw-text escapes', () => {
  const original = project([{ path: 'tokens.css', content: ':root{--color:red}' }, { path: 'page.html', content: '<style>:root{--color:blue}</style><main>Keep</main>' }]);
  const definitions = listCodeTokens(original).definitions, standalone = definitions[0]!, embedded = definitions[1]!;
  const bad = ['red; color: blue', 'red;', 'red;;', 'red}body{display:none}', 'red !important', 'red !/**/important', 'red !\\69mportant', 'var(--color', '"unterminated', 'url(unclosed', '', '  /**/ ', 'red\u0001'];
  for (const value of bad) assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(standalone, value)] }), code('VALIDATION'), value);
  for (const close of ['</style>', '</STYLE >', '</style\n>', '</style/>']) {
    assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(embedded, '"' + close + '"')] }), /closing style tag/);
  }
  for (const value of ['var(--other, rgb(1 2 3 / .5))', 'calc(2px + 1rem)', '"a;b!"', 'url("data:image/svg+xml;a;b")', '"</stylex>"', 'red\\;']) {
    assert.equal(editCodeTokens(original, { expectedRevision: 1, edits: [edit(embedded, value)] }).changes[0]!.after, value);
  }
  assert.equal(editCodeTokens(original, { expectedRevision: 1, edits: [edit(standalone, '"</style>"')] }).changes[0]!.after, '"</style>"', 'A standalone CSS file has no HTML raw-text boundary');
});

test('CAS and declaration identities reject stale, forged and duplicate edits without returning a partial plan', () => {
  const original = project([{ path: 'tokens.css', content: ':root{--color:red;--gap:8px}.dark{--color:blue}' }]);
  const definitions = listCodeTokens(original).definitions, first = definitions[0]!, snapshot = JSON.stringify(original);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 0, edits: [edit(first, 'green')] }), code('REVISION_CONFLICT'));
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [{ ...edit(first, 'green'), fileHash: '0'.repeat(64) }] }), code('REVISION_CONFLICT'));
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [{ ...edit(first, 'green'), sourceId: definitions[2]!.sourceId, file: 'index.html', fileHash: codeFileHash(original.files[0]!) }] }), code('REVISION_CONFLICT'));
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(first, 'green'), edit(first, 'yellow')] }), /Duplicate/);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(first, 'green'), edit(definitions[1]!, '8px;--injected:1')] }), code('VALIDATION'));
  const changed = structuredClone(original); changed.files[1]!.content += ' /* concurrent source save */';
  assert.throws(() => editCodeTokens(changed, { expectedRevision: 1, edits: [edit(first, 'green')] }), code('REVISION_CONFLICT'));
  assert.notEqual(listCodeTokens(changed).definitions[0]!.sourceId, first.sourceId);
  const metadata = structuredClone(original); metadata.revision = 2; metadata.designSystem.notes = 'New description only';
  assert.equal(listCodeTokens(metadata).definitions[0]!.sourceId, first.sourceId, 'Descriptive metadata does not invent a new source identity');
  assert.equal(editCodeTokens(metadata, { expectedRevision: 2, edits: [edit(first, 'green')] }).baseRevision, 2);
  assert.equal(JSON.stringify(original), snapshot);
});

test('pagination is deterministic and validates file filters without hiding cross-file diagnostics', () => {
  const css = ':root{' + Array.from({ length: 205 }, (_, index) => `--token-${index}:${index}px;`).join('') + '}';
  const original = project([{ path: 'tokens.css', content: css }, { path: 'broken.css', content: ':root{--oops:' }]);
  const first = listCodeTokens(original), last = listCodeTokens(original, { offset: 200, limit: 20 });
  assert.equal(first.total, 205); assert.equal(first.definitions.length, 100); assert.equal(first.nextOffset, 100);
  assert.equal(last.definitions.length, 5); assert.equal(last.nextOffset, null); assert.equal(last.definitions[0]!.name, '--token-200');
  assert.equal(listCodeTokens(original, { offset: 999 }).definitions.length, 0);
  assert.equal(listCodeTokens(original, { file: 'index.html' }).total, 0);
  assert.match(first.diagnostics[0]!.message, /CSS parse failed/);
  assert.equal(first.diagnostics[0]!.file, 'broken.css');
  for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 201 }, { file: '' }]) assert.throws(() => listCodeTokens(original, options), code('VALIDATION'));
  assert.throws(() => listCodeTokens(original, { file: 'missing.css' }), code('NOT_FOUND'));
});

test('HTML locations map to actual source spans and never treat scripts or non-CSS style types as token sources', () => {
  const html = '<!doctype html>\n<!-- 🎨 -->\n<template><style media="screen">\n:root{--inside:5px}\n</style></template>\n<style type="text/plain">--fake:1</style><script>"<style>--fake:2</style>"</script>\n<style>:root{--last:7px}';
  const original = project([{ path: 'page.html', content: html }]), result = listCodeTokens(original);
  assert.deepEqual(result.definitions.map(item => [item.name, item.value, item.line, item.column]), [['--inside', '5px', 4, 7], ['--last', '7px', 7, 14]]);
  for (const definition of result.definitions) assert.equal(html.slice(definition.valueStart, definition.valueEnd), definition.value);
  const plan = editCodeTokens(original, { expectedRevision: 1, edits: result.definitions.map(definition => edit(definition, '9px')) });
  assert.equal(plan.files[0]!.content, '<!doctype html>\n<!-- 🎨 -->\n<template><style media="screen">\n:root{--inside:9px}\n</style></template>\n<style type="text/plain">--fake:1</style><script>"<style>--fake:2</style>"</script>\n<style>:root{--last:9px}');
});

test('definition, reference and value truncation are explicit and oversized values cannot be edited from a partial read', () => {
  const css = ':root{--shared:red;--huge:' + 'x'.repeat(16_385) + ';' + Array.from({ length: 10_000 }, (_, index) => `--n${index}:${index};`).join('') + '}' + '.consumer{color:var(--shared);}'.repeat(205);
  const original = project([{ path: 'tokens.css', content: css }]), result = listCodeTokens(original, { limit: 200 });
  assert.equal(result.total, 10_000); assert.equal(result.truncated.definitions, true); assert.equal(result.truncated.references, true); assert.equal(result.truncated.content, true);
  const shared = result.definitions[0]!, huge = result.definitions[1]!;
  assert.equal(shared.references.length, 200); assert.equal(huge.value.length, 16_384); assert.equal(huge.editable, false);
  assert.match(huge.diagnostic!, /16 KiB/);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(huge, 'new')] }), code('VALIDATION'));
});

test('source scan and global reference budgets expose omissions instead of silently claiming full coverage', () => {
  const filler = '/*' + ' '.repeat(1_048_500) + '*/';
  const original = project(Array.from({ length: 9 }, (_, index) => ({ path: `large-${index}.css`, content: filler + `:root{--large-${index}:${index}}` })));
  const result = listCodeTokens(original);
  assert.equal(result.truncated.content, true); assert.equal(result.definitions.length, 8); assert.match(result.diagnostics[0]!.message, /8 MiB source budget/);
  const references = project([{ path: 'references.css', content: ':root{--a:1;--tail:1}' + 'a{c:var(--a)}'.repeat(50_000) + 'b{c:var(--tail)}' }]);
  const referenceResult = listCodeTokens(references, { limit: 2 });
  assert.equal(referenceResult.truncated.references, true); assert.equal(referenceResult.definitions[0]!.references.length, 200);
  assert.equal(referenceResult.definitions[1]!.references.length, 0, 'References after the global budget must be reported as truncated instead of partial coverage being called complete');
});

test('unchanged values produce no file changes and mixed batches only report actual edits', () => {
  const original = project([{ path: 'tokens.css', content: ':root{--color:red;--gap:8px}' }, { path: 'other.css', content: ':root{--width:20px}' }]);
  const [color, gap, width] = listCodeTokens(original).definitions;
  const unchanged = editCodeTokens(original, { expectedRevision: 1, edits: [edit(color!, 'red'), edit(width!, '20px')] });
  assert.deepEqual(unchanged.files, []); assert.deepEqual(unchanged.changes, []);
  const mixed = editCodeTokens(original, { expectedRevision: 1, edits: [edit(color!, 'red'), edit(gap!, '12px'), edit(width!, '20px')] });
  assert.deepEqual(mixed.files.map(file => file.path), ['tokens.css']);
  assert.deepEqual(mixed.changes.map(change => [change.name, change.before, change.after]), [['--gap', '8px', '12px']]);
  assert.equal(mixed.files[0]!.content, ':root{--color:red;--gap:12px}');
});

test('batch and value bounds accept the documented maxima and reject larger requests before persistence', () => {
  const original = project([{ path: 'tokens.css', content: ':root{' + Array.from({ length: 101 }, (_, index) => `--n${index}:0;`).join('') + '}' }]);
  const definitions = listCodeTokens(original, { limit: 200 }).definitions;
  assert.equal(editCodeTokens(original, { expectedRevision: 1, edits: definitions.slice(0, 100).map(definition => edit(definition, '1')) }).changes.length, 100);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: definitions.map(definition => edit(definition, '1')) }), /1 to 100/);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [] }), code('VALIDATION'));
  assert.equal(editCodeTokens(original, { expectedRevision: 1, edits: [edit(definitions[0]!, 'x'.repeat(16_384))] }).changes[0]!.after.length, 16_384);
  assert.throws(() => editCodeTokens(original, { expectedRevision: 1, edits: [edit(definitions[0]!, 'x'.repeat(16_385))] }), /16 KiB/);
});

test('a real store commits one token plan atomically and history restores exact source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-token-plan-'));
  try {
    const store = new CodeProjectStore({ dataDir: directory });
    const first = await store.importProject(project([{ path: 'brand.css', content: '\uFEFF:root{--color:red;--gap:8px}\r\n' }, { path: 'page.html', content: '<style>.card{--gap:12px}</style>' }]));
    const definitions = listCodeTokens(first).definitions, plan = editCodeTokens(first, { expectedRevision: 1, edits: [edit(definitions[0]!, 'blue'), edit(definitions[2]!, '16px')] });
    const saved = await store.update(first.id, plan.baseRevision, { files: plan.files });
    assert.equal(saved.revision, 2); assert.equal(saved.files.find(file => file.path === 'brand.css')!.content, '\uFEFF:root{--color:blue;--gap:8px}\r\n');
    assert.equal(saved.files.find(file => file.path === 'page.html')!.content, '<style>.card{--gap:16px}</style>');
    await assert.rejects(store.update(first.id, plan.baseRevision, { files: plan.files }), code('REVISION_CONFLICT'));
    assert.deepEqual(await store.get(first.id), saved);
    assert.equal((await store.history(first.id)).versions.length, 2, 'A stale retry cannot create another revision');
    const undone = await store.undo(first.id, 2); assert.deepEqual(undone.files, first.files);
    const redone = await store.redo(first.id, 3); assert.deepEqual(redone.files, saved.files);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsupported development formats are diagnosed without mutation or implicit token metadata migration', () => {
  const current = project([{ path: 'tokens.css', content: ':root{--color:red}' }]);
  const old = { ...current, schemaVersion: 2, designSystem: { ...current.designSystem, tokens: { color: 'blue' } } } as unknown as CodeProject;
  const snapshot = JSON.stringify(old);
  assert.throws(() => listCodeTokens(old), code('UNSUPPORTED_FORMAT'));
  assert.throws(() => editCodeTokens(old, { expectedRevision: 1, edits: [{ sourceId: 'fake', file: 'tokens.css', fileHash: codeFileHash(old.files[1] as CodeFile), value: 'green' }] }), code('UNSUPPORTED_FORMAT'));
  assert.equal(JSON.stringify(old), snapshot);
});
