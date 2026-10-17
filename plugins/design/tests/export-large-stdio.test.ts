import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CodeProjectStore, codeFileHash, createCodeTemplate } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import type { CodePreview } from '../src/code-preview.ts';
import type { ExportArtifact, InlineExportArtifact, SavedExportArtifact } from '../src/export-artifacts.ts';
import { createExportPngFixture } from './export-image-fixture.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('default SDK stdio carries a real reused PNG once per structured preview and saves a large export at its original revision', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-export-default-stdio-')), store = new CodeProjectStore({ dataDir: join(directory, 'code') });
  const image = createExportPngFixture(), encoded = image.toString('base64'), template = createCodeTemplate('Original large photo export', 'html');
  template.files = [{ path: 'index.html', encoding: 'utf8', content: '<!doctype html><html><body><h1>Original exact snapshot</h1><img src="photo.png" alt="Size fixture"><img src="photo.png" alt="A second crop of the same fixture"></body></html>' }, { path: 'photo.png', encoding: 'base64', content: encoded }];
  template.designSystem = { components: [], notes: 'The PNG is a local transport fixture, never an artistic reference.' };
  const project = await store.importProject(template), client = new Client({ name: 'default-buffer-large-export', version: '1' });
  // Deliberately omit maxBufferSize: production clients must not need a larger SDK buffer for these operations.
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', fileURLToPath(new URL('../src/index.ts', import.meta.url))], cwd: tmpdir(), env: { ...process.env, DESIGN_DATA_DIR: directory }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const errors: string[] = []; client.onerror = error => errors.push(String(error));
  const call = async <T>(name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }) as CallToolResult; assert.notEqual(result.isError, true, JSON.stringify(result.content).slice(0, 1000) + stderr); return { data: result.structuredContent as unknown as T, raw: result }; };
  try {
    await client.connect(transport);
    const loaded = await call<{ project: CodeProject }>('design_code_get', { projectId: project.id });
    assert.deepEqual(loaded.data.project.files, project.files); assert.ok(Buffer.byteLength(JSON.stringify(loaded.raw.structuredContent)) > 3 * 1024 * 1024);
    assert.ok(loaded.raw.content.every(item => item.type === 'text' && item.text.length < 2048));
    const preview = await call<CodePreview>('design_code_preview', { projectId: project.id });
    assert.deepEqual(preview.data.diagnostics.filter(item => item.level === 'error'), []);
    assert.equal(preview.data.html.split(encoded).length - 1, 2, 'Both real image references must remain complete in the structured HTML');
    const previewBytes = Buffer.byteLength(JSON.stringify(preview.raw)); assert.ok(previewBytes > 6 * 1024 * 1024); assert.ok(previewBytes < 10 * 1024 * 1024);
    assert.ok(preview.raw.content.every(item => item.type === 'text' && item.text.length < 2048));
    const exported = await call<ExportArtifact>('design_code_export', { projectId: project.id, expectedRevision: 1, format: 'html' });
    assert.equal(exported.data.delivery, 'artifact'); assert.ok(exported.data.bytes > 6 * 1024 * 1024); assert.equal(Object.hasOwn(exported.data, 'dataBase64'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(exported.raw)) < 4096); assert.ok(!JSON.stringify(exported.raw).includes(encoded.slice(0, 100)));
    const entry = project.files[0]!;
    await store.update(project.id, 1, { files: [{ path: entry.path, content: '<h1>Newer source must not replace this artifact</h1>', expectedHash: codeFileHash(entry) }] });
    const saved = await call<SavedExportArtifact>('design_code_save_export', { artifactId: exported.data.artifactId }), actual = await readFile(saved.data.path);
    assert.equal(saved.data.revision, 1); assert.equal(saved.data.projectId, project.id); assert.equal(saved.data.bytes, actual.length); assert.equal(actual.length, exported.data.bytes); assert.equal(hash(actual), exported.data.sha256);
    assert.ok(actual.toString().includes('Original exact snapshot')); assert.ok(!actual.toString().includes('Newer source')); assert.equal(actual.toString().split(encoded).length - 1, 2);
    assert.equal(Object.hasOwn(saved.data, 'dataBase64'), false);
    const history = await call<{ revision: number }>('design_code_history', { projectId: project.id }); assert.equal(history.data.revision, 2);
    const small = await store.create({ name: 'Small direct download', template: 'html' }), inline = await call<InlineExportArtifact>('design_code_export', { projectId: small.id, format: 'html' });
    assert.equal(inline.data.delivery, 'inline'); assert.equal(inline.data.bytes, Buffer.from(inline.data.dataBase64, 'base64').length); assert.equal(hash(Buffer.from(inline.data.dataBase64, 'base64')), inline.data.sha256);
    assert.deepEqual(JSON.parse((inline.raw.content[0] as { text: string }).text), inline.data, 'Small replies retain their complete text representation');
    assert.deepEqual(errors, []);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
