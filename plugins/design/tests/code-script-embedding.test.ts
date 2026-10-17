import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { parse as parseHtml } from 'parse5';
import { createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { compileCodeProject } from '../src/code-preview.ts';
import { browserExecutable } from '../src/browser.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';

const pair = '<!--<script></script>';
function sourceProject(mode: 'plain' | 'name' | 'literal' | 'external' | 'inline' | 'defer'): CodeProject {
  const project = createCodeTemplate('Script parser boundary', 'html');
  project.designSystem.components = [];
  const name = mode === 'name' ? '<!--<script>' : 'Main';
  project.name = name; project.pages[0]!.name = name;
  const heading = mode === 'literal' ? '&lt;!--&lt;script&gt;&lt;/script&gt;' : 'Expected body';
  const code = 'var sourceValue="<!--<script></script>";window.sourceValue=sourceValue;';
  const script = mode === 'external' || mode === 'defer' ? `<script ${mode === 'defer' ? 'defer ' : ''}src="./classic.js"></script>` : mode === 'inline' ? `<script>${code}</script>` : '';
  project.files = [{ path: 'index.html', encoding: 'utf8', content: `<!doctype html><html><head></head><body><h1>${heading}</h1>${script}</body></html>` }, ...(mode === 'external' || mode === 'defer' ? [{ path: 'classic.js', encoding: 'utf8' as const, content: code }] : [])];
  return validateCodeProject(project);
}
function parsedDocument(html: string) {
  const scripts: string[] = [], headings: string[] = [];
  const visit = (node: any): void => {
    if (node.tagName === 'script' && !(node.attrs ?? []).some((attr: any) => attr.name === 'type' && attr.value === 'application/json')) scripts.push((node.childNodes ?? []).map((child: any) => child.value ?? '').join(''));
    if (node.tagName === 'h1') headings.push((node.childNodes ?? []).map((child: any) => child.value ?? '').join(''));
    for (const child of node.childNodes ?? []) visit(child);
  }; visit(parseHtml(html));
  return { scripts, headings };
}

test('HTML script escaped states cannot swallow the body for names, literal source text, or classic inputs', async () => {
  for (const mode of ['plain', 'name', 'literal', 'external', 'inline', 'defer'] as const) {
    const compiled = await compileCodeProject(sourceProject(mode), { instrument: false });
    assert.deepEqual(compiled.diagnostics.filter(item => item.level === 'error'), [], mode);
    const parsed = parsedDocument(compiled.html);
    assert.deepEqual(parsed.headings, [mode === 'literal' ? pair : 'Expected body'], mode);
    assert.ok(parsed.scripts.length >= 1, mode);
    for (const [index, code] of parsed.scripts.entries()) assert.doesNotThrow(() => new Script(code), `${mode}: script ${index} must remain complete JavaScript after the actual HTML parser.`);
  }
});

test('Chromium preserves classic globals, deferred order, comments, raw templates, regexes and operator semantics', { timeout: 45000 }, async context => {
  if (!await browserExecutable()) { context.skip('Chromium unavailable; exact script-value behavior is unverified.'); return; }
  const project = sourceProject('plain'); project.name = '<!--<script>'; project.pages[0]!.name = '<!--<script></script>';
  const rawTemplate = '`' + pair + String.fromCharCode(92) + 'u0041`';
  const head = String.raw`/*! Retained comment: <!--<script></script> */
var fixtureOrder = ['head'];
var fixture = { open: '<!--<script>', pair: '<!--<script></script>', closing: '</script>' };
fixture.raw = String.raw` + rawTemplate + String.raw`;
function captureTemplate(parts) { return { cooked: parts[0], raw: parts.raw[0] }; }
fixture.tagged = captureTemplate` + rawTemplate + String.raw`;
fixture.pattern = /<!--<script>/;
var unaryCounter = 2;
fixture.unary = 0 < !--unaryCounter;
var postfixCounter = 2;
fixture.postfix = postfixCounter-->0;
var fixtureClicks = 0;
function classicClick() { fixtureClicks++; document.getElementById('clicked').textContent = 'Clicked ' + fixtureClicks; }
`;
  const inline = 'fixtureOrder.push("inline");var inlinePair="<!--<script></script>";';
  const deferred = String.raw`
fixtureOrder.push('defer');
function ensure(value, message) { if (!value) throw Error(message); }
ensure(window.fixture && window.fixtureClicks === 0 && typeof window.classicClick === 'function', 'CLASSIC_GLOBALS_LOST');
ensure(fixture.open === '<!--<script>' && fixture.pair === '<!--<script></script>' && fixture.closing === '</script>', 'STRING_VALUE_CHANGED');
ensure(inlinePair === '<!--<script></script>', 'INLINE_VALUE_CHANGED');
var expectedRaw = '<!--<script></script>' + String.fromCharCode(92) + 'u0041';
ensure(fixture.raw === expectedRaw, 'STRING_RAW_VALUE_CHANGED');
ensure(fixture.tagged.cooked === '<!--<script></script>A' && fixture.tagged.raw === expectedRaw, 'TEMPLATE_COOKED_OR_RAW_CHANGED');
ensure(fixture.pattern.source === '<!--<script>' && fixture.pattern.test(fixture.open), 'REGEX_VALUE_CHANGED');
ensure(fixture.unary === false && unaryCounter === 1 && fixture.postfix === true && postfixCounter === 1, 'OPERATOR_SEMANTICS_CHANGED');
ensure(fixtureOrder.join(',') === 'head,inline,defer', 'DEFER_ORDER_CHANGED');
document.getElementById('action').click();
ensure(window.fixtureClicks === 1 && document.getElementById('clicked').textContent === 'Clicked 1', 'GLOBAL_CLICK_HANDLER_FAILED');
document.getElementById('proof').textContent = 'Classic script semantics verified';
`;
  project.files = [
    { path: 'index.html', encoding: 'utf8', content: `<!doctype html><html><head><script src="./head.js"></script><script defer src="./defer.js"></script></head><body><h1 id="literal">&lt;!--&lt;script&gt;&lt;/script&gt;</h1><p id="clicked">Not clicked</p><button id="action" onclick="classicClick()">Run global action</button><h2 id="proof">Waiting</h2><script>${inline}</script></body></html>` },
    { path: 'head.js', encoding: 'utf8', content: head },
    { path: 'defer.js', encoding: 'utf8', content: deferred },
  ];
  const compiled = await compileCodeProject(validateCodeProject(project), { instrument: false });
  assert.deepEqual(compiled.diagnostics.filter(item => item.level === 'error'), []);
  const parsed = parsedDocument(compiled.html); assert.deepEqual(parsed.headings, [pair]);
  for (const code of parsed.scripts) assert.doesNotThrow(() => new Script(code));
  const result = await inspectCodeHtml(compiled.html, { width: 800, height: 600, timeoutMs: 15000, waitFor: { selector: '#proof', text: 'Classic script semantics verified' } });
  assert.deepEqual(result.errors, []); assert.equal(result.blockedRequests, 0); assert.ok(result.metrics.headings.includes(pair)); assert.ok(result.metrics.headings.includes('Classic script semantics verified'));
});
