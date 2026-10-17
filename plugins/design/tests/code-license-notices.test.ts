import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse as parseHtml } from 'parse5';
import { browserExecutable } from '../src/browser.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';
import { exportCodeProject } from '../src/code-export.ts';
import { compileCodeProject } from '../src/code-preview.ts';
import { createCodeTemplate, type CodeProject } from '../src/code-project.ts';

const licensePath = 'components/design-system/source/assets/OFL.txt';
function fixture(text: string): CodeProject {
  const base = createCodeTemplate('License notice fixture', 'html');
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { ...base, files: [
    { path: 'index.html', encoding: 'utf8', content: '<!doctype html><html><head></head><body><h1>License fixture stable</h1></body></html>' },
    { path: licensePath, encoding: 'utf8', content: text },
    { path: 'docs/design-system-provenance.json', encoding: 'utf8', content: JSON.stringify({ schemaVersion: 1, licenses: [{ sourcePath: 'assets/OFL.txt', path: licensePath, sha256 }] }) },
  ] };
}
function declaredNotices(html: string): unknown {
  const tree = parseHtml(html) as any;
  const scripts: any[] = [];
  const walk = (node: any): void => { if (node.attrs?.some((attr: any) => attr.name === 'id' && attr.value === 'design-component-notices')) scripts.push(node); for (const child of node.childNodes ?? []) walk(child); };
  walk(tree); assert.equal(scripts.length, 1);
  assert.ok(scripts[0].attrs.some((attr: any) => attr.name === 'type' && attr.value === 'application/json'));
  return JSON.parse(scripts[0].childNodes.map((node: any) => node.value ?? '').join(''));
}

test('standalone HTML preserves declared license text exactly as inert JSON and refuses missing or changed declarations', async () => {
  const text = '\uFEFF原创许可测试 · 中文\r\n</script><script>throw new Error("notice executed")</script>\n<!-- <script>\n';
  const original = fixture(text);
  const compiled = await compileCodeProject(original, { instrument: false });
  assert.deepEqual(compiled.diagnostics, []);
  const exported = await exportCodeProject(original, 'html');
  const html = Buffer.from(exported.dataBase64, 'base64').toString('utf8');
  assert.deepEqual(declaredNotices(html), [{ sourcePath: 'assets/OFL.txt', path: licensePath, sha256: createHash('sha256').update(text).digest('hex'), text }]);
  assert.ok(!html.includes('</script><script>throw new Error("notice executed")'));
  const changed = structuredClone(original); changed.files.find(file => file.path === licensePath)!.content += 'changed';
  assert.ok((await compileCodeProject(changed)).diagnostics.some(item => item.level === 'error' && /license changed/.test(item.message)));
  await assert.rejects(exportCodeProject(changed, 'html'), /compilation errors/);
  const missing = structuredClone(original); missing.files = missing.files.filter(file => file.path !== licensePath);
  assert.ok((await compileCodeProject(missing)).diagnostics.some(item => item.level === 'error' && /license is missing/.test(item.message)));
  await assert.rejects(exportCodeProject(missing, 'zip'), /compilation errors/);
});

test('actual Chromium keeps license markup inert in a runnable standalone export', async (context) => {
  if (!await browserExecutable()) { context.skip('A local Chromium browser is unavailable; inert notice runtime behavior is unverified.'); return; }
  const exported = await exportCodeProject(fixture('</script><script>throw new Error("notice executed")</script>\n<!-- <script>'), 'html');
  const inspected = await inspectCodeHtml(Buffer.from(exported.dataBase64, 'base64').toString('utf8'), { width: 800, height: 600, waitFor: { selector: 'h1', text: 'License fixture stable' } });
  assert.deepEqual(inspected.errors, []); assert.equal(inspected.blockedRequests, 0);
  assert.ok(inspected.metrics.headings.includes('License fixture stable'));
});

test('the delivered React runtime includes the complete upstream React and React DOM license texts', async () => {
  const require = createRequire(import.meta.url);
  const vendor = await readFile(new URL('../runtime/react-vendor.js', import.meta.url), 'utf8');
  for (const name of ['react', 'react-dom']) {
    const license = await readFile(join(dirname(require.resolve(name + '/package.json')), 'LICENSE'), 'utf8');
    assert.ok(vendor.includes(license.trim()), `${name} full license is absent from the delivered browser runtime`);
  }
});
