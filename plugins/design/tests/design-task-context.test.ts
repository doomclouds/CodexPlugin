import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodeTemplate, CodeProjectStore, validateCodeProject, codeFileHash } from '../src/code-project.ts';
import { designTaskContext, designTaskPrompt } from '../src/design-task-context.ts';
import { getDesignGuidance } from '../src/art-direction.ts';
import { createDesignServer } from '../src/server.ts';

function largeProject() {
  const project = createCodeTemplate('Task metadata budget', 'html');
  project.files = Array.from({ length: 32 }, (_, index) => ({ path: 'p'.repeat(490) + index + '.html', encoding: 'utf8' as const, content: `<h1>Page ${index}</h1>` }));
  project.pages = project.files.map((file, index) => ({ id: `page_${index}`, name: 'N'.repeat(200), entry: file.path, route: '/' + 'r'.repeat(500) + index }));
  project.defaultPageId = 'page_0';
  project.comments = Array.from({ length: 2000 }, (_, index) => ({ id: `comment_${index}`, file: project.files[0]!.path, sourceId: 's'.repeat(500), text: 'C'.repeat(10_000), status: 'open' as const, createdAt: project.createdAt }));
  project.designSystem = { notes: 'Z'.repeat(100_000), components: Array.from({ length: 500 }, (_, index) => ({ name: `Component ${index}`, path: project.files[0]!.path, usage: 'U'.repeat(10_000) })) };
  return validateCodeProject(project);
}

test('maximum valid project metadata cannot displace or duplicate the complete user brief', () => {
  const project = largeProject(), brief = '设计需求\n' + '界'.repeat(9985) + 'UNIQUE-END';
  assert.equal(brief.length, 10_000);
  const context = designTaskContext(project, 'page_0', { selected: { sourceId: 'actual_selected_source', file: project.files[0]!.path, start: 0, end: 19, tag: 'h1', fileHash: codeFileHash(project.files[0]!), selectedRevision: project.revision, pageId: 'page_0', stale: false, text: 'T'.repeat(100_000), computedStyles: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`property-${index}`, 'v'.repeat(10_000)])) } });
  assert.ok(JSON.stringify(context).length < 12_000);
  assert.equal(context.pageCount, 32); assert.equal(context.omittedPageCount, 31);
  assert.equal(context.openCommentCount, 2000); assert.equal(context.omittedCommentCount, 2000 - context.comments.length);
  assert.equal(context.selected!.fileHash, codeFileHash(project.files[0]!)); assert.equal(context.selected!.textCharacters, 100_000); assert.equal(context.selected!.computedStylesArePartial, true);
  assert.equal(context.designSystem.componentCount, 500); assert.equal(context.designSystem.notesCharacters, 100_000);
  const prompt = designTaskPrompt(brief, context, getDesignGuidance({ brief }).guidance);
  assert.ok(prompt.length < 30_000, `Actual composed request length: ${prompt.length}`);
  assert.equal(prompt.split(brief).length - 1, 1); assert.ok(prompt.includes('UNIQUE-END'));
  assert.doesNotMatch(prompt, /Z{1000}|U{1000}|C{1000}|T{1000}/);
});

test('the real guidance tool accepts the original 10k brief and returns bounded identity for a large valid project', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'design-guidance-budget-'));
  const store = new CodeProjectStore({ dataDir: directory });
  const project = await store.importProject(largeProject());
  const instance = await createDesignServer({ codeStore: store, panelHtml: '<!doctype html><title>Protocol fixture</title>' });
  const client = new Client({ name: 'bounded-guidance-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport); await client.connect(clientTransport);
    const end = 'PRESERVE-END-10', brief = 'x'.repeat(10_000 - end.length) + end; assert.equal(brief.length, 10_000);
    const result = await client.callTool({ name: 'design_code_guidance', arguments: { projectId: project.id, pageId: 'page_0', prompt: brief } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content).slice(0, 500));
    const data = result.structuredContent as { prompt: string; context: ReturnType<typeof designTaskContext> };
    assert.equal(data.context.projectId, project.id); assert.equal(data.context.revision, 1); assert.equal(data.context.pageId, 'page_0');
    assert.equal(data.context.pageCount, 32); assert.equal(data.context.openCommentCount, 2000);
    assert.ok(JSON.stringify(data).length < 30_000); assert.ok(data.prompt.includes(brief)); assert.equal(data.prompt.split(brief).length - 1, 1);
  } finally { await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); }
});
