import { summarizeCodeFiles } from './code-project.ts';
import type { CodeFileSummary, CodeProject } from './code-project.ts';
import { DesignError } from './validation.ts';

export const CODE_METADATA_RESPONSE_BYTES = 65_536;
export type CodeMetadataSection = 'pages' | 'viewports' | 'components' | 'comments' | 'notes';
type ArraySection = Exclude<CodeMetadataSection, 'notes'>;
type MetadataItem = CodeProject['pages'][number] | CodeProject['viewports'][number] | CodeProject['designSystem']['components'][number] | CodeProject['comments'][number];
interface PagePosition { total: number; offset: number; returned: number; nextOffset: number | null }
export interface CodeModelSummary {
  schemaVersion: CodeProject['schemaVersion']; id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  defaultPageId: string; fileCount: number; pageCount: number; viewportCount: number; componentCount: number; commentCount: number; noteCharacters: number;
}
export interface CodeFilePage extends PagePosition { project: CodeModelSummary; revision: number; files: CodeFileSummary[] }
export interface CodeMetadataItemsPage extends PagePosition { projectId: string; revision: number; section: ArraySection; items: MetadataItem[] }
export interface CodeMetadataTextPage extends PagePosition { projectId: string; revision: number; section: 'notes'; unit: 'unicode-code-points'; text: string }
export type CodeMetadataPage = CodeMetadataItemsPage | CodeMetadataTextPage;
export interface ReadCodeMetadataOptions { section: CodeMetadataSection; offset?: number; limit?: number; key?: string; file?: string; expectedRevision?: number }

function revision(project: CodeProject, expected?: number): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) throw new DesignError('VALIDATION', 'expectedRevision must be a positive safe integer.');
  if (expected !== undefined && expected !== project.revision) throw new DesignError('REVISION_CONFLICT', 'The project revision changed. Read a fresh first page and keep its revision for subsequent pages.');
}
function pagination(offset: number, limit: number, total: number, maxLimit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new DesignError('VALIDATION', `Metadata offset must be a safe integer from 0 to ${total}; offset equal to total is the empty final page.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new DesignError('VALIDATION', `Metadata limit must be a safe integer from 1 to ${maxLimit}.`);
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function arrayPage<T, R>(source: T[], offset: number, limit: number, compose: (items: T[], position: PagePosition) => R): R {
  const items: T[] = [], total = source.length;
  let response = compose(items, { total, offset, returned: 0, nextOffset: offset < total ? offset : null });
  for (let index = offset; index < total && items.length < limit; index++) {
    const candidateItems = [...items, source[index]!];
    const candidate = compose(candidateItems, { total, offset, returned: candidateItems.length, nextOffset: index + 1 < total ? index + 1 : null });
    if (bytes(candidate) > CODE_METADATA_RESPONSE_BYTES) {
      if (!items.length) throw new DesignError('VALIDATION', 'A complete metadata item exceeds the 64 KiB structured-response budget and cannot be silently truncated.');
      break;
    }
    items.push(source[index]!); response = candidate;
  }
  return response;
}
export function summarizeCodeProjectForModel(project: CodeProject): CodeModelSummary {
  return { schemaVersion: project.schemaVersion, id: project.id, name: project.name, revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt, defaultPageId: project.defaultPageId, fileCount: project.files.length, pageCount: project.pages.length, viewportCount: project.viewports.length, componentCount: project.designSystem.components.length, commentCount: project.comments.length, noteCharacters: Array.from(project.designSystem.notes).length };
}

export function listCodeFilesPage(project: CodeProject, options: { offset?: number; limit?: number; expectedRevision?: number } = {}): CodeFilePage {
  revision(project, options.expectedRevision);
  const offset = options.offset ?? 0, limit = options.limit ?? 50;
  pagination(offset, limit, project.files.length, 100);
  const summary = summarizeCodeProjectForModel(project);
  return arrayPage(summarizeCodeFiles(project), offset, limit, (files, position) => ({ project: summary, revision: project.revision, ...position, files }));
}

export function readCodeMetadata(project: CodeProject, options: ReadCodeMetadataOptions): CodeMetadataPage {
  revision(project, options.expectedRevision);
  if (!['pages', 'viewports', 'components', 'comments', 'notes'].includes(options.section)) throw new DesignError('VALIDATION', 'Choose pages, viewports, components, comments or notes metadata.');
  if (options.key !== undefined && (typeof options.key !== 'string' || !options.key || options.key.length > 200)) throw new DesignError('VALIDATION', 'Metadata key must be a nonempty exact identifier or component name of at most 200 characters.');
  if (options.file !== undefined && (options.section !== 'comments' || typeof options.file !== 'string' || !options.file)) throw new DesignError('VALIDATION', 'The file filter is only supported for comments.');
  if (options.key !== undefined && (options.section === 'notes' || options.offset !== undefined || options.limit !== undefined)) throw new DesignError('VALIDATION', 'An exact metadata key cannot be combined with offset/limit or used for notes.');
  if (options.file !== undefined && !project.files.some(file => file.path === options.file)) throw new DesignError('NOT_FOUND', 'The requested comment source file does not exist in this project.');
  if (options.section === 'notes') {
    // Offsets count Unicode code points, never split a valid UTF-16 surrogate pair.
    const characters = Array.from(project.designSystem.notes), total = characters.length;
    const offset = options.offset ?? 0, limit = options.limit ?? 4_000;
    pagination(offset, limit, total, 8_000);
    const returned = Math.min(limit, total - offset), end = offset + returned;
    const page: CodeMetadataTextPage = { projectId: project.id, revision: project.revision, section: 'notes', unit: 'unicode-code-points', total, offset, returned, nextOffset: end < total ? end : null, text: characters.slice(offset, end).join('') };
    if (bytes(page) > CODE_METADATA_RESPONSE_BYTES) throw new DesignError('VALIDATION', 'The note page exceeds the 64 KiB structured-response budget. Request a smaller limit.');
    return page;
  }
  let source: MetadataItem[] = options.section === 'components' ? project.designSystem.components : project[options.section];
  if (options.file !== undefined) source = project.comments.filter(comment => comment.file === options.file);
  if (options.key !== undefined) {
    source = source.filter(item => ('name' in item && options.section === 'components' ? item.name : 'id' in item ? item.id : undefined) === options.key);
    if (!source.length) throw new DesignError('NOT_FOUND', 'No metadata item matches that exact key and filter.');
    if (source.length > 1) throw new DesignError('VALIDATION', 'This component name matches multiple entries. Read its containing metadata pages and disambiguate the source before editing.');
  }
  const offset = options.offset ?? 0, limit = options.limit ?? 10;
  pagination(offset, limit, source.length, 50);
  return arrayPage(source, offset, limit, (items, position) => ({ projectId: project.id, revision: project.revision, section: options.section as ArraySection, ...position, items: structuredClone(items) }));
}

export interface CommentPatch { text?: string; status?: 'open' | 'resolved' }
export interface CodeCommentUpdatePlan { comment: CodeProject['comments'][number]; comments?: CodeProject['comments']; unchanged: boolean }
export function planCodeCommentUpdate(project: CodeProject, input: { expectedRevision: number; commentId: string; changes: CommentPatch }): CodeCommentUpdatePlan {
  if (input.expectedRevision === undefined) throw new DesignError('VALIDATION', 'A comment update requires the exact expectedRevision.');
  revision(project, input.expectedRevision);
  const changes = input.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => key !== 'text' && key !== 'status')) throw new DesignError('VALIDATION', 'Provide at least one comment text or status change, without other fields.');
  if ('text' in changes && (typeof changes.text !== 'string' || !changes.text.trim() || changes.text.length > 10_000)) throw new DesignError('VALIDATION', 'Comment text must contain non-whitespace content and be at most 10000 characters.');
  if ('status' in changes && changes.status !== 'open' && changes.status !== 'resolved') throw new DesignError('VALIDATION', 'Comment status must be open or resolved.');
  const current = project.comments.find(comment => comment.id === input.commentId);
  if (!current) throw new DesignError('NOT_FOUND', 'Comment not found. Read its exact identity before updating.');
  const comment = { ...current, ...changes }, unchanged = comment.text === current.text && comment.status === current.status;
  return { comment, unchanged, ...(!unchanged ? { comments: project.comments.map(item => item.id === current.id ? comment : item) } : {}) };
}
