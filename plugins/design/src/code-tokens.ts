import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import postcss from 'postcss';
import type { AtRule, Declaration, Node, Root, Rule } from 'postcss';
import valueParser from 'postcss-value-parser';
import { parse as parseHtml } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { codeFileHash } from './code-project.ts';
import type { CodeFile, CodeProject } from './code-project.ts';
import { CODE_PROJECT_FORMAT } from './code-project-format.ts';
import { UnsupportedCodeProjectFormatError } from './code-pages.ts';
import { DesignError } from './validation.ts';

export interface CssTokenReference { file: string; line: number; column: number; property: string; selector: string }
export interface CssTokenDiagnostic { file?: string; line?: number; column?: number; message: string }
export interface CssTokenDefinition {
  sourceId: string; file: string; fileHash: string; name: string; value: string; important: boolean;
  selector: string; atRules: string[]; line: number; column: number;
  start: number; end: number; valueStart: number; valueEnd: number;
  references: CssTokenReference[]; editable: boolean; diagnostic?: string;
}
export interface CssTokenCatalog {
  projectId: string; revision: number; definitions: CssTokenDefinition[]; total: number; offset: number; nextOffset: number | null;
  diagnostics: CssTokenDiagnostic[]; files: Array<{ path: string; sha256: string }>;
  sourceOnly: true; referenceResolution: 'syntactic-name';
  truncated: { definitions: boolean; references: boolean; content: boolean };
}
export interface CssTokenEdit { sourceId: string; file: string; fileHash: string; value: string }
export interface CssTokenEditPlan {
  projectId: string; baseRevision: number;
  files: Array<{ path: string; content: string; encoding: 'utf8'; expectedHash: string }>;
  changes: Array<{ sourceId: string; file: string; name: string; before: string; after: string; valueStart: number; valueEnd: number }>;
}
interface CssSegment { file: CodeFile; css: string; start: number; embedded: boolean }
interface InternalDefinition extends CssTokenDefinition { segment: CssSegment }
interface ScanResult {
  definitions: InternalDefinition[]; references: Map<string, CssTokenReference[]>; diagnostics: CssTokenDiagnostic[];
  files: Array<{ path: string; sha256: string }>; truncated: CssTokenCatalog['truncated'];
}
const limits = { cssBytes: 8 * 1024 * 1024, definitions: 10_000, references: 50_000, referencesPerDefinition: 200, value: 16_384, edits: 100 } as const;
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const lineIndexes = new WeakMap<CodeFile, { content: string; starts: number[] }>();
function position(file: CodeFile, offset: number): { line: number; column: number } {
  let index = lineIndexes.get(file);
  if (!index || index.content !== file.content) {
    const starts = [0], content = file.content;
    for (let cursor = 0; cursor < content.length; cursor++) {
      const char = content.charCodeAt(cursor);
      if (char === 13) { if (content.charCodeAt(cursor + 1) === 10) cursor++; starts.push(cursor + 1); }
      else if (char === 10) starts.push(cursor + 1);
    }
    index = { content, starts }; lineIndexes.set(file, index);
  }
  // Offsets are UTF-16 source indices, matching PostCSS and parse5. Index once per file.
  const atCrLf = file.content.charCodeAt(offset) === 10 && file.content.charCodeAt(offset - 1) === 13;
  const lookup = atCrLf ? offset + 1 : offset;
  let low = 0, high = index.starts.length;
  while (low + 1 < high) { const middle = (low + high) >>> 1; if (index.starts[middle]! <= lookup) low = middle; else high = middle; }
  return { line: low + 1, column: atCrLf ? 1 : offset - index.starts[low]! + 1 };
}
function scopes(declaration: Declaration): { selector: string; atRules: string[] } {
  const selectors: string[] = [], atRules: string[] = [];
  for (let parent: Node['parent'] = declaration.parent; parent; parent = parent.parent) {
    if (parent.type === 'rule') selectors.unshift((parent as Rule).selector);
    else if (parent.type === 'atrule') { const rule = parent as AtRule; atRules.unshift(`@${rule.name}${rule.params ? ` ${rule.params}` : ''}`); }
  }
  return { selector: selectors.join(' → ') || '(stylesheet)', atRules };
}
function rawValue(declaration: Declaration): string {
  return declaration.raws.value?.value === declaration.value ? declaration.raws.value.raw : declaration.value;
}
function declarationOffsets(declaration: Declaration, segment: CssSegment): { start: number; end: number; rawStart: number; raw: string } | undefined {
  const start = declaration.source?.start?.offset, end = declaration.source?.end?.offset;
  if (start === undefined || end === undefined) return undefined;
  const raw = rawValue(declaration), prefix = declaration.prop + declaration.raws.between;
  const rawStart = start + prefix.length;
  // Never infer an edit span from normalized CSS or an ambiguous serialization.
  if (segment.css.slice(start, rawStart) !== prefix || segment.css.slice(rawStart, rawStart + raw.length) !== raw) return undefined;
  const suffix = segment.css.slice(rawStart + raw.length, end);
  const expectedSuffix = (declaration.important ? declaration.raws.important ?? ' !important' : '');
  if (suffix !== expectedSuffix && suffix !== expectedSuffix + ';') return undefined;
  return { start: segment.start + start, end: segment.start + end, rawStart: segment.start + rawStart, raw };
}
function segments(file: CodeFile, diagnostics: CssTokenDiagnostic[]): CssSegment[] {
  if (file.encoding !== 'utf8') return [];
  const extension = extname(file.path).toLowerCase();
  if (extension === '.css') return [{ file, css: file.content, start: 0, embedded: false }];
  if (extension !== '.html' && extension !== '.htm') return [];
  const document = parseHtml(file.content, { sourceCodeLocationInfo: true });
  const stack: DefaultTreeAdapterMap['node'][] = [document], result: CssSegment[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node && node.tagName === 'style') {
      const location = node.sourceCodeLocation;
      // parse5 leaves endOffset at the opening tag when raw-text content reaches EOF.
      const start = location?.startTag?.endOffset, end = location?.endTag?.startOffset ?? file.content.length;
      const type = node.attrs.find(attribute => attribute.name === 'type')?.value.trim().toLowerCase();
      if (type && type !== 'text/css') { diagnostics.push({ file: file.path, ...(start === undefined ? {} : position(file, start)), message: `Skipped <style type="${type}">: only CSS stylesheets are supported.` }); }
      else if (start !== undefined && end !== undefined) result.push({ file, css: file.content.slice(start, end), start, embedded: true });
    }
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]!);
    if ('content' in node) stack.push(node.content);
  }
  return result.sort((a, b) => a.start - b.start);
}
function scan(project: CodeProject, fileFilter?: string): ScanResult {
  if (project.schemaVersion !== CODE_PROJECT_FORMAT) throw new UnsupportedCodeProjectFormatError(project.schemaVersion);
  const result: ScanResult = { definitions: [], references: new Map(), diagnostics: [], files: [], truncated: { definitions: false, references: false, content: false } };
  if (fileFilter !== undefined && !project.files.some(file => file.path === fileFilter)) throw new DesignError('NOT_FOUND', `Token source file not found: ${fileFilter}`);
  let bytes = 0, referenceCount = 0;
  // References remain project-wide even when the returned definitions are file-filtered.
  for (const file of project.files) {
    const extension = extname(file.path).toLowerCase();
    if (file.encoding !== 'utf8' || !['.css', '.html', '.htm'].includes(extension)) continue;
    const fileHash = codeFileHash(file);
    result.files.push({ path: file.path, sha256: fileHash });
    for (const original of segments(file, result.diagnostics)) {
      const byteLength = Buffer.byteLength(original.css, 'utf8');
      if (bytes + byteLength > limits.cssBytes) { result.truncated.content = true; result.diagnostics.push({ file: file.path, ...position(file, original.start), message: 'CSS scan exceeded the 8 MiB source budget; this stylesheet was not scanned.' }); continue; }
      bytes += byteLength;
      // PostCSS strips a leading BOM before assigning offsets. Account for it explicitly.
      const bom = original.css.charCodeAt(0) === 0xfeff ? 1 : 0;
      const segment = bom ? { ...original, css: original.css.slice(1), start: original.start + 1 } : original;
      let root: Root;
      try { root = postcss.parse(segment.css, { from: file.path }); }
      catch (error) {
        const issue = error as { reason?: string; line?: number; column?: number };
        let relativeOffset = 0;
        if (issue.line !== undefined) {
          let currentLine = 1;
          while (relativeOffset < segment.css.length && currentLine < issue.line) if (segment.css[relativeOffset++] === '\n') currentLine++;
          relativeOffset += Math.max(0, (issue.column ?? 1) - 1);
        }
        result.diagnostics.push({ file: file.path, ...position(file, segment.start + relativeOffset), message: `CSS parse failed: ${issue.reason ?? 'Invalid stylesheet'}` });
        continue;
      }
      root.walkDecls(declaration => {
        const offsets = declarationOffsets(declaration, segment), scope = scopes(declaration);
        const declarationPosition = position(file, segment.start + (declaration.source?.start?.offset ?? 0));
        if (offsets) {
          const parsed = valueParser(offsets.raw);
          parsed.walk(node => {
            if (node.type !== 'function' || node.value.toLowerCase() !== 'var') return;
            const beforeComma = [];
            for (const child of node.nodes) { if (child.type === 'div' && child.value === ',') break; if (child.type !== 'space' && child.type !== 'comment') beforeComma.push(child); }
            const nameNode = beforeComma.length === 1 && beforeComma[0]?.type === 'word' ? beforeComma[0] : undefined;
            if (!nameNode || !nameNode.value.startsWith('--') || nameNode.value.length <= 2 || node.unclosed) return;
            if (referenceCount >= limits.references) { result.truncated.references = true; return; }
            referenceCount++;
            const references = result.references.get(nameNode.value) ?? [];
            references.push({ file: file.path, ...position(file, offsets.rawStart + nameNode.sourceIndex), property: declaration.prop, selector: scope.selector });
            result.references.set(nameNode.value, references);
          });
        }
        if (!declaration.prop.startsWith('--') || declaration.prop.length <= 2 || fileFilter !== undefined && file.path !== fileFilter) return;
        if (result.definitions.length >= limits.definitions) { result.truncated.definitions = true; return; }
        const start = offsets?.start ?? segment.start + (declaration.source?.start?.offset ?? 0);
        const end = offsets?.end ?? start;
        let valueStart = offsets?.rawStart ?? start, valueEnd = valueStart;
        let value = offsets?.raw ?? declaration.value, diagnostic: string | undefined;
        if (!offsets) diagnostic = 'The original declaration cannot be mapped losslessly; edit its source directly.';
        else {
          const nodes = valueParser(offsets.raw).nodes;
          const meaningful = nodes.filter(node => node.type !== 'space' && node.type !== 'comment');
          if (!meaningful.length) diagnostic = 'An empty or comments-only value has no replaceable value span; edit its source directly.';
          else {
            const first = meaningful[0]!, last = meaningful[meaningful.length - 1]!;
            valueStart += first.sourceIndex; valueEnd = offsets.rawStart + last.sourceEndIndex;
            value = file.content.slice(valueStart, valueEnd);
            valueParser(offsets.raw).walk(node => { if (node.type === 'comment' && node.sourceIndex >= first.sourceIndex && node.sourceEndIndex <= last.sourceEndIndex) diagnostic = 'Comments inside this value must remain in their exact positions; edit its source directly.'; });
            valueParser(value).walk(node => { if ('unclosed' in node && node.unclosed) diagnostic = 'The value contains an unclosed CSS token; edit its source directly.'; });
          }
        }
        if (value.length > limits.value) { value = value.slice(0, limits.value); result.truncated.content = true; diagnostic = 'The value exceeds the 16 KiB inspection budget; edit its source directly.'; }
        const sourceId = 'css_' + digest([file.path, fileHash, start, end, declaration.prop].join('\0'));
        result.definitions.push({ sourceId, file: file.path, fileHash, name: declaration.prop, value, important: !!declaration.important, ...scope, ...declarationPosition, start, end, valueStart, valueEnd, references: [], editable: diagnostic === undefined, ...(diagnostic ? { diagnostic } : {}), segment });
      });
    }
  }
  return result;
}

export function listCodeTokens(project: CodeProject, options: { file?: string; offset?: number; limit?: number } = {}): CssTokenCatalog {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || options.file !== undefined && (typeof options.file !== 'string' || !options.file)) throw new DesignError('VALIDATION', 'Token pagination requires offset >= 0 and limit from 1 to 200.');
  const result = scan(project, options.file), selected = result.definitions.slice(offset, offset + limit);
  const definitions = selected.map(({ segment: _segment, ...definition }) => {
    const references = result.references.get(definition.name) ?? [];
    if (references.length > limits.referencesPerDefinition) result.truncated.references = true;
    return { ...definition, references: references.slice(0, limits.referencesPerDefinition) };
  });
  return { projectId: project.id, revision: project.revision, definitions, total: result.definitions.length, offset, nextOffset: offset + definitions.length < result.definitions.length ? offset + definitions.length : null, diagnostics: result.diagnostics, files: result.files, sourceOnly: true, referenceResolution: 'syntactic-name', truncated: result.truncated };
}
function validateNewValue(value: string, definition: InternalDefinition): void {
  if (typeof value !== 'string' || value.length > limits.value || /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(value)) throw new DesignError('VALIDATION', 'A token value must be CSS text of at most 16 KiB without control characters.');
  if (definition.segment.embedded && /<\/style(?=[\t\n\f\r />])/i.test(value)) throw new DesignError('VALIDATION', 'An HTML style token value cannot contain a closing style tag.');
  try {
    const parsed = postcss.parse(`x{${definition.name}:${value}}`), rule = parsed.nodes[0];
    if (parsed.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'x' || rule.nodes.length !== 1 || rule.raws.semicolon) throw new Error();
    const declaration = rule.nodes[0];
    if (declaration?.type !== 'decl' || declaration.prop !== definition.name || declaration.important) throw new Error();
    const valueNodes = valueParser(value);
    if (!valueNodes.nodes.some(node => node.type !== 'space' && node.type !== 'comment')) throw new Error();
    valueNodes.walk(node => { if ('unclosed' in node && node.unclosed) throw new Error(); });
    // A top-level ! cannot be part of a custom-property value. This also rejects escaped importance spellings.
    if (valueNodes.nodes.some(node => node.type === 'word' && node.value.includes('!'))) throw new Error();
  } catch { throw new DesignError('VALIDATION', 'A token edit must contain one balanced CSS value and cannot add declarations, rules or !important.'); }
}

export function editCodeTokens(project: CodeProject, input: { expectedRevision: number; edits: CssTokenEdit[] }): CssTokenEditPlan {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== project.revision) throw new DesignError('REVISION_CONFLICT', 'The project revision changed; read token definitions again.');
  if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > limits.edits) throw new DesignError('VALIDATION', 'Provide from 1 to 100 token edits.');
  const scanResult = scan(project), definitions = new Map(scanResult.definitions.map(definition => [definition.sourceId, definition]));
  const selected: Array<{ definition: InternalDefinition; value: string }> = [], seen = new Set<string>();
  for (const edit of input.edits) {
    if (!edit || typeof edit.sourceId !== 'string' || typeof edit.file !== 'string' || typeof edit.fileHash !== 'string') throw new DesignError('VALIDATION', 'Each token edit needs its exact source identity, file and hash.');
    if (seen.has(edit.sourceId)) throw new DesignError('VALIDATION', 'Duplicate token declarations cannot be edited in one batch.');
    seen.add(edit.sourceId);
    const file = project.files.find(file => file.path === edit.file);
    if (!file || file.encoding !== 'utf8') throw new DesignError('NOT_FOUND', `Token source file not found: ${edit.file}`);
    if (codeFileHash(file) !== edit.fileHash) throw new DesignError('REVISION_CONFLICT', `Token source changed: ${edit.file}`);
    const definition = definitions.get(edit.sourceId);
    if (!definition || definition.file !== edit.file || definition.fileHash !== edit.fileHash) throw new DesignError('REVISION_CONFLICT', 'The exact token declaration is no longer available; read token definitions again.');
    if (!definition.editable) throw new DesignError('VALIDATION', definition.diagnostic ?? 'This declaration cannot be edited losslessly.');
    validateNewValue(edit.value, definition);
    if (edit.value !== definition.value) selected.push({ definition, value: edit.value });
  }
  const byFile = new Map<string, Array<{ definition: InternalDefinition; value: string }>>();
  for (const edit of selected) { const edits = byFile.get(edit.definition.file) ?? []; edits.push(edit); byFile.set(edit.definition.file, edits); }
  const files: CssTokenEditPlan['files'] = [];
  for (const [path, edits] of byFile) {
    const original = project.files.find(file => file.path === path)!;
    edits.sort((a, b) => b.definition.valueStart - a.definition.valueStart);
    let content = original.content, previousStart = original.content.length + 1;
    for (const { definition, value } of edits) {
      if (definition.valueEnd > previousStart) throw new DesignError('VALIDATION', 'Token edit spans overlap.');
      previousStart = definition.valueStart;
      if (original.content.slice(definition.valueStart, definition.valueEnd) !== definition.value) throw new DesignError('REVISION_CONFLICT', 'The exact token value span changed.');
      content = content.slice(0, definition.valueStart) + value + content.slice(definition.valueEnd);
    }
    if (content !== original.content) files.push({ path, content, encoding: 'utf8', expectedHash: codeFileHash(original) });
  }
  // The caller commits this complete plan with the same revision and all file hashes in one store update.
  return { projectId: project.id, baseRevision: project.revision, files, changes: selected.map(({ definition, value }) => ({ sourceId: definition.sourceId, file: definition.file, name: definition.name, before: definition.value, after: value, valueStart: definition.valueStart, valueEnd: definition.valueEnd })) };
}
