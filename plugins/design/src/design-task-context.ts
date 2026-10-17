import type { CodeProject } from './code-project.ts';
import { resolveCodePage } from './code-pages.ts';

export interface DesignTaskInspection {
  activeFile?: string;
  canvasMode?: string;
  viewportId?: string;
  selected?: {
    sourceId: string; file: string; start: number; end: number; tag: string; fileHash: string;
    selectedRevision: number; pageId: string; stale: boolean; text: string;
    computedStyles: Record<string, string>; runtimeLiteralText?: boolean; ancestorMapped?: boolean;
  };
}

/** Identity and bounded reading hints only; the complete project remains in tools. */
export function designTaskContext(project: CodeProject, pageId?: string, inspection: DesignTaskInspection = {}) {
  const page = resolveCodePage(project, pageId), open = project.comments.filter(comment => comment.status === 'open');
  const selected = inspection.selected;
  const related = open.filter(comment => comment.file === (selected?.file ?? page.entry));
  const candidates = (related.length ? related : open).slice(-4);
  const comments: Array<{ id: string; file: string; textPreview: string; textCharacters: number }> = [];
  const context = {
    projectId: project.id, revision: project.revision, name: project.name, defaultPageId: project.defaultPageId,
    pageId: page.id, page, pageCount: project.pages.length, fileCount: project.files.length,
    activeFile: inspection.activeFile ?? page.entry, canvasMode: inspection.canvasMode ?? 'single',
    viewport: project.viewports.find(viewport => viewport.id === inspection.viewportId),
    selected: selected ? {
      sourceId: selected.sourceId, file: selected.file, start: selected.start, end: selected.end,
      tag: selected.tag, fileHash: selected.fileHash, selectedRevision: selected.selectedRevision,
      pageId: selected.pageId, stale: selected.stale, textPreview: selected.text.slice(0, 800), textCharacters: selected.text.length,
      computedStyles: Object.fromEntries(Object.entries(selected.computedStyles).slice(0, 12).map(([key, value]) => [key.slice(0, 80), value.slice(0, 160)])),
      computedStylesArePartial: Object.keys(selected.computedStyles).length > 12 || Object.values(selected.computedStyles).some(value => value.length > 160),
      runtimeLiteralText: selected.runtimeLiteralText, ancestorMapped: selected.ancestorMapped,
    } : null,
    designSystem: { componentCount: project.designSystem.components.length, notesCharacters: project.designSystem.notes.length },
    openCommentCount: open.length, comments, commentScope: related.length ? 'selected-file' : 'recent-project',
    omittedPageCount: Math.max(0, project.pages.length - 1), omittedCommentCount: open.length,
    sourceOfTruth: 'Read current project metadata and exact source hashes with Design tools before applying changes. These are source reading hints, not the full project or computed cascade.',
  };
  for (const comment of candidates) {
    const hint = { id: comment.id, file: comment.file, textPreview: comment.text.slice(0, 240), textCharacters: comment.text.length };
    comments.push(hint);
    if (JSON.stringify(context).length > 12_000) { comments.pop(); break; }
  }
  context.omittedCommentCount = open.length - comments.length;
  return context;
}

export function designTaskPrompt(brief: string, context: ReturnType<typeof designTaskContext>, guidance?: string) {
  const introduction = guidance ?? `在 Design 项目 ${context.projectId}（修订 ${context.revision}）完成以下需求。先核对最新源码与 hash，保留无关修改，用真实预览和关键操作检验结果。\n\n完整设计需求：\n${brief}`;
  return `${introduction}\n\n本次操作上下文（只附当前页和有限源码线索；省略数已注明，所需完整内容按工具读取；旧选择先协调，不能直接覆盖新源码）：\n${JSON.stringify(context, null, 2)}`;
}
