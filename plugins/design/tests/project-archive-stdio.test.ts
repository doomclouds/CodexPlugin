import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createCodeTemplate } from '../src/code-project.ts';
import { zipFiles } from '../src/zip.ts';

test('a large real stdio archive request returns complete source once and preserves the default-buffer client connection', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'design-archive-stdio-'));
  const client = new Client({ name: 'large-archive-transport-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/index.js', import.meta.url))], cwd: tmpdir(), env: { ...process.env, DESIGN_DATA_DIR: directory }, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
  try {
    await client.connect(transport);
    const source = createCodeTemplate('Large synthetic notes archive', 'html');
    for (let index = 0; index < 6; index++) source.files.push({ path: `notes/chapter-${index}.txt`, encoding: 'utf8', content: `${index}` + 'a'.repeat(1024 * 1024 - 1) });
    const archive = zipFiles([
      ...source.files.map(file => ({ name: `source/${file.path}`, data: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') })),
      { name: 'design-project.json', data: Buffer.from(JSON.stringify(source)) },
      { name: 'prototype.html', data: Buffer.from('<!doctype html><h1>Transport fixture only</h1>') },
    ]);
    const encoded = archive.toString('base64'); assert.ok(Buffer.byteLength(encoded) > 10 * 1024 * 1024);
    const response = await client.callTool({ name: 'design_code_import_project', arguments: { dataBase64: encoded, expectedSha256: createHash('sha256').update(archive).digest('hex') } }, undefined, { timeout: 45000 }) as CallToolResult;
    assert.notEqual(response.isError, true, JSON.stringify(response.content).slice(0, 2000) + errors);
    const responseBytes = Buffer.byteLength(JSON.stringify(response));
    assert.ok(responseBytes > 6 * 1024 * 1024, 'The complete large source remains in structuredContent.');
    assert.ok(responseBytes < 10 * 1024 * 1024, 'Duplicate source text must not exceed the default SDK read budget.');
    assert.ok(response.content.filter(block => block.type === 'text').every(block => block.text.length < 4096), 'Large source replies use bounded text alongside complete structuredContent.');
    const imported = (response.structuredContent as { project: typeof source }).project;
    assert.notEqual(imported.id, source.id); assert.equal(imported.revision, 1); assert.deepEqual(imported.files, source.files);
    const next = await client.callTool({ name: 'design_code_history', arguments: { projectId: imported.id } });
    const history = next.structuredContent as { revision: number; canUndo: boolean };
    assert.notEqual(next.isError, true); assert.equal(history.revision, 1); assert.equal(history.canUndo, false);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
