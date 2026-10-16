import type { CodeFile, CodePage, CodeProject, CodeProjectUpdate } from "../src/code-project.ts";
import { injectCodePageRuntimeLocation, resolveCodePage, resolveCodePageViewport } from "../src/code-pages.ts";
import "./code-editor.css";

export interface CodeEditorBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(text: string, context?: unknown): Promise<{ sent: boolean; reason?: string }>;
  download?(file: { filename: string; mimeType: string; dataBase64?: string; text?: string }): Promise<{ saved: boolean; unsupported?: boolean; reason?: string }>;
  openLink?(url: string): Promise<{ opened: boolean; reason?: string }>;
}
interface ProjectSummary { id: string; name: string; revision: number; updatedAt: string }
interface UnsupportedProject { id: string; format?: number | string; reason: string }
interface FileSummary { path: string; sha256: string; encoding?: string; bytes?: number }
interface SourceElement { id: string; file: string; start: number; end: number; tag: string; editableText: boolean; fileHash?: string; identity?: "stable" | "ephemeral" }
interface Diagnostic { level: string; message: string; file?: string; line?: number }
interface Preview { projectId: string; revision: number; pageId: string; pages: CodePage[]; html: string; diagnostics: Diagnostic[]; sources: SourceElement[] }
interface Selection { source: SourceElement; revision: number; pageId: string; fileHash: string; text: string; styles: Record<string, string>; viewportId: string; runtimeLiteralText?: boolean; ancestorMapped?: boolean }
interface Draft { content: string; baseHash: string | null; dirty: boolean; conflict: boolean }
interface FrameRecord { projectId: string; pageId: string; viewportId: string; revision: number; iframe: HTMLIFrameElement; ready?: boolean }
interface PageLocation { projectId: string; revision: number; pageId: string; href: string; hash: string; search: string }
interface ModelSummary { id: string; displayName?: string; isDefault?: boolean }
interface VisualDirection { id: string; name: string; summary: string }
interface GenerationVerification { compiled: boolean; rendered: boolean; modelReviewed: boolean; viewports: number; pages?: string[] }
interface ProposalDraft { id: string; projectId: string; baseRevision: number; originJobId: string; status: "unverified"; requiresReview: true; stage: string; verification: GenerationVerification; createdAt: string; updatedAt: string; expiresAt: string; expired: boolean; resumable: boolean; captureCount: number; reviewPageIds: string[]; originStatus: string; lastError?: string }
interface DraftDetails { draft: ProposalDraft; files: FileSummary[]; captures: { pageId: string; viewportId: string; width: number; height: number; sha256: string }[] }
interface GenerationJob { id: string; projectId: string; baseRevision: number; status: "running" | "completed" | "failed" | "cancelled"; model?: string; changes?: CodeProjectUpdate; log: string[]; error?: string; verification: GenerationVerification; budgetMs?: number; reviewPageIds?: string[]; draft?: ProposalDraft }

const svgPaths: Record<string, string> = {
  plus: "M10 3v14M3 10h14", close: "M5 5l10 10M15 5L5 15", arrow: "M4 10h12M10 4l6 6-6 6", cursor: "M4 3l13 8-6 1-3 6z", play: "M6 3l11 7-11 7z", code: "M7 5l-5 5 5 5M13 5l5 5-5 5M12 2L8 18", file: "M4 2h8l4 4v12H4zM12 2v5h4", component: "M10 2l8 8-8 8-8-8zM6 6l8 8M14 6l-8 8", undo: "M7 4L3 8l4 4M3 8h9a5 5 0 010 10", redo: "M13 4l4 4-4 4M17 8H8a5 5 0 000 10", refresh: "M17 7a7 7 0 00-12-3L2 7M2 2v5h5M3 13a7 7 0 0012 3l3-3M18 18v-5h-5", download: "M10 2v11M6 9l4 4 4-4M3 14v4h14v-4", spark: "M10 2l2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5z", comment: "M3 3h14v11H9l-6 4z", check: "M3 10l5 5L17 5", fit: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4", minus: "M3 10h14", copy: "M7 7h10v11H7zM13 7V2H3v11h4", panelLeft: "M2 3h16v14H2zM7 3v14", panelRight: "M2 3h16v14H2zM13 3v14", desktop: "M2 3h16v11H2zM10 14v4M6 18h8", mobile: "M6 1h8v18H6zM9 16h2", image: "M3 3h14v14H3zM3 14l5-5 4 4 2-2 3 3M13 6h.01", save: "M3 2h12l3 3v13H3zM6 2v6h8V2M6 12h9v6", upload: "M10 14V3M6 7l4-4 4 4M3 13v5h14v-5", settings: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4", trash: "M3 5h14M8 2h4l1 3M5 5l1 13h8l1-13M8 8v7M12 8v7",
};
const icon = (key: string) => `<svg class="dc-icon" aria-hidden="true" viewBox="0 0 20 20"><path d="${svgPaths[key] ?? svgPaths.file}"/></svg>`;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const isProject = (value: unknown): value is CodeProject => !!value && typeof value === "object" && (value as CodeProject).schemaVersion === 2 && typeof (value as CodeProject).defaultPageId === "string" && Array.isArray((value as CodeProject).pages) && Array.isArray((value as CodeProject).files) && typeof (value as CodeProject).revision === "number";
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const styleFields: [string, string][] = [["color", "文字颜色"], ["background-color", "背景颜色"], ["font-size", "字号"], ["font-weight", "字重"], ["line-height", "行高"], ["letter-spacing", "字距"], ["border-radius", "圆角"], ["padding", "内边距"], ["margin", "外边距"], ["width", "宽度"], ["height", "高度"], ["gap", "间距"]];

export function mountCodeEditor(root: HTMLElement, bridge: CodeEditorBridge) {
  let project: CodeProject | undefined;
  let projects: ProjectSummary[] = [];
  let unsupportedProjects: UnsupportedProject[] = [];
  let hashes = new Map<string, string>();
  const drafts = new Map<string, Draft>();
  let preview: Preview | undefined;
  const previewCache = new Map<string, Preview>();
  let canvasSignature = "";
  let activePageId = "";
  let pendingLocation: PageLocation | undefined;
  let frames: FrameRecord[] = [];
  let selection: Selection | undefined;
  let selectionText = "";
  let selectionStyles: Record<string, string> = {};
  let activeFile = "";
  let leftTab = "files";
  let rightTab = "inspect";
  let view = "design";
  let mode: "select" | "preview" = "select";
  let viewportId = "all";
  let activeViewport = "";
  let leftOpen = false;
  let rightOpen = false;
  let modal = "";
  let exportPageId = "";
  let exportViewportId = "";
  let template: "html" | "react" = "react";
  let newName = "未命名原型";
  let newFilePath = "";
  let commentDraft = "";
  let aiPrompt = "";
  let aiMode: "host" | "codex" = "host";
  let aiModel = "";
  let aiDirection = "auto";
  let generationBudgetMs = 600000;
  let directions: VisualDirection[] = [];
  let models: ModelSummary[] = [];
  let modelsLoaded = false;
  let modelsLoading = false;
  let modelsError = "";
  let generationStarting = false;
  const jobs = new Map<string, GenerationJob>();
  const proposalDrafts = new Map<string, ProposalDraft[]>();
  const draftDetails = new Map<string, DraftDetails>();
  const draftsLoaded = new Set<string>();
  const draftsLoading = new Set<string>();
  const appliedJobs = new Set<string>();
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let aiStatus = "";
  let aiError = false;
  let fallbackPrompt = "";
  let status = "尚未连接宿主";
  let connected = false;
  let disposed = false;
  let saving = 0;
  let compiling = false;
  let loadSerial = 0;
  let previewSerial = 0;
  let scale = .6;
  let offset = { x: 45, y: 55 };
  let space = false;
  let queue: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toast: { text: string; error: boolean } | undefined;
  let pointerCleanup: (() => void) | undefined;

  function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  function notify(text: string, error = false) {
    if (disposed) return;
    toast = { text, error }; clearTimeout(toastTimer); renderToast();
    toastTimer = setTimeout(() => { toast = undefined; renderToast(); }, error ? 8500 : 4000);
  }
  function renderToast() {
    root.querySelector(".dc-toast")?.remove();
    if (!toast) return;
    const element = document.createElement("div"); element.className = `dc-toast${toast.error ? " error" : ""}`; element.textContent = toast.text; element.setAttribute("role", toast.error ? "alert" : "status"); root.querySelector(".dc-body")?.append(element);
  }
  function call(name: string, args: Record<string, unknown>) {
    if (!connected) return Promise.reject(new Error("尚未连接 MCP 宿主，请通过 Design 工具打开编辑器。"));
    return bridge.callTool(name, args);
  }
  function hasDirty() { return Array.from(drafts.values()).some(draft => draft.dirty); }
  function currentPage(): CodePage | undefined { return project ? resolveCodePage(project, activePageId || undefined) : undefined; }
  function selectedIsCurrent() { return !!selection && !!project && selection.pageId === activePageId && selection.revision === project.revision && selection.fileHash === hashes.get(selection.source.file); }
  function matchingViewports() { return project?.viewports.filter(viewport => !viewport.pageId || viewport.pageId === activePageId) ?? []; }
  function normalizeViewports() {
    if (!project) return;
    const choices = matchingViewports();
    if (viewportId !== "all" && !choices.some(viewport => viewport.id === viewportId)) viewportId = "all";
    if (!choices.some(viewport => viewport.id === activeViewport)) {
      try { activeViewport = resolveCodePageViewport(project, { pageId: activePageId }).viewport.id; }
      catch { activeViewport = ""; }
    }
  }
  function canEditSelectionText() { return !!selection?.source.editableText && selection.runtimeLiteralText !== false && selection.ancestorMapped !== true; }
  function fileAt(path: string) { return project?.files.find(file => file.path === path); }
  function activeSource() { return fileAt(activeFile); }
  function draftAt(path: string): Draft | undefined {
    if (!project) return;
    let draft = drafts.get(path);
    const file = fileAt(path);
    if (!draft && file?.encoding === "utf8") { draft = { content: file.content, baseHash: hashes.get(path) ?? null, dirty: false, conflict: false }; drafts.set(path, draft); }
    return draft;
  }
  function updateMetadata(result: Record<string, unknown>) {
    if (isProject(result.project) && project?.id === result.project.id && result.project.revision < project.revision) return;
    if (Array.isArray(result.files)) hashes = new Map((result.files as FileSummary[]).filter(file => typeof file.path === "string" && typeof file.sha256 === "string").map(file => [file.path, file.sha256]));
  }
  async function hydrate(result: Record<string, unknown>, allowSwitch = false): Promise<CodeProject | undefined> {
    if (!isProject(result.project)) throw new Error("工具没有返回有效代码项目。");
    const currentId = project?.id;
    const serial = loadSerial;
    if (disposed || !allowSwitch && currentId !== result.project.id) return;
    if (Array.isArray(result.files)) { updateMetadata(result); return result.project; }
    const full = await call("design_code_get", { projectId: result.project.id });
    if (!isProject(full.project)) throw new Error("读取代码项目失败。");
    if (disposed || serial !== loadSerial || project?.id !== currentId) return;
    updateMetadata(full); return full.project;
  }
  function accept(next: CodeProject, fit = false, force = false) {
    if (disposed) return;
    const changed = project?.id !== next.id;
    if (!changed && project && next.revision < project.revision) return;
    if (!changed && project && next.revision === project.revision && !force) return;
    const revisionChanged = changed || next.revision !== project?.revision;
    if (changed) {
      drafts.clear(); selection = undefined; activePageId = next.defaultPageId; activeFile = resolveCodePage(next).entry; viewportId = "all"; activeViewport = "";
      aiStatus = ""; aiError = false; fallbackPrompt = "";
    }
    if (revisionChanged || force) { previewCache.clear(); preview = undefined; canvasSignature = ""; pendingLocation = undefined; }
    project = next;
    if (!next.pages.some(page => page.id === activePageId)) { activePageId = next.defaultPageId; selection = undefined; }
    for (const [path, draft] of drafts) {
      const file = next.files.find(file => file.path === path);
      const currentHash = hashes.get(path) ?? null;
      if (!draft.dirty) {
        if (file?.encoding === "utf8") { draft.content = file.content; draft.baseHash = currentHash; draft.conflict = false; }
        else drafts.delete(path);
      } else draft.conflict = currentHash !== draft.baseHash;
    }
    if (!next.files.some(file => file.path === activeFile)) activeFile = currentPage()!.entry;
    normalizeViewports();
    projects = [{ id: next.id, name: next.name, revision: next.revision, updatedAt: next.updatedAt }, ...projects.filter(item => item.id !== next.id)];
    status = "已保存";
    render();
    void refreshPreview(fit || changed);
    scheduleGenerationPoll();
  }
  async function loadProject(projectId: string, force = false) {
    if (project?.id !== projectId && hasDirty()) { notify("请先保存或重新载入源码草稿，再切换项目。", true); renderHeader(); return; }
    const serial = ++loadSerial;
    try {
      const result = await call("design_code_get", { projectId });
      if (serial !== loadSerial || disposed) return;
      if (!isProject(result.project)) throw new Error("项目文档不可用。");
      updateMetadata(result); accept(result.project, project?.id !== projectId, force);
    } catch (error) { notify(message(error), true); }
  }
  async function listProjects() {
    const result = await call("design_code_list", {});
    projects = Array.isArray(result.projects) ? result.projects as ProjectSummary[] : [];
    unsupportedProjects = Array.isArray(result.unsupported) ? result.unsupported as UnsupportedProject[] : [];
    if (!project && projects[0]) await loadProject(projects[0].id); else { renderHeader(); renderProjectNotice(); }
  }
  async function refreshPreview(fit = false) {
    if (!project || disposed) return;
    const projectId = project.id;
    const pageId = activePageId;
    const serial = ++previewSerial;
    const cacheKey = `${projectId}:${project.revision}:${pageId}`;
    const cached = previewCache.get(cacheKey);
    if (cached) { preview = cached; compiling = false; renderCanvas(); renderInspector(); renderStatus(); if (fit) requestAnimationFrame(() => fitCanvas()); return; }
    compiling = true; renderStatus();
    try {
      const result = await call("design_code_preview", { projectId, pageId });
      if (serial !== previewSerial || project?.id !== projectId || activePageId !== pageId || disposed) return;
      if (typeof result.html !== "string" || typeof result.revision !== "number" || result.pageId !== pageId) throw new Error("预览编译器没有返回所选页面的可运行内容。");
      if (result.revision !== project.revision) {
        const current = await call("design_code_get", { projectId });
        if (serial !== previewSerial || !isProject(current.project)) return;
        updateMetadata(current); accept(current.project, fit); return;
      }
      preview = { projectId, revision: result.revision, pageId, pages: Array.isArray(result.pages) ? result.pages as CodePage[] : project.pages, html: result.html, diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics as Diagnostic[] : [], sources: Array.isArray(result.sources) ? result.sources as SourceElement[] : [] };
      previewCache.set(cacheKey, preview);
      if (previewCache.size > 3) previewCache.delete(previewCache.keys().next().value!);
      canvasSignature = "";
      if (selection && !preview.sources.some(source => source.id === selection!.source.id && source.file === selection!.source.file)) selection = undefined;
      renderCanvas(); renderInspector();
      if (fit) requestAnimationFrame(() => fitCanvas());
    } catch (error) {
      if (serial === previewSerial) { preview = undefined; renderCanvas(); notify(`预览失败：${message(error)}`, true); }
    } finally { if (serial === previewSerial) { compiling = false; renderStatus(); } }
  }
  async function selectPage(pageId: string, location?: PageLocation) {
    if (!project || !project.pages.some(page => page.id === pageId)) { notify("目标页面不存在，请读取当前项目页面。", true); return; }
    if (pageId === activePageId) {
      if (location) { pendingLocation = location; for (const frame of frames) sendLocation(frame); }
      return;
    }
    activePageId = pageId; activeFile = currentPage()!.entry; selection = undefined; normalizeViewports(); pendingLocation = location; preview = undefined; canvasSignature = "";
    renderCanvas(); renderFilePanel(); renderInspector(); renderProjectNotice();
    await refreshPreview(true);
  }
  function sendLocation(frame: FrameRecord) {
    if (pendingLocation && frame.projectId === pendingLocation.projectId && frame.revision === pendingLocation.revision && frame.pageId === pendingLocation.pageId) frame.iframe.contentWindow?.postMessage({ type: "design:location", ...pendingLocation }, "*");
  }
  function focusSource(sourceId: string) {
    for (const frame of frames) {
      const focus = () => { if (!disposed && project?.id === frame.projectId && project.revision === frame.revision && activePageId === frame.pageId) frame.iframe.contentWindow?.postMessage({ type: "design:focus", projectId: frame.projectId, revision: frame.revision, pageId: frame.pageId, sourceId }, "*"); };
      if (frame.ready) focus(); else frame.iframe.addEventListener("load", focus, { once: true });
    }
  }
  async function focusComment(commentId: string) {
    if (!project) return;
    const projectId = project.id;
    const comment = project.comments.find(item => item.id === commentId); if (!comment) return;
    const page = project.pages.find(item => item.entry === comment.file);
    const cachedPage = Array.from(previewCache.values()).find(item => item.projectId === projectId && item.revision === project!.revision && item.sources.some(source => source.id === comment.sourceId && source.file === comment.file));
    const targetPageId = page?.id ?? cachedPage?.pageId ?? activePageId;
    if (targetPageId !== activePageId) await selectPage(targetPageId);
    if (!project || project.id !== projectId) return;
    const source = preview?.sources.find(item => item.id === comment.sourceId && item.file === comment.file);
    if (source) {
      setMode("select"); view = "design"; renderCanvas();
      selectSource(source, "", {}, activeViewport, { runtimeLiteralText: false }); focusSource(source.id);
      notify("已定位评论对应的源码对象。点击元素可读取当前文字和样式。");
    } else { openSource(comment.file); notify(comment.sourceId ? "此页未定位到原锚点，已打开源文件。请核对标记是否仍存在或对象是否用于其他页面。" : "已打开评论对应的源文件。"); }
  }
  function update(changes: CodeProjectUpdate | ((current: CodeProject) => CodeProjectUpdate), success?: string) {
    const projectId = project?.id;
    queue = queue.then(async () => {
      if (!project || project.id !== projectId) return;
      const next = typeof changes === "function" ? changes(project) : changes;
      saving++; status = "正在保存…"; renderStatus();
      try {
        const result = await call("design_code_update", { projectId, expectedRevision: project.revision, changes: next });
        if (project?.id !== projectId) { notify("原项目的修改已保存，当前项目视图保持不变。"); return; }
        const nextProject = await hydrate(result);
        if (nextProject) { accept(nextProject); if (success) notify(success); }
      } catch (error) {
        status = "保存失败";
        notify(/hash|revision|conflict|版本|冲突/i.test(message(error)) ? `源码冲突：${message(error)}。草稿已保留，请刷新并核对文件后继续。` : message(error), true);
      } finally { saving--; renderStatus(); }
    });
    return queue;
  }
  async function saveSource() {
    if (!project || !activeFile) return;
    const projectId = project.id;
    const path = activeFile;
    const draft = draftAt(path);
    if (!draft?.dirty) return;
    if (draft.conflict) { notify("此文件已有新版本。请复制草稿后协调，或重新载入文件。", true); return; }
    const content = draft.content;
    const baseHash = draft.baseHash;
    await update({ files: [{ path, content, encoding: "utf8", expectedHash: baseHash }] });
    if (project?.id !== projectId) return;
    const saved = fileAt(path);
    if (saved?.encoding === "utf8" && saved.content === content) {
      const existing = drafts.get(path);
      if (existing) { existing.dirty = existing.content !== content; existing.conflict = false; existing.baseHash = hashes.get(path) ?? null; }
      renderFilePanel(); renderSource(); notify(existing?.dirty ? "本次源码已保存，继续输入的内容仍作为草稿保留" : "源码已保存，原型预览已更新");
    }
  }
  function resetSource() {
    const file = activeSource();
    if (!file || file.encoding !== "utf8") return;
    drafts.set(file.path, { content: file.content, baseHash: hashes.get(file.path) ?? null, dirty: false, conflict: false }); renderSource(); renderFilePanel();
  }
  async function editSelection() {
    if (!project || !selection) return;
    if (!selectedIsCurrent()) { notify("选择来自旧修订。请在最新预览中重新选择元素。", true); return; }
    if (hasDirty()) { notify("请先保存源码草稿，再应用元素属性。", true); return; }
    const selected = selection;
    const styles: Record<string, string> = {};
    for (const [key, value] of Object.entries(selectionStyles)) if (value !== selected.styles[key]) styles[key] = value;
    const text = selectionText !== selected.text && canEditSelectionText() ? selectionText : undefined;
    if (text === undefined && !Object.keys(styles).length) { notify("尚未修改元素属性。"); return; }
    saving++; status = "正在修改源码…"; renderStatus();
    try {
      const result = await call("design_code_edit_element", { projectId: project.id, expectedRevision: project.revision, sourceId: selected.source.id, fileHash: selected.fileHash, ...(text !== undefined ? { text } : {}), ...(Object.keys(styles).length ? { styles } : {}) });
      const next = await hydrate(result); if (next) { selection = undefined; accept(next); notify("元素修改已写回源码"); }
    } catch (error) { notify(`元素修改未应用：${message(error)}`, true); }
    finally { saving--; renderStatus(); }
  }
  function selectSource(source: SourceElement, text: string, styles: Record<string, string>, selectedViewport = activeViewport, runtime: { runtimeLiteralText?: boolean; ancestorMapped?: boolean } = {}) {
    if (!project || !preview || preview.revision !== project.revision || preview.pageId !== activePageId) return;
    const hash = hashes.get(source.file);
    if (!hash) { notify("找不到该源文件的摘要，请刷新项目。", true); return; }
    selection = { source, text, styles, pageId: activePageId, viewportId: selectedViewport, fileHash: hash, revision: project.revision, ...runtime };
    selectionText = text; selectionStyles = { ...styles }; activeViewport = selectedViewport; rightTab = "inspect"; rightOpen = true; renderInspector(); renderHeader();
    root.querySelector(".dc-body")?.classList.toggle("show-right", rightOpen);
    root.querySelectorAll<HTMLElement>(".dc-frame").forEach(element => element.classList.toggle("active", element.dataset.viewportId === activeViewport));
  }
  function onMessage(event: MessageEvent) {
    if (!project || !preview || !event.data || typeof event.data !== "object") return;
    const frame = frames.find(item => event.source === item.iframe.contentWindow);
    if (!frame) return;
    const data = event.data as Record<string, unknown>;
    if (frame.projectId !== project.id || data.projectId !== project.id || data.revision !== frame.revision || frame.revision !== project.revision || data.pageId !== frame.pageId || frame.pageId !== activePageId) return;
    if (data.type === "design:navigate") {
      if (typeof data.targetPageId !== "string" || !project.pages.some(page => page.id === data.targetPageId)) { notify("原型导航目标未在项目中声明。", true); return; }
      const location: PageLocation = { projectId: project.id, revision: project.revision, pageId: data.targetPageId, href: typeof data.href === "string" ? data.href.slice(0, 2048) : "", hash: typeof data.hash === "string" ? data.hash.slice(0, 1000) : "", search: typeof data.search === "string" ? data.search.slice(0, 1000) : "" };
      void selectPage(data.targetPageId, location); return;
    }
    if (data.type === "design:ready") { frame.ready = true; sendLocation(frame); return; }
    if (data.type === "design:runtime-error" && data.projectId === project.id && data.revision === frame.revision && data.revision === project.revision && typeof data.message === "string") {
      const diagnostic: Diagnostic = { level: "error", message: data.message.slice(0, 1000), ...(typeof data.line === "number" ? { line: data.line } : {}) };
      if (!preview.diagnostics.some(item => item.message === diagnostic.message)) preview.diagnostics = [...preview.diagnostics.slice(-5), diagnostic];
      let banner = root.querySelector<HTMLElement>(".dc-diagnostic-bar");
      if (!banner) { banner = document.createElement("div"); banner.className = "dc-diagnostic-bar error"; banner.setAttribute("role", "alert"); root.querySelector(".dc-canvas")?.append(banner); }
      banner.innerHTML = preview.diagnostics.map(item => `<p>${escape(item.message)}</p>`).join("");
      return;
    }
    if (data.type !== "design:selection" || data.projectId !== project.id || data.revision !== frame.revision || data.revision !== project.revision || typeof data.sourceId !== "string") return;
    const source = preview.sources.find(item => item.id === data.sourceId);
    if (!source || typeof data.file === "string" && source.file !== data.file) return;
    const styles: Record<string, string> = {};
    if (data.computedStyles && typeof data.computedStyles === "object") for (const [key] of styleFields) {
      const camelKey = key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      const value = (data.computedStyles as Record<string, unknown>)[key] ?? (data.computedStyles as Record<string, unknown>)[camelKey];
      if (typeof value === "string" && value.length <= 300) styles[key] = value;
    }
    selectSource(source, typeof data.text === "string" ? data.text.slice(0, 20_000) : "", styles, frame.viewportId, { ...(typeof data.runtimeLiteralText === "boolean" ? { runtimeLiteralText: data.runtimeLiteralText } : {}), ...(typeof data.ancestorMapped === "boolean" ? { ancestorMapped: data.ancestorMapped } : {}) });
  }
  function setMode(next: "select" | "preview") {
    mode = next;
    for (const frame of frames) frame.iframe.contentWindow?.postMessage({ type: "design:mode", projectId: frame.projectId, revision: frame.revision, pageId: frame.pageId, mode }, "*");
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
    const modeLabel = root.querySelector("[data-mode-label]"); if (modeLabel) modeLabel.textContent = mode === "select" ? "点击原型元素以定位源码" : "原型交互正在运行";
  }
  function viewports() { return matchingViewports().filter(item => viewportId === "all" || item.id === viewportId); }
  function viewportPositions() {
    let x = 0;
    return viewports().map(viewport => { const result = { ...viewport, x }; x += viewport.width + 90; return result; });
  }
  function transform() {
    const world = root.querySelector<HTMLElement>(".dc-world"); if (world) world.style.transform = `translate(${offset.x}px,${offset.y}px) scale(${scale})`;
    const label = root.querySelector(".dc-zoom .value"); if (label) label.textContent = `${Math.round(scale * 100)}%`;
  }
  function fitCanvas() {
    const canvas = root.querySelector(".dc-canvas"); const items = viewportPositions();
    if (!canvas || !items.length) return;
    const width = items.at(-1)!.x + items.at(-1)!.width; const height = Math.max(...items.map(item => item.height)); const rect = canvas.getBoundingClientRect();
    scale = Math.max(.05, Math.min(1, (rect.width - 80) / width, (rect.height - 125) / height));
    offset = { x: Math.max(25, (rect.width - width * scale) / 2), y: 48 }; transform();
  }
  function zoom(next: number, point?: { x: number; y: number }) {
    const canvas = root.querySelector(".dc-canvas"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); const center = point ?? { x: rect.width / 2, y: rect.height / 2 }; next = Math.max(.05, Math.min(2, next)); offset = { x: center.x - (center.x - offset.x) * next / scale, y: center.y - (center.y - offset.y) * next / scale }; scale = next; transform();
  }
  function renderStatus() {
    const statusNode = root.querySelector<HTMLElement>(".dc-save-state"); if (statusNode) { statusNode.textContent = status; statusNode.classList.toggle("saving", saving > 0); }
    const connection = root.querySelector("[data-connection]"); if (connection) connection.innerHTML = `<span class="dc-dot${connected ? " connected" : ""}"></span>${escape(connected ? "本地 MCP 已连接" : status)}`;
    const revision = root.querySelector("[data-revision]"); if (revision) revision.textContent = project ? `修订 ${project.revision}` : "";
    const compilingNode = root.querySelector<HTMLElement>(".dc-loading"); if (compilingNode) compilingNode.hidden = !compiling;
    // Update control state in place: rebuilding the header/canvas would drop
    // focus or the live iframe state after an asynchronous save completes.
    const disable = (action: string, value: boolean) => { for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>(`button[data-action="${action}"]`))) button.disabled = value; };
    const busy = saving > 0;
    disable("undo", !project || busy); disable("redo", !project || busy);
    const draft = drafts.get(activeFile);
    disable("save-source", !draft?.dirty || draft.conflict || busy);
    disable("apply-selection", !selectedIsCurrent() || busy);
    disable("apply-generation", busy);
  }
  function renderHeader() {
    const container = root.querySelector<HTMLElement>(".dc-header"); if (!container) return;
    container.innerHTML = `<div class="dc-brand"><b>D</b><span class="dc-hide-mobile">Design</span></div><div class="dc-divider dc-hide-mobile"></div><select data-setting="project" aria-label="当前原型项目"><option value="">${projects.length ? "选择项目" : "未创建项目"}</option>${projects.map(item => `<option value="${escape(item.id)}"${item.id === project?.id ? " selected" : ""}>${escape(item.name)}</option>`).join("")}<option value="__new__">＋ 新建原型</option></select><button class="icon quiet dc-hide-mobile" data-action="new" title="新建代码原型">${icon("plus")}</button><span class="dc-save-state"></span><div class="dc-header-actions"><button class="icon quiet dc-mobile" data-action="toggle-left" title="项目文件">${icon("panelLeft")}</button><button class="icon quiet" data-action="undo" title="撤销 ⌘Z"${!project || saving ? " disabled" : ""}>${icon("undo")}</button><button class="icon quiet" data-action="redo" title="重做 ⌘⇧Z"${!project || saving ? " disabled" : ""}>${icon("redo")}</button><button class="icon quiet dc-hide-mobile" data-action="refresh" title="刷新代码与预览">${icon("refresh")}</button><div class="dc-divider dc-hide-mobile"></div><button class="primary" data-action="export" aria-label="导出代码原型"${!project ? " disabled" : ""}>${icon("download")}<span class="dc-hide-mobile">导出</span></button><button class="icon quiet dc-mobile" data-action="toggle-right" title="属性与 AI">${icon("panelRight")}</button></div>`;
    renderStatus();
  }
  function renderFilePanel() {
    const panel = root.querySelector<HTMLElement>("[data-left-panel]"); if (!panel) return;
    if (!project) { panel.innerHTML = '<div class="dc-empty">项目的真实源文件和组件会显示在这里。</div>'; return; }
    panel.classList.toggle("flush", leftTab === "files");
    if (leftTab === "files") {
      let group = "";
      panel.innerHTML = `<div class="dc-file-header"><span>项目文件 · ${project.files.length}</span><button class="icon quiet" data-action="new-file" title="添加源文件">${icon("plus")}</button></div>${[...project.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => {
        const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "项目根目录";
        const folderTitle = folder !== group ? `<div class="dc-path-group">${escape(folder)}</div>` : ""; group = folder;
        return `${folderTitle}<div class="dc-file-row${file.path === activeFile ? " active" : ""}" data-file="${escape(file.path)}" role="button" tabindex="0" aria-label="打开 ${escape(file.path)}">${icon(file.encoding === "base64" ? "image" : "file")}<span class="path">${escape(file.path.split("/").at(-1))}</span>${drafts.get(file.path)?.dirty ? '<span class="dirty" title="未保存">•</span>' : project!.pages.some(page => page.entry === file.path) ? '<small>页面入口</small>' : ""}</div>`;
      }).join("")}<div style="padding:14px 11px"><label class="dc-upload">${icon("upload")}添加图片素材<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-upload aria-label="导入项目图片素材"/></label></div>`;
    } else {
      panel.innerHTML = `<div class="dc-section"><div class="dc-section-title">真实组件</div>${project.designSystem.components.map(component => `<article class="dc-component">${icon("component")}<div><strong>${escape(component.name)}</strong><p>${escape(component.path)}${component.exportName ? ` · ${escape(component.exportName)}` : ""}</p>${component.usage ? `<p>${escape(component.usage)}</p>` : ""}</div><button data-file="${escape(component.path)}" title="打开组件源码">${icon("code")}</button></article>`).join("") || '<p class="dc-hint">组件来自项目源文件。让当前聊天建立或扩展组件库，组件代码会保留在交付包中。</p>'}</div><div class="dc-section"><div class="dc-section-title">设计令牌</div>${Object.entries(project.designSystem.tokens).map(([key, value]) => `<div class="dc-token-row"><span class="dc-swatch" data-swatch="${escape(value)}"></span><code>${escape(key)}</code><span title="${escape(value)}">${escape(value)}</span></div>`).join("") || '<p class="dc-hint">尚未登记设计令牌。CSS 和组件仍以项目源码为准。</p>'}</div>${project.designSystem.notes ? `<div class="dc-section"><div class="dc-section-title">系统说明</div><p class="dc-hint">${escape(project.designSystem.notes)}</p></div>` : ""}`;
      for (const node of Array.from(panel.querySelectorAll<HTMLElement>("[data-swatch]"))) if (CSS.supports("color", node.dataset.swatch!)) node.style.backgroundColor = node.dataset.swatch!;
    }
  }
  function stageHeader() {
    const defaultPageId = project?.defaultPageId;
    return `<div class="dc-segment"><button data-view="design" class="${view === "design" ? "active" : ""}">${icon("desktop")}设计效果</button><button data-view="source" class="${view === "source" ? "active" : ""}">${icon("code")}源码</button></div>${project ? `<div class="dc-page-controls"><select data-setting="page" aria-label="当前页面">${project.pages.map(page => `<option value="${escape(page.id)}"${page.id === activePageId ? " selected" : ""}>${escape(page.name)}${page.id === defaultPageId ? " · 默认" : ""}</option>`).join("")}</select>${view === "design" ? `<select data-setting="viewport" aria-label="预览尺寸"><option value="all"${viewportId === "all" ? " selected" : ""}>全部尺寸</option>${matchingViewports().map(item => `<option value="${escape(item.id)}"${viewportId === item.id ? " selected" : ""}>${escape(item.name)} · ${item.width}px</option>`).join("")}</select>` : ""}</div>` : ""}`;
  }
  function renderCanvas() {
    const stage = root.querySelector<HTMLElement>("[data-stage-content]"); if (!stage) return;
    let sourceStage = root.querySelector<HTMLElement>("[data-source-content]");
    if (!sourceStage) { sourceStage = document.createElement("div"); sourceStage.className = "dc-code-view"; sourceStage.dataset.sourceContent = ""; stage.after(sourceStage); }
    stage.hidden = view === "source"; sourceStage.hidden = view !== "source";
    const top = root.querySelector(".dc-stage-top"); if (top) top.innerHTML = stageHeader();
    if (view === "source") { renderSource(); return; }
    stage.className = "dc-canvas";
    const signature = project ? `${project.id}:${project.revision}:${activePageId}:${viewports().map(item => item.id).join(",")}:${preview?.pageId === activePageId && preview.revision === project.revision ? "compiled" : "pending"}` : "welcome";
    if (signature === canvasSignature && stage.childElementCount) { transform(); return; }
    canvasSignature = signature; frames = [];
    if (!project) {
      stage.innerHTML = `<div class="dc-welcome"><div class="dc-welcome-art" aria-hidden="true"></div><h1>让设计真正运行起来</h1><p>从 HTML 或 React 原型开始。效果、交互与源代码在同一个项目中持续迭代。</p><button class="primary" data-action="new">${icon("plus")}创建第一个原型</button></div>`; return;
    }
    stage.innerHTML = `<div class="dc-world"></div><div class="dc-loading"${compiling ? "" : " hidden"}>正在编译真实源代码…</div>${preview?.diagnostics.length ? `<div class="dc-diagnostic-bar${preview.diagnostics.some(item => item.level === "error") ? " error" : ""}" role="status">${preview.diagnostics.slice(0, 6).map(item => `<p>${escape(item.file ? `${item.file}${item.line ? `:${item.line}` : ""} · ` : "")}${escape(item.message)}</p>`).join("")}</div>` : ""}<div class="dc-canvas-toolbar" role="toolbar" aria-label="原型模式"><button data-mode="select" class="${mode === "select" ? "active" : ""}" title="选择元素并定位源码">${icon("cursor")}选择</button><button data-mode="preview" class="${mode === "preview" ? "active" : ""}" title="运行真实原型交互">${icon("play")}交互</button><div class="dc-divider"></div><button data-action="ai" title="让当前聊天修改设计">${icon("spark")}AI 设计</button></div><div class="dc-zoom"><button data-action="zoom-out" aria-label="缩小">${icon("minus")}</button><button class="value" data-action="fit" title="适合视图">${Math.round(scale * 100)}%</button><button data-action="zoom-in" aria-label="放大">${icon("plus")}</button></div>`;
    const world = stage.querySelector<HTMLElement>(".dc-world")!;
    for (const viewport of viewportPositions()) {
      const wrapper = document.createElement("div"); wrapper.className = `dc-frame${viewport.id === activeViewport ? " active" : ""}`; wrapper.dataset.pageId = activePageId; wrapper.dataset.viewportId = viewport.id; wrapper.style.cssText = `left:${viewport.x}px;top:0;width:${viewport.width}px;height:${viewport.height}px`;
      const title = document.createElement("div"); title.className = "dc-frame-title"; title.innerHTML = `${icon(viewport.width < 600 ? "mobile" : "desktop")}${escape(currentPage()?.name)} · ${escape(viewport.name)}<span>${viewport.width} × ${viewport.height}</span>`; wrapper.append(title);
      if (preview?.pageId === activePageId && preview.revision === project.revision) {
        const iframe = document.createElement("iframe"); iframe.setAttribute("sandbox", "allow-scripts allow-forms"); iframe.title = `${project.name} · ${currentPage()?.name} · ${viewport.name}`; iframe.referrerPolicy = "no-referrer";
        const record: FrameRecord = { projectId: project.id, pageId: activePageId, viewportId: viewport.id, revision: preview.revision, iframe };
        iframe.addEventListener("load", () => { record.ready = true; if (!disposed) { iframe.contentWindow?.postMessage({ type: "design:mode", projectId: record.projectId, revision: record.revision, pageId: record.pageId, mode }, "*"); sendLocation(record); } });
        const location = pendingLocation?.projectId === record.projectId && pendingLocation.revision === record.revision && pendingLocation.pageId === record.pageId ? pendingLocation : undefined;
        iframe.srcdoc = preview.diagnostics.some(item => item.level === "error") ? preview.html : injectCodePageRuntimeLocation(preview.html, { projectId: record.projectId, revision: record.revision, pageId: record.pageId, search: location?.search, hash: location?.hash }); wrapper.append(iframe); frames.push(record);
      } else {
        const empty = document.createElement("div"); empty.className = "dc-empty"; empty.textContent = compiling ? "正在编译项目…" : "预览尚未生成。请检查编译诊断或刷新项目。"; wrapper.append(empty);
      }
      world.append(wrapper);
    }
    if (!viewports().length) { const empty = document.createElement("div"); empty.className = "dc-empty"; empty.textContent = "此页面没有可用预览尺寸，请通过当前聊天添加共享尺寸或此页面的专属尺寸。"; stage.append(empty); }
    transform();
  }
  function renderSource() {
    const stage = root.querySelector<HTMLElement>("[data-source-content]"); if (!stage || view !== "source") return;
    stage.className = "dc-code-view";
    const file = activeSource(); const draft = file?.encoding === "utf8" ? draftAt(file.path) : undefined;
    const focus = stage.querySelector<HTMLTextAreaElement>(".dc-code-input"); const hadFocus = focus === document.activeElement; const position = focus ? { start: focus.selectionStart, end: focus.selectionEnd, top: focus.scrollTop, left: focus.scrollLeft } : undefined;
    if (!file) { stage.innerHTML = '<div class="dc-empty">选择一个项目源文件以查看和编辑。</div>'; return; }
    stage.innerHTML = `<div class="dc-code-head"><code>${escape(file.path)}</code><small>${draft?.dirty ? "未保存" : "已保存"}</small>${draft?.dirty ? '<button data-action="reset-source">重新载入</button>' : ""}<button class="primary" data-action="save-source"${!draft?.dirty || draft.conflict || saving ? " disabled" : ""}>${icon("save")}保存源码</button></div>${draft?.conflict ? '<div class="dc-code-conflict" role="alert">此文件已被其他编辑更新。你的草稿仍保留；请复制草稿后协调，或重新载入当前文件。</div>' : ""}${file.encoding === "utf8" ? `<textarea class="dc-code-input" aria-label="${escape(file.path)} 源码" spellcheck="false" autocomplete="off" autocapitalize="off" data-source-input>${escape(draft?.content ?? file.content)}</textarea>` : `<div class="dc-binary">${assetMime(file.path)?.startsWith("image/") && !file.path.endsWith(".svg") ? `<img src="data:${assetMime(file.path)};base64,${escape(file.content)}" alt="${escape(file.path)}"/>` : icon("file")}<p>这是项目二进制素材。文件内容会原样保留在项目与导出包中。</p></div>`}`;
    const nextInput = stage.querySelector<HTMLTextAreaElement>(".dc-code-input");
    if (nextInput && position) { nextInput.scrollTop = position.top; nextInput.scrollLeft = position.left; if (hadFocus) { nextInput.focus({ preventScroll: true }); nextInput.setSelectionRange(position.start, position.end); } }
  }
  function inspectorMarkup() {
    if (!project) return '<div class="dc-empty"><strong>效果与源码保持在一起</strong>创建原型后，在选择模式点击元素即可查看对应源文件。</div>';
    if (!selection) return `<div class="dc-project-summary"><strong>${escape(project.name)}</strong><p>${project.pages.length} 个页面 · ${project.files.length} 个真实文件<br>当前页：${escape(currentPage()?.name)}<br>入口：${escape(currentPage()?.entry)}</p></div><div class="dc-empty"><strong>点击原型中的元素</strong>选择模式会定位到确切源文件。动态内容或复杂结构可以交给当前聊天修改。</div><p class="dc-property-note">文字和样式的直接编辑只用于编译器确认可安全映射的源码。每次修改都校验文件摘要与项目修订。</p><button style="width:100%" data-action="ai">${icon("spark")}描述你的设计需求</button>`;
    const source = selection.source;
    return `<div class="dc-section"><div class="dc-selection-tag"><code>&lt;${escape(source.tag)}&gt;</code><span>已定位源元素</span></div><div class="dc-source-anchor"><strong>${escape(source.file)}</strong><br>源码位置 ${source.start}–${source.end}<span class="dc-file-hash">${escape(selection.fileHash)}</span></div><p class="dc-property-note">多个组件实例可能共享同一段源码，修改源会影响所有实例。</p>${!selectedIsCurrent() ? '<p class="dc-property-note" role="status">项目已更新。请在最新预览中重新选择元素，然后提交属性修改。</p>' : ""}<div class="dc-inline" style="margin-top:9px"><button data-action="source-selection">${icon("code")}打开源码</button><button data-action="ai-selection">${icon("spark")}让 AI 修改</button></div></div>
      <div class="dc-section"><div class="dc-section-title">文字内容</div>${canEditSelectionText() ? `<label class="dc-field">静态文字<textarea aria-label="选中元素文字" data-selection-text>${escape(selectionText)}</textarea></label>` : `<p class="dc-hint">${selection.ancestorMapped || selection.runtimeLiteralText === false ? "当前内容由运行时生成，定位的是可追溯的源容器。" : "此元素包含组件、嵌套结构或动态表达式。"}通过源码或当前聊天修改内容，避免覆盖原有逻辑。</p>`}</div>
      <div class="dc-section"><div class="dc-section-title">局部样式 <span style="font-size:9px;font-weight:400;color:var(--dc-muted)">写回源元素</span></div><div class="dc-fields">${styleFields.map(([key, label]) => `<label class="dc-field">${label}<input data-selection-style="${key}" value="${escape(selectionStyles[key] ?? "")}" placeholder="保留原样"/></label>`).join("")}</div><p class="dc-property-note">属性值来自当前运行结果，仅提交你改过的字段。编译器无法安全修改的动态样式会明确拒绝。</p><button class="primary" style="width:100%" data-action="apply-selection"${!selectedIsCurrent() || saving ? " disabled" : ""}>${icon("check")}应用到源码</button></div>
      <div class="dc-section"><button style="width:100%" data-action="comment-selection">${icon("comment")}评论此元素</button></div>`;
  }
  function aiMarkup() {
    const job = project ? jobs.get(project.id) : undefined;
    return `<div class="dc-ai-card"><strong>${icon("spark")}持续编辑真实设计</strong><p>描述目标、品牌和交互。模型编辑项目的 HTML、CSS、组件与逻辑，预览随保存的代码更新。</p></div>
      <label class="dc-field">执行模式<select data-ai-mode><option value="host"${aiMode === "host" ? " selected" : ""}>当前聊天模型 · 默认</option><option value="codex"${aiMode === "codex" ? " selected" : ""}>独立本地 Codex</option></select></label>
      ${aiMode === "codex" ? `<label class="dc-field">Codex 模型<select data-ai-model${modelsLoading ? " disabled" : ""}><option value="">${modelsLoading ? "正在读取本机模型目录…" : "使用本地默认模型"}</option>${models.map(model => `<option value="${escape(model.id)}"${aiModel === model.id ? " selected" : ""}>${escape(model.displayName || model.id)}${model.isDefault ? "（默认）" : ""}</option>`).join("")}</select></label><label class="dc-field">任务总预算<select data-generation-budget><option value="600000"${generationBudgetMs === 600000 ? " selected" : ""}>10 分钟 · 默认</option><option value="900000"${generationBudgetMs === 900000 ? " selected" : ""}>15 分钟</option></select></label><p class="dc-hint">沿用本机 Codex 登录，在独立任务生成提案。编译、渲染与模型回看分别记录，完成后仍需手动应用。</p>${modelsError ? `<p class="dc-hint" role="status">${escape(modelsError)}</p><button data-action="refresh-models">重新读取模型目录</button>` : ""}` : '<p class="dc-hint">使用当前聊天的模型与登录。宿主不支持发送消息时，提供完整提示词复制回聊天。</p>'}
      <label class="dc-field">视觉方向<select data-ai-direction><option value="auto"${aiDirection === "auto" ? " selected" : ""}>自动 · 依据需求与品牌</option>${directions.map(direction => `<option value="${escape(direction.id)}"${aiDirection === direction.id ? " selected" : ""}>${escape(direction.name)}</option>`).join("")}</select></label>
      ${selection ? `<div class="dc-comment-target" style="margin-top:10px">已选择 &lt;${escape(selection.source.tag)}&gt; · ${escape(selection.source.file)}${selectedIsCurrent() ? "" : "（旧修订，发送前会标明）"}</div>` : ""}<label class="dc-field" style="margin-top:11px">设计需求<textarea class="dc-ai-prompt" maxlength="10000" data-ai-prompt placeholder="例如：把首页改成编辑叙事风格，用真实产品内容，补充导航、移动适配和表单状态。">${escape(aiPrompt)}</textarea></label><p class="dc-hint">${project ? `${escape(project.name)} · 修订 ${project.revision} · ${project.comments.filter(comment => comment.status === "open").length} 条待处理评论` : "请先创建项目"}${hasDirty() ? " · 有未保存源码" : ""}</p><button class="primary" style="width:100%" data-action="generate"${!project || generationStarting || job?.status === "running" ? " disabled" : ""}>${icon("spark")}${generationStarting ? "正在准备任务…" : aiMode === "codex" ? "开始本地生成" : "交给当前聊天"}</button>${aiStatus ? `<div class="dc-ai-state${aiError ? " error" : ""}" role="status">${escape(aiStatus)}</div>` : ""}
      ${job ? generationMarkup(job) : ""}${aiMode === "codex" ? proposalDraftsMarkup() : ""}${fallbackPrompt ? `<div class="dc-fallback"><label class="dc-field">复制回当前聊天<textarea readonly>${escape(fallbackPrompt)}</textarea></label><button data-action="copy-prompt">${icon("copy")}复制完整提示词</button></div>` : ""}`;
  }
  function generationMarkup(job: GenerationJob) {
    const applied = appliedJobs.has(job.id);
    const verification = job.verification;
    const statusLabel = ({ running: "执行中", completed: applied ? "已应用" : "提案已完成 · 尚未应用", failed: "执行失败", cancelled: "已停止" })[job.status];
    const files = job.changes?.files ?? [];
    const reviewedPages = job.verification.pages?.map(pageId => project?.pages.find(page => page.id === pageId)?.name ?? pageId).join("、");
    return `<div class="dc-ai-state${job.status === "failed" ? " error" : ""}"><strong>本地 Codex · ${statusLabel}</strong><p class="dc-hint">基于修订 ${job.baseRevision}${job.model ? ` · ${escape(job.model)}` : ""}</p><div class="dc-verification"><span>编译：${verification.compiled ? "通过" : "未完成"}</span><span>渲染：${verification.rendered ? "完成" : "未完成"}</span><span>模型回看：${verification.modelReviewed ? "完成" : "未完成"}</span><span>视口：${verification.viewports}</span></div><p class="dc-hint">审阅页面：${escape(reviewedPages || "未记录")}</p>${job.error ? `<p>${escape(job.error)}</p>` : ""}${job.status === "completed" && project?.revision !== job.baseRevision && !applied ? '<p class="dc-property-note">项目已有新修订。原提案保留；应用时会检查冲突，不能直接覆盖最新源码。</p>' : ""}${files.length ? `<details class="dc-proposal"><summary>查看提案文件 · ${files.length}</summary>${files.map(file => `<div><code>${escape(file.path)}</code><small>${file.content === undefined ? "删除文件" : file.expectedHash === null ? "新增文件" : "修改文件"}</small>${file.content !== undefined && file.encoding !== "base64" ? `<pre>${escape(file.content.slice(0, 1800))}${file.content.length > 1800 ? "\n…（内容已截短，完整提案仍保留在任务中）" : ""}</pre>` : ""}</div>`).join("")}</details>` : ""}<div class="dc-actions-wrap" style="margin-top:10px">${job.status === "completed" && !applied ? `<button class="primary" data-action="apply-generation"${saving ? " disabled" : ""}>应用提案到项目</button>` : ""}${job.status === "running" ? '<button data-action="cancel-generation">停止任务</button>' : ""}<button data-action="refresh-generation">刷新状态</button></div>${job.log?.length ? `<details class="dc-proposal"><summary>任务记录</summary><pre>${escape(job.log.slice(-5).join("\n"))}</pre></details>` : ""}</div>`;
  }
  function proposalDraftsMarkup() {
    if (!project) return "";
    const projectId = project.id;
    const listed = proposalDrafts.get(projectId) ?? [];
    const draftsById = new Map(listed.map(draft => [draft.id, draft]));
    const job = jobs.get(projectId);
    if (job?.draft?.projectId === projectId) draftsById.set(job.draft.id, job.draft);
    return `<div class="dc-section"><div class="dc-section-title">未验收草稿</div><p class="dc-hint">当前审阅页：${escape(currentPage()?.name)}。草稿不可直接应用；继续会启动新的本地任务，重新编译、渲染与审阅。</p><button style="width:100%" data-action="list-drafts"${draftsLoading.has(projectId) ? " disabled" : ""}>${draftsLoading.has(projectId) ? "正在读取草稿…" : "查看 / 刷新未验收草稿"}</button>${Array.from(draftsById.values()).map(draft => proposalDraftMarkup(draft)).join("")}${draftsLoaded.has(projectId) && !draftsById.size ? '<p class="dc-hint">当前项目没有可列出的未验收草稿。</p>' : ""}</div>`;
  }
  function proposalDraftMarkup(draft: ProposalDraft) {
    const expired = draft.expired || Date.parse(draft.expiresAt) <= Date.now();
    const canResume = draft.resumable && !expired && !generationStarting && jobs.get(draft.projectId)?.status !== "running";
    const detail = draftDetails.get(draft.id);
    const stage = ({ compiled: "已编译", rendering: "渲染中", rendered: "已渲染", reviewing: "审阅中" } as Record<string, string>)[draft.stage] ?? draft.stage;
    const originStatus = ({ running: "执行中", completed: "已完成记录", failed: "失败", cancelled: "已取消", interrupted: "中断记录", "not-attached": "当前进程未连接原任务" } as Record<string, string>)[draft.originStatus] ?? draft.originStatus;
    return `<article class="dc-draft-card"><strong>未验收 · 不可应用${expired ? " · 已过期" : ""}</strong><p class="dc-hint">基于修订 ${draft.baseRevision} · ${escape(stage)} · ${draft.captureCount} 张截图记录<br>原任务状态：${escape(originStatus)}</p>${draft.lastError ? `<p class="dc-hint">${escape(draft.lastError)}</p>` : ""}<code>${escape(draft.id)}</code><div class="dc-actions-wrap" style="margin-top:9px"><button data-draft-view="${escape(draft.id)}">查看草稿信息</button><button class="primary" data-draft-resume="${escape(draft.id)}"${canResume ? "" : " disabled"}>继续审阅本页</button></div>${!canResume && !expired ? '<p class="dc-hint">草稿当前不可继续，或已有任务执行中；可刷新信息核对状态。</p>' : ""}${detail ? `<details class="dc-proposal" open><summary>草稿文件与截图记录</summary><p>${detail.files.length} 个文件；${detail.captures.length} 条截图元数据。本面板未回看截图。</p>${detail.files.map(file => `<p><code>${escape(file.path)}</code><small>${escape(file.sha256)}</small></p>`).join("")}${detail.captures.map(capture => `<p>${escape(project?.pages.find(page => page.id === capture.pageId)?.name ?? capture.pageId)} · ${escape(capture.viewportId)} · ${capture.width} × ${capture.height}</p>`).join("")}</details>` : ""}</article>`;
  }
  function readProposalDraft(value: unknown): ProposalDraft {
    if (!value || typeof value !== "object") throw new Error("服务未返回有效草稿信息。");
    const draft = value as ProposalDraft;
    if (typeof draft.id !== "string" || typeof draft.projectId !== "string" || draft.status !== "unverified" || draft.requiresReview !== true || typeof draft.baseRevision !== "number" || typeof draft.resumable !== "boolean" || typeof draft.expired !== "boolean" || typeof draft.expiresAt !== "string") throw new Error("未验收草稿的身份或状态无效。");
    return draft;
  }
  async function listProposalDrafts() {
    if (!project || draftsLoading.has(project.id)) return;
    const projectId = project.id; draftsLoading.add(projectId); renderInspector();
    try {
      const result = await call("design_code_list_drafts", { projectId, includeExpired: true });
      if (!Array.isArray(result.drafts)) throw new Error("服务没有返回草稿列表。");
      const items = result.drafts.map(readProposalDraft).filter(draft => draft.projectId === projectId);
      proposalDrafts.set(projectId, items); draftsLoaded.add(projectId);
    } catch (error) { notify(`读取草稿失败：${message(error)}`, true); }
    finally { draftsLoading.delete(projectId); if (project?.id === projectId) renderInspector(); }
  }
  async function viewProposalDraft(checkpointId: string) {
    if (!project) return;
    const projectId = project.id;
    try {
      const result = await call("design_code_get_draft", { checkpointId });
      const draft = readProposalDraft(result.draft);
      if (draft.id !== checkpointId || draft.projectId !== projectId) throw new Error("草稿不属于所选项目，未打开。");
      const files = Array.isArray(result.files) ? result.files as FileSummary[] : [];
      const captures = Array.isArray(result.captures) ? result.captures as DraftDetails["captures"] : [];
      draftDetails.set(checkpointId, { draft, files, captures });
      proposalDrafts.set(projectId, [draft, ...(proposalDrafts.get(projectId) ?? []).filter(item => item.id !== checkpointId)]);
      const job = jobs.get(projectId); if (job?.draft?.id === checkpointId) job.draft = draft;
      if (project?.id === projectId) renderInspector();
    } catch (error) { notify(`草稿信息不可用：${message(error)}`, true); }
  }
  async function resumeProposalDraft(checkpointId: string) {
    if (!project) return;
    if (hasDirty()) { notify("请先保存或协调源码草稿，再继续审阅未验收提案。", true); return; }
    if (generationStarting || jobs.get(project.id)?.status === "running") { notify("已有本地任务执行中，请先处理当前任务。", true); return; }
    const projectId = project.id; const pageId = activePageId;
    generationStarting = true; aiError = false; aiStatus = "正在为未验收草稿启动新的审阅任务…"; renderInspector();
    try {
      const result = await call("design_code_resume_generation", { projectId, checkpointId, timeoutMs: generationBudgetMs, pageIds: [pageId], ...(aiModel ? { model: aiModel } : {}), ...(aiPrompt.trim() ? { prompt: aiPrompt.trim().slice(0, 10000) } : {}) });
      const job = readGenerationJob(result.job);
      if (job.projectId !== projectId) throw new Error("继续审阅结果属于其他项目，未关联到当前项目。");
      jobs.set(projectId, job);
      if (project?.id === projectId) aiStatus = "新的本地审阅任务已启动；原草稿仍未应用，只有新任务完成的提案才可应用。";
      scheduleGenerationPoll();
    } catch (error) { if (project?.id === projectId) { aiStatus = `未能继续审阅：${message(error)}。原草稿未应用。`; aiError = true; } else notify(message(error), true); }
    finally { generationStarting = false; if (!disposed && project?.id === projectId) renderInspector(); }
  }
  function commentsMarkup() {
    if (!project) return '<div class="dc-empty">创建项目后即可添加定位评论。</div>';
    return project.comments.map(comment => `<article class="dc-comment${comment.status === "resolved" ? " resolved" : ""}"><div class="dc-comment-meta"><time>${escape(new Date(comment.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</time><span>${comment.status === "resolved" ? "已解决" : "待处理"}</span><button data-comment-resolve="${escape(comment.id)}" title="${comment.status === "resolved" ? "重新打开" : "标记已解决"}">${icon("check")}</button></div><p>${escape(comment.text)}</p><button class="anchor" data-comment-anchor="${escape(comment.id)}">${icon("code")}${escape(comment.file)}${comment.sourceId ? preview?.sources.some(source => source.id === comment.sourceId && source.file === comment.file) ? " · 源码锚点" : " · 当前页未定位" : " · 文件评论"}</button></article>`).join("") || '<div class="dc-empty"><strong>把反馈留在设计上</strong>选择元素后添加评论，模型会收到源文件和待处理反馈。</div>';
  }
  function renderInspector() {
    const panel = root.querySelector<HTMLElement>("[data-right-panel]"); if (!panel) return;
    const focus = captureFocus();
    const top = panel.scrollTop;
    panel.innerHTML = rightTab === "inspect" ? inspectorMarkup() : rightTab === "ai" ? aiMarkup() : commentsMarkup(); panel.scrollTop = top;
    const composer = root.querySelector<HTMLElement>(".dc-comment-composer");
    if (composer) {
      composer.hidden = rightTab !== "comments" || !project;
      composer.innerHTML = `<label class="dc-field">${selection ? `评论定位：${escape(selection.source.file)} · &lt;${escape(selection.source.tag)}&gt;` : `评论定位：${escape(activeFile || currentPage()?.entry || "页面入口")}`}<textarea data-comment-draft placeholder="记录建议、修改点或待办…">${escape(commentDraft)}</textarea></label><button data-action="add-comment">${icon("comment")}添加评论</button>`;
    }
    root.querySelectorAll<HTMLElement>("[data-right-tab]").forEach(button => button.classList.toggle("active", button.dataset.rightTab === rightTab));
    const commentsButton = root.querySelector<HTMLElement>('[data-right-tab="comments"]');
    if (commentsButton) { const count = project?.comments.filter(comment => comment.status === "open").length ?? 0; commentsButton.textContent = count ? `评论 · ${count}` : "评论"; }
    restoreFocus(focus);
  }
  function renderProjectNotice() {
    const meta = root.querySelector<HTMLElement>(".dc-source-meta"); if (!meta) return;
    meta.innerHTML = `源码是可持续编辑的交付内容。<br><code>${escape(currentPage()?.entry ?? "尚未打开项目")}</code>${unsupportedProjects.length ? `<details class="dc-unsupported"><summary>有 ${unsupportedProjects.length} 个不支持的开发版项目，未改写或删除</summary>${unsupportedProjects.map(item => `<p><code>${escape(item.id)}</code><br>${escape(item.reason)}</p>`).join("")}</details>` : ""}`;
  }
  function modalMarkup() {
    if (!modal) return "";
    let content = "";
    if (modal === "new") content = `<h2>创建可运行原型</h2><p>项目保留真实源文件。你可以直接编辑代码，也可以由当前聊天持续生成和修改。</p><label class="dc-field">项目名称<input data-new-name value="${escape(newName)}" maxlength="200"/></label><div class="dc-template-grid"><button class="${template === "react" ? "active" : ""}" data-template="react"><strong>React 组件项目</strong><small>真实 JSX 组件、样式与交互逻辑，适合产品原型。</small></button><button class="${template === "html" ? "active" : ""}" data-template="html"><strong>HTML 项目</strong><small>HTML、CSS 和 JavaScript，适合页面与轻量交互。</small></button></div><div class="dc-modal-actions"><button data-action="close-modal">取消</button><button class="primary" data-action="create-project">创建项目</button></div>`;
    if (modal === "file") content = `<h2>添加源文件</h2><p>路径相对项目根目录。已有文件不会被覆盖。</p><label class="dc-field">文件路径<input data-new-file-path value="${escape(newFilePath)}" placeholder="src/components/Card.tsx"/></label><div class="dc-modal-actions"><button data-action="close-modal">取消</button><button class="primary" data-action="create-file">添加文件</button></div>`;
    if (modal === "export") content = `<h2>导出可运行设计</h2><p>导出读取已保存的修订 ${project?.revision ?? ""}。ZIP 保留全部源文件，HTML 保留真实页面导航；图片和 PDF 渲染所选页面与尺寸。</p><label class="dc-field">起始/渲染页面<select data-export-page>${project?.pages.map(page => `<option value="${escape(page.id)}"${page.id === exportPageId ? " selected" : ""}>${escape(page.name)}</option>`).join("")}</select></label><label class="dc-field">预览尺寸<select data-export-viewport>${project?.viewports.filter(viewport => !viewport.pageId || viewport.pageId === exportPageId).map(item => `<option value="${escape(item.id)}"${item.id === exportViewportId ? " selected" : ""}>${escape(item.name)} · ${item.width} × ${item.height}</option>`).join("")}</select></label><div class="dc-export-grid">${[["html", "HTML", "可运行的多页原型"], ["zip", "ZIP", "完整代码与素材"], ["png", "PNG", "指定页面的截图"], ["pdf", "PDF", "设计审阅文件"]].map(([format, title, detail]) => `<button data-export="${format}"><strong>${title}</strong><small>${detail}</small></button>`).join("")}</div><div class="dc-modal-actions"><button data-action="close-modal">完成</button></div>`;
    return `<div class="dc-modal-backdrop"><section class="dc-modal" role="dialog" aria-modal="true" aria-label="${modal === "new" ? "创建代码原型" : modal === "file" ? "添加源文件" : "导出代码原型"}">${content}</section></div>`;
  }
  function render() {
    if (disposed) return;
    const focus = captureFocus();
    if (root.querySelector(".dc-app")) {
      const body = root.querySelector<HTMLElement>(".dc-body")!;
      body.classList.toggle("show-left", leftOpen); body.classList.toggle("show-right", rightOpen);
      root.querySelector(".dc-modal-backdrop")?.remove();
      if (modal) body.insertAdjacentHTML("beforeend", modalMarkup());
      renderHeader(); renderFilePanel(); renderCanvas(); renderInspector(); renderProjectNotice(); renderStatus(); renderToast();
      if (modal) root.querySelector<HTMLElement>(".dc-modal input,.dc-modal select,.dc-modal button")?.focus({ preventScroll: true });
      else restoreFocus(focus);
      return;
    }
    root.innerHTML = `<div class="dc-app"><header class="dc-header"></header><main class="dc-body${leftOpen ? " show-left" : ""}${rightOpen ? " show-right" : ""}"><aside class="dc-sidebar" aria-label="项目源文件"><nav class="dc-tabs"><button data-left-tab="files" class="${leftTab === "files" ? "active" : ""}">文件</button><button data-left-tab="system" class="${leftTab === "system" ? "active" : ""}">设计系统</button></nav><div class="dc-scroll flush" data-left-panel></div><div class="dc-source-meta">源码是可持续编辑的交付内容。<br><code>${escape(currentPage()?.entry ?? "尚未打开项目")}</code></div></aside><section class="dc-stage" aria-label="可运行原型工作区"><div class="dc-stage-top"></div><div class="dc-canvas" data-stage-content></div></section><aside class="dc-inspector" aria-label="源码定位与设计助手"><nav class="dc-tabs"><button data-right-tab="inspect" class="${rightTab === "inspect" ? "active" : ""}">元素</button><button data-right-tab="ai" class="${rightTab === "ai" ? "active" : ""}">${icon("spark")}AI</button><button data-right-tab="comments" class="${rightTab === "comments" ? "active" : ""}">评论${project?.comments.filter(comment => comment.status === "open").length ? ` · ${project.comments.filter(comment => comment.status === "open").length}` : ""}</button></nav><div class="dc-scroll" data-right-panel></div><div class="dc-comment-composer" hidden></div></aside>${modalMarkup()}</main><footer class="dc-footer"><span data-connection></span><span class="keyboard" data-mode-label>${mode === "select" ? "点击原型元素以定位源码" : "原型交互正在运行"}</span><span class="keyboard">空格拖动画布 · ⌘ / Ctrl + S 保存源码</span><span class="right" data-revision></span></footer></div>`;
    renderHeader(); renderFilePanel(); renderCanvas(); renderInspector(); renderProjectNotice(); renderStatus(); renderToast();
    if (modal) root.querySelector<HTMLElement>(".dc-modal input,.dc-modal select,.dc-modal button")?.focus({ preventScroll: true });
    else restoreFocus(focus);
  }
  function captureFocus() {
    const element = document.activeElement;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || !root.contains(element)) return;
    const selector = element.hasAttribute("data-source-input") ? "[data-source-input]" : element.hasAttribute("data-ai-prompt") ? "[data-ai-prompt]" : element.hasAttribute("data-comment-draft") ? "[data-comment-draft]" : element.hasAttribute("data-selection-text") ? "[data-selection-text]" : element.dataset.selectionStyle ? `[data-selection-style="${element.dataset.selectionStyle}"]` : undefined;
    return selector ? { selector, start: element.selectionStart, end: element.selectionEnd, top: element.scrollTop, left: element.scrollLeft } : undefined;
  }
  function restoreFocus(focus: ReturnType<typeof captureFocus>) {
    if (!focus) return;
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(focus.selector);
    if (input) { input.focus({ preventScroll: true }); input.scrollTop = focus.top; input.scrollLeft = focus.left; try { if (focus.start !== null) input.setSelectionRange(focus.start, focus.end); } catch { /* Numeric controls have no text selection range. */ } }
  }
  async function generate() {
    if (!project || !aiPrompt.trim()) { notify("请填写设计需求。", true); return; }
    if (aiPrompt.length > 10_000) { notify("设计需求请控制在 10000 字以内，可在项目文件中补充长篇说明。", true); return; }
    if (hasDirty()) { notify("请先保存源码草稿，再交给模型修改项目。", true); return; }
    const projectId = project.id;
    const generationMode = aiMode;
    const requestedModel = aiModel;
    const selectedDirection = directions.find(direction => direction.id === aiDirection);
    const directionId = selectedDirection?.id;
    generationStarting = true;
    aiStatus = "正在整理源文件、选中元素与评论…"; aiError = false; fallbackPrompt = ""; renderInspector();
    try {
      const openComments = project.comments.filter(comment => comment.status === "open");
      const context = { projectId, revision: project.revision, page: currentPage(), pages: project.pages, viewport: project.viewports.find(viewport => viewport.id === activeViewport), selected: selection ? { sourceId: selection.source.id, file: selection.source.file, start: selection.source.start, end: selection.source.end, tag: selection.source.tag, fileHash: selection.fileHash, selectedRevision: selection.revision, pageId: selection.pageId, stale: !selectedIsCurrent(), text: selection.text.slice(0, 2000), computedStyles: selection.styles, runtimeLiteralText: selection.runtimeLiteralText, ancestorMapped: selection.ancestorMapped } : null, openCommentCount: openComments.length, comments: openComments.slice(-20).map(comment => ({ ...comment, text: comment.text.slice(0, 500) })) };
      const request = `${aiPrompt.trim()}${selectedDirection ? `\n\n视觉方向参考：${selectedDirection.name}（${selectedDirection.id}）。${selectedDirection.summary}。用户已有品牌与明确约束优先。` : ""}\n\n当前设计上下文（代码与最新修订以工具读取为准；先协调旧选择，再应用修改；评论过多时这里只附最近摘要，应通过工具读取完整项目）：\n${JSON.stringify(context, null, 2)}`;
      if (generationMode === "codex") {
        const result = await call("design_code_request_generation", { projectId, prompt: request, timeoutMs: generationBudgetMs, pageIds: [activePageId], ...(requestedModel ? { model: requestedModel } : {}) });
        const job = readGenerationJob(result.job);
        if (job.projectId !== projectId) throw new Error("生成任务返回了其他项目，未关联到当前项目。");
        jobs.set(projectId, job);
        if (project?.id === projectId) aiStatus = "本地 Codex 任务已启动。完成提案会保留在这里，点击应用后才写入项目。";
        scheduleGenerationPoll();
      } else {
        const result = await call("design_code_guidance", { projectId, pageId: activePageId, prompt: request, ...(directionId ? { directionId } : {}) });
        if (project?.id !== projectId) { notify("项目已切换，原项目的设计需求尚未发送。"); return; }
        const prompt = typeof result.prompt === "string" ? result.prompt : request;
        const deliveryContext = result.context ?? context;
        const delivery = await bridge.prompt(prompt, deliveryContext);
        if (project?.id === projectId) {
          aiStatus = delivery.sent ? "已将需求交给当前聊天。模型保存的代码修改会自动刷新到预览。" : delivery.reason ?? "当前宿主未提供聊天消息接口，请复制完整提示词回到当前聊天。";
          if (!delivery.sent) fallbackPrompt = `${prompt}\n\n项目上下文：\n${JSON.stringify(deliveryContext, null, 2)}`;
        }
      }
    } catch (error) { if (project?.id === projectId) { aiStatus = message(error); aiError = true; } else notify(message(error), true); }
    finally { generationStarting = false; if (!disposed) renderInspector(); }
  }
  function readGenerationJob(value: unknown): GenerationJob {
    if (!value || typeof value !== "object") throw new Error("任务服务未返回有效任务。");
    const job = value as GenerationJob;
    if (typeof job.id !== "string" || typeof job.projectId !== "string" || !["running", "completed", "failed", "cancelled"].includes(job.status) || typeof job.baseRevision !== "number" || !job.verification || typeof job.verification.compiled !== "boolean" || typeof job.verification.rendered !== "boolean" || typeof job.verification.modelReviewed !== "boolean" || typeof job.verification.viewports !== "number") throw new Error("任务状态或验证记录无效。");
    return job;
  }
  async function loadModels(force = false) {
    if (modelsLoading || modelsLoaded && !force) return;
    modelsLoading = true; modelsError = ""; renderInspector();
    try { const result = await call("design_list_models", {}); if (!Array.isArray(result.models)) throw new Error("本机 Codex 没有返回有效模型目录。"); models = result.models as ModelSummary[]; modelsLoaded = true; }
    catch (error) { modelsError = `模型目录不可用：${message(error)}`; }
    finally { modelsLoading = false; if (!disposed) renderInspector(); }
  }
  async function loadDirections() {
    try { const result = await call("design_get_guidance", {}); if (Array.isArray(result.directions)) directions = result.directions as VisualDirection[]; if (!disposed) renderInspector(); }
    catch (error) { notify(`视觉方向目录不可用：${message(error)}`, true); }
  }
  function scheduleGenerationPoll() {
    clearTimeout(jobTimer);
    const job = project ? jobs.get(project.id) : undefined;
    if (!disposed && job?.status === "running") jobTimer = setTimeout(() => { void refreshGeneration(); }, 1700);
  }
  async function refreshGeneration() {
    const projectId = project?.id;
    const job = projectId ? jobs.get(projectId) : undefined;
    if (!job || disposed) return;
    try {
      const result = await call("design_code_get_generation", { jobId: job.id });
      const next = readGenerationJob(result.job);
      if (next.id !== job.id || next.projectId !== projectId) throw new Error("任务状态不属于原项目，未更新当前任务。");
      jobs.set(next.projectId, next);
      if (project?.id === next.projectId) renderInspector();
      scheduleGenerationPoll();
    } catch (error) { if (project?.id === projectId) { aiStatus = `读取任务失败：${message(error)}。提案仍保留，可手动刷新。`; aiError = true; renderInspector(); } }
  }
  async function cancelGeneration() {
    const projectId = project?.id; const job = projectId ? jobs.get(projectId) : undefined;
    if (!job || job.status !== "running") return;
    try { const result = await call("design_code_cancel_generation", { jobId: job.id }); const next = readGenerationJob(result.job); if (next.id !== job.id || next.projectId !== projectId) throw new Error("停止结果不属于原项目。"); jobs.set(next.projectId, next); clearTimeout(jobTimer); if (project?.id === projectId) renderInspector(); }
    catch (error) { notify(message(error), true); }
  }
  async function applyGeneration() {
    const projectId = project?.id; const job = projectId ? jobs.get(projectId) : undefined;
    if (!project || !job || job.projectId !== project.id || job.status !== "completed" || appliedJobs.has(job.id)) return;
    if (hasDirty()) { notify("请先保存或协调源码草稿，再应用生成提案。", true); return; }
    queue = queue.then(async () => {
      if (!project || project.id !== projectId) { notify("项目已切换，提案尚未应用。"); return; }
      saving++; status = "正在应用提案…"; renderStatus();
      try {
        const result = await call("design_code_apply_generation", { jobId: job.id, expectedRevision: project.revision });
        if (project?.id !== projectId) { appliedJobs.add(job.id); notify("原项目的提案已应用，当前项目视图保持不变。"); return; }
        const next = await hydrate(result);
        if (!next || next.id !== projectId) throw new Error("应用结果不属于原项目。");
        appliedJobs.add(job.id); selection = undefined; accept(next);
        aiStatus = result.unchanged ? "提案没有文件改动，当前项目保持原样。" : "提案已应用到项目，可继续编辑和撤销。"; aiError = false;
      } catch (error) { aiStatus = `提案未应用：${message(error)}。原提案已保留，请基于最新修订协调。`; aiError = true; }
      finally { saving--; renderStatus(); renderInspector(); }
    });
    await queue;
  }
  async function history(direction: "undo" | "redo") {
    if (hasDirty()) { notify("请先保存或重新载入源码草稿，再撤销或重做。", true); return; }
    queue = queue.then(async () => {
      if (!project) return;
      saving++; status = direction === "undo" ? "正在撤销…" : "正在重做…"; renderStatus();
      try { const result = await call(`design_code_${direction}`, { projectId: project.id, expectedRevision: project.revision }); const next = await hydrate(result); if (next) { selection = undefined; accept(next); } }
      catch (error) { notify(message(error), true); }
      finally { saving--; renderStatus(); }
    });
    await queue;
  }
  async function exportProject(format: string) {
    if (!project) return;
    if (hasDirty()) { notify("请先保存源码草稿，再导出最新设计。", true); return; }
    const projectId = project.id;
    const pageId = root.querySelector<HTMLSelectElement>("[data-export-page]")?.value || activePageId;
    const viewport = root.querySelector<HTMLSelectElement>("[data-export-viewport]")?.value || undefined;
    saving++; status = "正在导出…"; renderStatus();
    try {
      const result = await call("design_code_export", { projectId, pageId, format, ...(viewport ? { viewportId: viewport } : {}) });
      if (typeof result.filename !== "string" || typeof result.mimeType !== "string" || typeof result.dataBase64 !== "string") throw new Error("导出器没有返回真实文件。");
      if (!bridge.download) throw new Error("当前宿主没有提供下载入口。可从当前聊天调用导出工具保存文件。");
      const delivery = await bridge.download({ filename: result.filename, mimeType: result.mimeType, dataBase64: result.dataBase64 });
      if (delivery.saved) notify(`已向宿主提交下载 ${result.filename}`);
      else if (delivery.unsupported) {
        const saved = await call("design_code_save_export", { projectId, pageId, format, ...(viewport ? { viewportId: viewport } : {}) });
        if (typeof saved.path !== "string") throw new Error("本地导出未返回保存路径。");
        notify(`已保存到 ${saved.path}`);
      } else notify(delivery.reason ?? "下载未完成或已取消。", true);
    } catch (error) { notify(message(error), true); }
    finally { saving--; status = "已保存"; renderStatus(); }
  }
  async function upload(file: File) {
    if (!project) return;
    if (file.size > 8 * 1024 * 1024) { notify("请选择不超过 8 MB 的素材。", true); return; }
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
    if (!allowed.includes(file.type)) { notify("支持 PNG、JPEG、WebP、GIF 与 SVG 素材。", true); return; }
    const safeName = file.name.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 120) || `image-${id("asset")}`;
    const path = `assets/${safeName}`;
    if (fileAt(path)) { notify("同名素材已存在，请重命名文件后再导入。", true); return; }
    try {
      const content = file.type === "image/svg+xml" ? await file.text() : await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      await update({ files: [{ path, content, encoding: file.type === "image/svg+xml" ? "utf8" : "base64", expectedHash: null }] }, `素材已加入 ${path}，可由源码或当前聊天引用。`);
    } catch (error) { notify(message(error), true); }
  }
  function assetMime(path: string) { const extension = path.split(".").at(-1)?.toLowerCase(); return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" } as Record<string, string>)[extension ?? ""]; }
  function openSource(path: string, source?: SourceElement) {
    if (!fileAt(path)) { notify("源文件已移除，请刷新项目后重新选择。", true); return; }
    activeFile = path; view = "source"; leftOpen = false; render();
    if (source) {
      const input = root.querySelector<HTMLTextAreaElement>(".dc-code-input");
      if (input) { input.focus(); input.setSelectionRange(Math.max(0, source.start), Math.min(input.value.length, source.end)); const line = input.value.slice(0, source.start).split("\n").length; input.scrollTop = Math.max(0, (line - 5) * 20); }
    }
  }
  async function action(action: string) {
    switch (action) {
      case "new": modal = "new"; render(); break;
      case "close-modal": modal = ""; render(); break;
      case "create-project": {
        if (hasDirty()) { notify("请先保存源码草稿，再创建项目。", true); break; }
        try { const serial = loadSerial; const result = await call("design_code_create", { name: newName.trim() || "未命名原型", template }); if (disposed || serial !== loadSerial) return; const next = await hydrate(result, true); if (next) { modal = ""; accept(next, true); } } catch (error) { notify(message(error), true); }
        break;
      }
      case "toggle-left": leftOpen = !leftOpen; rightOpen = false; render(); break;
      case "toggle-right": rightOpen = !rightOpen; leftOpen = false; render(); break;
      case "refresh": if (project) await loadProject(project.id, true); else await listProjects().catch(error => notify(message(error), true)); break;
      case "fit": fitCanvas(); break;
      case "zoom-in": zoom(scale * 1.25); break;
      case "zoom-out": zoom(scale / 1.25); break;
      case "save-source": await saveSource(); break;
      case "reset-source": resetSource(); break;
      case "new-file": modal = "file"; newFilePath = ""; render(); break;
      case "create-file": {
        const path = newFilePath.trim();
        if (!path) { notify("请输入文件路径。", true); break; }
        if (fileAt(path)) { notify("该文件已存在，不会覆盖。", true); break; }
        await update({ files: [{ path, content: "", encoding: "utf8", expectedHash: null }] });
        if (fileAt(path)) { modal = ""; openSource(path); }
        break;
      }
      case "source-selection": if (selection) openSource(selection.source.file, selection.source); break;
      case "apply-selection": await editSelection(); break;
      case "ai-selection": rightTab = "ai"; rightOpen = true; if (!aiPrompt) aiPrompt = "修改当前选中的元素："; renderInspector(); root.querySelector(".dc-body")?.classList.add("show-right"); break;
      case "ai": rightTab = "ai"; rightOpen = true; renderInspector(); root.querySelector(".dc-body")?.classList.add("show-right"); break;
      case "comment-selection": rightTab = "comments"; renderInspector(); break;
      case "add-comment": {
        if (!project || !commentDraft.trim()) { notify("请填写评论内容。", true); break; }
        const text = commentDraft.trim();
        if (selection) {
          if (!selectedIsCurrent()) { notify("请在最新预览中重新选择元素，再添加定位评论。", true); break; }
          try {
            const result = await call("design_code_add_comment", { projectId: project.id, expectedRevision: project.revision, sourceId: selection.source.id, fileHash: selection.fileHash, text });
            const next = await hydrate(result);
            if (next) { commentDraft = ""; selection = undefined; accept(next); }
          } catch (error) { notify(`评论未保存：${message(error)}`, true); }
        } else {
          const file = activeFile || currentPage()!.entry; const commentId = id("comment");
          await update(current => ({ comments: [...current.comments, { id: commentId, file, text, status: "open", createdAt: new Date().toISOString() }] }));
          if (project?.comments.some(comment => comment.id === commentId)) { commentDraft = ""; renderInspector(); }
        }
        break;
      }
      case "undo": await history("undo"); break;
      case "redo": await history("redo"); break;
      case "export": if (project) { exportPageId = activePageId; exportViewportId = activeViewport; modal = "export"; render(); } break;
      case "generate": await generate(); break;
      case "refresh-models": await loadModels(true); break;
      case "refresh-generation": await refreshGeneration(); break;
      case "cancel-generation": await cancelGeneration(); break;
      case "apply-generation": await applyGeneration(); break;
      case "list-drafts": await listProposalDrafts(); break;
      case "copy-prompt": try { await navigator.clipboard.writeText(fallbackPrompt); notify("提示词已复制，请粘贴到当前聊天。 "); } catch { const input = root.querySelector<HTMLTextAreaElement>(".dc-fallback textarea"); input?.focus(); input?.select(); notify("请按 ⌘C / Ctrl+C 复制已选择的提示词。"); } break;
    }
  }
  function onClick(event: MouseEvent) {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action],[data-file],[data-left-tab],[data-right-tab],[data-view],[data-mode],[data-template],[data-comment-resolve],[data-comment-anchor],[data-export],[data-draft-view],[data-draft-resume]");
    if (!target || !root.contains(target) || (target as HTMLButtonElement).disabled) return;
    if (target.dataset.action) { void action(target.dataset.action); return; }
    if (target.dataset.file) { openSource(target.dataset.file); return; }
    if (target.dataset.leftTab) { leftTab = target.dataset.leftTab; renderFilePanel(); root.querySelectorAll<HTMLElement>("[data-left-tab]").forEach(button => button.classList.toggle("active", button.dataset.leftTab === leftTab)); return; }
    if (target.dataset.rightTab) { rightTab = target.dataset.rightTab; renderInspector(); return; }
    if (target.dataset.view) { view = target.dataset.view; renderCanvas(); if (view === "design") requestAnimationFrame(() => fitCanvas()); return; }
    if (target.dataset.mode) { setMode(target.dataset.mode as "select" | "preview"); return; }
    if (target.dataset.template) { template = target.dataset.template as "html" | "react"; render(); return; }
    if (target.dataset.export) { void exportProject(target.dataset.export); return; }
    if (target.dataset.draftView) { void viewProposalDraft(target.dataset.draftView); return; }
    if (target.dataset.draftResume) { void resumeProposalDraft(target.dataset.draftResume); return; }
    if (target.dataset.commentResolve && project) { const commentId = target.dataset.commentResolve; void update(current => ({ comments: current.comments.map(comment => comment.id === commentId ? { ...comment, status: comment.status === "open" ? "resolved" : "open" } : comment) })); return; }
    if (target.dataset.commentAnchor && project) void focusComment(target.dataset.commentAnchor);
  }
  function onInput(event: Event) {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (input.hasAttribute("data-source-input")) {
      const draft = draftAt(activeFile); if (draft) { const wasDirty = draft.dirty; draft.content = input.value; draft.dirty = input.value !== activeSource()?.content; if (wasDirty !== draft.dirty) renderFilePanel(); const save = root.querySelector<HTMLButtonElement>('[data-action="save-source"]'); if (save) save.disabled = !draft.dirty || draft.conflict || saving > 0; const label = root.querySelector(".dc-code-head small"); if (label) label.textContent = draft.dirty ? "未保存" : "已保存"; }
    }
    if (input.hasAttribute("data-selection-text")) selectionText = input.value;
    if (input.dataset.selectionStyle) selectionStyles[input.dataset.selectionStyle] = input.value;
    if (input.hasAttribute("data-ai-prompt")) aiPrompt = input.value;
    if (input.hasAttribute("data-comment-draft")) commentDraft = input.value;
    if (input.hasAttribute("data-new-name")) newName = input.value;
    if (input.hasAttribute("data-new-file-path")) newFilePath = input.value;
  }
  function onChange(event: Event) {
    const input = event.target as HTMLSelectElement | HTMLInputElement;
    if (input.dataset.setting === "project") { if (input.value === "__new__") { modal = "new"; render(); } else if (input.value) void loadProject(input.value); }
    if (input.dataset.setting === "viewport") { viewportId = input.value; if (viewportId !== "all") activeViewport = viewportId; renderCanvas(); requestAnimationFrame(() => fitCanvas()); }
    if (input.dataset.setting === "page") void selectPage(input.value);
    if (input.hasAttribute("data-export-page") && project) {
      exportPageId = input.value;
      try { exportViewportId = resolveCodePageViewport(project, { pageId: exportPageId }).viewport.id; } catch { exportViewportId = ""; }
      render();
    }
    if (input.hasAttribute("data-export-viewport")) exportViewportId = input.value;
    if (input.hasAttribute("data-upload")) { const file = (input as HTMLInputElement).files?.[0]; if (file) void upload(file); }
    if (input.hasAttribute("data-ai-mode")) { aiMode = input.value === "codex" ? "codex" : "host"; renderInspector(); if (aiMode === "codex") void loadModels(); }
    if (input.hasAttribute("data-ai-model")) aiModel = input.value;
    if (input.hasAttribute("data-ai-direction")) aiDirection = input.value;
    if (input.hasAttribute("data-generation-budget")) generationBudgetMs = Number(input.value) === 900000 ? 900000 : 600000;
  }
  function onKeyDown(event: KeyboardEvent) {
    if (!root.isConnected || !root.contains(event.target as Node) && !root.contains(document.activeElement) && event.target !== document.body) return;
    if (event.key === "Escape") { if (modal) { modal = ""; render(); } else if (leftOpen || rightOpen) { leftOpen = false; rightOpen = false; root.querySelector(".dc-body")?.classList.remove("show-left", "show-right"); } else { setMode("select"); } return; }
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "s") { event.preventDefault(); void saveSource(); return; }
    if (modal && event.key === "Tab") {
      const elements = Array.from(root.querySelectorAll<HTMLElement>(".dc-modal input,.dc-modal select,.dc-modal textarea,.dc-modal button:not(:disabled)"));
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true],.dc-modal")) return;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); void history(event.shiftKey ? "redo" : "undo"); return; }
    if (event.code === "Space") { space = true; event.preventDefault(); }
    if (event.key === "0") fitCanvas();
    if (["Enter", " "].includes(event.key) && event.target instanceof HTMLElement && event.target.dataset.file) { event.preventDefault(); openSource(event.target.dataset.file); }
  }
  function onKeyUp(event: KeyboardEvent) { if (event.code === "Space") space = false; }
  function onWheel(event: WheelEvent) {
    const canvas = (event.target as HTMLElement).closest<HTMLElement>(".dc-canvas"); if (!canvas || !project) return;
    event.preventDefault(); const rect = canvas.getBoundingClientRect();
    if (event.metaKey || event.ctrlKey) zoom(scale * Math.exp(-event.deltaY * .008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    else { offset.x -= event.deltaX; offset.y -= event.deltaY; transform(); }
  }
  function onPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement; const canvas = target.closest<HTMLElement>(".dc-canvas");
    if (!canvas || target.closest("button,select,input,textarea") || event.button > 1 || !project) return;
    const pan = space || event.button === 1 || target === canvas || !!target.closest(".dc-frame-title");
    if (!pan) return;
    event.preventDefault(); pointerCleanup?.(); canvas.classList.add("panning");
    const start = { x: event.clientX, y: event.clientY }; const before = { ...offset };
    for (const frame of frames) frame.iframe.style.pointerEvents = "none";
    const move = (event: PointerEvent) => { offset = { x: before.x + event.clientX - start.x, y: before.y + event.clientY - start.y }; transform(); };
    const end = () => { canvas.classList.remove("panning"); for (const frame of frames) frame.iframe.style.pointerEvents = ""; pointerCleanup?.(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
    pointerCleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); pointerCleanup = undefined; };
  }
  function schedulePoll() {
    clearTimeout(pollTimer); if (disposed) return;
    pollTimer = setTimeout(async () => {
      if (project && connected && !saving && !compiling && !modal && !pointerCleanup && !document.hidden) {
        const currentId = project.id;
        try { const result = await call("design_code_get", { projectId: currentId, ifRevision: project.revision }); if (project?.id === currentId && isProject(result.project) && result.project.revision > project.revision) { updateMetadata(result); accept(result.project); } }
        catch { /* The host lifecycle reports disconnection; polling does not fabricate state. */ }
      }
      schedulePoll();
    }, 3000);
  }
  function receive(result: unknown) {
    if (!result || typeof result !== "object") return;
    const wrapper = result as Record<string, unknown>; const data = wrapper.structuredContent && typeof wrapper.structuredContent === "object" ? wrapper.structuredContent as Record<string, unknown> : wrapper;
    if (data.job && typeof data.job === "object" && "verification" in data.job) {
      try { const job = readGenerationJob(data.job); jobs.set(job.projectId, job); if (job.projectId === project?.id) renderInspector(); scheduleGenerationPoll(); } catch { /* Other tool results do not define a code-generation job. */ }
    }
    if (isProject(data.project) && (!project || data.project.id === project.id)) {
      if (Array.isArray(data.files)) { updateMetadata(data); accept(data.project); }
      else void loadProject(data.project.id);
    }
  }
  root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onChange); root.addEventListener("wheel", onWheel, { passive: false }); root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("message", onMessage); window.addEventListener("keydown", onKeyDown); window.addEventListener("keyup", onKeyUp);
  render();
  return {
    connecting() { status = "正在连接宿主…"; renderStatus(); },
    async connected() { if (disposed) return; connected = true; status = "已连接"; renderStatus(); await Promise.allSettled([listProjects().catch(error => notify(message(error), true)), loadDirections()]); schedulePoll(); },
    disconnected(error: unknown) { connected = false; status = `连接不可用：${message(error)}`; renderStatus(); notify(status, true); },
    async setProjectId(projectId: string) { if (connected && project?.id !== projectId) await loadProject(projectId); },
    receive,
    async teardown() { disposed = true; ++loadSerial; ++previewSerial; clearTimeout(pollTimer); clearTimeout(toastTimer); clearTimeout(jobTimer); pointerCleanup?.(); root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onChange); root.removeEventListener("wheel", onWheel); root.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); await queue; },
  };
}
