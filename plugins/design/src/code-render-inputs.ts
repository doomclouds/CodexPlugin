import type { CodeProject } from "./code-project.ts";

// Comments and design-reference metadata do not participate in compilation.
// Imported components and live CSS tokens affect rendering through actual files.
export function codeRenderInputs(project: CodeProject) {
  return { schemaVersion: project.schemaVersion, id: project.id, name: project.name, pages: project.pages, defaultPageId: project.defaultPageId, viewports: project.viewports, files: [...project.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function sameCodeRenderInputs(previous: CodeProject, next: CodeProject): boolean {
  if (previous.id !== next.id || previous.schemaVersion !== next.schemaVersion || previous.name !== next.name || previous.defaultPageId !== next.defaultPageId || previous.files.length !== next.files.length) return false;
  if (JSON.stringify(previous.pages) !== JSON.stringify(next.pages) || JSON.stringify(previous.viewports) !== JSON.stringify(next.viewports)) return false;
  const files = new Map(previous.files.map(file => [file.path, file]));
  return next.files.every(file => { const original = files.get(file.path); return original?.encoding === file.encoding && original.content === file.content; });
}

export interface CodeRevisionBinding {
  projectId: string; pageId: string; revision: number; desiredRevision: number; renderIdentity: string; fileHashes: Record<string, string>;
  syncing?: { from: number; to: number; nonce: string };
}
// Confirmation can advance an intermediate in-flight revision, but cannot authorize
// source events until the binding reaches the current project revision.
export function acceptsCodeRevisionAck(binding: CodeRevisionBinding, current: { projectId: string; pageId: string; revision: number; fileHashes: ReadonlyMap<string, string> }, data: Record<string, unknown>): boolean {
  const pending = binding.syncing;
  const sameHashes = (value: unknown): boolean => !!value && typeof value === "object" && Object.keys(value).length === current.fileHashes.size && [...current.fileHashes].every(([file, hash]) => (value as Record<string, unknown>)[file] === hash);
  return !!pending && binding.revision === pending.from && binding.desiredRevision === current.revision && pending.to <= current.revision
    && binding.projectId === current.projectId && data.projectId === current.projectId && binding.pageId === current.pageId && data.pageId === current.pageId
    && data.type === "design:revision-synced" && data.revision === pending.to && data.previousRevision === pending.from && data.nonce === pending.nonce
    && data.renderIdentity === binding.renderIdentity && sameHashes(binding.fileHashes) && sameHashes(data.fileHashes);
}
