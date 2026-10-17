import type { CodePage, CodeProject } from "../src/code-project.ts";

export interface CommentSource { id: string; file: string; identity?: "stable" | "ephemeral" }
export interface CommentRegistryResult {
  projectId: string;
  revision: number;
  pageId: string;
  sources: CommentSource[];
  diagnostics: Array<{ level: string; message: string }>;
}
export interface CommentAnchorPage extends CodePage { identity?: "stable" | "ephemeral" }
export interface CommentAnchorState {
  status: "file" | "checking" | "live" | "missing" | "unknown";
  fileExists: boolean;
  pages: CommentAnchorPage[];
  pendingPageIds: string[];
  unknownPages: Array<{ id: string; name: string; reason: string }>;
  checkedPages: number;
  totalPages: number;
}
type PageRegistry = { status: "checking" | "ready" | "unknown"; sources: CommentSource[]; reason?: string };

// A compiler registry proves source reachability, never that a runtime instance is visible.
// Keep only source identities: the much larger compiled HTML has its own bounded UI cache.
export class CommentAnchorIndex {
  private projectId = "";
  private revision = -1;
  private pages: CodePage[] = [];
  private files = new Set<string>();
  private sourceFiles: CodeProject["files"] = [];
  private registries = new Map<string, PageRegistry>();

  reset(project: Pick<CodeProject, "id" | "revision" | "pages" | "files">, reuseUnchanged = false): void {
    const oldFiles = new Map(this.sourceFiles.map(file => [file.path, file]));
    const unchanged = reuseUnchanged && this.projectId === project.id && this.sourceFiles.length === project.files.length
      && project.files.every(file => { const old = oldFiles.get(file.path); return old?.encoding === file.encoding && old.content === file.content; })
      && this.pages.length === project.pages.length && project.pages.every(page => this.pages.some(old => old.id === page.id && old.entry === page.entry));
    const retained = unchanged ? new Map([...this.registries].filter(([, registry]) => registry.status === "ready")) : new Map<string, PageRegistry>();
    this.projectId = project.id; this.revision = project.revision;
    this.pages = project.pages.map(page => ({ ...page }));
    this.files = new Set(project.files.map(file => file.path));
    this.sourceFiles = project.files;
    this.registries = retained;
  }
  isCurrent(projectId: string, revision: number): boolean { return this.projectId === projectId && this.revision === revision; }
  pendingPageIds(): string[] { return this.pages.filter(page => !this.registries.has(page.id)).map(page => page.id); }
  retryUnknown(): void {
    for (const [pageId, registry] of this.registries) if (registry.status === "unknown") this.registries.delete(pageId);
  }
  begin(projectId: string, revision: number, pageId: string): boolean {
    if (!this.accepts(projectId, revision, pageId)) return false;
    this.registries.set(pageId, { status: "checking", sources: [] }); return true;
  }
  record(result: CommentRegistryResult): boolean {
    if (!this.accepts(result.projectId, result.revision, result.pageId)) return false;
    const errors = result.diagnostics.filter(diagnostic => diagnostic.level === "error");
    this.registries.set(result.pageId, errors.length
      ? { status: "unknown", sources: [], reason: errors.map(error => error.message).join("；").slice(0, 1000) }
      : { status: "ready", sources: result.sources });
    return true;
  }
  fail(projectId: string, revision: number, pageId: string, reason: string): boolean {
    if (!this.accepts(projectId, revision, pageId)) return false;
    this.registries.set(pageId, { status: "unknown", sources: [], reason: reason.slice(0, 1000) }); return true;
  }
  forget(projectId: string, revision: number, pageId: string): void { this.fail(projectId, revision, pageId, "此页源码注册表已按缓存预算释放，请按需重新核对。"); }
  resolve(comment: { file: string; sourceId?: string }): CommentAnchorState {
    const pages: CommentAnchorPage[] = [], pendingPageIds: string[] = [], unknownPages: CommentAnchorState["unknownPages"] = [];
    let checkedPages = 0;
    for (const page of this.pages) {
      const registry = this.registries.get(page.id);
      if (!registry || registry.status === "checking") { pendingPageIds.push(page.id); continue; }
      if (registry.status === "unknown") { unknownPages.push({ id: page.id, name: page.name, reason: registry.reason ?? "无法读取页面源码注册表。" }); continue; }
      checkedPages++;
      const source = registry.sources.find(source => source.file === comment.file && source.id === comment.sourceId);
      if (source) pages.push({ ...page, identity: source.identity });
    }
    const fileExists = this.files.has(comment.file);
    const status = !fileExists ? "missing" : !comment.sourceId ? "file" : pages.length ? "live" : pendingPageIds.length ? "checking" : unknownPages.length ? "unknown" : "missing";
    return { status, fileExists, pages, pendingPageIds, unknownPages, checkedPages, totalPages: this.pages.length };
  }
  private accepts(projectId: string, revision: number, pageId: string): boolean {
    return this.isCurrent(projectId, revision) && this.pages.some(page => page.id === pageId);
  }
}
