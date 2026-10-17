import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeProjectStore } from '../src/code-project.ts';
import { DESIGN_REFERENCE_IDS, DESIGN_REFERENCE_LIMITS } from '../src/design-references.ts';
import { DESIGN_REFERENCE_VERSION } from '../src/design-reference-format.ts';
import type { DesignReferenceContent, DesignReferenceMetadata } from '../src/design-references.ts';
import { createDesignServer } from '../src/server.ts';

const cases = DESIGN_REFERENCE_IDS;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
interface ReferenceReply { metadata: DesignReferenceMetadata; content: DesignReferenceContent }
async function protocol(run: (client: Client, store: CodeProjectStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'design-reference-tools-'));
  const store = new CodeProjectStore({ dataDir: directory }), instance = await createDesignServer({ codeStore: store, panelHtml: '<!doctype html><div>Reference tool protocol fixture</div>' });
  const client = new Client({ name: 'design-reference-protocol-test', version: '1' }), [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  try { await instance.server.connect(serverSide); await client.connect(clientSide); await run(client, store); }
  finally { await client.close(); await instance.dispose(); await rm(directory, { recursive: true, force: true }); }
}
function hasEncodedBytes(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasEncodedBytes);
  return Object.entries(value).some(([key, item]) => key === 'dataBase64' || key === 'data' || hasEncodedBytes(item));
}
function checked<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent as unknown as T;
}

for (const referenceId of cases) test(`real MCP reference ${referenceId} delivers attributable package text and each genuine PNG once`, async () => protocol(async client => {
  const result = await client.callTool({ name: 'design_get_reference', arguments: { referenceId } }), reply = checked<ReferenceReply>(result);
  assert.deepEqual(Object.keys(reply).sort(), ['content', 'metadata']);
  assert.equal(reply.metadata.version, DESIGN_REFERENCE_VERSION);
  assert.equal(reply.metadata.selectedId, referenceId); assert.equal(reply.metadata.requested, referenceId); assert.deepEqual(reply.metadata.views, ['desktop', 'mobile']);
  assert.equal(hasEncodedBytes(reply), false, 'Structured metadata and source excerpts cannot duplicate binary image payloads');
  const blocks = result.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  const first = blocks[0]!; assert.equal(first.type, 'text'); assert.deepEqual(JSON.parse(first.text!), reply, 'The first native text block carries the exact structured text once');
  const images = blocks.filter(block => block.type === 'image'); assert.equal(images.length, 2);
  assert.equal(blocks.filter(block => block.type === 'text' && block.text === first.text).length, 1);
  const prefix = `skills/design/assets/examples/${referenceId}/`, source = await readFile(join(packageRoot, prefix, 'index.html'), 'utf8');
  const readme = await readFile(join(packageRoot, prefix, 'README.md'));
  assert.equal(reply.content.readme, readme.toString('utf8'));
  const readmeAsset = reply.metadata.assets.find(asset => asset.kind === 'readme')!, sourceAsset = reply.metadata.assets.find(asset => asset.kind === 'source')!;
  assert.equal(readmeAsset.path, prefix + 'README.md'); assert.equal(readmeAsset.sha256, hash(readme)); assert.equal(readmeAsset.bytes, readme.length);
  assert.equal(sourceAsset.path, prefix + 'index.html'); assert.equal(sourceAsset.sha256, hash(source)); assert.equal(sourceAsset.bytes, Buffer.byteLength(source));
  assert.equal(reply.content.snippets.length, 3);
  for (const snippet of reply.content.snippets) {
    assert.equal(snippet.path, sourceAsset.path); assert.equal(snippet.partial, true); assert.equal(snippet.language, 'html');
    assert.equal(source.slice(snippet.start, snippet.end), snippet.text, 'Offsets must identify the exact published source range after transport');
    assert.equal(snippet.startLine, source.slice(0, snippet.start).split('\n').length); assert.equal(snippet.endLine, source.slice(0, snippet.end).split('\n').length); assert.equal(snippet.sha256, hash(snippet.text));
  }
  for (const [index, view] of ['desktop', 'mobile'].entries()) {
    const asset = reply.metadata.assets.find(asset => asset.kind === view)!; assert.equal(asset.path, prefix + view + '.png');
    const image = images[index]!, actual = await readFile(join(packageRoot, asset.path)), transported = Buffer.from(image.data!, 'base64');
    assert.equal(image.mimeType, 'image/png'); assert.deepEqual(transported, actual); assert.equal(image.data, actual.toString('base64')); assert.equal(hash(transported), asset.sha256); assert.equal(transported.length, asset.bytes);
    assert.deepEqual([...transported.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(transported.readUInt32BE(16), view === 'desktop' ? 1440 : 390); assert.equal(transported.readUInt32BE(20), view === 'desktop' ? 1000 : 844);
    assert.equal(blocks.filter(block => block.type === 'image' && block.data === image.data).length, 1, 'No image may also be copied into a second native block');
    assert.equal(JSON.stringify(reply).includes(image.data!.slice(0, 256)), false);
    const nativeIndex = blocks.indexOf(image), label = blocks[nativeIndex - 1]!;
    assert.equal(label.type, 'text'); assert.match(label.text!, /reference only/i); assert.ok(label.text!.includes(referenceId) && label.text!.includes(view)); assert.match(label.text!, /not the user's current work/i);
  }
  assert.match(reply.content.rules, /不是本次作品/); assert.match(reply.content.rules, /已有品牌/);
  assert.ok(reply.metadata.budget.textCharacters <= DESIGN_REFERENCE_LIMITS.textCharacters); assert.ok(reply.metadata.budget.imageBytes <= DESIGN_REFERENCE_LIMITS.totalImageBytes);
  assert.doesNotMatch(JSON.stringify(reply.metadata), /\/Users\/|\/tmp\/|https?:\/\//);
}));

test('real MCP reference views support text-only and individual requested images without expanding model filesystem permissions', async () => protocol(async client => {
  for (const views of [[], ['mobile'], ['desktop']] as const) {
    const result = await client.callTool({ name: 'design_get_reference', arguments: { referenceId: 'editorial-atlas', views: [...views] } }), reply = checked<ReferenceReply>(result);
    assert.deepEqual(reply.metadata.views, views); assert.equal(reply.metadata.assets.length, 2 + views.length);
    const blocks = result.content as Array<{ type: string; data?: string }>, images = blocks.filter(block => block.type === 'image'); assert.equal(images.length, views.length);
    assert.equal(hasEncodedBytes(reply), false); assert.ok(reply.content.readme.length > 0 && reply.content.snippets.length > 0);
    if (!views.length) { assert.equal(blocks.length, 1); assert.equal(reply.metadata.budget.imageBytes, 0); }
    else assert.equal(hash(Buffer.from(images[0]!.data!, 'base64')), hash(await readFile(join(packageRoot, `skills/design/assets/examples/editorial-atlas/${views[0]}.png`))));
  }
  const tools = await client.listTools(), reference = tools.tools.find(tool => tool.name === 'design_get_reference')!;
  assert.equal(reference.annotations?.readOnlyHint, true); assert.equal(reference.annotations?.openWorldHint, false);
  assert.deepEqual(reference.inputSchema.required, ['referenceId']);
  const properties = reference.inputSchema.properties as { referenceId: { enum: string[] } };
  assert.deepEqual(properties.referenceId.enum, cases);
  assert.equal(Object.hasOwn(properties, 'file'), false); assert.equal(Object.hasOwn(properties, 'packageRoot'), false);
}));

test('real MCP rejects unknown case IDs, unsupported view choices and duplicate views without fabricated reference images', async () => protocol(async client => {
  for (const args of [
    { referenceId: 'none' }, { referenceId: 'auto' }, { referenceId: '../private' }, { referenceId: 'unknown-case' },
    { referenceId: 'editorial-atlas', views: ['desktop', 'desktop'] }, { referenceId: 'editorial-atlas', views: ['mobile', 'mobile'] },
    { referenceId: 'operations-console', views: ['tablet'] }, { referenceId: 'operations-console', views: ['desktop', 'mobile', 'desktop'] },
  ]) {
    const result = await client.callTool({ name: 'design_get_reference', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal((result.content as Array<{ type: string }>).filter(block => block.type === 'image').length, 0);
    assert.equal(Object.hasOwn(result.structuredContent ?? {}, 'metadata'), false, 'An error cannot pretend to select a different available case');
  }
}));

test('guidance and capabilities advertise the small case catalogue and actual bounded model-reading tools', async () => protocol(async client => {
  const guidance = checked<{ examples: Array<{ id: string; title: string; task: string; relation: string }>; referenceTool: string; guidance: string }>(await client.callTool({ name: 'design_get_guidance', arguments: { brief: '创建完整中文研究报道，保留本次独有内容。' } }));
  assert.equal(guidance.referenceTool, 'design_get_reference'); assert.deepEqual(guidance.examples.map(item => item.id), cases);
  assert.ok(Buffer.byteLength(JSON.stringify(guidance.examples)) < 4000);
  for (const example of guidance.examples) { assert.deepEqual(Object.keys(example).sort(), ['id', 'relation', 'task', 'title']); assert.ok(example.title && example.task && example.relation); }
  assert.equal(hasEncodedBytes(guidance), false);
  const capabilities = checked<{ modelReads: { files: string; metadata: string; commentUpdate: string; structuredResponseBytes: number }; designReferences: { tool: string; catalog: unknown[]; limits: unknown; imagesAre: string } }>(await client.callTool({ name: 'design_get_capabilities', arguments: {} }));
  assert.deepEqual(capabilities.modelReads, { files: 'design_code_list_files', metadata: 'design_code_read_metadata', commentUpdate: 'design_code_update_comment', structuredResponseBytes: 65536 });
  assert.equal(capabilities.designReferences.tool, guidance.referenceTool); assert.deepEqual(capabilities.designReferences.catalog, guidance.examples); assert.deepEqual(capabilities.designReferences.limits, DESIGN_REFERENCE_LIMITS);
  assert.match(capabilities.designReferences.imagesAre, /never verified work/);
}));

test('code guidance honors explicit none/case choice, preserves the original brief and returns reference metadata without images', async () => protocol(async (client, store) => {
  const project = await store.create({ name: 'Original brief identity', template: 'html' }), filename = join(store.dataDir, project.id + '.json'), before = await readFile(filename);
  const brief = '为已有系统做一个 operations console；保留品牌和布局。\n用户原话：“对象先可检索，再确认恢复”，不能丢掉异常路径。\n原样保留示例字段 `queue: 14` 与这段换行。';
  const replies = [];
  for (const referenceId of ['none', 'editorial-atlas'] as const) {
    const result = await client.callTool({ name: 'design_code_guidance', arguments: { projectId: project.id, prompt: brief, referenceId } });
    const reply = checked<{ mode: string; prompt: string; context: { projectId: string; revision: number }; reference: DesignReferenceMetadata }>(result);
    assert.equal(reply.mode, 'host'); assert.ok(reply.prompt.includes(brief), 'The reference choice cannot replace or summarize the user brief');
    assert.equal(reply.context.projectId, project.id); assert.equal(reply.context.revision, 1); assert.equal(reply.reference.requested, referenceId);
    assert.equal(reply.reference.selectedId, referenceId === 'none' ? null : referenceId); assert.deepEqual(reply.reference.views, []);
    assert.equal(reply.reference.budget.imageBytes, 0); assert.equal(hasEncodedBytes(reply), false);
    assert.equal(Object.hasOwn(reply.reference, 'content'), false); assert.equal(Object.hasOwn(reply.reference, 'images'), false);
    assert.equal((result.content as Array<{ type: string }>).filter(block => block.type === 'image').length, 0);
    if (referenceId === 'none') { assert.deepEqual(reply.reference.assets, []); assert.match(reply.prompt, /本次不附固定案例/); }
    else { assert.equal(reply.reference.assets.length, 2); assert.match(reply.prompt, /design_get_reference/); }
    replies.push(reply);
  }
  assert.notEqual(replies[0]!.reference.digest, replies[1]!.reference.digest);
  assert.deepEqual(await readFile(filename), before, 'Read-only guidance cannot alter project source, metadata, revision or history');
}));
