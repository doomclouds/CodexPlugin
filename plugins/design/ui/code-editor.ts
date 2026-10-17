import type { CodeFile, CodePage, CodeProject, CodeProjectUpdate, CodeViewport, SourceStatus, SourceComparison } from "../src/code-project.ts";
import { injectCodePageRuntimeLocation, resolveCodePage, resolveCodePageViewport } from "../src/code-pages.ts";
import { acceptsCodeRevisionAck, sameCodeRenderInputs } from "../src/code-render-inputs.ts";
import type { CssTokenCatalog, CssTokenDefinition } from "../src/code-tokens.ts";
import { designTaskContext, designTaskPrompt } from "../src/design-task-context.ts";
import type { HostPromptIntent, HostPromptResult } from "./host-delivery.ts";
import type { DesignReferenceChoice, DesignReferenceMetadata } from "../src/design-references.ts";
import { DESIGN_REFERENCE_VERSION } from "../src/design-reference-format.ts";
import { CommentAnchorIndex } from "./comment-anchors.ts";
import { limitLiveBoards, PAGE_PREVIEW_LIMITS, pagePreviewKey, PagePreviewPool, PreviewBudgetError, PreviewStaleError } from "./page-previews.ts";
import "./code-editor.css";

export interface CodeEditorBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(text: string, context?: unknown, intent?: HostPromptIntent): Promise<HostPromptResult>;
  download?(file: { filename: string; mimeType: string; dataBase64?: string; text?: string }): Promise<{ saved: boolean; unsupported?: boolean; reason?: string }>;
  openLink?(url: string): Promise<{ opened: boolean; reason?: string }>;
}
interface ProjectSummary { id: string; name: string; revision: number; updatedAt: string }
interface UnsupportedProject { id: string; format?: number | string; reason: string }
interface FileSummary { path: string; sha256: string; encoding?: string; bytes?: number }
interface HistoryMetadata { projectId: string; revision: number; canUndo: boolean; canRedo: boolean }
interface SourceElement { id: string; file: string; start: number; end: number; tag: string; editableText: boolean; fileHash?: string; identity?: "stable" | "ephemeral" }
interface Diagnostic { level: string; message: string; file?: string; line?: number }
interface Preview { projectId: string; revision: number; compiledRevision: number; compiledSuccessfully: boolean; pageId: string; pages: CodePage[]; renderIdentity: string; fileHashes: Record<string, string>; html: string; diagnostics: Diagnostic[]; sources: SourceElement[] }
interface Selection { source: SourceElement; revision: number; pageId: string; fileHash: string; text: string; styles: Record<string, string>; viewportId: string; runtimeLiteralText?: boolean; ancestorMapped?: boolean }
interface Draft { content: string; baseHash: string | null; dirty: boolean; conflict: boolean }
interface FrameRecord { key: string; cacheKey: string; wrapper: HTMLElement; visible: boolean; usedAt: number; runtimeDiagnostics: Diagnostic[]; projectId: string; pageId: string; viewportId: string; revision: number; desiredRevision: number; renderIdentity: string; fileHashes: Record<string, string>; iframe: HTMLIFrameElement; ready?: boolean; retired?: boolean; pendingFocus?: string; syncing?: { from: number; to: number; nonce: string; timer: ReturnType<typeof setTimeout> } }
interface CanvasBoard { key: string; page: CodePage; viewport?: CodeViewport; error?: string; width: number; height: number; x: number; y: number; captionHeight: number }
interface BoardElements { wrapper: HTMLElement; caption: HTMLElement; signature: string }
interface PageLocation { projectId: string; revision: number; pageId: string; href: string; hash: string; search: string }
interface ModelSummary { id: string; displayName?: string; isDefault?: boolean }
interface VisualDirection { id: string; name: string; summary: string }
interface ReferenceExample { id: DesignReferenceChoice; title: string; task: string; relation: string }
interface GenerationVerification { compiled: boolean; rendered: boolean; modelReviewed: boolean; viewports: number; pages?: string[] }
interface ProposalDraft { id: string; projectId: string; baseRevision: number; originJobId: string; status: "unverified"; requiresReview: true; stage: string; verification: GenerationVerification; createdAt: string; updatedAt: string; expiresAt: string; expired: boolean; resumable: boolean; captureCount: number; reviewPageIds: string[]; originStatus: string; lastError?: string; reference: DesignReferenceMetadata }
interface DraftDetails { draft: ProposalDraft; files: FileSummary[]; captures: { pageId: string; viewportId: string; width: number; height: number; sha256: string }[] }
interface GenerationJob { id: string; projectId: string; baseRevision: number; status: "running" | "completed" | "failed" | "cancelled"; model?: string; changes?: CodeProjectUpdate; log: string[]; error?: string; verification: GenerationVerification; budgetMs?: number; reviewPageIds?: string[]; draft?: ProposalDraft; reference: DesignReferenceMetadata }
interface SourceSide { path: string; encoding: string; sha256: string; bytes: number; content?: string; binary?: boolean }
interface SourceFileDifference { projectId: string; revision: number; file: string; projectFile: SourceSide | null; directoryFile: SourceSide | null; difference: SourceComparison["files"][number] }
interface SourceDifferenceNotice { projectId: string; file: string; invalidated: boolean; reading: boolean; error?: string; detail?: string }
interface EditorFocus { projectId?: string; selector: string; inModal: boolean; start?: number | null; end?: number | null; direction?: "forward" | "backward" | "none" | null; top: number; left: number }
interface HistoryFocusOwner { projectId: string; loadSerial: number; action: "undo" | "redo"; anchor: HTMLElement; inFlight: boolean }
interface CssTokenDraft { definition: CssTokenDefinition; value: string }
interface CssTokenState { catalog?: CssTokenCatalog; file: string; offset: number; serial: number; loading: boolean; applying: boolean; error: string; drafts: Map<string, CssTokenDraft> }
interface ImportedArchiveCopy { projectId: string; name: string; importedFrom: { projectId: string; revision: number }; archiveSha256: string }
interface ArchiveOperation { ticket: number; phase: "reading" | "submitted"; fileName: string; reader?: FileReader; submitFocused: boolean }
interface AiDraftState { prompt: string; status: string; error: boolean; fallback: string; unknown: boolean; referenceId: DesignReferenceChoice; directionId: string }

const svgPaths: Record<string, string> = {
  plus: "M10 3v14M3 10h14", close: "M5 5l10 10M15 5L5 15", arrow: "M4 10h12M10 4l6 6-6 6", cursor: "M4 3l13 8-6 1-3 6z", play: "M6 3l11 7-11 7z", code: "M7 5l-5 5 5 5M13 5l5 5-5 5M12 2L8 18", file: "M4 2h8l4 4v12H4zM12 2v5h4", component: "M10 2l8 8-8 8-8-8zM6 6l8 8M14 6l-8 8", undo: "M7 4L3 8l4 4M3 8h9a5 5 0 010 10", redo: "M13 4l4 4-4 4M17 8H8a5 5 0 000 10", refresh: "M17 7a7 7 0 00-12-3L2 7M2 2v5h5M3 13a7 7 0 0012 3l3-3M18 18v-5h-5", download: "M10 2v11M6 9l4 4 4-4M3 14v4h14v-4", spark: "M10 2l2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5z", comment: "M3 3h14v11H9l-6 4z", check: "M3 10l5 5L17 5", fit: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4", minus: "M3 10h14", copy: "M7 7h10v11H7zM13 7V2H3v11h4", panelLeft: "M2 3h16v14H2zM7 3v14", panelRight: "M2 3h16v14H2zM13 3v14", desktop: "M2 3h16v11H2zM10 14v4M6 18h8", mobile: "M6 1h8v18H6zM9 16h2", image: "M3 3h14v14H3zM3 14l5-5 4 4 2-2 3 3M13 6h.01", save: "M3 2h12l3 3v13H3zM6 2v6h8V2M6 12h9v6", upload: "M10 14V3M6 7l4-4 4 4M3 13v5h14v-5", settings: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4", trash: "M3 5h14M8 2h4l1 3M5 5l1 13h8l1-13M8 8v7M12 8v7",
};
const icon = (key: string) => `<svg class="dc-icon" aria-hidden="true" viewBox="0 0 20 20"><path d="${svgPaths[key] ?? svgPaths.file}"/></svg>`;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const isProject = (value: unknown): value is CodeProject => !!value && typeof value === "object" && (value as CodeProject).schemaVersion === 3 && typeof (value as CodeProject).defaultPageId === "string" && Array.isArray((value as CodeProject).pages) && Array.isArray((value as CodeProject).files) && typeof (value as CodeProject).revision === "number";
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
  let changingPreviewScope = false;
  const previewPool = new PagePreviewPool<Preview>({ onEvict: (key, value, reason) => {
    commentAnchors.forget(value.projectId, value.revision, value.pageId);
    if (changingPreviewScope) return;
    for (const frame of [...frames]) if (frame.cacheKey === key && (reason === "budget" || !frame.visible)) removeFrame(frame, true);
    if (preview && pagePreviewKey(preview.projectId, preview.revision, preview.pageId) === key) preview = undefined;
  } });
  const pageStates = new Map<string, { status: "loading" | "error" | "budget"; message?: string }>();
  const boardElements = new Map<string, BoardElements>();
  let canvasMode: "single" | "overview" = "single";
  let overviewPageIds: string[] = [];
  const overviewViewportIds = new Map<string, string>();
  const cameras = new Map<string, { scale: number; offset: { x: number; y: number } }>();
  const commentAnchors = new CommentAnchorIndex();
  const commentChecks = new Map<string, Promise<void>>();
  let commentRegistryEpoch = 0;
  const historyRequests = new Map<string, Promise<void>>();
  let historyMetadata: HistoryMetadata | undefined;
  let historyFocusOwner: HistoryFocusOwner | undefined;
  let movingHistoryFocus = false;
  let historyHeaderRendering = false;
  const tokenStates = new Map<string, CssTokenState>();
  let activePageId = "";
  const pageLocations = new Map<string, PageLocation>();
  let cameraSerial = 0;
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
  let renderedModal = "";
  let modalReturnFocus: EditorFocus | undefined;
  let modalControlFocus: EditorFocus | undefined;
  const archiveLimit = 32 * 1024 * 1024;
  let selectedArchive: File | undefined;
  let archiveName = "";
  let archiveError = "";
  let archiveErrorHint = "";
  let archiveErrorDetail = "";
  let archiveBackgroundError: { fileName: string; hint: string; detail: string } | undefined;
  let archiveTicket = 0;
  let archiveOperation: ArchiveOperation | undefined;
  let archiveNotice: ImportedArchiveCopy | undefined;
  const notifiedArchives = new Set<string>();
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
  let aiReference: DesignReferenceChoice = "auto";
  let generationBudgetMs = 600000;
  let directions: VisualDirection[] = [];
  let referenceExamples: ReferenceExample[] = [];
  let models: ModelSummary[] = [];
  let modelsLoaded = false;
  let modelsLoading = false;
  let modelsError = "";
  let generationStarting = false;
  const generationStarts = new Set<string>();
  const generationTickets = new Map<string, number>();
  let nextGenerationTicket = 0;
  const aiDraftStates = new Map<string, AiDraftState>();
  let deliveryUnknown = false;
  const jobs = new Map<string, GenerationJob>();
  const proposalDrafts = new Map<string, ProposalDraft[]>();
  const draftDetails = new Map<string, DraftDetails>();
  const sourceStatuses = new Map<string, SourceStatus>();
  const sourceComparisons = new Map<string, SourceComparison>();
  const sourceSelections = new Map<string, Set<string>>();
  const sourceBusy = new Set<string>();
  let sourceDirectoryInput = "";
  let sourceImportName = "导入的工程";
  let sourceImportEntry = "";
  let sourceImportStarting = false;
  let sourceFileDifference: SourceFileDifference | undefined;
  let sourceDifferenceNotice: SourceDifferenceNotice | undefined;
  let sourceDifferenceSerial = 0;
  let sourceError = "";
  const draftsLoaded = new Set<string>();
  const draftsLoading = new Set<string>();
  let unsupportedDrafts: Array<{ id: string; format: string | number; reason: string }> = [];
  let draftListTicket = 0;
  const appliedJobs = new Set<string>();
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let aiStatus = "";
  let aiError = false;
  let fallbackPrompt = "";
  let status = "尚未连接宿主";
  let connected = false;
  let disposed = false;
  const captionObserver = new ResizeObserver(() => { if (!disposed && view === "design") transform(); });
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
  function aiDraftState(): AiDraftState { return { prompt: aiPrompt, status: aiStatus, error: aiError, fallback: fallbackPrompt, unknown: deliveryUnknown, referenceId: aiReference, directionId: aiDirection }; }
  function updateAiState(projectId: string, patch: Partial<AiDraftState>) {
    const previous = project?.id === projectId ? aiDraftState() : aiDraftStates.get(projectId) ?? { prompt: "", status: "", error: false, fallback: "", unknown: false, referenceId: "auto", directionId: "auto" };
    const next = { ...previous, ...patch }; aiDraftStates.set(projectId, next);
    if (project?.id === projectId) { aiPrompt = next.prompt; aiStatus = next.status; aiError = next.error; fallbackPrompt = next.fallback; deliveryUnknown = next.unknown; aiReference = next.referenceId; aiDirection = next.directionId; }
  }
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
  function tokenState(projectId = project?.id): CssTokenState | undefined {
    if (!projectId) return;
    let state = tokenStates.get(projectId);
    if (!state) { state = { file: "", offset: 0, serial: 0, loading: false, applying: false, error: "", drafts: new Map() }; tokenStates.set(projectId, state); }
    return state;
  }
  function tokenDraftStale(draft: CssTokenDraft) { return hashes.get(draft.definition.file) !== draft.definition.fileHash; }
  function canApplyTokens(state: CssTokenState) { return !!project && !state.loading && !state.applying && !saving && !hasDirty() && state.catalog?.projectId === project.id && state.catalog.revision === project.revision && state.drafts.size > 0 && [...state.drafts.values()].every(draft => !tokenDraftStale(draft)); }
  function literalTokenColor(value: string) {
    const text = value.trim();
    return /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d\s.,%/+\-]+\))$/i.test(text) && CSS.supports("color", text) ? text : undefined;
  }
  function updateTokenActions() {
    const state = tokenState(); if (!state || leftTab !== "system") return;
    const count = root.querySelector("[data-token-draft-count]"); if (count) count.textContent = state.drafts.size ? `${state.drafts.size} 项尚未应用` : "没有未应用的修改";
    const apply = root.querySelector<HTMLButtonElement>('[data-action="apply-tokens"]'); if (apply) { apply.disabled = !canApplyTokens(state); apply.textContent = state.applying ? "正在应用…" : "应用暂存修改"; }
    const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel-tokens"]'); if (cancel) cancel.disabled = !state.drafts.size || state.applying;
    for (const card of root.querySelectorAll<HTMLElement>("[data-token-card]")) {
      const draft = state.drafts.get(card.dataset.tokenCard!); card.classList.toggle("dirty", !!draft);
      const action = card.querySelector<HTMLButtonElement>("[data-token-cancel]"); if (action) action.hidden = !draft;
      const status = card.querySelector("[data-token-status]"); if (status) status.textContent = draft ? tokenDraftStale(draft) ? "源码已变化，暂存保留" : "已暂存" : "";
      const swatch = card.querySelector<HTMLElement>("[data-token-swatch]"), input = card.querySelector<HTMLTextAreaElement>("[data-token-value]");
      if (swatch && input) { const color = literalTokenColor(input.value); swatch.hidden = !color; swatch.style.backgroundColor = color ?? ""; }
    }
  }
  function parkTokenAction() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-token-actions]")) root.querySelector<HTMLElement>("[data-token-actions]")?.focus({ preventScroll: true });
  }
  async function loadTokens(offset?: number) {
    if (!project || disposed) return;
    const state = tokenState()!, projectId = project.id, revision = project.revision, scope = loadSerial, serial = ++state.serial;
    if (offset !== undefined) state.offset = Math.max(0, offset);
    const file = state.file, requestedOffset = state.offset;
    state.loading = true; state.error = ""; if (leftTab === "system") renderFilePanel();
    try {
      const result = await call("design_code_list_tokens", { projectId, ...(file ? { file } : {}), offset: requestedOffset, limit: 50 });
      if (disposed || project?.id !== projectId || project.revision !== revision || loadSerial !== scope || state.serial !== serial) return;
      const catalog = result as unknown as CssTokenCatalog;
      if (catalog.projectId !== projectId || catalog.revision !== revision || catalog.sourceOnly !== true || !Array.isArray(catalog.definitions) || !Array.isArray(catalog.diagnostics)) throw new Error("令牌列表与当前源码修订不一致，请重新读取。");
      state.catalog = catalog;
    } catch (error) { if (!disposed && project?.id === projectId && loadSerial === scope && state.serial === serial) state.error = `读取失败：${message(error)}。已有暂存未丢失。`; }
    finally { if (state.serial === serial) state.loading = false; if (!disposed && project?.id === projectId && loadSerial === scope && leftTab === "system") renderFilePanel(); }
  }
  async function applyTokens() {
    const state = tokenState(); if (!project || !state || !canApplyTokens(state)) return;
    const projectId = project.id, revision = project.revision, scope = loadSerial;
    const edits = [...state.drafts.values()].map(draft => ({ sourceId: draft.definition.sourceId, file: draft.definition.file, fileHash: draft.definition.fileHash, value: draft.value }));
    parkTokenAction(); state.applying = true; state.error = ""; renderFilePanel();
    queue = queue.then(async () => {
      if (disposed || project?.id !== projectId || loadSerial !== scope || project.revision !== revision || saving || hasDirty()) { state.error = "项目或源码已变化，未提交。暂存保留，请重新核对。"; return; }
      saving++; status = "正在应用 CSS 令牌…"; renderStatus();
      try {
        const result = await call("design_code_edit_tokens", { projectId, expectedRevision: revision, edits });
        if (!isProject(result.project) || result.project.id !== projectId) throw new Error("工具没有返回原项目的保存结果。");
        if (disposed || project?.id !== projectId || loadSerial !== scope) return;
        const next = await hydrate(result); if (!next || project?.id !== projectId || loadSerial !== scope) return;
        accept(next);
        for (const edit of edits) { const draft = state.drafts.get(edit.sourceId); if (draft?.value === edit.value && draft.definition.fileHash === edit.fileHash) state.drafts.delete(edit.sourceId); }
        state.catalog = undefined; await loadTokens();
        notify("CSS 令牌已写入源码，预览按保存后的源码更新。");
      } catch (error) { state.error = `未完成应用：${message(error)}。暂存保留；请重新读取并核对源码后继续。`; }
      finally { saving--; renderStatus(); }
    }).finally(() => { state.applying = false; if (!disposed && project?.id === projectId && leftTab === "system") renderFilePanel(); });
    await queue;
  }
  function currentPage(): CodePage | undefined { return project ? resolveCodePage(project, activePageId || undefined) : undefined; }
  function selectedIsCurrent() { return !!selection && !!project && selection.pageId === activePageId && selection.revision === project.revision && selection.fileHash === hashes.get(selection.source.file); }
  function matchingViewports(pageId = activePageId) { return project?.viewports.filter(viewport => !viewport.pageId || viewport.pageId === pageId) ?? []; }
  function normalizeViewports() {
    if (!project) return;
    const choices = matchingViewports();
    if (viewportId === "all" && choices.length > PAGE_PREVIEW_LIMITS.liveFrames) viewportId = choices.some(item => item.id === activeViewport) ? activeViewport : choices[0]?.id ?? "all";
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
    const retainPreview = !force && !!project && sameCodeRenderInputs(project, next);
    if (changed) {
      if (project) aiDraftStates.set(project.id, aiDraftState());
      drafts.clear(); selection = undefined; activePageId = next.defaultPageId; activeFile = resolveCodePage(next).entry; viewportId = "all"; activeViewport = "";
      canvasMode = "single"; overviewPageIds = [next.defaultPageId, ...next.pages.filter(page => page.id !== next.defaultPageId).map(page => page.id)].slice(0, 2); overviewViewportIds.clear(); cameras.clear(); pageLocations.clear(); releasedBoards.clear(); clearFrames(); for (const board of boardElements.values()) { board.wrapper.remove(); captionObserver.unobserve(board.caption); board.caption.remove(); } boardElements.clear();
      const aiDraft = aiDraftStates.get(next.id);
      aiPrompt = aiDraft?.prompt ?? ""; aiStatus = aiDraft?.status ?? ""; aiError = aiDraft?.error ?? false; fallbackPrompt = aiDraft?.fallback ?? ""; deliveryUnknown = aiDraft?.unknown ?? false; aiReference = aiDraft?.referenceId ?? "auto"; aiDirection = aiDraft?.directionId ?? "auto"; generationStarting = generationStarts.has(next.id);
      sourceDirectoryInput = ""; sourceError = ""; sourceFileDifference = undefined; sourceDifferenceNotice = undefined; sourceDifferenceSerial++;
    }
    if (revisionChanged) { sourceComparisons.delete(next.id); sourceSelections.delete(next.id); }
    if (revisionChanged || force) {
      const retained = retainPreview ? previewPool.values().filter(item => item.value.revision === project!.revision && previewHashesCurrent(item.value.fileHashes)).map(item => ({ ...item, value: { ...item.value, revision: next.revision } })) : [];
      commentRegistryEpoch++; commentAnchors.reset(next, !changed && !force); historyMetadata = undefined;
      changingPreviewScope = true; if (force) for (const entry of previewPool.values()) previewPool.delete(entry.key); previewPool.setScope(`${next.id}:${next.revision}`); changingPreviewScope = false; pageStates.clear();
      if (retainPreview) for (const frame of frames) { frame.desiredRevision = next.revision; frame.cacheKey = pagePreviewKey(next.id, next.revision, frame.pageId); }
      previewPool.setProtected(retained.filter(item => frames.some(frame => frame.visible && frame.pageId === item.value.pageId)).map(item => pagePreviewKey(next.id, next.revision, item.value.pageId)));
      for (const item of retained) try { previewPool.put(pagePreviewKey(next.id, next.revision, item.value.pageId), item.value, { registryOnly: item.registryOnly }); } catch (error) { pageStates.set(pagePreviewKey(next.id, next.revision, item.value.pageId), { status: "budget", message: message(error) }); }
      if (retainPreview) {
        preview = previewPool.get(pagePreviewKey(next.id, next.revision, activePageId));
        for (const [pageId, location] of pageLocations) pageLocations.set(pageId, { ...location, revision: next.revision });
      } else { for (const frame of frames) if (frame.syncing) { clearTimeout(frame.syncing.timer); frame.syncing = undefined; } preview = undefined; pageLocations.clear(); if (force) clearFrames(); }
    }
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
    overviewPageIds = overviewPageIds.filter(pageId => next.pages.some(page => page.id === pageId)).slice(0, PAGE_PREVIEW_LIMITS.liveFrames);
    if (!overviewPageIds.length) overviewPageIds = [next.defaultPageId];
    normalizeViewports();
    projects = [{ id: next.id, name: next.name, revision: next.revision, updatedAt: next.updatedAt }, ...projects.filter(item => item.id !== next.id)];
    status = "已保存";
    render();
    if (retainPreview) { for (const frame of frames) syncFrameRevision(frame); }
    void refreshVisiblePreviews(fit || changed);
    void checkCommentAnchors();
    void refreshHistoryMetadata();
    if (leftTab === "system" && !tokenState()?.applying) void loadTokens();
    scheduleGenerationPoll();
  }
  async function loadProject(projectId: string, force = false) {
    if (project?.id !== projectId && hasDirty()) { notify("请先保存或重新载入源码草稿，再切换项目。", true); renderHeader(); return; }
    const serial = ++loadSerial;
    try {
      const result = await call("design_code_get", { projectId });
      if (serial !== loadSerial || disposed) return;
      if (project?.id !== projectId && hasDirty()) { notify("读取期间出现了新的源码草稿，已保留当前项目。请先保存或协调草稿，再显式打开新项目。", true); renderHeader(); return; }
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
  function refreshCommentLocations() {
    if (!project || modal || rightTab !== "comments") return;
    for (const element of root.querySelectorAll<HTMLElement>("[data-comment-location]")) {
      const comment = project.comments.find(comment => comment.id === element.dataset.commentLocation);
      if (!comment) continue;
      const state = commentAnchors.resolve(comment), markup = commentLocationMarkup(comment);
      element.dataset.anchorState = state.status;
      if (element.innerHTML !== markup) element.innerHTML = markup;
    }
  }
  function pageResource(pageId: string): Preview | undefined { return project ? previewPool.get(pagePreviewKey(project.id, project.revision, pageId)) : undefined; }
  function frameResource(frame: FrameRecord): Preview | undefined {
    const resource = previewPool.getRegistry(frame.cacheKey);
    return resource && project && resource.projectId === project.id && resource.revision === project.revision && resource.pageId === frame.pageId && resource.renderIdentity === frame.renderIdentity ? resource : undefined;
  }
  function loadPagePreview(snapshot: CodeProject, pageId: string, background = false): Promise<Preview> {
    const key = pagePreviewKey(snapshot.id, snapshot.revision, pageId), scope = `${snapshot.id}:${snapshot.revision}`;
    if (scope !== `${project?.id}:${project?.revision}`) return Promise.reject(new PreviewStaleError());
    commentAnchors.begin(snapshot.id, snapshot.revision, pageId);
    if (!background) pageStates.set(key, { status: "loading" });
    refreshCommentLocations();
    return previewPool.request(key, async () => {
      const result = await call("design_code_preview", { projectId: snapshot.id, pageId });
      if (typeof result.html !== "string" || result.projectId !== snapshot.id || result.pageId !== pageId || result.revision !== snapshot.revision) throw new PreviewStaleError();
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics as Diagnostic[] : [];
      return { projectId: snapshot.id, revision: result.revision, compiledRevision: result.revision, compiledSuccessfully: !diagnostics.some(diagnostic => diagnostic.level === "error"), pageId, pages: Array.isArray(result.pages) ? result.pages as CodePage[] : snapshot.pages, renderIdentity: typeof result.renderIdentity === "string" ? result.renderIdentity : "", fileHashes: result.fileHashes && typeof result.fileHashes === "object" ? result.fileHashes as Record<string, string> : {}, html: result.html, diagnostics, sources: Array.isArray(result.sources) ? result.sources as SourceElement[] : [] };
    }, { scope, priority: background ? "background" : "visible", registryOnly: background }).then(resource => {
      if (project?.id !== snapshot.id || project.revision !== snapshot.revision || disposed) throw new PreviewStaleError();
      // The shared cache has already accepted the bytes before the index keeps its array reference.
      commentAnchors.record(resource); pageStates.delete(key);
      if (pageId === activePageId) preview = previewPool.get(key);
      if (!background) renderCanvas();
      refreshCommentLocations(); return resource;
    }).catch(error => {
      if (!(error instanceof PreviewStaleError) && project?.id === snapshot.id && project.revision === snapshot.revision) {
        pageStates.set(key, { status: error instanceof PreviewBudgetError ? "budget" : "error", message: message(error) });
        commentAnchors.fail(snapshot.id, snapshot.revision, pageId, message(error));
        if (!background) renderCanvas();
      }
      throw error;
    }).finally(() => { compiling = previewPool.stats().active > 0; if (!disposed) { renderStatus(); refreshCommentLocations(); } });
  }
  function checkCommentAnchors(allPages = false): Promise<void> {
    if (!project || disposed || !project.comments.some(comment => comment.sourceId && project!.files.some(file => file.path === comment.file))) return Promise.resolve();
    const snapshot = project, epoch = commentRegistryEpoch, key = `${snapshot.id}:${snapshot.revision}:${epoch}:${allPages ? "all" : "visible"}`;
    const existing = commentChecks.get(key); if (existing) return existing;
    if (allPages) commentAnchors.retryUnknown();
    const candidates = allPages ? snapshot.pages.map(page => page.id) : [...new Set([...canvasBoards().map(board => board.page.id), ...snapshot.pages.filter(page => snapshot.comments.some(comment => comment.file === page.entry)).map(page => page.id)])];
    const run = (async () => {
      for (const pageId of candidates) {
        if (disposed || epoch !== commentRegistryEpoch || !commentAnchors.isCurrent(snapshot.id, snapshot.revision)) break;
        const cacheKey = pagePreviewKey(snapshot.id, snapshot.revision, pageId), cached = previewPool.getRegistry(cacheKey);
        if (cached) { commentAnchors.record(cached); continue; }
        try { await loadPagePreview(snapshot, pageId, true); } catch { /* Failed or evicted pages remain explicitly unknown. */ }
      }
    })().finally(() => { commentChecks.delete(key); if (!disposed) refreshCommentLocations(); });
    commentChecks.set(key, run); return run;
  }
  function refreshHistoryMetadata(): Promise<void> {
    if (!project || disposed) return Promise.resolve();
    const projectId = project.id, revision = project.revision, key = `${projectId}:${revision}`;
    const existing = historyRequests.get(key); if (existing) return existing;
    const request = (async () => {
      try {
        const result = await call("design_code_history", { projectId });
        if (disposed || project?.id !== projectId || project.revision !== revision) return;
        if (result.revision !== revision) { void loadProject(projectId); return; }
        if (typeof result.canUndo !== "boolean" || typeof result.canRedo !== "boolean") throw new Error("历史状态尚未核实。");
        historyMetadata = { projectId, revision, canUndo: result.canUndo, canRedo: result.canRedo };
      } catch { /* Unknown history availability stays disabled; refresh retries it. */ }
      finally { historyRequests.delete(key); if (!disposed) renderStatus(); }
    })();
    historyRequests.set(key, request); return request;
  }
  async function refreshVisiblePreviews(fit = false) {
    if (!project || disposed) return;
    const snapshot = project, serial = ++previewSerial, cameraVersion = cameraSerial;
    const pages = [...new Set(canvasBoards().map(board => board.page.id))];
    previewPool.setProtected(pages.map(pageId => pagePreviewKey(snapshot.id, snapshot.revision, pageId)));
    compiling = true; renderStatus();
    await Promise.allSettled(pages.map(pageId => loadPagePreview(snapshot, pageId)));
    if (serial !== previewSerial || project?.id !== snapshot.id || project.revision !== snapshot.revision || disposed) return;
    preview = pageResource(activePageId);
    if (selection) { const resource = pageResource(selection.pageId); if (resource && !resource.sources.some(source => source.id === selection!.source.id && source.file === selection!.source.file)) selection = undefined; }
    renderCanvas(); renderInspector(); compiling = previewPool.stats().active > 0; renderStatus();
    if (fit && cameraSerial === cameraVersion) requestAnimationFrame(() => { if (!disposed && cameraSerial === cameraVersion) fitCanvas(); });
  }
  async function refreshPreview(fit = false) { await refreshVisiblePreviews(fit); }
  function cameraKey() { return canvasMode === "overview" ? "overview" : `single:${activePageId}`; }
  function saveCamera() { cameras.set(cameraKey(), { scale, offset: { ...offset } }); }
  function restoreCamera(): boolean { const camera = cameras.get(cameraKey()); if (!camera) return false; scale = camera.scale; offset = { ...camera.offset }; cameraSerial++; return true; }
  function activateBoard(pageId: string, selectedViewport?: string) {
    if (!project || !project.pages.some(page => page.id === pageId)) return;
    const different = activePageId !== pageId || selectedViewport !== undefined && activeViewport !== selectedViewport;
    if (different) selection = undefined;
    if (activePageId !== pageId) activeFile = resolveCodePage(project, pageId).entry;
    activePageId = pageId;
    if (selectedViewport) activeViewport = selectedViewport;
    normalizeViewports(); preview = pageResource(pageId);
    renderCanvas(); renderHeader(); renderFilePanel(); renderInspector(); renderProjectNotice();
  }
  function showOverview() {
    if (!project) return;
    if (canvasMode !== "overview") { saveCamera(); canvasMode = "overview"; const board = canvasBoards().find(item => item.page.id === activePageId) ?? canvasBoards()[0]; if (board) { if (activePageId !== board.page.id || activeViewport !== board.viewport?.id) selection = undefined; activePageId = board.page.id; activeViewport = board.viewport?.id ?? ""; activeFile = board.page.entry; preview = pageResource(activePageId); } const restored = restoreCamera(); setMode("select"); renderCanvas(); renderFilePanel(); renderInspector(); renderProjectNotice(); void refreshVisiblePreviews(!restored); }
  }
  async function selectPage(pageId: string, location?: PageLocation) {
    if (!project || !project.pages.some(page => page.id === pageId)) { notify("目标页面不存在，请读取当前项目页面。", true); return; }
    const changed = canvasMode !== "single" || activePageId !== pageId;
    if (changed) saveCamera();
    canvasMode = "single"; activePageId = pageId; activeFile = resolveCodePage(project, pageId).entry; selection = undefined; normalizeViewports();
    if (location) { pageLocations.set(pageId, location); for (const frame of [...frames]) if (frame.pageId === pageId) removeFrame(frame); }
    preview = pageResource(pageId);
    const restored = changed && restoreCamera();
    renderCanvas(); renderFilePanel(); renderInspector(); renderProjectNotice();
    await refreshVisiblePreviews(changed && !restored);
  }
  function sendLocation(frame: FrameRecord) {
    if (!project || frame.revision !== project.revision) return;
    const location = pageLocations.get(frame.pageId);
    if (location && frame.projectId === location.projectId && frame.revision === location.revision) frame.iframe.contentWindow?.postMessage({ type: "design:location", ...location }, "*");
  }
  function previewHashesCurrent(fileHashes: Record<string, string>): boolean {
    return fileHashes && hashes.size === Object.keys(fileHashes).length && [...hashes].every(([file, value]) => fileHashes[file] === value);
  }
  function syncFrameRevision(frame: FrameRecord) {
    if (!project || !frame.ready || frame.retired || !frames.includes(frame) || frame.projectId !== project.id || frame.syncing || frame.revision === frame.desiredRevision || !previewHashesCurrent(frame.fileHashes)) return;
    const from = frame.revision, to = frame.desiredRevision, nonce = id("sync");
    const timer = setTimeout(() => {
      if (disposed || !frames.includes(frame) || frame.syncing?.nonce !== nonce) return;
      frame.syncing = undefined;
      if (project?.id === frame.projectId) {
        for (const stale of frames.filter(item => item.pageId === frame.pageId)) { stale.retired = true; if (stale.syncing) clearTimeout(stale.syncing.timer); stale.syncing = undefined; }
        const key = pagePreviewKey(project.id, project.revision, frame.pageId); previewPool.delete(key);
        pageStates.set(key, { status: "loading" }); if (activePageId === frame.pageId) preview = undefined;
        renderCanvas(); void loadPagePreview(project, frame.pageId).catch(() => {}); notify("预览未确认当前修订，已重新编译；未接受旧修订的元素事件。", true);
      }
    }, 2000);
    frame.syncing = { from, to, nonce, timer };
    frame.iframe.contentWindow?.postMessage({ type: "design:sync-revision", projectId: frame.projectId, pageId: frame.pageId, revision: from, nextRevision: to, renderIdentity: frame.renderIdentity, fileHashes: frame.fileHashes, nonce }, "*");
  }
  function clearFrames() { for (const frame of [...frames]) removeFrame(frame); }
  function focusSource(sourceId: string, pageId = activePageId) {
    for (const frame of frames.filter(frame => frame.visible && frame.pageId === pageId)) {
      frame.pendingFocus = sourceId;
      const focus = () => sendFrameFocus(frame);
      if (frame.ready) focus(); else frame.iframe.addEventListener("load", focus, { once: true });
    }
  }
  function sendFrameFocus(frame: FrameRecord) {
    if (!disposed && frames.includes(frame) && frame.pendingFocus && project?.id === frame.projectId && project.revision === frame.revision && activePageId === frame.pageId && frameResource(frame)?.sources.some(source => source.id === frame.pendingFocus)) {
      frame.iframe.contentWindow?.postMessage({ type: "design:focus", projectId: frame.projectId, revision: frame.revision, pageId: frame.pageId, sourceId: frame.pendingFocus }, "*"); frame.pendingFocus = undefined;
    }
  }
  async function focusComment(commentId: string, targetPageId?: string) {
    if (!project) return;
    const projectId = project.id, revision = project.revision;
    const comment = project.comments.find(item => item.id === commentId); if (!comment) return;
    if (!targetPageId) {
      if (fileAt(comment.file)) openSource(comment.file); else notify("评论对应的源文件已不存在。评论仍保留，未绑定其他对象。", true);
      return;
    }
    const state = commentAnchors.resolve(comment);
    if (!state.pages.some(page => page.id === targetPageId)) { notify("此页面尚未核实到原源码锚点。请重新核对，或直接打开源文件。", true); return; }
    if (canvasMode === "overview") {
      if (!overviewPageIds.includes(targetPageId)) { if (overviewPageIds.length >= 4) { notify("此评论属于未显示页面。请先在页面总览中取消一个页面，再定位该评论。", true); return; } overviewPageIds.push(targetPageId); }
      activateBoard(targetPageId, overviewViewportIds.get(targetPageId)); view = "design"; await refreshVisiblePreviews();
    } else if (targetPageId !== activePageId) await selectPage(targetPageId);
    else if (!preview || preview.revision !== revision || preview.pageId !== targetPageId) await refreshPreview();
    if (!project || project.id !== projectId || project.revision !== revision || activePageId !== targetPageId) return;
    const source = preview?.sources.find(item => item.id === comment.sourceId && item.file === comment.file);
    if (source) {
      setMode("select"); view = "design"; renderCanvas();
      focusSource(source.id);
      notify("已打开含原源码锚点的页面并请求定位。条件内容可能尚未显示；重复组件对应同一源码，不能区分运行实例。");
    } else { openSource(comment.file); notify("最新预览无法核实原锚点，已打开源文件，未绑定其他对象。", true); }
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
    root.querySelectorAll<HTMLElement>(".dc-frame").forEach(element => element.classList.toggle("active", element.dataset.pageId === activePageId && element.dataset.viewportId === activeViewport));
  }
  function onMessage(event: MessageEvent) {
    if (!project || !event.data || typeof event.data !== "object") return;
    const frame = frames.find(item => event.source === item.iframe.contentWindow); if (!frame || frame.retired) return;
    const data = event.data as Record<string, unknown>;
    if (data.type === "design:revision-synced") {
      const syncing = frame.syncing;
      if (!syncing || !project.pages.some(page => page.id === frame.pageId) || !acceptsCodeRevisionAck(frame, { projectId: project.id, pageId: frame.pageId, revision: project.revision, fileHashes: hashes }, data)) return;
      clearTimeout(syncing.timer); frame.syncing = undefined; frame.revision = syncing.to;
      if (frame.revision === project.revision) {
        if (selection?.pageId === frame.pageId && selection.viewportId === frame.viewportId && hashes.get(selection.source.file) === selection.fileHash) selection.revision = frame.revision;
        frame.iframe.contentWindow?.postMessage({ type: "design:mode", projectId: frame.projectId, pageId: frame.pageId, revision: frame.revision, mode }, "*");
        sendLocation(frame); sendFrameFocus(frame); renderStatus();
      }
      syncFrameRevision(frame); return;
    }
    if (frame.projectId !== project.id || data.projectId !== project.id || data.revision !== frame.revision || frame.revision !== project.revision || data.pageId !== frame.pageId) return;
    if (data.type === "design:ready") { frame.ready = true; syncFrameRevision(frame); sendLocation(frame); return; }
    const resource = frameResource(frame); if (!resource || !previewHashesCurrent(frame.fileHashes) || !previewHashesCurrent(resource.fileHashes)) return;
    if (data.type === "design:runtime-error" && typeof data.message === "string") {
      const diagnostic: Diagnostic = { level: "error", message: data.message.slice(0, 1000), ...(typeof data.line === "number" ? { line: data.line } : {}) };
      if (!frame.runtimeDiagnostics.some(item => item.message === diagnostic.message)) frame.runtimeDiagnostics = [...frame.runtimeDiagnostics.slice(-5), diagnostic];
      if (frame.visible && view === "design" && !modal) renderCanvas(); return;
    }
    if (!frame.visible || view !== "design" || modal) return;
    if (data.type === "design:activate") {
      if (data.renderIdentity !== frame.renderIdentity || !data.fileHashes || typeof data.fileHashes !== "object" || !previewHashesCurrent(data.fileHashes as Record<string, string>)) return;
      if (activePageId !== frame.pageId || activeViewport !== frame.viewportId) activateBoard(frame.pageId, frame.viewportId);
      return;
    }
    if (data.type === "design:navigate") {
      if (typeof data.targetPageId !== "string" || !project.pages.some(page => page.id === data.targetPageId)) { notify("原型导航目标未在项目中声明。", true); return; }
      const location: PageLocation = { projectId: project.id, revision: project.revision, pageId: data.targetPageId, href: typeof data.href === "string" ? data.href.slice(0, 2048) : "", hash: typeof data.hash === "string" ? data.hash.slice(0, 1000) : "", search: typeof data.search === "string" ? data.search.slice(0, 1000) : "" };
      void selectPage(data.targetPageId, location); return;
    }
    if (data.type !== "design:selection" || typeof data.sourceId !== "string") return;
    const source = resource.sources.find(item => item.id === data.sourceId);
    if (!source || data.file !== source.file || data.fileHash !== hashes.get(source.file) || data.fileHash !== frame.fileHashes[source.file]) return;
    if (activePageId !== frame.pageId || activeViewport !== frame.viewportId) activateBoard(frame.pageId, frame.viewportId);
    const styles: Record<string, string> = {};
    if (data.computedStyles && typeof data.computedStyles === "object") for (const [key] of styleFields) { const camelKey = key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()); const value = (data.computedStyles as Record<string, unknown>)[key] ?? (data.computedStyles as Record<string, unknown>)[camelKey]; if (typeof value === "string" && value.length <= 300) styles[key] = value; }
    frame.usedAt = Date.now(); selectSource(source, typeof data.text === "string" ? data.text.slice(0, 20_000) : "", styles, frame.viewportId, { ...(typeof data.runtimeLiteralText === "boolean" ? { runtimeLiteralText: data.runtimeLiteralText } : {}), ...(typeof data.ancestorMapped === "boolean" ? { ancestorMapped: data.ancestorMapped } : {}) });
  }
  function setMode(next: "select" | "preview") {
    mode = next;
    for (const frame of frames) frame.iframe.contentWindow?.postMessage({ type: "design:mode", projectId: frame.projectId, revision: frame.revision, pageId: frame.pageId, mode }, "*");
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
    const modeLabel = root.querySelector("[data-mode-label]"); if (modeLabel) modeLabel.textContent = mode === "select" ? "点击原型元素以定位源码" : "原型交互正在运行";
  }
  function viewports() { return matchingViewports().filter(item => viewportId === "all" || item.id === viewportId).slice(0, PAGE_PREVIEW_LIMITS.liveFrames); }
  function canvasBoards(): CanvasBoard[] {
    if (!project) return [];
    const selected = canvasMode === "overview" ? overviewPageIds : [activePageId]; let x = 0;
    const boards: CanvasBoard[] = [];
    for (const pageId of selected) {
      const page = project.pages.find(item => item.id === pageId); if (!page) continue;
      let choices: CodeViewport[] = [];
      if (canvasMode === "single") choices = viewports();
      else { const matching = matchingViewports(pageId), preferred = overviewViewportIds.get(pageId); const viewport = matching.find(item => item.id === preferred) ?? matching.find(item => item.pageId === pageId) ?? matching[0]; if (viewport) { overviewViewportIds.set(pageId, viewport.id); choices = [viewport]; } }
      if (!choices.length) { boards.push({ key: `${pageId}:unavailable`, page, error: "此页没有匹配的真实预览尺寸，请添加共享尺寸或本页尺寸。", width: 400, height: 300, x, y: 0, captionHeight: 92 }); x += 490; continue; }
      for (const viewport of choices) { boards.push({ key: `${page.id}:${viewport.id}`, page, viewport, width: viewport.width, height: viewport.height, x, y: 0, captionHeight: 92 }); x += viewport.width + 90; }
    }
    return layoutCanvasBoards(limitLiveBoards(boards).allowed, scale).boards;
  }
  function layoutCanvasBoards(boards: CanvasBoard[], atScale: number) {
    const available = Math.max(160, (root.querySelector<HTMLElement>(".dc-canvas")?.clientWidth ?? 800) - 70), gap = 24;
    const columns = Math.max(1, Math.min(boards.length || 1, available < 384 && boards.length > 1 ? 2 : Math.floor((available + gap) / (180 + gap))));
    const captionWidth = Math.min(180, (available - gap * (columns - 1)) / columns);
    const placed: CanvasBoard[] = []; let top = 0, totalWidth = 0;
    for (let start = 0; start < boards.length; start += columns) {
      const row = boards.slice(start, start + columns);
      // Labels remain unscaled; reserve their rendered height, including state messages.
      const captionHeight = Math.max(...row.map(board => {
        const caption = boardElements.get(board.key)?.caption;
        if (!caption || caption.hidden) return captionWidth < 140 ? 126 : 100;
        const width = Math.max(captionWidth, Math.min(440, board.width * atScale));
        caption.style.width = `${width}px`; caption.classList.toggle("narrow", width < 140);
        return Math.ceil(caption.getBoundingClientRect().height) + 8;
      }));
      let left = 0;
      for (const board of row) { placed.push({ ...board, x: left / atScale, y: (top + captionHeight) / atScale, captionHeight }); left += Math.max(board.width * atScale, captionWidth) + gap; }
      totalWidth = Math.max(totalWidth, left - gap); top += captionHeight + Math.max(...row.map(board => board.height)) * atScale + gap;
    }
    return { boards: placed, width: totalWidth, height: Math.max(0, top - gap), captionWidth };
  }
  function transform() {
    const world = root.querySelector<HTMLElement>(".dc-world"); if (world) world.style.transform = `translate(${offset.x}px,${offset.y}px) scale(${scale})`;
    const value = root.querySelector<HTMLElement>(".dc-zoom .value"); if (value) value.textContent = `${Math.round(scale * 100)}%`;
    const captionBoards = canvasBoards(), captionMinimum = layoutCanvasBoards(captionBoards, scale).captionWidth;
    for (const board of captionBoards) { const elements = boardElements.get(board.key); if (elements) { elements.wrapper.style.left = `${board.x}px`; elements.wrapper.style.top = `${board.y}px`; elements.caption.style.left = `${offset.x + board.x * scale}px`; elements.caption.style.top = `${offset.y + board.y * scale - board.captionHeight}px`; elements.caption.style.width = `${Math.max(captionMinimum, Math.min(440, board.width * scale))}px`; elements.caption.classList.toggle("narrow", Number.parseFloat(elements.caption.style.width) < 140); } }
  }
  function fitCanvas() {
    const canvas = root.querySelector(".dc-canvas"), items = canvasBoards(); if (!canvas || !items.length) return;
    const rect = canvas.getBoundingClientRect(); if (rect.width < 100 || rect.height < 100) return;
    let low = .005, high = 1;
    for (let index = 0; index < 32; index++) { const candidate = (low + high) / 2, layout = layoutCanvasBoards(items, candidate); if (layout.width <= rect.width - 70 && layout.height <= rect.height - 72) low = candidate; else high = candidate; }
    scale = low; offset = { x: 35, y: 12 }; cameraSerial++; saveCamera(); transform();
  }
  function zoom(next: number, point?: { x: number; y: number }) {
    cameraSerial++;
    const canvas = root.querySelector(".dc-canvas"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); const center = point ?? { x: rect.width / 2, y: rect.height / 2 }; next = Math.max(.05, Math.min(2, next)); offset = { x: center.x - (center.x - offset.x) * next / scale, y: center.y - (center.y - offset.y) * next / scale }; scale = next; transform();
  }
  function renderStatus() {
    if (disposed) return;
    const statusNode = root.querySelector<HTMLElement>(".dc-save-state"); if (statusNode) { statusNode.textContent = status; statusNode.classList.toggle("saving", saving > 0); }
    const connection = root.querySelector("[data-connection]"); if (connection) connection.innerHTML = `<span class="dc-dot${connected ? " connected" : ""}"></span>${escape(connected ? "本地 MCP 已连接" : status)}`;
    const revision = root.querySelector("[data-revision]"); if (revision) revision.textContent = project ? `修订 ${project.revision}` : "";
    const compilingNode = root.querySelector<HTMLElement>(".dc-loading"); if (compilingNode) compilingNode.hidden = !compiling;
    // Update control state in place: rebuilding the header/canvas would drop
    // focus or the live iframe state after an asynchronous save completes.
    const disable = (action: string, value: boolean) => { for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>(`button[data-action="${action}"]`))) button.disabled = value; };
    const busy = saving > 0;
    const reliableHistory = project && historyMetadata?.projectId === project.id && historyMetadata.revision === project.revision ? historyMetadata : undefined;
    disable("undo", busy || !connected || reliableHistory?.canUndo !== true); disable("redo", busy || !connected || reliableHistory?.canRedo !== true);
    for (const direction of ["undo", "redo"] as const) {
      const button = root.querySelector<HTMLButtonElement>(`button[data-action="${direction}"]`);
      if (button) button.title = !project ? "请先打开项目" : !reliableHistory ? "历史状态尚未核实，可刷新项目重新读取" : direction === "undo" ? reliableHistory.canUndo ? "撤销 ⌘Z" : "没有可撤销的版本" : reliableHistory.canRedo ? "重做 ⌘⇧Z" : "没有可重做的版本";
    }
    const draft = drafts.get(activeFile);
    disable("save-source", !draft?.dirty || draft.conflict || busy);
    disable("apply-selection", !selectedIsCurrent() || busy);
    disable("apply-generation", busy);
    // Revision acknowledgement must update presentation without replacing active editors.
    for (const note of root.querySelectorAll<HTMLElement>("[data-selection-stale],[data-selection-ai-stale]")) note.hidden = selectedIsCurrent();
    root.querySelector("[data-history-focus]")?.setAttribute("aria-busy", String(busy || !!historyFocusOwner));
    updateTokenActions();
    if (!historyHeaderRendering) reconcileHistoryFocus();
  }
  function renderHeader() {
    if (modal) return;
    const container = root.querySelector<HTMLElement>(".dc-header"); if (!container) return;
    const focus = container.contains(document.activeElement) ? captureFocus() : undefined;
    const owner = historyFocusOwner, ownedFocus = !!owner && ownsHistoryFocus(owner);
    historyHeaderRendering = true;
    try { container.innerHTML = `<div class="dc-brand"><b>D</b><span class="dc-hide-mobile">Design</span></div><div class="dc-divider dc-hide-mobile"></div><select data-setting="project" aria-label="当前原型项目"><option value="">${projects.length ? "选择项目" : "未创建项目"}</option>${projects.map(item => `<option value="${escape(item.id)}"${item.id === project?.id ? " selected" : ""}>${escape(item.name)}</option>`).join("")}<option value="__new__">＋ 新建原型</option></select><button class="icon quiet dc-hide-mobile" data-action="new" title="新建代码原型">${icon("plus")}</button><button class="quiet dc-open-project" data-action="project-archive-view" title="从 ZIP 打开 Design 工程新副本">${icon("upload")}<span class="dc-hide-mobile">打开 Design 工程</span></button>${archiveNotice && archiveNotice.projectId !== project?.id ? `<button class="dc-archive-ready" data-archive-open="${escape(archiveNotice.projectId)}" title="${escape(archiveNotice.name)}">打开新副本</button>` : ""}<span class="dc-save-state"></span><div class="dc-header-actions" data-history-focus tabindex="-1" role="group" aria-label="历史与导出操作"><button class="icon quiet dc-mobile" data-action="toggle-left" title="项目文件">${icon("panelLeft")}</button><button class="icon quiet" data-action="undo" title="撤销 ⌘Z"${!project || saving ? " disabled" : ""}>${icon("undo")}</button><button class="icon quiet" data-action="redo" title="重做 ⌘⇧Z"${!project || saving ? " disabled" : ""}>${icon("redo")}</button><button class="icon quiet dc-hide-mobile" data-action="refresh" title="刷新代码与预览">${icon("refresh")}</button><div class="dc-divider dc-hide-mobile"></div><button class="primary" data-action="export" aria-label="导出代码原型"${!project ? " disabled" : ""}>${icon("download")}<span class="dc-hide-mobile">导出</span></button><button class="icon quiet dc-mobile" data-action="toggle-right" title="属性与 AI">${icon("panelRight")}</button></div>`;
      renderStatus();
    } finally { historyHeaderRendering = false; }
    if (ownedFocus && owner === historyFocusOwner && document.activeElement === document.body) {
      const group = root.querySelector<HTMLElement>("[data-history-focus]"); if (group) moveHistoryFocus(owner!, group);
    } else restoreFocus(focus);
    reconcileHistoryFocus();
  }
  function renderFilePanel() {
    if (modal) return;
    const panel = root.querySelector<HTMLElement>("[data-left-panel]"); if (!panel) return;
    if (leftTab === "source") { panel.classList.remove("flush"); panel.innerHTML = sourceMarkup(); return; }
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
      const focus = panel.contains(document.activeElement) ? captureFocus() : undefined, top = panel.scrollTop;
      panel.innerHTML = tokenMarkup() + `<div class="dc-section"><div class="dc-section-title">真实组件</div>${project.designSystem.components.map(component => `<article class="dc-component">${icon("component")}<div><strong>${escape(component.name)}</strong><p>${escape(component.path)}${component.exportName ? ` · ${escape(component.exportName)}` : ""}</p>${component.usage ? `<p>${escape(component.usage)}</p>` : ""}</div><button data-file="${escape(component.path)}" title="打开组件源码">${icon("code")}</button></article>`).join("") || '<p class="dc-hint">组件来自项目源文件。让当前聊天建立或扩展组件库，组件代码会保留在交付包中。</p>'}</div>${project.designSystem.notes ? `<div class="dc-section"><div class="dc-section-title">品牌与使用说明</div><p class="dc-hint">${escape(project.designSystem.notes)}</p></div>` : ""}`;
      updateTokenActions(); panel.scrollTop = top; restoreFocus(focus);
    }
  }
  function tokenMarkup() {
    const state = tokenState()!, catalog = state.catalog, current = catalog?.projectId === project?.id && catalog?.revision === project?.revision;
    const files = project!.files.filter(file => file.encoding === "utf8" && /\.(?:css|html?)$/i.test(file.path));
    const visibleIds = new Set(catalog?.definitions.map(definition => definition.sourceId));
    const retained = [...state.drafts.values()].filter(draft => !visibleIds.has(draft.definition.sourceId));
    const staleCount = [...state.drafts.values()].filter(tokenDraftStale).length;
    const cards = (catalog?.definitions ?? []).map(definition => tokenCard(definition, state)).join("");
    return `<section class="dc-section dc-tokens"><div class="dc-section-title">CSS 源码令牌<button class="icon quiet" data-action="refresh-tokens" aria-label="重新读取 CSS 令牌">${icon("refresh")}</button></div><p class="dc-hint">修改真实 CSS 自定义属性。作用域和 var() 引用仅按源码展示，不计算浏览器级联。只读取 CSS 文件与 HTML 的 style 块。</p><label class="dc-field">文件<select data-token-file aria-label="筛选 CSS 令牌文件"><option value="">全部 CSS 与 HTML</option>${files.map(file => `<option value="${escape(file.path)}"${file.path === state.file ? " selected" : ""}>${escape(file.path)}</option>`).join("")}</select></label>${state.loading ? '<p class="dc-hint" role="status" data-token-loading>正在读取源码声明…</p>' : ""}<div class="dc-token-notice error" data-token-error role="alert"${state.error ? "" : " hidden"}>${escape(state.error)}</div>${catalog && !current ? '<p class="dc-token-notice">列表来自旧修订，请重新读取；暂存未自动套用到新声明。</p>' : ""}${staleCount ? `<p class="dc-token-notice" role="status">${staleCount} 项暂存的文件已变化。请保留所需文本，取消旧项后，在最新声明中重新修改。</p>` : ""}${catalog?.diagnostics.length ? `<details class="dc-token-diagnostics"><summary>源码诊断 · ${catalog.diagnostics.length}</summary>${catalog.diagnostics.map(item => `<p>${escape(item.file ?? "CSS")}${item.line ? `:${item.line}` : ""} · ${escape(item.message)}</p>`).join("")}</details>` : ""}${cards || (!state.loading ? '<p class="dc-hint" data-token-empty>没有可展示的 CSS 自定义属性声明。可打开源码添加真实的 --变量，再重新读取。</p>' : "")}${retained.length ? `<details open class="dc-token-retained"><summary>保留的其它暂存 · ${retained.length}</summary>${retained.map(draft => tokenCard(draft.definition, state)).join("")}</details>` : ""}${catalog?.truncated && Object.values(catalog.truncated).some(Boolean) ? '<p class="dc-token-notice">扫描或引用结果达到预算，列表可能不完整。请筛选具体文件后读取，不能据此认定其它声明不存在。</p>' : ""}<div class="dc-token-actions" data-token-actions role="group" aria-label="CSS 令牌暂存操作" tabindex="-1"><p data-token-draft-count></p><button class="primary" data-action="apply-tokens" disabled>应用暂存修改</button><button data-action="cancel-tokens" disabled>取消全部暂存</button>${hasDirty() ? '<p class="dc-hint">先保存或协调源码编辑器里的草稿，再应用令牌。</p>' : ""}<div class="dc-token-pages"><button data-action="tokens-prev"${!catalog || catalog.offset === 0 || state.loading || state.applying ? " disabled" : ""}>上一页</button><span>${catalog ? `${catalog.total ? catalog.offset + 1 : 0}–${catalog.offset + catalog.definitions.length} / ${catalog.total}` : "尚未读取"}</span><button data-action="tokens-next"${!catalog || typeof catalog.nextOffset !== "number" || state.loading || state.applying ? " disabled" : ""}>下一页</button></div></div></section>`;
  }
  function tokenCard(definition: CssTokenDefinition, state: CssTokenState) {
    const draft = state.drafts.get(definition.sourceId), stale = draft && tokenDraftStale(draft), value = draft?.value ?? definition.value;
    return `<article class="dc-token-card${draft ? " dirty" : ""}${stale ? " stale" : ""}" data-token-card="${escape(definition.sourceId)}"><div class="dc-token-title"><code>${escape(definition.name)}</code><span class="dc-swatch" data-token-swatch hidden></span></div><p class="dc-token-scope">${escape(definition.selector || "（无选择器）")}${definition.important ? " · !important" : ""}${definition.atRules.length ? `<br>${definition.atRules.map(escape).join(" → ")}` : ""}</p><button class="dc-token-source" data-token-source="${escape(definition.sourceId)}" title="打开此声明的真实源码">${escape(definition.file)}:${definition.line}</button><label class="dc-field">${draft ? "暂存值" : "当前值"}<textarea rows="2" data-token-value="${escape(definition.sourceId)}" aria-label="${escape(definition.name)} · ${escape(definition.file)}:${definition.line}"${!definition.editable || state.applying ? " disabled" : ""}>${escape(value)}</textarea></label>${definition.diagnostic ? `<p class="dc-token-notice">${escape(definition.diagnostic)}</p>` : ""}<div class="dc-token-card-actions"><small data-token-status>${stale ? "源码已变化，暂存保留" : draft ? "已暂存" : ""}</small><button data-token-cancel="${escape(definition.sourceId)}"${draft ? "" : " hidden"}${state.applying ? " disabled" : ""}>取消此项</button></div><details><summary>同名 var() 引用 · ${definition.references.length}</summary><p class="dc-hint">静态同名引用，不代表它们均由本声明提供值。</p>${definition.references.map(reference => `<p class="dc-token-reference">${escape(reference.file)}:${reference.line}<br>${escape(reference.selector)} · ${escape(reference.property)}</p>`).join("") || '<p class="dc-hint">已扫描源码中未找到同名 var()。</p>'}</details></article>`;
  }
  function sourceMarkup() {
    const projectId = project?.id; const link = projectId ? sourceStatuses.get(projectId) : undefined; const comparison = projectId ? sourceComparisons.get(projectId) : undefined;
    const busy = projectId ? sourceBusy.has(projectId) : false; const selected = projectId ? sourceSelections.get(projectId) ?? new Set<string>() : new Set<string>();
    const stale = comparison && comparison.revision !== project?.revision; const operation = link?.operation; const needsRecheck = operation && ["writing", "partial"].includes(operation.phase);
    const changed = comparison?.files.filter(file => file.status !== "synced") ?? [];
    const pathInput = `<label class="dc-field">本地源码目录<input data-source-directory value="${escape(sourceDirectoryInput)}" placeholder="输入明确选择的绝对目录" autocomplete="off"/></label>`;
    if (!project) return `<div class="dc-section-title">导入本地工程</div><p class="dc-hint">只读导入 HTML / React 源码，建立私有基线。不会安装依赖、执行脚本或改原目录。</p>${pathInput}<label class="dc-field">项目名称<input data-source-import-name value="${escape(sourceImportName)}"/></label><label class="dc-field">入口（可选）<input data-source-import-entry value="${escape(sourceImportEntry)}" placeholder="index.html 或 src/main.tsx"/></label><button class="primary" data-action="source-import"${sourceImportStarting ? " disabled" : ""}>${sourceImportStarting ? "正在只读导入…" : "只读导入工程"}</button>${sourceError ? `<p role="alert" class="dc-source-error">${escape(sourceError)}</p>` : ""}`;
    if (!link) return `<div class="dc-section-title">源码目录</div><p class="dc-hint">先读取当前项目的私有连接信息。</p><button data-action="source-status">读取连接信息</button>${sourceError ? `<p class="dc-source-error" role="alert">${escape(sourceError)}</p>` : ""}<button data-action="project-archive-view">打开 Design 工程 ZIP</button><button data-action="source-import-view">导入本地工程</button>`;
    return `<div class="dc-section-title">源码目录</div>${link?.connected ? `<code class="dc-source-location">${escape(link.directory)}</code><p class="dc-hint">基线保存在本机项目记录。仅点击检查或同步时读取目录，不自动监听。</p><div class="dc-actions-wrap"><button data-action="source-compare"${busy ? " disabled" : ""}>检查变化</button>${operation ? `<button data-action="source-recheck"${busy ? " disabled" : ""}>重查写入记录</button>` : ""}</div>` : `<p class="dc-hint">连接明确选择的工程，只有字节一致的文件作为共同基线；其他差异需审阅。</p>${pathInput}<button data-action="source-connect"${busy ? " disabled" : ""}>只读连接目录</button>`}
      ${operation ? `<details class="dc-source-operation"${needsRecheck ? " open" : ""}><summary>${needsRecheck ? "写入未完成 · 必须重查" : operation.phase === "completed" ? "上次写入已完成" : "写入现场已重查"}</summary><p>修订 ${operation.revision} · ${operation.steps.filter(step => step.done).length}/${operation.steps.length} 项已核对</p>${operation.error ? `<p>${escape(operation.error)}</p>` : ""}${operation.steps.map(step => `<code>${step.done ? "已完成" : "待处理"} · ${escape(step.path)}</code>`).join("")}<p>重查只读现场，不会自动重试写入。</p></details>` : ""}
      ${sourceError ? `<p class="dc-source-error" role="alert">${escape(sourceError)}</p>` : ""}${comparison ? `<p class="dc-hint">比较修订 ${comparison.revision} · ${escape(new Date(comparison.checkedAt).toLocaleTimeString("zh-CN"))}${stale ? " · 已过期，请重新检查" : ""}<br>${changed.length} 项变化，${comparison.files.length - changed.length} 项一致</p>${changed.map(file => `<div class="dc-source-change${file.status === "conflict" ? " conflict" : ""}"><label><input type="checkbox" data-source-select="${escape(file.path)}"${selected.has(file.path) ? " checked" : ""}${busy || stale || file.status === "conflict" ? " disabled" : ""}/><span><code>${escape(file.path)}</code><small>${({ project: "仅项目变化 · 可写回目录", directory: "仅目录变化 · 可拉取", conflict: "双方变化或路径不可用 · 不会覆盖", synced: "一致" })[file.status]}</small></span></label>${file.issue ? `<p>${escape(file.issue)}</p>` : `<button data-source-diff="${escape(file.path)}">查看对照</button>`}</div>`).join("")}${changed.length ? `<div class="dc-actions-wrap"><button data-action="source-pull"${busy || stale || needsRecheck || !selected.size ? " disabled" : ""}>拉取所选</button><button class="primary" data-action="source-push"${busy || stale || needsRecheck || !selected.size ? " disabled" : ""}>写回所选</button></div>` : '<p class="dc-hint">受管文件与基线一致。</p>'}` : ""}
      ${(comparison?.ignored ?? link?.ignored)?.length ? `<details class="dc-source-operation"><summary>未纳入源码（最多显示 200 项）</summary>${(comparison?.ignored ?? link?.ignored ?? []).map(item => `<p><code>${escape(item.path)}</code><br>${escape(item.reason)}</p>`).join("")}</details>` : ""}<p class="dc-hint">删除仍须保持页面、组件及评论引用有效；复杂改动交给当前聊天协调源码。检测到外部新保存时会中止旧操作；写入期间避免同时编辑相同文件。</p><button data-action="project-archive-view">打开 Design 工程 ZIP</button><button data-action="source-import-view">导入另一个工程</button>`;
  }
  async function readSourceStatus(projectId = project?.id) {
    if (!projectId) return;
    try { const result = await call("design_code_source_status", { projectId }); if (result.projectId === projectId) sourceStatuses.set(projectId, result as unknown as SourceStatus); }
    catch (error) { if (project?.id === projectId) sourceError = message(error); }
    if (project?.id === projectId && leftTab === "source") renderFilePanel();
  }
  async function sourceAction(kind: "compare" | "recheck" | "connect" | "pull" | "push") {
    if (!project) return; const projectId = project.id; if (sourceBusy.has(projectId)) return;
    if (["connect", "pull", "push"].includes(kind) && hasDirty()) { notify("请先保存或协调源码草稿，再同步目录。", true); return; }
    const comparison = sourceComparisons.get(projectId); const paths = [...(sourceSelections.get(projectId) ?? [])];
    if ((kind === "pull" || kind === "push") && (!comparison || comparison.revision !== project.revision || !paths.length)) { notify("请重新检查差异并选择文件。", true); return; }
    sourceBusy.add(projectId); sourceError = ""; renderFilePanel();
    try {
      const args = kind === "connect" ? { projectId, expectedRevision: project.revision, directory: sourceDirectoryInput.trim() } : kind === "pull" || kind === "push" ? { projectId, expectedRevision: project.revision, paths, expectedDirectoryHashes: Object.fromEntries(comparison!.files.filter(file => paths.includes(file.path)).map(file => [file.path, file.directoryHash])) } : { projectId };
      const result = await call(`design_code_${kind === "compare" ? "compare_source" : kind === "recheck" ? "recheck_source" : kind === "connect" ? "connect_directory" : `${kind}_source`}`, args);
      if (kind === "pull") { const next = await hydrate(result); if (next) accept(next); }
      if (Array.isArray(result.files) && result.projectId === projectId) sourceComparisons.set(projectId, result as unknown as SourceComparison);
      else if (result.connected !== undefined) sourceStatuses.set(projectId, result as unknown as SourceStatus);
      if (kind === "push" || kind === "connect" || kind === "pull") { sourceSelections.delete(projectId); const fresh = await call("design_code_compare_source", { projectId }); if (fresh.projectId === projectId) sourceComparisons.set(projectId, fresh as unknown as SourceComparison); }
      await readSourceStatus(projectId);
    } catch (error) {
      const details = error && typeof error === "object" && "details" in error ? error.details as Record<string, unknown> | undefined : undefined;
      if (project?.id === projectId) sourceError = `${message(error)}${details?.partial ? `\n目录：${details.directory ?? ""}\n已写：${Array.isArray(details.filesWritten) ? details.filesWritten.join("、") || "无" : "见记录"}\n待处理：${Array.isArray(details.pendingFiles) ? details.pendingFiles.join("、") : "请重查"}` : ""}`;
      await readSourceStatus(projectId);
    } finally { sourceBusy.delete(projectId); if (project?.id === projectId) renderFilePanel(); }
  }
  async function openSourceDifference(file: string, trigger?: HTMLElement) {
    if (!project) return; const projectId = project.id; const serial = ++sourceDifferenceSerial; const initialModal = modal;
    const returnFocus = modal ? undefined : captureFocus(trigger ?? document.activeElement);
    const replacing = modal === "source-difference" && sourceFileDifference?.projectId === projectId && sourceFileDifference.file === file;
    sourceDifferenceNotice = { projectId, file, invalidated: true, reading: true };
    if (replacing) render();
    try {
      const result = await call("design_code_read_source_difference", { projectId, file });
      if (disposed || serial !== sourceDifferenceSerial || project?.id !== projectId || result.projectId !== projectId || result.file !== file) return;
      if (replacing && modal !== "source-difference") return;
      if (!replacing && modal !== initialModal) return;
      sourceFileDifference = result as unknown as SourceFileDifference;
      sourceDifferenceNotice = { projectId, file, invalidated: result.revision !== project.revision, reading: false, ...(result.revision !== project.revision ? { error: "项目修订已更新，请刷新项目后重新读取两端。" } : {}) };
      openModal("source-difference", returnFocus);
    } catch (error) {
      if (disposed || serial !== sourceDifferenceSerial || project?.id !== projectId) return;
      sourceDifferenceNotice = { projectId, file, invalidated: true, reading: false, error: "未能读取两端最新内容。请检查连接后重新读取，旧快照仍不可应用。", detail: message(error) };
      if (modal === "source-difference" && sourceFileDifference?.projectId === projectId && sourceFileDifference.file === file) render();
      else notify("未能读取源码对照，请检查连接后重试。", true);
    }
  }
  async function resolveSourceDifference(choice: "project" | "directory") {
    const difference = sourceFileDifference; if (!project || !difference || difference.projectId !== project.id || difference.revision !== project.revision) { notify("对照已过期，请重新读取。", true); return; }
    if (sourceDifferenceNotice?.projectId === difference.projectId && sourceDifferenceNotice.file === difference.file && (sourceDifferenceNotice.invalidated || sourceDifferenceNotice.reading)) return;
    if (["writing", "partial"].includes(sourceStatuses.get(difference.projectId)?.operation?.phase ?? "")) { notify("写入记录尚未核对，请先关闭对照并重查写入记录。", true); return; }
    if (hasDirty()) { notify("请先保存或协调源码草稿，再解决目录冲突。", true); return; }
    const projectId = project.id; if (sourceBusy.has(projectId)) return; sourceBusy.add(projectId); render();
    try {
      const result = await call("design_code_resolve_source", { projectId, expectedRevision: difference.revision, file: difference.file, expectedProjectHash: difference.difference.projectHash, expectedDirectoryHash: difference.difference.directoryHash, choice });
      if (result.project) { const next = await hydrate(result); if (next) accept(next); }
      if (project?.id === projectId && modal === "source-difference" && sourceFileDifference === difference) { modal = ""; sourceFileDifference = undefined; sourceDifferenceNotice = undefined; sourceError = ""; render(); }
      const fresh = await call("design_code_compare_source", { projectId }); sourceComparisons.set(projectId, fresh as unknown as SourceComparison); await readSourceStatus(projectId);
    } catch (error) {
      if (project?.id === projectId && modal === "source-difference" && sourceFileDifference === difference) {
        const detail = message(error); const changed = /conflict|hash|revision|changed|stale/i.test(detail);
        const partial = error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object" && "partial" in error.details && error.details.partial === true;
        sourceDifferenceNotice = { projectId, file: difference.file, invalidated: true, reading: false, error: partial ? "写入已停止，可能已有文件落盘。请先关闭对照，在源码目录中重查写入记录，再核对两端实际内容。" : changed ? "检测到两端内容或项目修订变化，操作已停止。请重新读取两端，核对实际结果后再选择版本。" : "本次操作未完成。请重新读取两端并核对后继续，旧快照已停用。", detail };
      }
      await readSourceStatus(projectId);
    }
    finally { sourceBusy.delete(projectId); if (project?.id === projectId) { if (modal === "source-difference" && sourceFileDifference === difference) render(); else renderFilePanel(); } }
  }
  async function importSourceDirectory() {
    if (sourceImportStarting) return;
    if (hasDirty()) { notify("请先保存或协调源码草稿，再导入工程。", true); return; }
    sourceImportStarting = true; render();
    try {
      const serial = loadSerial; const result = await call("design_code_import_directory", { name: sourceImportName.trim() || "导入的工程", directory: sourceDirectoryInput.trim(), ...(sourceImportEntry.trim() ? { entry: sourceImportEntry.trim() } : {}) });
      if (disposed || serial !== loadSerial) return; const next = await hydrate(result, true); if (next) { modal = ""; leftTab = "source"; accept(next, true); await readSourceStatus(next.id); }
    } catch (error) { sourceError = message(error); notify(sourceError, true); renderFilePanel(); }
    finally { sourceImportStarting = false; if (!disposed) render(); }
  }
  let stageHeaderSignature = "";
  const releasedBoards = new Set<string>();
  function stageHeader() {
    const pages = project?.pages ?? [], tooManySizes = matchingViewports().length > PAGE_PREVIEW_LIMITS.liveFrames;
    const picker = canvasMode === "overview" ? `<details class="dc-overview-picker"><summary>比较页面 · ${overviewPageIds.length}/4</summary><div><p>最多选择 4 个真实页面，每页使用一个实际尺寸。</p>${pages.map(page => `<label><input type="checkbox" data-overview-page="${escape(page.id)}"${overviewPageIds.includes(page.id) ? " checked" : ""}${overviewPageIds.length >= 4 && !overviewPageIds.includes(page.id) ? " disabled" : ""}/><span><strong>${escape(page.name)}</strong><small title="${escape(page.entry + ' · ' + page.route)}">${escape(page.entry)} · ${escape(page.route)}</small></span></label>`).join("")}</div></details>` : "";
    return `<div class="dc-segment"><button data-view="design" class="${view === "design" ? "active" : ""}">${icon("desktop")}设计效果</button><button data-view="source" class="${view === "source" ? "active" : ""}">${icon("code")}源码</button></div>${project ? `<div class="dc-segment"><button data-action="page-single" class="${canvasMode === "single" ? "active" : ""}">单页编辑</button><button data-action="page-overview" class="${canvasMode === "overview" ? "active" : ""}">页面总览</button></div>${picker}<div class="dc-page-controls"><select data-setting="page" aria-label="当前页面">${pages.map(page => `<option value="${escape(page.id)}"${page.id === activePageId ? " selected" : ""}>${escape(page.name)}${page.id === project!.defaultPageId ? " · 默认" : ""}</option>`).join("")}</select>${view === "design" && canvasMode === "single" ? `<select data-setting="viewport" aria-label="预览尺寸"><option value="all"${viewportId === "all" ? " selected" : ""}${tooManySizes ? " disabled" : ""}>${tooManySizes ? "全部尺寸超过 4 板预算" : "全部尺寸"}</option>${matchingViewports().map(item => `<option value="${escape(item.id)}"${viewportId === item.id ? " selected" : ""}>${escape(item.name)} · ${item.width}px</option>`).join("")}</select>` : ""}</div>` : ""}`;
  }
  function removeFrame(frame: FrameRecord, released = false) {
    if (frame.syncing) clearTimeout(frame.syncing.timer);
    frame.iframe.remove(); frames = frames.filter(item => item !== frame);
    if (released) { releasedBoards.add(frame.key); notify("已按 4 个实时画板或缓存预算释放未显示页面；再次打开会重建该板的临时运行状态。"); }
  }
  function renderBoardCaption(board: CanvasBoard, elements: BoardElements) {
    const current = activePageId === board.page.id && activeViewport === board.viewport?.id;
    const synchronizeControls = () => { const select = elements.caption.querySelector<HTMLSelectElement>("[data-board-viewport]"); if (select && board.viewport && select.value !== board.viewport.id) select.value = board.viewport.id; };
    synchronizeControls();
    const signature = JSON.stringify([board.page, board.viewport, matchingViewports(board.page.id), canvasMode, current, releasedBoards.has(board.key)]);
    if (elements.signature === signature) return;
    elements.signature = signature;
    elements.caption.innerHTML = `<div class="dc-board-caption-title"><button data-board-active="${escape(board.page.id)}" data-viewport-id="${escape(board.viewport?.id ?? '')}" class="${current ? "active" : ""}" aria-pressed="${current}" title="设为当前页：${escape(board.page.name)}">${escape(board.page.name)}</button><button data-board-open="${escape(board.page.id)}" data-viewport-id="${escape(board.viewport?.id ?? '')}" title="进入此真实页面的单页编辑">进入单页</button></div><code title="${escape(board.page.entry + ' · ' + board.page.route)}">${escape(board.page.entry)} · ${escape(board.page.route)}</code><div class="dc-board-caption-size">${canvasMode === "overview" ? `<select data-board-viewport="${escape(board.page.id)}" aria-label="${escape(board.page.name)}预览尺寸">${matchingViewports(board.page.id).map(viewport => `<option value="${escape(viewport.id)}"${viewport.id === board.viewport?.id ? " selected" : ""}>${escape(viewport.name)} · ${viewport.width} × ${viewport.height}</option>`).join("")}</select>` : `<span>${escape(board.viewport?.name ?? '无匹配尺寸')} · ${board.width} × ${board.height}</span>`}</div>${releasedBoards.has(board.key) ? '<small class="dc-board-released" title="此画板曾因预览预算被释放，重新载入后临时输入与运行状态已重置。">已重载 · 临时状态已重置</small>' : ""}<div class="dc-board-caption-status"></div>`;
    synchronizeControls();
  }
  function renderBoardStatus(board: CanvasBoard, elements: BoardElements, status: string, reason = "", frame?: FrameRecord) {
    const target = elements.caption.querySelector<HTMLElement>(".dc-board-caption-status"); if (!target) return;
    const markup = status === "ready" ? frame?.runtimeDiagnostics.length ? `<div class="dc-board-runtime" data-board-runtime-errors="${escape(board.page.id)}" role="status">${frame.runtimeDiagnostics.map(diagnostic => `<p>${escape(diagnostic.message)}</p>`).join("")}</div>` : "" : `<div class="dc-board-load-state ${status}" role="status"><strong>${status === "budget" ? "资源预算拒绝" : status === "error" ? "此页预览失败" : "正在载入真实页面"}</strong>${reason ? `<details><summary>查看原因</summary><p>${escape(reason)}</p></details>` : ""}${status !== "loading" ? `<button data-board-retry="${escape(board.page.id)}">重新载入此页</button>` : ""}</div>`;
    if (target.innerHTML !== markup) target.innerHTML = markup;
  }
  function renderCanvas() {
    if (modal) return;
    const focus = captureFocus(), stage = root.querySelector<HTMLElement>("[data-stage-content]"); if (!stage) return;
    let sourceStage = root.querySelector<HTMLElement>("[data-source-content]");
    if (!sourceStage) { sourceStage = document.createElement("div"); sourceStage.className = "dc-code-view"; sourceStage.dataset.sourceContent = ""; stage.after(sourceStage); }
    stage.hidden = view === "source"; sourceStage.hidden = view !== "source";
    const top = root.querySelector(".dc-stage-top"), header = stageHeader(), pickerOpen = top?.querySelector<HTMLDetailsElement>(".dc-overview-picker")?.open;
    if (top && stageHeaderSignature !== header) { top.innerHTML = header; stageHeaderSignature = header; const nextPicker = top.querySelector<HTMLDetailsElement>(".dc-overview-picker"); if (pickerOpen && nextPicker) nextPicker.open = true; }
    if (view === "source") { renderSource(); restoreFocus(focus); return; }
    stage.className = "dc-canvas";
    if (!project) { clearFrames(); stage.innerHTML = `<div class="dc-welcome"><div class="dc-welcome-art" aria-hidden="true"></div><h1>让设计真正运行起来</h1><p>从 HTML 或 React 原型开始。效果、交互与源代码在同一个项目中持续迭代。</p><button class="primary" data-action="new">${icon("plus")}创建第一个原型</button><button data-action="project-archive-view">打开 Design 工程 ZIP</button><button data-action="source-import-view">导入本地工程</button></div>`; return; }
    if (!stage.querySelector(".dc-world")) stage.innerHTML = `<div class="dc-world"></div><div class="dc-board-labels"></div><div class="dc-loading" hidden>正在编译真实源代码…</div><div class="dc-canvas-toolbar" role="toolbar" aria-label="原型模式"><button data-mode="select">${icon("cursor")}选择</button><button data-mode="preview">${icon("play")}交互</button><div class="dc-divider"></div><button data-action="ai">${icon("spark")}AI 设计</button></div><div class="dc-zoom"><button data-action="zoom-out" aria-label="缩小">${icon("minus")}</button><button class="value" data-action="fit" title="适合视图">${Math.round(scale * 100)}%</button><button data-action="zoom-in" aria-label="放大">${icon("plus")}</button></div>`;
    const world = stage.querySelector<HTMLElement>(".dc-world")!, labels = stage.querySelector<HTMLElement>(".dc-board-labels")!, boards = canvasBoards(), wanted = new Set(boards.map(board => board.key));
    previewPool.setProtected(boards.map(board => pagePreviewKey(project!.id, project!.revision, board.page.id)));
    for (const [key, elements] of boardElements) { elements.wrapper.hidden = !wanted.has(key); elements.caption.hidden = !wanted.has(key); }
    for (const frame of frames) frame.visible = wanted.has(frame.key);
    for (const board of boards) {
      let elements = boardElements.get(board.key);
      if (!elements) { const wrapper = document.createElement("div"), caption = document.createElement("div"); wrapper.className = "dc-frame"; wrapper.dataset.pageId = board.page.id; wrapper.dataset.viewportId = board.viewport?.id ?? ""; caption.className = "dc-board-caption"; caption.dataset.pageId = board.page.id; wrapper.style.position = "absolute"; world.append(wrapper); labels.append(caption); elements = { wrapper, caption, signature: "" }; boardElements.set(board.key, elements); captionObserver.observe(caption); }
      const { wrapper, caption } = elements; wrapper.hidden = false; caption.hidden = false;
      wrapper.style.cssText = `left:${board.x}px;top:${board.y}px;width:${board.width}px;height:${board.height}px`;
      wrapper.classList.toggle("active", board.page.id === activePageId && board.viewport?.id === activeViewport);
      renderBoardCaption(board, elements);
      const key = pagePreviewKey(project.id, project.revision, board.page.id), resource = previewPool.get(key), state = pageStates.get(key);
      let frame = frames.find(item => item.key === board.key);
      if (frame && (frame.retired || !resource || !resource.compiledSuccessfully || frame.renderIdentity !== resource.renderIdentity || frame.projectId !== project.id)) { removeFrame(frame); frame = undefined; }
      if (!resource || !resource.compiledSuccessfully || board.error) {
        const status = board.error ? "error" : state?.status ?? (!resource ? "loading" : "error");
        const reason = board.error ?? state?.message ?? (resource ? resource.diagnostics.map(diagnostic => diagnostic.message).join("；") : "按需加载此真实页面，未使用截图或模拟内容。");
        wrapper.dataset.boardState = status;
        const markup = `<div class="dc-board-status ${status}" role="status"><strong>${status === "budget" ? "资源预算拒绝" : status === "error" ? "此页未能预览" : "正在加载真实页面"}</strong><p>${escape(reason)}</p>${status !== "loading" ? `<button data-board-retry="${escape(board.page.id)}">重新载入此页</button>` : ""}</div>`;
        if (wrapper.innerHTML !== markup) wrapper.innerHTML = markup;
        renderBoardStatus(board, elements, status, reason);
        continue;
      }
      wrapper.dataset.boardState = "ready";
      if (!frame) {
        while (frames.length >= PAGE_PREVIEW_LIMITS.liveFrames) { const victim = frames.filter(item => !item.visible).sort((a, b) => a.usedAt - b.usedAt)[0]; if (!victim) break; removeFrame(victim, true); }
        if (frames.length >= PAGE_PREVIEW_LIMITS.liveFrames) { wrapper.dataset.boardState = "budget"; wrapper.innerHTML = '<div class="dc-board-status budget" role="status">已达到 4 个实时画板上限，请减少页面或尺寸选择。</div>'; renderBoardStatus(board, elements, "budget", "已达到 4 个实时画板上限，请减少页面或尺寸选择。"); continue; }
        const iframe = document.createElement("iframe"); iframe.setAttribute("sandbox", "allow-scripts allow-forms"); iframe.title = `${project.name} · ${board.page.name} · ${board.viewport!.name}`; iframe.referrerPolicy = "no-referrer";
        const record: FrameRecord = { key: board.key, cacheKey: key, wrapper, visible: true, usedAt: Date.now(), runtimeDiagnostics: [], projectId: project.id, pageId: board.page.id, viewportId: board.viewport!.id, revision: resource.compiledRevision, desiredRevision: project.revision, renderIdentity: resource.renderIdentity, fileHashes: resource.fileHashes, iframe };
        iframe.addEventListener("load", () => { record.ready = true; if (!disposed && frames.includes(record)) { iframe.contentWindow?.postMessage({ type: "design:mode", projectId: record.projectId, revision: record.revision, pageId: record.pageId, mode }, "*"); syncFrameRevision(record); sendLocation(record); sendFrameFocus(record); } });
        const location = pageLocations.get(record.pageId);
        iframe.srcdoc = injectCodePageRuntimeLocation(resource.html, { projectId: record.projectId, revision: resource.compiledRevision, pageId: record.pageId, search: location?.search, hash: location?.hash }); wrapper.replaceChildren(iframe); frames.push(record); frame = record;
      }
      frame.cacheKey = key; frame.visible = true; frame.desiredRevision = project.revision; syncFrameRevision(frame);
      renderBoardStatus(board, elements, "ready", "", frame);
    }
    let empty = stage.querySelector<HTMLElement>(".dc-no-boards");
    if (!boards.length && !empty) { empty = document.createElement("p"); empty.className = "dc-no-boards dc-empty"; empty.textContent = "请选择 1 至 4 个真实页面进行比较。"; stage.append(empty); } else if (boards.length) empty?.remove();
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
    transform(); if (!restoreFocus(focus) && focus?.selector.includes("data-board-")) root.querySelector<HTMLElement>('[data-setting="page"]')?.focus({ preventScroll: true });
  }
  function renderSource() {
    if (modal) return;
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
    return `<div class="dc-section"><div class="dc-selection-tag"><code>&lt;${escape(source.tag)}&gt;</code><span>已定位源元素</span></div><div class="dc-source-anchor"><strong>${escape(source.file)}</strong><br>源码位置 ${source.start}–${source.end}<span class="dc-file-hash">${escape(selection.fileHash)}</span></div><p class="dc-property-note">多个组件实例可能共享同一段源码，修改源会影响所有实例。</p><p class="dc-property-note" role="status" data-selection-stale${selectedIsCurrent() ? " hidden" : ""}>项目已更新。请在最新预览中重新选择元素，然后提交属性修改。</p><div class="dc-inline" style="margin-top:9px"><button data-action="source-selection">${icon("code")}打开源码</button><button data-action="ai-selection">${icon("spark")}让 AI 修改</button></div></div>
      <div class="dc-section"><div class="dc-section-title">文字内容</div>${canEditSelectionText() ? `<label class="dc-field">静态文字<textarea aria-label="选中元素文字" data-selection-text>${escape(selectionText)}</textarea></label>` : `<p class="dc-hint">${selection.ancestorMapped || selection.runtimeLiteralText === false ? "当前内容由运行时生成，定位的是可追溯的源容器。" : "此元素包含组件、嵌套结构或动态表达式。"}通过源码或当前聊天修改内容，避免覆盖原有逻辑。</p>`}</div>
      <div class="dc-section"><div class="dc-section-title">局部样式 <span style="font-size:9px;font-weight:400;color:var(--dc-muted)">写回源元素</span></div><div class="dc-fields">${styleFields.map(([key, label]) => `<label class="dc-field">${label}<input data-selection-style="${key}" value="${escape(selectionStyles[key] ?? "")}" placeholder="保留原样"/></label>`).join("")}</div><p class="dc-property-note">属性值来自当前运行结果，仅提交你改过的字段。编译器无法安全修改的动态样式会明确拒绝。</p><button class="primary" style="width:100%" data-action="apply-selection"${!selectedIsCurrent() || saving ? " disabled" : ""}>${icon("check")}应用到源码</button></div>
      <div class="dc-section"><button style="width:100%" data-action="comment-selection">${icon("comment")}评论此元素</button></div>`;
  }
  function aiMarkup() {
    const job = project ? jobs.get(project.id) : undefined;
    return `<div class="dc-ai-card"><strong>${icon("spark")}持续编辑真实设计</strong><p>描述目标、品牌和交互。模型编辑项目的 HTML、CSS、组件与逻辑，预览随保存的代码更新。</p></div>
      <label class="dc-field">执行模式<select data-ai-mode><option value="host"${aiMode === "host" ? " selected" : ""}>当前聊天模型 · 默认</option><option value="codex"${aiMode === "codex" ? " selected" : ""}>独立本地 Codex</option></select></label>
      ${aiMode === "codex" ? `<label class="dc-field">Codex 模型<select data-ai-model${modelsLoading ? " disabled" : ""}><option value="">${modelsLoading ? "正在读取本机模型目录…" : "使用本地默认模型"}</option>${models.map(model => `<option value="${escape(model.id)}"${aiModel === model.id ? " selected" : ""}>${escape(model.displayName || model.id)}${model.isDefault ? "（默认）" : ""}</option>`).join("")}</select></label><label class="dc-field">任务总预算<select data-generation-budget><option value="600000"${generationBudgetMs === 600000 ? " selected" : ""}>10 分钟 · 默认</option><option value="900000"${generationBudgetMs === 900000 ? " selected" : ""}>15 分钟</option></select></label><p class="dc-hint">沿用本机 Codex 登录，在独立任务生成提案。编译、渲染与模型回看分别记录，完成后仍需手动应用。</p>${modelsError ? `<p class="dc-hint" role="status">${escape(modelsError)}</p><button data-action="refresh-models">重新读取模型目录</button>` : ""}` : '<p class="dc-hint">使用当前聊天的模型与登录。宿主不支持发送消息时，提供完整提示词复制回聊天。</p>'}
      <label class="dc-field">视觉方向<select data-ai-direction${generationStarting ? " disabled" : ""}><option value="auto"${aiDirection === "auto" ? " selected" : ""}>自动 · 依据需求与品牌</option>${directions.map(direction => `<option value="${escape(direction.id)}"${aiDirection === direction.id ? " selected" : ""}>${escape(direction.name)}</option>`).join("")}</select></label>
      <label class="dc-field">案例参考<select data-ai-reference${generationStarting ? " disabled" : ""}><option value="auto"${aiReference === "auto" ? " selected" : ""}>自动 · 依据任务选择</option><option value="none"${aiReference === "none" ? " selected" : ""}>不使用固定案例</option>${referenceExamples.map(example => `<option value="${escape(example.id)}"${aiReference === example.id ? " selected" : ""}>${escape(example.title)} · ${escape(example.task)}</option>`).join("")}</select></label><p class="dc-hint">选择一个主方向；案例按需借鉴局部关系，保留你的内容、品牌和明确要求。</p>
      ${selection ? `<div class="dc-comment-target" style="margin-top:10px">已选择 &lt;${escape(selection.source.tag)}&gt; · ${escape(selection.source.file)}<span data-selection-ai-stale${selectedIsCurrent() ? " hidden" : ""}>（旧修订，发送前会标明）</span></div>` : ""}<label class="dc-field" style="margin-top:11px">设计需求<textarea class="dc-ai-prompt" maxlength="10000" data-ai-prompt placeholder="例如：把首页改成编辑叙事风格，用真实产品内容，补充导航、移动适配和表单状态。">${escape(aiPrompt)}</textarea></label><p class="dc-hint">${project ? `${escape(project.name)} · 修订 ${project.revision} · ${project.comments.filter(comment => comment.status === "open").length} 条待处理评论` : "请先创建项目"}${hasDirty() ? " · 有未保存源码" : ""}</p><button class="primary" style="width:100%" data-action="generate"${!project || generationStarting || deliveryUnknown || job?.status === "running" ? " disabled" : ""}>${icon("spark")}${generationStarting ? "正在准备任务…" : aiMode === "codex" ? "开始本地生成" : "交给当前聊天"}</button>${deliveryUnknown ? '<div class="dc-ai-state error"><p>请先查看聊天，再确认本次需求是否收到。</p><button data-action="confirm-prompt-received">聊天中已收到</button><button data-action="confirm-prompt-missing">确认未收到，允许重发</button></div>' : ""}${aiStatus ? `<div class="dc-ai-state${aiError ? " error" : ""}" role="status">${escape(aiStatus)}</div>` : ""}
      ${job ? generationMarkup(job) : ""}${aiMode === "codex" ? proposalDraftsMarkup() : ""}${fallbackPrompt ? `<div class="dc-fallback"><label class="dc-field">复制回当前聊天<textarea readonly>${escape(fallbackPrompt)}</textarea></label><button data-action="copy-prompt"${deliveryUnknown ? " disabled" : ""}>${icon("copy")}复制完整提示词</button></div>` : ""}`;
  }
  function generationMarkup(job: GenerationJob) {
    const applied = appliedJobs.has(job.id);
    const verification = job.verification;
    const statusLabel = ({ running: "执行中", completed: applied ? "已应用" : "提案已完成 · 尚未应用", failed: "执行失败", cancelled: "已停止" })[job.status];
    const files = job.changes?.files ?? [];
    const reviewedPages = job.verification.pages?.map(pageId => project?.pages.find(page => page.id === pageId)?.name ?? pageId).join("、");
    return `<div class="dc-ai-state${job.status === "failed" ? " error" : ""}"><strong>本地 Codex · ${statusLabel}</strong><p class="dc-hint">基于修订 ${job.baseRevision}${job.model ? ` · ${escape(job.model)}` : ""}</p>${referenceMarkup(job.reference)}<div class="dc-verification"><span>编译：${verification.compiled ? "通过" : "未完成"}</span><span>渲染：${verification.rendered ? "完成" : "未完成"}</span><span>模型回看：${verification.modelReviewed ? "完成" : "未完成"}</span><span>视口：${verification.viewports}</span></div><p class="dc-hint">审阅页面：${escape(reviewedPages || "未记录")}</p>${job.error ? `<p>${escape(job.error)}</p>` : ""}${job.status === "completed" && project?.revision !== job.baseRevision && !applied ? '<p class="dc-property-note">项目已有新修订。原提案保留；应用时会检查冲突，不能直接覆盖最新源码。</p>' : ""}${files.length ? `<details class="dc-proposal"><summary>查看提案文件 · ${files.length}</summary>${files.map(file => `<div><code>${escape(file.path)}</code><small>${file.content === undefined ? "删除文件" : file.expectedHash === null ? "新增文件" : "修改文件"}</small>${file.content !== undefined && file.encoding !== "base64" ? `<pre>${escape(file.content.slice(0, 1800))}${file.content.length > 1800 ? "\n…（内容已截短，完整提案仍保留在任务中）" : ""}</pre>` : ""}</div>`).join("")}</details>` : ""}<div class="dc-actions-wrap" style="margin-top:10px">${job.status === "completed" && !applied ? `<button class="primary" data-action="apply-generation"${saving ? " disabled" : ""}>应用提案到项目</button>` : ""}${job.status === "running" ? '<button data-action="cancel-generation">停止任务</button>' : ""}<button data-action="refresh-generation">刷新状态</button></div>${job.log?.length ? `<details class="dc-proposal"><summary>任务记录</summary><pre>${escape(job.log.slice(-5).join("\n"))}</pre></details>` : ""}</div>`;
  }
  function referenceMarkup(reference: DesignReferenceMetadata) {
    return `<p class="dc-hint">案例参考：${reference.selectedId ? `${escape(reference.title)} · ${reference.views.length} 张参考画面` : "未使用固定案例"}。作品审阅另行记录。</p>`;
  }
  function proposalDraftsMarkup() {
    if (!project) return "";
    const projectId = project.id;
    const listed = proposalDrafts.get(projectId) ?? [];
    const draftsById = new Map(listed.map(draft => [draft.id, draft]));
    const job = jobs.get(projectId);
    if (job?.draft?.projectId === projectId) draftsById.set(job.draft.id, job.draft);
    return `<div class="dc-section"><div class="dc-section-title">未验收草稿</div><p class="dc-hint">当前审阅页：${escape(currentPage()?.name)}。草稿不可直接应用；继续会启动新的本地任务，重新编译、渲染与审阅，并沿用草稿原有参考案例。</p><button style="width:100%" data-action="list-drafts"${draftsLoading.has(projectId) ? " disabled" : ""}>${draftsLoading.has(projectId) ? "正在读取草稿…" : "查看 / 刷新未验收草稿"}</button>${unsupportedDrafts.length ? `<p class="dc-hint" role="status">本地另有 ${unsupportedDrafts.length} 份不支持格式的旧草稿，不提供继续入口；原文件保留。</p>` : ""}${Array.from(draftsById.values()).map(draft => proposalDraftMarkup(draft)).join("")}${draftsLoaded.has(projectId) && !draftsById.size ? '<p class="dc-hint">当前项目没有可列出的未验收草稿。</p>' : ""}</div>`;
  }
  function proposalDraftMarkup(draft: ProposalDraft) {
    const expired = draft.expired || Date.parse(draft.expiresAt) <= Date.now();
    const canResume = draft.resumable && !expired && !generationStarting && jobs.get(draft.projectId)?.status !== "running";
    const detail = draftDetails.get(draft.id);
    const stage = ({ compiled: "已编译", rendering: "渲染中", rendered: "已渲染", reviewing: "审阅中" } as Record<string, string>)[draft.stage] ?? draft.stage;
    const originStatus = ({ running: "执行中", completed: "已完成记录", failed: "失败", cancelled: "已取消", interrupted: "中断记录", "not-attached": "当前进程未连接原任务" } as Record<string, string>)[draft.originStatus] ?? draft.originStatus;
    return `<article class="dc-draft-card"><strong>未验收 · 不可应用${expired ? " · 已过期" : ""}</strong><p class="dc-hint">基于修订 ${draft.baseRevision} · ${escape(stage)} · ${draft.captureCount} 张截图记录<br>原任务状态：${escape(originStatus)}</p>${draft.lastError ? `<p class="dc-hint">${escape(draft.lastError)}</p>` : ""}${referenceMarkup(draft.reference)}<code>${escape(draft.id)}</code><div class="dc-actions-wrap" style="margin-top:9px"><button data-draft-view="${escape(draft.id)}">查看草稿信息</button><button class="primary" data-draft-resume="${escape(draft.id)}"${canResume ? "" : " disabled"}>继续审阅本页</button></div>${!canResume && !expired ? '<p class="dc-hint">草稿当前不可继续，或已有任务执行中；可刷新信息核对状态。</p>' : ""}${detail ? `<details class="dc-proposal" open><summary>草稿文件与截图记录</summary><p>${detail.files.length} 个文件；${detail.captures.length} 条截图元数据。本面板未回看截图。</p>${detail.files.map(file => `<p><code>${escape(file.path)}</code><small>${escape(file.sha256)}</small></p>`).join("")}${detail.captures.map(capture => `<p>${escape(project?.pages.find(page => page.id === capture.pageId)?.name ?? capture.pageId)} · ${escape(capture.viewportId)} · ${capture.width} × ${capture.height}</p>`).join("")}</details>` : ""}</article>`;
  }
  function readProposalDraft(value: unknown): ProposalDraft {
    if (!value || typeof value !== "object") throw new Error("服务未返回有效草稿信息。");
    const draft = value as ProposalDraft;
    if (typeof draft.id !== "string" || typeof draft.projectId !== "string" || draft.status !== "unverified" || draft.requiresReview !== true || typeof draft.baseRevision !== "number" || typeof draft.resumable !== "boolean" || typeof draft.expired !== "boolean" || typeof draft.expiresAt !== "string") throw new Error("未验收草稿的身份或状态无效。");
    readReferenceMetadata(draft.reference);
    return draft;
  }
  async function listProposalDrafts() {
    if (!project || draftsLoading.has(project.id)) return;
    const projectId = project.id, ticket = ++draftListTicket; draftsLoading.add(projectId); renderInspector();
    try {
      const result = await call("design_code_list_drafts", { projectId, includeExpired: true });
      if (disposed) return;
      if (!Array.isArray(result.drafts)) throw new Error("服务没有返回草稿列表。");
      if (!Array.isArray(result.unsupported)) throw new Error("服务没有返回不支持格式的草稿诊断。");
      if (ticket === draftListTicket) unsupportedDrafts = result.unsupported.filter(item => item && typeof item === "object" && typeof item.id === "string" && typeof item.reason === "string") as typeof unsupportedDrafts;
      const items = result.drafts.map(readProposalDraft).filter(draft => draft.projectId === projectId);
      proposalDrafts.set(projectId, items); draftsLoaded.add(projectId);
    } catch (error) { notify(`读取草稿失败：${message(error)}`, true); }
    finally { draftsLoading.delete(projectId); if (!disposed && project?.id === projectId) renderInspector(); }
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
    if (aiPrompt.length > 10_000) { notify("完整需求超过 10000 字，尚未启动；请把补充说明保存为项目文件。", true); return; }
    if (generationStarting || jobs.get(project.id)?.status === "running") { notify("已有本地任务执行中，请先处理当前任务。", true); return; }
    const projectId = project.id; const pageId = activePageId;
    generationStarts.add(projectId); generationStarting = true; aiError = false; aiStatus = "正在为未验收草稿启动新的审阅任务…"; renderInspector();
    try {
      const result = await call("design_code_resume_generation", { projectId, checkpointId, timeoutMs: generationBudgetMs, pageIds: [pageId], ...(aiModel ? { model: aiModel } : {}), ...(aiPrompt.trim() ? { prompt: aiPrompt.trim() } : {}) });
      const job = readGenerationJob(result.job);
      if (job.projectId !== projectId) throw new Error("继续审阅结果属于其他项目，未关联到当前项目。");
      jobs.set(projectId, job);
      if (project?.id === projectId) aiStatus = "新的本地审阅任务已启动；原草稿仍未应用，只有新任务完成的提案才可应用。";
      scheduleGenerationPoll();
    } catch (error) { if (project?.id === projectId) { aiStatus = `未能继续审阅：${message(error)}。原草稿未应用。`; aiError = true; } else notify(message(error), true); }
    finally { generationStarts.delete(projectId); generationStarting = !!project && generationStarts.has(project.id); if (!disposed && project?.id === projectId) renderInspector(); }
  }
  function commentLocationMarkup(comment: CodeProject["comments"][number]) {
    const state = commentAnchors.resolve(comment);
    const labels = { file: "文件评论", checking: "锚点核对未完成", live: "源码锚点有效", missing: state.fileExists ? "原锚点未在页面中找到" : "源文件已移除", unknown: "锚点无法核对" };
    const progress = state.pendingPageIds.length ? ` · 其余 ${state.pendingPageIds.length} 页待按需核对` : "";
    const pageButtons = state.pages.map(page => `<button data-comment-page="${escape(comment.id)}" data-page-id="${escape(page.id)}" title="${escape(page.entry)} · ${escape(page.route)}">${icon("cursor")}${escape(page.name)}${page.id === activePageId ? " · 当前页" : " · 前往定位"}</button>`).join("");
    const note = !comment.sourceId ? "文件评论不绑定具体元素。" : !state.fileExists ? "评论已保留，未改绑到其他文件或元素。" : state.status === "missing" ? "标记可能已移除，或源码未被任何页面引用；评论保留，未按偏移量改绑。" : state.status === "unknown" ? "页面编译或读取失败，不能据此判定原锚点已丢失。" : state.status === "live" ? `${state.pages.some(page => page.identity !== "stable") ? "包含临时源码身份，仅对当前修订有效。" : "已核实源码身份。"}条件内容可能未显示；共享或重复组件不能区分运行实例。` : "按已保存修订读取各页注册表，未使用旧位置重新绑定。";
    return `<span class="dc-anchor-status ${state.status}" role="status">${escape(labels[state.status])}${escape(progress)}</span><button class="anchor" data-comment-anchor="${escape(comment.id)}"${state.fileExists ? "" : " disabled"}>${icon("code")}${escape(comment.file)}${state.fileExists ? " · 打开源码" : ""}</button>${pageButtons ? `<div class="dc-comment-pages" aria-label="含原源码锚点的页面">${pageButtons}</div>` : ""}<small class="dc-anchor-note">${escape(note)}</small>${state.unknownPages.length ? `<details class="dc-anchor-errors"><summary>${state.unknownPages.length} 页未能核对</summary>${state.unknownPages.map(page => `<p><strong>${escape(page.name)}</strong>：${escape(page.reason)}</p>`).join("")}</details>` : ""}`;
  }
  function commentsMarkup() {
    if (!project) return '<div class="dc-empty">创建项目后即可添加定位评论。</div>';
    return (project.comments.length ? `<div class="dc-comment-check"><small>锚点按已保存修订 ${project.revision} 核对${hasDirty() ? "，源码草稿尚未参与" : ""}。</small><button data-action="check-comment-anchors" title="按需编译全部页面的源码索引，不创建额外画板">${icon("refresh")}核对全部页面</button></div>` : "") + (project.comments.map(comment => `<article class="dc-comment${comment.status === "resolved" ? " resolved" : ""}" data-comment-id="${escape(comment.id)}" data-comment-status="${escape(comment.status)}" aria-label="${comment.status === "resolved" ? "已解决评论" : "待处理评论"}"><div class="dc-comment-meta"><time>${escape(new Date(comment.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</time><span class="dc-comment-status">${comment.status === "resolved" ? "已解决" : "待处理"}</span><button data-comment-resolve="${escape(comment.id)}" aria-label="${comment.status === "resolved" ? "重新打开评论" : "标记评论为已解决"}" title="${comment.status === "resolved" ? "重新打开" : "标记已解决"}">${icon("check")}</button></div><p>${escape(comment.text)}</p><div class="dc-comment-location" data-comment-location="${escape(comment.id)}" data-anchor-state="${commentAnchors.resolve(comment).status}">${commentLocationMarkup(comment)}</div></article>`).join("") || '<div class="dc-empty"><strong>把反馈留在设计上</strong>选择元素后添加评论，模型会收到源文件和待处理反馈。</div>');
  }
  function renderInspector() {
    if (modal) return;
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
    if (modal === "new") content = `<h2>创建可运行原型</h2><p>项目保留真实源文件。你可以直接编辑代码，也可以由当前聊天持续生成和修改。</p><label class="dc-field">项目名称<input data-new-name value="${escape(newName)}" maxlength="200"/></label><div class="dc-template-grid"><button class="${template === "react" ? "active" : ""}" data-template="react"><strong>React 组件项目</strong><small>真实 JSX 组件、样式与交互逻辑，适合产品原型。</small></button><button class="${template === "html" ? "active" : ""}" data-template="html"><strong>HTML 项目</strong><small>HTML、CSS 和 JavaScript，适合页面与轻量交互。</small></button></div><div class="dc-modal-actions"><button data-action="project-archive-view">打开 Design 工程 ZIP</button><button data-action="close-modal">取消</button><button class="primary" data-action="create-project">创建项目</button></div>`;
    if (modal === "project-archive") content = `<h2>打开 Design 工程</h2><p>从完整 ZIP 创建独立新副本，自动恢复真实源码、页面、路由、组件、令牌与评论。原工程的目录连接与版本历史不会继承。</p><label class="dc-field">Design 工程 ZIP<input type="file" accept=".zip,application/zip" data-project-archive aria-label="选择 Design 工程 ZIP"/></label><label class="dc-field">新副本名称（可选）<input data-project-archive-name maxlength="200" value="${escape(archiveName)}" placeholder="留空沿用工程原名"${archiveOperation?.ticket === archiveTicket ? " disabled" : ""}/></label><div data-project-archive-state>${archiveStateMarkup()}</div><div class="dc-modal-actions"><button data-action="close-modal">${archiveOperation?.phase === "submitted" ? "关闭，后台继续" : archiveOperation ? "取消读取并关闭" : "关闭"}</button><button class="primary" data-action="import-project-archive"${!selectedArchive || archiveOperation ? " disabled" : ""}>${archiveOperation ? "正在打开…" : "打开为新副本"}</button></div>`;
    if (modal === "file") content = `<h2>添加源文件</h2><p>路径相对项目根目录。已有文件不会被覆盖。</p><label class="dc-field">文件路径<input data-new-file-path value="${escape(newFilePath)}" placeholder="src/components/Card.tsx"/></label><div class="dc-modal-actions"><button data-action="close-modal">取消</button><button class="primary" data-action="create-file">添加文件</button></div>`;
    if (modal === "source-import") content = `<h2>只读导入本地工程</h2><p>建立独立项目和私有目录基线，不改源目录、不安装依赖或执行脚本。导入报告会显示未纳入的文件。</p><label class="dc-field">本地源码目录<input data-source-directory value="${escape(sourceDirectoryInput)}" placeholder="输入明确选择的绝对目录"/></label><label class="dc-field">项目名称<input data-source-import-name value="${escape(sourceImportName)}"/></label><label class="dc-field">入口（可选）<input data-source-import-entry value="${escape(sourceImportEntry)}" placeholder="index.html 或 src/main.tsx"/></label><div class="dc-modal-actions"><button data-action="close-modal">取消</button><button class="primary" data-action="source-import"${sourceImportStarting ? " disabled" : ""}>${sourceImportStarting ? "正在只读导入…" : "只读导入工程"}</button></div>`;
    if (modal === "source-difference" && sourceFileDifference) {
      const difference = sourceFileDifference; const notice = sourceDifferenceNotice?.projectId === difference.projectId && sourceDifferenceNotice.file === difference.file ? sourceDifferenceNotice : undefined;
      const stale = !project || difference.projectId !== project.id || difference.revision !== project.revision; const busy = sourceBusy.has(difference.projectId); const needsRecheck = ["writing", "partial"].includes(sourceStatuses.get(difference.projectId)?.operation?.phase ?? ""); const blocked = stale || busy || needsRecheck || !!difference.difference.issue || !!notice?.invalidated || !!notice?.reading;
      const side = (title: string, file: SourceSide | null) => `<section><strong>${title}</strong><p>${file ? `${file.bytes} 字节 · ${escape(file.sha256)}` : "此端不存在（选择此端会删除另一端文件）"}</p>${file?.content !== undefined ? `<textarea readonly data-modal-key="${title}" aria-label="${title}源码">${escape(file.content)}</textarea>` : `<p>${file ? "二进制资产：按实际字节和 hash 比较，不转抄内容。" : "文件不存在"}</p>`}</section>`;
      content = `<h2>源码对照</h2><code>${escape(difference.file)}</code><p>比较修订 ${difference.revision}${stale ? " · 已过期，请刷新项目后重新读取" : notice?.invalidated ? " · 旧快照已停用" : ""}。以下是读取时的两端内容；共同基线仅保存 hash。双方变更不会自动合并。选择版本将明确替换另一端，执行时还会重新核对两端 hash。</p>${needsRecheck && !notice?.error ? '<p class="dc-source-error" role="alert">写入记录尚未核对。请先关闭对照，在源码目录中重查写入记录；重新读取两端不会自动继续写入。</p>' : ""}${notice?.error ? `<div class="dc-source-error" role="alert"><strong>${escape(notice.error)}</strong>${notice.detail ? `<details><summary>技术详情</summary><p>${escape(notice.detail)}</p></details>` : ""}</div>` : ""}${notice?.reading ? '<p class="dc-hint" role="status">正在读取两端最新内容…</p>' : busy ? '<p class="dc-hint" role="status">正在核对并应用所选版本…</p>' : ""}<div class="dc-source-diff">${side("项目版本", difference.projectFile)}${side("目录版本", difference.directoryFile)}</div><div class="dc-modal-actions"><button data-action="close-modal">关闭</button><button data-action="source-refresh-difference"${busy || notice?.reading ? " disabled" : ""}>重新读取两端</button><button data-action="source-resolve-directory"${blocked ? " disabled" : ""}>采用目录版本 → 项目</button><button class="primary" data-action="source-resolve-project"${blocked ? " disabled" : ""}>采用项目版本 → 目录</button></div>`;
    }
    if (modal === "export") content = `<h2>导出可运行设计</h2><p>导出读取已保存的修订 ${project?.revision ?? ""}。ZIP 保留全部源文件，HTML 保留真实页面导航；图片和 PDF 渲染所选页面与尺寸。</p><label class="dc-field">起始/渲染页面<select data-export-page>${project?.pages.map(page => `<option value="${escape(page.id)}"${page.id === exportPageId ? " selected" : ""}>${escape(page.name)}</option>`).join("")}</select></label><label class="dc-field">预览尺寸<select data-export-viewport>${project?.viewports.filter(viewport => !viewport.pageId || viewport.pageId === exportPageId).map(item => `<option value="${escape(item.id)}"${item.id === exportViewportId ? " selected" : ""}>${escape(item.name)} · ${item.width} × ${item.height}</option>`).join("")}</select></label><div class="dc-export-grid">${[["html", "HTML", "可运行的多页原型"], ["zip", "ZIP", "完整代码与素材"], ["png", "PNG", "指定页面的截图"], ["pdf", "PDF", "设计审阅文件"]].map(([format, title, detail]) => `<button data-export="${format}"><strong>${title}</strong><small>${detail}</small></button>`).join("")}</div><div class="dc-modal-actions"><button data-action="close-modal">完成</button></div>`;
    return `<div class="dc-modal-backdrop"><section class="dc-modal${modal === "source-difference" ? " dc-modal-wide" : ""}" role="dialog" aria-modal="true" tabindex="-1" aria-label="${modal === "new" ? "创建代码原型" : modal === "file" ? "添加源文件" : modal === "project-archive" ? "打开 Design 工程" : modal === "source-import" ? "导入本地工程" : modal === "source-difference" ? "源码对照" : "导出代码原型"}">${content}</section></div>`;
  }
  function render() {
    if (disposed) return;
    const focus = captureFocus();
    const modalScroll = root.querySelector<HTMLElement>(".dc-modal");
    const scroll = modalScroll ? { top: modalScroll.scrollTop, left: modalScroll.scrollLeft } : undefined;
    if (root.querySelector(".dc-app")) {
      const body = root.querySelector<HTMLElement>(".dc-body")!;
      body.classList.toggle("show-left", leftOpen); body.classList.toggle("show-right", rightOpen);
      root.querySelector(".dc-modal-backdrop")?.remove();
      if (modal) body.insertAdjacentHTML("beforeend", modalMarkup());
      renderHeader(); renderFilePanel(); renderCanvas(); renderInspector(); renderProjectNotice(); renderStatus(); renderToast();
      finishModalFocus(focus, scroll);
      return;
    }
    root.innerHTML = `<div class="dc-app"><header class="dc-header"></header><main class="dc-body${leftOpen ? " show-left" : ""}${rightOpen ? " show-right" : ""}"><aside class="dc-sidebar" aria-label="项目源文件"><nav class="dc-tabs"><button data-left-tab="files" class="${leftTab === "files" ? "active" : ""}">文件</button><button data-left-tab="system" class="${leftTab === "system" ? "active" : ""}">设计系统</button><button data-left-tab="source" class="${leftTab === "source" ? "active" : ""}">源码目录</button></nav><div class="dc-scroll flush" data-left-panel></div><div class="dc-source-meta">源码是可持续编辑的交付内容。<br><code>${escape(currentPage()?.entry ?? "尚未打开项目")}</code></div></aside><section class="dc-stage" aria-label="可运行原型工作区"><div class="dc-stage-top"></div><div class="dc-canvas" data-stage-content></div></section><aside class="dc-inspector" aria-label="源码定位与设计助手"><nav class="dc-tabs"><button data-right-tab="inspect" class="${rightTab === "inspect" ? "active" : ""}">元素</button><button data-right-tab="ai" class="${rightTab === "ai" ? "active" : ""}">${icon("spark")}AI</button><button data-right-tab="comments" class="${rightTab === "comments" ? "active" : ""}">评论${project?.comments.filter(comment => comment.status === "open").length ? ` · ${project.comments.filter(comment => comment.status === "open").length}` : ""}</button></nav><div class="dc-scroll" data-right-panel></div><div class="dc-comment-composer" hidden></div></aside>${modalMarkup()}</main><footer class="dc-footer"><span data-connection></span><span class="keyboard" data-mode-label>${mode === "select" ? "点击原型元素以定位源码" : "原型交互正在运行"}</span><span class="keyboard">空格拖动画布 · ⌘ / Ctrl + S 保存源码</span><span class="right" data-revision></span></footer></div>`;
    renderHeader(); renderFilePanel(); renderCanvas(); renderInspector(); renderProjectNotice(); renderStatus(); renderToast();
    finishModalFocus(focus, scroll);
  }
  function openModal(name: string, returnFocus?: EditorFocus) {
    historyFocusOwner = undefined;
    if (modal !== name) { if (modal === "project-archive") invalidateArchiveIntent(); modalReturnFocus = returnFocus ?? captureFocus(); modalControlFocus = undefined; }
    modal = name; render();
  }
  function captureFocus(element: Element | null = document.activeElement): EditorFocus | undefined {
    if (!(element instanceof HTMLElement) || !root.contains(element)) return;
    // A comment action keeps its identity when its accessible name changes
    // between resolving and reopening. Never include that mutable name.
    const commentAction = element.hasAttribute("data-comment-resolve");
    const attributes = [...element.attributes].filter(attribute => commentAction ? attribute.name === "data-comment-resolve" : attribute.name.startsWith("data-") || attribute.name === "aria-label");
    const selector = element.matches(".dc-modal") ? ".dc-modal" : attributes.length ? element.tagName.toLowerCase() + attributes.map(attribute => `[${CSS.escape(attribute.name)}="${CSS.escape(attribute.value)}"]`).join("") : element.id ? `#${CSS.escape(element.id)}` : undefined;
    if (!selector) return;
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : undefined;
    return { projectId: project?.id, selector, inModal: !!element.closest(".dc-modal"), start: input?.selectionStart, end: input?.selectionEnd, direction: input?.selectionDirection, top: element.scrollTop, left: element.scrollLeft };
  }
  function usableFocus(element: HTMLElement, dialog = false): boolean {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return root.contains(element) && !element.closest("[hidden],[inert]") && !element.matches(":disabled") && (dialog || element.tabIndex >= 0) && rect.width > 0 && rect.height > 0 && style.display !== "none" && !["hidden", "collapse"].includes(style.visibility);
  }
  function modalFocusables(dialog: HTMLElement): HTMLElement[] {
    return [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"]')].filter(element => usableFocus(element));
  }
  function restoreFocus(focus: EditorFocus | undefined, scope: HTMLElement = root): boolean {
    if (!focus || focus.projectId !== project?.id || modal && !focus.inModal) return false;
    const candidates = scope.matches(focus.selector) ? [scope] : [...scope.querySelectorAll<HTMLElement>(focus.selector)];
    const element = candidates.find(candidate => usableFocus(candidate, candidate.matches(".dc-modal,[data-token-actions]")));
    if (!element) return false;
    element.focus({ preventScroll: true });
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) try { if (focus.start != null) element.setSelectionRange(focus.start, focus.end ?? focus.start, focus.direction ?? undefined); } catch { /* Numeric controls have no text selection range. */ }
    element.scrollTop = focus.top; element.scrollLeft = focus.left;
    return document.activeElement === element;
  }
  function finishModalFocus(focus: EditorFocus | undefined, scroll?: { top: number; left: number }) {
    const dialog = root.querySelector<HTMLElement>(".dc-modal");
    const background = [...root.querySelectorAll<HTMLElement>(".dc-header,.dc-footer,.dc-body > :not(.dc-modal-backdrop)")];
    for (const element of background) element.inert = !!modal;
    if (modal && dialog) {
      const continuing = renderedModal === modal;
      if (continuing && focus?.inModal && focus.selector !== ".dc-modal") modalControlFocus = focus;
      if (continuing && modalControlFocus) {
        if (!restoreFocus(modalControlFocus, dialog)) dialog.focus({ preventScroll: true });
      } else (modalFocusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
      if (continuing && scroll) { dialog.scrollTop = scroll.top; dialog.scrollLeft = scroll.left; }
    } else if (renderedModal) {
      if (!restoreFocus(modalReturnFocus)) {
        const selectors = renderedModal === "source-difference" ? ['[data-left-tab="source"]','[data-setting="project"]','[data-action="new"]'] : ['[data-setting="project"]','[data-action="new"]','[data-view="design"]'];
        for (const selector of selectors) { const target = [...root.querySelectorAll<HTMLElement>(selector)].find(element => usableFocus(element)); if (target) { target.focus({ preventScroll: true }); break; } }
      }
      modalReturnFocus = undefined; modalControlFocus = undefined;
    } else restoreFocus(focus);
    renderedModal = modal;
  }
  function historyFocusScope(owner: HistoryFocusOwner): boolean {
    return !disposed && root.isConnected && project?.id === owner.projectId && loadSerial === owner.loadSerial && !modal;
  }
  function ownsHistoryFocus(owner: HistoryFocusOwner): boolean {
    return historyFocusOwner === owner && historyFocusScope(owner) && root.contains(owner.anchor) && document.activeElement === owner.anchor && document.hasFocus();
  }
  function moveHistoryFocus(owner: HistoryFocusOwner, target: HTMLElement): boolean {
    if (historyFocusOwner !== owner || !historyFocusScope(owner) || !usableFocus(target, true)) return false;
    movingHistoryFocus = true;
    try { owner.anchor = target; target.focus({ preventScroll: true }); }
    finally { movingHistoryFocus = false; }
    if (document.activeElement !== target) { historyFocusOwner = undefined; return false; }
    return true;
  }
  function beginHistoryFocus(): HistoryFocusOwner | undefined {
    const target = document.activeElement;
    if (!project || modal || !(target instanceof HTMLElement) || !target.matches('.dc-header button[data-action="undo"],.dc-header button[data-action="redo"]') || !usableFocus(target)) return;
    const owner: HistoryFocusOwner = { projectId: project.id, loadSerial, action: target.dataset.action as "undo" | "redo", anchor: target, inFlight: true };
    historyFocusOwner = owner;
    // A real disabled button cannot retain focus. Park on its visible, inert-action
    // group until the operation and actual history metadata have both settled.
    const group = root.querySelector<HTMLElement>("[data-history-focus]");
    if (!group || !moveHistoryFocus(owner, group)) { historyFocusOwner = undefined; return; }
    return owner;
  }
  function reconcileHistoryFocus() {
    try {
      const owner = historyFocusOwner; if (!owner) return;
      if (!ownsHistoryFocus(owner)) { historyFocusOwner = undefined; return; }
      if (owner.inFlight || saving || historyRequests.has(`${owner.projectId}:${project!.revision}`)) return;
      const opposite = owner.action === "undo" ? "redo" : "undo";
      const selectors = [`button[data-action="${owner.action}"]`, `button[data-action="${opposite}"]`, 'button[data-action="refresh"]', 'select[data-setting="project"]', 'button[data-action="export"]'];
      for (const selector of selectors) {
        const target = [...root.querySelectorAll<HTMLElement>(`.dc-header ${selector}`)].find(element => usableFocus(element));
        if (target) { moveHistoryFocus(owner, target); break; }
      }
      historyFocusOwner = undefined;
    } finally { root.querySelector("[data-history-focus]")?.setAttribute("aria-busy", String(saving > 0 || !!historyFocusOwner)); }
  }
  function onHistoryFocusIn(event: FocusEvent) {
    if (historyFocusOwner && !movingHistoryFocus && event.target !== historyFocusOwner.anchor) historyFocusOwner = undefined;
  }
  function onHistoryFocusIntent(event: Event) {
    if (!movingHistoryFocus && (event.type === "pointerdown" || event instanceof KeyboardEvent && event.key === "Tab")) historyFocusOwner = undefined;
  }
  function onFocusIn(event: FocusEvent) {
    const dialog = modal ? root.querySelector<HTMLElement>(".dc-modal") : undefined;
    if (dialog && event.target instanceof HTMLElement && !dialog.contains(event.target)) {
      if (!restoreFocus(modalControlFocus, dialog)) (modalFocusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    }
  }
  async function generate() {
    if (!project || !aiPrompt.trim()) { notify("请填写设计需求。", true); return; }
    if (aiPrompt.length > 10_000) { notify("设计需求请控制在 10000 字以内，可在项目文件中补充长篇说明。", true); return; }
    if (hasDirty()) { notify("请先保存源码草稿，再交给模型修改项目。", true); return; }
    if (generationStarting || deliveryUnknown) { notify(deliveryUnknown ? "上次投递结果未知，请先查看聊天并确认是否收到。" : "当前需求仍在处理中。", true); return; }
    const projectId = project.id;
    const revision = project.revision, pageId = activePageId, serial = loadSerial;
    const brief = aiPrompt.trim(), ticket = ++nextGenerationTicket;
    generationTickets.set(projectId, ticket); generationStarts.add(projectId);
    const generationMode = aiMode;
    const requestedModel = aiModel;
    const requestedReference = aiReference;
    const selectedDirection = directions.find(direction => direction.id === aiDirection);
    const directionId = selectedDirection?.id;
    const context = { ...designTaskContext(project, pageId, { activeFile, canvasMode, viewportId: activeViewport, ...(selection ? { selected: { sourceId: selection.source.id, file: selection.source.file, start: selection.source.start, end: selection.source.end, tag: selection.source.tag, fileHash: selection.fileHash, selectedRevision: selection.revision, pageId: selection.pageId, stale: !selectedIsCurrent(), text: selection.text, computedStyles: selection.styles, runtimeLiteralText: selection.runtimeLiteralText, ancestorMapped: selection.ancestorMapped } } : {}) }), referenceChoice: requestedReference, directionChoice: aiDirection };
    let request = designTaskPrompt(brief, context);
    const isCurrent = () => !disposed && project?.id === projectId && project.revision === revision && activePageId === pageId && loadSerial === serial && generationTickets.get(projectId) === ticket && !hasDirty();
    const outcome = (patch: Partial<AiDraftState>) => { if (!disposed && generationTickets.get(projectId) === ticket) updateAiState(projectId, patch); };
    let deliveryAttempted = false;
    generationStarting = true;
    aiStatus = "正在整理源文件、选中元素与评论…"; aiError = false; fallbackPrompt = request; renderInspector();
    try {
      if (generationMode === "codex") {
        if (selectedDirection) request += `\n\n视觉方向参考：${selectedDirection.name}（${selectedDirection.id}）：${selectedDirection.summary}。已有品牌与明确要求优先。`;
        outcome({ fallback: request });
        if (request.length > 30_000) throw new Error("完整需求和必要上下文超过本地任务 30000 字上限；需求已保留，请把补充说明保存为项目文件后重试。");
        if (!isCurrent()) { outcome({ status: "页面或项目已变化，未启动旧需求；完整需求已保留。" }); return; }
        const result = await call("design_code_request_generation", { projectId, prompt: request, timeoutMs: generationBudgetMs, pageIds: [pageId], referenceId: requestedReference, ...(requestedModel ? { model: requestedModel } : {}) });
        const job = readGenerationJob(result.job);
        if (job.projectId !== projectId) throw new Error("生成任务返回了其他项目，未关联到当前项目。");
        jobs.set(projectId, job);
        outcome({ status: "本地 Codex 任务已启动。完成提案会保留在这里，点击应用后才写入项目。", fallback: "" });
        scheduleGenerationPoll();
      } else {
        const result = await call("design_code_guidance", { projectId, pageId, prompt: brief, referenceId: requestedReference, ...(directionId ? { directionId } : {}) });
        const identity = result.context as { projectId?: string; revision?: number; pageId?: string } | undefined;
        if (!isCurrent() || identity?.projectId !== projectId || identity.revision !== revision || identity.pageId !== pageId) { outcome({ status: "项目或页面修订已变化，旧需求未发送；完整需求已保留，请核对最新工程。" }); return; }
        if (typeof result.prompt !== "string" || !result.prompt.includes(brief)) throw new Error("设计指导未保留完整需求，未发送。完整需求可复制回聊天。");
        request = designTaskPrompt(brief, context, result.prompt); outcome({ fallback: request });
        if (request.length > 30_000) throw new Error("完整需求和设计指导超过 30000 字，未发送。完整提示词已保留，可核对后复制到聊天。");
        deliveryAttempted = true;
        const delivery = await bridge.prompt(request, context, { isCurrent });
        if (delivery.status === "sent") outcome({ status: `已将基于修订 ${revision} 的本次需求交给当前聊天。模型保存的代码修改会自动刷新到预览。`, fallback: "", unknown: false });
        else if (delivery.status === "unknown") outcome({ status: delivery.reason ?? "投递结果未知，请先查看聊天，避免重复发送。", fallback: request, unknown: true, error: true });
        else outcome({ status: delivery.reason ?? "需求未发送，完整提示词已保留。", fallback: request, unknown: false });
      }
    } catch (error) { outcome({ status: deliveryAttempted ? `投递结果未知：${message(error)}。请先查看聊天，避免重复发送。` : message(error), error: true, unknown: deliveryAttempted, fallback: request }); }
    finally { generationStarts.delete(projectId); generationStarting = !!project && generationStarts.has(project.id); if (!disposed) renderInspector(); }
  }
  function readGenerationJob(value: unknown): GenerationJob {
    if (!value || typeof value !== "object") throw new Error("任务服务未返回有效任务。");
    const job = value as GenerationJob;
    if (typeof job.id !== "string" || typeof job.projectId !== "string" || !["running", "completed", "failed", "cancelled"].includes(job.status) || typeof job.baseRevision !== "number" || !job.verification || typeof job.verification.compiled !== "boolean" || typeof job.verification.rendered !== "boolean" || typeof job.verification.modelReviewed !== "boolean" || typeof job.verification.viewports !== "number") throw new Error("任务状态或验证记录无效。");
    readReferenceMetadata(job.reference);
    return job;
  }
  function readReferenceMetadata(value: unknown): DesignReferenceMetadata {
    const reference = value as DesignReferenceMetadata | undefined;
    if (!reference || reference.version !== DESIGN_REFERENCE_VERSION || typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/.test(reference.digest) || reference.selectedId !== null && typeof reference.selectedId !== "string" || !Array.isArray(reference.views) || reference.views.length > 2 || reference.views.some(view => view !== "desktop" && view !== "mobile")) throw new Error("任务未返回当前版本的有效案例参考身份。");
    return reference;
  }
  async function loadModels(force = false) {
    if (modelsLoading || modelsLoaded && !force) return;
    modelsLoading = true; modelsError = ""; renderInspector();
    try { const result = await call("design_list_models", {}); if (!Array.isArray(result.models)) throw new Error("本机 Codex 没有返回有效模型目录。"); models = result.models as ModelSummary[]; modelsLoaded = true; }
    catch (error) { modelsError = `模型目录不可用：${message(error)}`; }
    finally { modelsLoading = false; if (!disposed) renderInspector(); }
  }
  async function loadDirections() {
    try { const result = await call("design_get_guidance", {}); if (disposed) return; if (Array.isArray(result.directions)) directions = result.directions as VisualDirection[]; if (Array.isArray(result.examples)) referenceExamples = result.examples.filter(item => item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string" && typeof item.task === "string") as ReferenceExample[]; renderInspector(); }
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
    historyFocusOwner = undefined;
    if (hasDirty()) { notify("请先保存或重新载入源码草稿，再撤销或重做。", true); return; }
    const projectId = project?.id;
    queue = queue.then(async () => {
      if (!project || project.id !== projectId || saving) return;
      if (historyMetadata?.projectId !== project.id || historyMetadata.revision !== project.revision) { notify("历史状态尚未核实，请刷新项目后重试。", true); return; }
      if (!(direction === "undo" ? historyMetadata.canUndo : historyMetadata.canRedo)) { notify(direction === "undo" ? "没有可撤销的版本。" : "没有可重做的版本。"); return; }
      const focusOwner = beginHistoryFocus();
      saving++; status = direction === "undo" ? "正在撤销…" : "正在重做…"; renderStatus();
      try { const result = await call(`design_code_${direction}`, { projectId: project.id, expectedRevision: project.revision }); const next = await hydrate(result); if (next) { selection = undefined; accept(next); } }
      catch (error) { notify(message(error), true); }
      finally { saving--; if (historyFocusOwner === focusOwner && focusOwner) focusOwner.inFlight = false; renderStatus(); }
    });
    await queue;
  }
  async function exportProject(format: string) {
    if (!project) return;
    if (hasDirty()) { notify("请先保存源码草稿，再导出最新设计。", true); return; }
    const projectId = project.id, expectedRevision = project.revision;
    const pageId = root.querySelector<HTMLSelectElement>("[data-export-page]")?.value || activePageId;
    const viewport = root.querySelector<HTMLSelectElement>("[data-export-viewport]")?.value || undefined;
    saving++; status = "正在导出…"; renderStatus();
    try {
      const result = await call("design_code_export", { projectId, expectedRevision, pageId, format, ...(viewport ? { viewportId: viewport } : {}) });
      if (typeof result.filename !== "string" || typeof result.mimeType !== "string" || typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.delivery !== "inline" && result.delivery !== "artifact") throw new Error("导出器没有返回真实文件与交付方式。");
      if (typeof result.artifactId !== "string" || result.projectId !== projectId || result.pageId !== pageId || result.revision !== expectedRevision || result.format !== format || typeof result.sha256 !== "string") throw new Error("导出器未返回可核对的文件修订身份。");
      if (result.delivery === "inline" && typeof result.dataBase64 !== "string") throw new Error("导出器没有返回可下载的文件内容。");
      if (disposed) return;
      const saveSnapshot = async () => {
        const saved = await call("design_code_save_export", { artifactId: result.artifactId });
        if (typeof saved.path !== "string" || saved.artifactId !== result.artifactId || saved.sha256 !== result.sha256 || saved.revision !== result.revision || saved.projectId !== projectId || saved.pageId !== pageId || saved.format !== format || saved.bytes !== result.bytes || saved.filename !== result.filename || saved.mimeType !== result.mimeType) throw new Error("本地保存未返回同一份导出文件的身份。");
        if (!disposed) notify(`修订 ${result.revision} 已保存到 ${saved.path}`);
      };
      if (result.delivery === "artifact") {
        status = "正在保存大文件…"; renderStatus();
        await saveSnapshot();
      } else {
        if (typeof result.dataBase64 !== "string") throw new Error("导出器没有返回可下载的文件内容。");
        const delivery = bridge.download ? await bridge.download({ filename: result.filename, mimeType: result.mimeType, dataBase64: result.dataBase64 }) : { saved: false, unsupported: true };
        if (disposed) return;
        if (delivery.saved) notify(`已向宿主提交下载 ${result.filename}`);
        else if (delivery.unsupported) await saveSnapshot();
        else notify(delivery.reason ?? "下载未完成或已取消。", true);
      }
    } catch (error) { if (!disposed) notify(message(error), true); }
    finally { saving--; status = "已保存"; if (!disposed) renderStatus(); }
  }
  function invalidateArchiveIntent() { archiveTicket++; if (archiveOperation?.phase === "reading") archiveOperation.reader?.abort(); }
  function closeCurrentModal() {
    const continuing = modal === "project-archive" && archiveOperation?.phase === "submitted";
    if (modal === "project-archive") invalidateArchiveIntent();
    modal = ""; render();
    if (continuing) notify("已关闭对话框；已提交的新副本创建仍会继续，完成后提供显式打开入口。");
  }
  function openProjectArchive() {
    if (hasDirty()) { notify("请先保存或协调源码草稿，再打开 Design 工程新副本。", true); return; }
    invalidateArchiveIntent(); openModal("project-archive");
  }
  function selectProjectArchive(file?: File) {
    invalidateArchiveIntent(); selectedArchive = file; archiveError = ""; archiveErrorHint = ""; archiveErrorDetail = "";
    if (file && (!file.size || file.size > archiveLimit)) { archiveError = file.size ? "ZIP 超过 32 MiB 工程上限，请减小工程后重新选择。" : "所选 ZIP 为空，请选择完整的 Design 工程。"; selectedArchive = undefined; }
    renderProjectArchiveState();
  }
  function archiveResult(result: Record<string, unknown>): { project: CodeProject; notice: ImportedArchiveCopy } {
    const value = result.importedFrom as Record<string, unknown> | undefined;
    if (!isProject(result.project) || result.project.revision !== 1 || !value || typeof value.projectId !== "string" || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || result.project.id === value.projectId || typeof result.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.archiveSha256)) throw new Error("导入结果没有确认独立的新副本，当前视图未切换。请读取项目列表核对创建状态。");
    return { project: result.project, notice: { projectId: result.project.id, name: result.project.name, importedFrom: { projectId: value.projectId, revision: Number(value.revision) }, archiveSha256: result.archiveSha256 } };
  }
  function rememberArchiveCopy(copy: ImportedArchiveCopy, announce = true) {
    const existing = projects.find(item => item.id === copy.projectId);
    if (!existing) projects = [{ id: copy.projectId, name: copy.name, revision: 1, updatedAt: new Date().toISOString() }, ...projects];
    if (project?.id !== copy.projectId) archiveNotice = copy;
    if (announce && !notifiedArchives.has(copy.projectId)) { notifiedArchives.add(copy.projectId); if (notifiedArchives.size > 50) notifiedArchives.delete(notifiedArchives.values().next().value!); notify(`已创建 Design 工程新副本“${copy.name}”（修订 1）。当前视图保持不变，可点击“打开新副本”。`); }
    if (!disposed) { renderHeader(); renderProjectNotice(); renderProjectArchiveState(); }
  }
  function archiveStateMarkup() {
    const file = selectedArchive, operation = archiveOperation;
    const size = file ? file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KiB` : `${(file.size / 1024 / 1024).toFixed(2)} MiB` : "";
    const selected = file ? `已选择：${file.name} · ${size}` : "尚未选择 ZIP 文件。";
    const progress = operation ? operation.phase === "submitted" ? `正在创建“${operation.fileName}”的新副本。关闭或更换文件只离开当前打开意图，不会取消已提交的创建。` : `正在读取“${operation.fileName}”的实际 ZIP 字节，尚未提交。` : "点击“打开为新副本”后才提交 ZIP；原项目、目录连接和历史不会被替换。";
    const failure = (main: string, hint: string, detail: string) => `<div class="dc-source-error" role="alert" data-project-archive-error><p data-project-archive-error-main>${escape(main)}</p>${hint ? `<p>${escape(hint)}</p>` : ""}${detail ? `<details><summary>查看原因</summary><pre>${escape(detail)}</pre></details>` : ""}</div>`;
    return `<p class="dc-archive-file" data-project-archive-selection>${escape(selected)}</p><p class="dc-hint" role="status" data-project-archive-progress>${escape(progress)}</p>${archiveError ? failure(archiveError, archiveErrorHint, archiveErrorDetail) : ""}${archiveBackgroundError ? failure(`后台请求“${archiveBackgroundError.fileName}”尚未确认完成。当前项目、源码和草稿已保留。`, archiveBackgroundError.hint, archiveBackgroundError.detail) : ""}${archiveNotice && archiveNotice.projectId !== project?.id ? `<div class="dc-archive-copy"><strong>已有新副本可打开</strong><p>${escape(archiveNotice.name)} · 来源修订 ${archiveNotice.importedFrom.revision}</p><button data-archive-open="${escape(archiveNotice.projectId)}">打开新副本</button></div>` : ""}`;
  }
  function renderProjectArchiveState() {
    if (disposed || modal !== "project-archive") return;
    const status = root.querySelector<HTMLElement>("[data-project-archive-state]"); if (status) status.innerHTML = archiveStateMarkup();
    const submit = root.querySelector<HTMLButtonElement>('[data-action="import-project-archive"]');
    if (submit) { const disable = !selectedArchive || !!archiveOperation || hasDirty(); if (disable && document.activeElement === submit) root.querySelector<HTMLElement>(".dc-modal")?.focus({ preventScroll: true }); submit.disabled = disable; submit.textContent = archiveOperation ? archiveOperation.phase === "submitted" ? "正在创建新副本…" : "正在读取 ZIP…" : "打开为新副本"; }
    const name = root.querySelector<HTMLInputElement>("[data-project-archive-name]"); if (name) name.disabled = !!archiveOperation && archiveOperation.ticket === archiveTicket;
    const close = root.querySelector<HTMLButtonElement>('.dc-modal [data-action="close-modal"]'); if (close) close.textContent = archiveOperation?.phase === "submitted" ? "关闭，后台继续" : archiveOperation ? "取消读取并关闭" : "关闭";
  }
  async function importProjectArchive() {
    if (archiveOperation || !selectedArchive) return;
    if (hasDirty()) { notify("请先保存或协调源码草稿，再打开 Design 工程。", true); return; }
    const file = selectedArchive, ticket = archiveTicket, serial = loadSerial, originId = project?.id;
    if (!file.size || file.size > archiveLimit) { archiveError = "请选择 1 字节至 32 MiB 的完整 ZIP。"; renderProjectArchiveState(); return; }
    const operation: ArchiveOperation = { ticket, phase: "reading", fileName: file.name, submitFocused: document.activeElement === root.querySelector('[data-action="import-project-archive"]') };
    archiveOperation = operation; archiveError = ""; archiveErrorHint = ""; archiveErrorDetail = ""; renderProjectArchiveState();
    let createdCopy = false;
    const currentIntent = () => !disposed && archiveTicket === ticket && loadSerial === serial && project?.id === originId && modal === "project-archive" && !hasDirty();
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); operation.reader = reader; reader.onload = () => { const result = reader.result; const match = typeof result === "string" ? /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(result) : undefined; match ? resolve(match[1]!) : reject(new Error("本地文件未返回有效的二进制 ZIP 数据。")); }; reader.onerror = () => reject(new Error("无法读取所选 ZIP，请重新选择本地文件。")); reader.onabort = () => reject(new Error("本地读取已停止，尚未提交工程。")); reader.readAsDataURL(file); });
      if (!currentIntent()) return;
      const name = archiveName.trim(); operation.phase = "submitted"; renderProjectArchiveState();
      const result = await call("design_code_import_project", { dataBase64, ...(name ? { name } : {}) });
      const imported = archiveResult(result);
      createdCopy = true;
      if (disposed) return;
      rememberArchiveCopy(imported.notice, !currentIntent());
      if (!currentIntent() || imported.project.id === originId) return;
      let ready = result;
      if (!Array.isArray(ready.files)) ready = await call("design_code_get", { projectId: imported.project.id });
      if (!currentIntent()) return;
      if (!isProject(ready.project) || ready.project.id !== imported.project.id || !Array.isArray(ready.files)) throw new Error("新副本已创建，但完整源码摘要未读取成功；可从“打开新副本”继续，当前项目未切换。");
      updateMetadata(ready); modal = ""; ++loadSerial; accept(ready.project, true);
      if (archiveNotice?.projectId === ready.project.id) archiveNotice = undefined;
      notify(`已打开 Design 工程新副本“${ready.project.name}”（修订 ${ready.project.revision}），页面、组件、令牌与评论来自原工程。`);
      renderHeader(); renderProjectNotice();
    } catch (error) {
      if (disposed || operation.phase === "reading" && !currentIntent()) return;
      const main = "尚未确认工程已打开。当前项目、源码和草稿已保留。", detail = message(error);
      const hint = createdCopy ? "新副本已创建，可通过“打开新副本”继续。" : /Invalid Design project archive/i.test(detail) ? "请确认选择的是完整的 Design 工程 ZIP，并重新导出后再试。" : operation.phase === "submitted" ? "请求结果尚未确认，后台可能已创建新副本。请先核对项目列表，再决定是否重试。" : "本地文件未能完成读取，请重新选择完整的 Design 工程 ZIP 后再试。";
      if (currentIntent()) { archiveError = main; archiveErrorHint = hint; archiveErrorDetail = detail; }
      else { archiveBackgroundError = { fileName: operation.fileName, hint, detail }; notify(`${main}${hint}可在“打开 Design 工程”查看原因。`, true); }
    } finally {
      if (archiveOperation === operation) archiveOperation = undefined;
      if (!disposed) { renderProjectArchiveState(); if (operation.submitFocused && modal === "project-archive" && document.activeElement?.matches(".dc-modal")) root.querySelector<HTMLElement>('[data-action="import-project-archive"]')?.focus({ preventScroll: true }); }
    }
  }
  async function openImportedArchive(projectId: string) {
    if (hasDirty()) { notify("请先保存或协调源码草稿，再打开已创建的新副本。", true); return; }
    if (modal) closeCurrentModal();
    await loadProject(projectId);
    if (!disposed && project?.id === projectId && archiveNotice?.projectId === projectId) { archiveNotice = undefined; renderHeader(); renderProjectNotice(); }
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
      case "new": openModal("new"); break;
      case "project-archive-view": openProjectArchive(); break;
      case "import-project-archive": await importProjectArchive(); break;
      case "close-modal": closeCurrentModal(); break;
      case "create-project": {
        if (hasDirty()) { notify("请先保存源码草稿，再创建项目。", true); break; }
        try { const serial = loadSerial; const result = await call("design_code_create", { name: newName.trim() || "未命名原型", template }); if (disposed || serial !== loadSerial) return; const next = await hydrate(result, true); if (next) { modal = ""; accept(next, true); } } catch (error) { notify(message(error), true); }
        break;
      }
      case "toggle-left": leftOpen = !leftOpen; rightOpen = false; render(); break;
      case "toggle-right": rightOpen = !rightOpen; leftOpen = false; render(); break;
      case "refresh": if (project) await loadProject(project.id, true); else await listProjects().catch(error => notify(message(error), true)); break;
      case "refresh-tokens": await loadTokens(); break;
      case "apply-tokens": await applyTokens(); break;
      case "cancel-tokens": { const state = tokenState(); if (state && !state.applying) { parkTokenAction(); state.drafts.clear(); state.error = ""; renderFilePanel(); } break; }
      case "tokens-prev": { const state = tokenState(); if (state && !state.loading && !state.applying) { parkTokenAction(); await loadTokens(Math.max(0, (state.catalog?.offset ?? 0) - 50)); } break; }
      case "tokens-next": { const state = tokenState(); if (state && !state.loading && !state.applying && typeof state.catalog?.nextOffset === "number") { parkTokenAction(); await loadTokens(state.catalog.nextOffset); } break; }
      case "check-comment-anchors": await checkCommentAnchors(true); break;
      case "page-overview": view = "design"; showOverview(); break;
      case "page-single": view = "design"; await selectPage(activePageId); break;
      case "fit": fitCanvas(); break;
      case "zoom-in": zoom(scale * 1.25); break;
      case "zoom-out": zoom(scale / 1.25); break;
      case "save-source": await saveSource(); break;
      case "reset-source": resetSource(); break;
      case "new-file": newFilePath = ""; openModal("file"); break;
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
      case "export": if (project) { exportPageId = activePageId; exportViewportId = activeViewport; openModal("export"); } break;
      case "generate": await generate(); break;
      case "refresh-models": await loadModels(true); break;
      case "refresh-generation": await refreshGeneration(); break;
      case "cancel-generation": await cancelGeneration(); break;
      case "apply-generation": await applyGeneration(); break;
      case "source-import-view": sourceDirectoryInput = ""; sourceImportEntry = ""; openModal("source-import"); break;
      case "source-import": await importSourceDirectory(); break;
      case "source-status": await readSourceStatus(); break;
      case "source-connect": await sourceAction("connect"); break;
      case "source-compare": await sourceAction("compare"); break;
      case "source-recheck": await sourceAction("recheck"); break;
      case "source-pull": await sourceAction("pull"); break;
      case "source-push": await sourceAction("push"); break;
      case "source-resolve-project": await resolveSourceDifference("project"); break;
      case "source-resolve-directory": await resolveSourceDifference("directory"); break;
      case "source-refresh-difference": if (sourceFileDifference) await openSourceDifference(sourceFileDifference.file); break;
      case "list-drafts": await listProposalDrafts(); break;
      case "confirm-prompt-received": deliveryUnknown = false; aiStatus = "已确认聊天收到本次需求。"; aiError = false; fallbackPrompt = ""; renderInspector(); break;
      case "confirm-prompt-missing": deliveryUnknown = false; aiStatus = "已确认聊天未收到，可以重新发送或复制完整提示词。"; aiError = false; renderInspector(); break;
      case "copy-prompt": if (deliveryUnknown) { notify("请先查看聊天并确认是否收到本次需求，避免重复发送。", true); break; } try { await navigator.clipboard.writeText(fallbackPrompt); notify("提示词已复制，请粘贴到当前聊天。 "); } catch { const input = root.querySelector<HTMLTextAreaElement>(".dc-fallback textarea"); input?.focus(); input?.select(); notify("请按 ⌘C / Ctrl+C 复制已选择的提示词。"); } break;
    }
  }
  function onClick(event: MouseEvent) {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action],[data-file],[data-left-tab],[data-right-tab],[data-view],[data-mode],[data-template],[data-comment-resolve],[data-comment-anchor],[data-comment-page],[data-export],[data-draft-view],[data-draft-resume],[data-source-diff],[data-token-source],[data-token-cancel],[data-board-active],[data-board-open],[data-board-retry],[data-archive-open]");
    if (!target || !root.contains(target) || (target as HTMLButtonElement).disabled) return;
    if (modal && !target.closest(".dc-modal")) return;
    if (target.dataset.tokenSource) {
      const state = tokenState(), definition = state?.catalog?.definitions.find(item => item.sourceId === target.dataset.tokenSource) ?? state?.drafts.get(target.dataset.tokenSource)?.definition;
      if (definition) openSource(definition.file, definition.fileHash === hashes.get(definition.file) ? { id: definition.sourceId, file: definition.file, fileHash: definition.fileHash, start: definition.start, end: definition.end, tag: "CSS", editableText: false } : undefined);
      return;
    }
    if (target.dataset.tokenCancel) {
      const state = tokenState(); if (state && !state.applying) { const key = target.dataset.tokenCancel; state.drafts.delete(key); state.error = ""; renderFilePanel(); root.querySelector<HTMLElement>(`[data-token-value="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }); }
      return;
    }
    if (target.dataset.archiveOpen) { void openImportedArchive(target.dataset.archiveOpen); return; }
    if (target.dataset.boardActive) { activateBoard(target.dataset.boardActive, target.dataset.viewportId || undefined); return; }
    if (target.dataset.boardOpen) { if (target.dataset.viewportId) activeViewport = target.dataset.viewportId; void selectPage(target.dataset.boardOpen); return; }
    if (target.dataset.boardRetry && project) { const pageId = target.dataset.boardRetry; for (const frame of [...frames]) if (frame.pageId === pageId) removeFrame(frame); previewPool.delete(pagePreviewKey(project.id, project.revision, pageId)); void loadPagePreview(project, pageId).catch(() => {}); renderCanvas(); return; }
    if (target.dataset.action) { void action(target.dataset.action); return; }
    if (target.dataset.file) { openSource(target.dataset.file); return; }
    if (target.dataset.leftTab) { leftTab = target.dataset.leftTab; renderFilePanel(); if (leftTab === "source" && project) void readSourceStatus(); if (leftTab === "system" && project) void loadTokens(); root.querySelectorAll<HTMLElement>("[data-left-tab]").forEach(button => button.classList.toggle("active", button.dataset.leftTab === leftTab)); return; }
    if (target.dataset.rightTab) { rightTab = target.dataset.rightTab; renderInspector(); if (rightTab === "comments") void checkCommentAnchors(); return; }
    if (target.dataset.view) { view = target.dataset.view; renderCanvas(); if (view === "design" && !cameras.has(cameraKey())) requestAnimationFrame(() => fitCanvas()); return; }
    if (target.dataset.mode) { setMode(target.dataset.mode as "select" | "preview"); return; }
    if (target.dataset.template) { template = target.dataset.template as "html" | "react"; render(); return; }
    if (target.dataset.export) { void exportProject(target.dataset.export); return; }
    if (target.dataset.sourceDiff) { void openSourceDifference(target.dataset.sourceDiff, target); return; }
    if (target.dataset.draftView) { void viewProposalDraft(target.dataset.draftView); return; }
    if (target.dataset.draftResume) { void resumeProposalDraft(target.dataset.draftResume); return; }
    if (target.dataset.commentResolve && project) { const commentId = target.dataset.commentResolve; void update(current => ({ comments: current.comments.map(comment => comment.id === commentId ? { ...comment, status: comment.status === "open" ? "resolved" : "open" } : comment) })); return; }
    if (target.dataset.commentPage && target.dataset.pageId && project) { void focusComment(target.dataset.commentPage, target.dataset.pageId); return; }
    if (target.dataset.commentAnchor && project) void focusComment(target.dataset.commentAnchor);
  }
  function onInput(event: Event) {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (modal && !input.closest(".dc-modal")) return;
    if (input.dataset.tokenValue) {
      const state = tokenState(), key = input.dataset.tokenValue;
      if (!state || state.applying) return;
      const previous = state.drafts.get(key), definition = previous?.definition ?? state.catalog?.definitions.find(item => item.sourceId === key);
      if (!definition?.editable) return;
      if (input.value === definition.value) state.drafts.delete(key); else state.drafts.set(key, { definition, value: input.value });
      state.error = ""; const notice = root.querySelector<HTMLElement>("[data-token-error]"); if (notice) notice.hidden = true;
      updateTokenActions(); return;
    }
    if (input.hasAttribute("data-source-input")) {
      const draft = draftAt(activeFile); if (draft) { const wasDirty = draft.dirty; draft.content = input.value; draft.dirty = input.value !== activeSource()?.content; if (wasDirty !== draft.dirty) renderFilePanel(); const save = root.querySelector<HTMLButtonElement>('[data-action="save-source"]'); if (save) save.disabled = !draft.dirty || draft.conflict || saving > 0; const label = root.querySelector(".dc-code-head small"); if (label) label.textContent = draft.dirty ? "未保存" : "已保存"; }
    }
    if (input.hasAttribute("data-selection-text")) selectionText = input.value;
    if (input.dataset.selectionStyle) selectionStyles[input.dataset.selectionStyle] = input.value;
    if (input.hasAttribute("data-ai-prompt")) aiPrompt = input.value;
    if (input.hasAttribute("data-comment-draft")) commentDraft = input.value;
    if (input.hasAttribute("data-source-directory")) sourceDirectoryInput = input.value;
    if (input.hasAttribute("data-source-import-name")) sourceImportName = input.value;
    if (input.hasAttribute("data-source-import-entry")) sourceImportEntry = input.value;
    if (input.hasAttribute("data-new-name")) newName = input.value;
    if (input.hasAttribute("data-new-file-path")) newFilePath = input.value;
    if (input.hasAttribute("data-project-archive-name")) archiveName = input.value;
  }
  function onChange(event: Event) {
    const input = event.target as HTMLSelectElement | HTMLInputElement;
    if (modal && !input.closest(".dc-modal")) return;
    if (input.hasAttribute("data-token-file")) { const state = tokenState(); if (state) { state.file = input.value; void loadTokens(0); } return; }
    if (input.hasAttribute("data-project-archive")) { selectProjectArchive((input as HTMLInputElement).files?.[0]); return; }
    if (input.dataset.overviewPage && project) {
      const pageId = input.dataset.overviewPage, checked = (input as HTMLInputElement).checked;
      if (checked && !overviewPageIds.includes(pageId)) { if (overviewPageIds.length >= 4) { (input as HTMLInputElement).checked = false; notify("最多同时比较 4 个真实页面，请先取消一个页面。", true); return; } overviewPageIds.push(pageId); }
      else if (!checked) overviewPageIds = overviewPageIds.filter(item => item !== pageId);
      if (!overviewPageIds.includes(activePageId) && overviewPageIds[0]) activateBoard(overviewPageIds[0], overviewViewportIds.get(overviewPageIds[0]));
      renderCanvas(); void refreshVisiblePreviews(); void checkCommentAnchors(); return;
    }
    if (input.dataset.boardViewport && project) { const pageId = input.dataset.boardViewport; if (!matchingViewports(pageId).some(viewport => viewport.id === input.value)) return; overviewViewportIds.set(pageId, input.value); if (activePageId === pageId) { activeViewport = input.value; selection = undefined; renderInspector(); } renderCanvas(); void refreshVisiblePreviews(); return; }
    if (input.dataset.sourceSelect && project) { const selected = sourceSelections.get(project.id) ?? new Set<string>(); if ((input as HTMLInputElement).checked) selected.add(input.dataset.sourceSelect); else selected.delete(input.dataset.sourceSelect); sourceSelections.set(project.id, selected); renderFilePanel(); }
    if (input.dataset.setting === "project") { if (input.value === "__new__") openModal("new"); else if (input.value) void loadProject(input.value); }
    if (input.dataset.setting === "viewport") { viewportId = input.value; if (viewportId !== "all") activeViewport = viewportId; normalizeViewports(); selection = undefined; renderCanvas(); renderInspector(); void refreshVisiblePreviews(true); }
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
    if (input.hasAttribute("data-ai-reference")) aiReference = input.value === "none" || referenceExamples.some(example => example.id === input.value) ? input.value as DesignReferenceChoice : "auto";
    if (input.hasAttribute("data-generation-budget")) generationBudgetMs = Number(input.value) === 900000 ? 900000 : 600000;
  }
  function onKeyDown(event: KeyboardEvent) {
    if (!root.isConnected || !root.contains(event.target as Node) && !root.contains(document.activeElement) && event.target !== document.body) return;
    const command = event.metaKey || event.ctrlKey;
    if (modal) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCurrentModal(); return; }
      if (event.key === "Tab") {
        const dialog = root.querySelector<HTMLElement>(".dc-modal"); if (!dialog) return;
        const elements = modalFocusables(dialog), current = elements.indexOf(document.activeElement as HTMLElement);
        if (current < 0 || event.shiftKey && current === 0 || !event.shiftKey && current === elements.length - 1) { event.preventDefault(); (event.shiftKey ? elements.at(-1) ?? dialog : elements[0] ?? dialog).focus({ preventScroll: true }); }
      } else if (command && event.key.toLowerCase() === "s") event.preventDefault();
      return;
    }
    if (event.key === "Escape") { if (leftOpen || rightOpen) { leftOpen = false; rightOpen = false; root.querySelector(".dc-body")?.classList.remove("show-left", "show-right"); } else setMode("select"); return; }
    if (command && event.key.toLowerCase() === "s") { event.preventDefault(); void saveSource(); return; }
    if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true],.dc-modal")) return;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); void history(event.shiftKey ? "redo" : "undo"); return; }
    if (event.code === "Space") { space = true; event.preventDefault(); }
    if (event.key === "0") fitCanvas();
    if (["Enter", " "].includes(event.key) && event.target instanceof HTMLElement && event.target.dataset.file) { event.preventDefault(); openSource(event.target.dataset.file); }
  }
  function onKeyUp(event: KeyboardEvent) { if (event.code === "Space") space = false; }
  function onWheel(event: WheelEvent) {
    if (modal) return;
    const canvas = (event.target as HTMLElement).closest<HTMLElement>(".dc-canvas"); if (!canvas || !project) return;
    event.preventDefault(); const rect = canvas.getBoundingClientRect();
    if (event.metaKey || event.ctrlKey) zoom(scale * Math.exp(-event.deltaY * .008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    else { cameraSerial++; offset.x -= event.deltaX; offset.y -= event.deltaY; transform(); }
  }
  function onPointerDown(event: PointerEvent) {
    if (modal) return;
    const target = event.target as HTMLElement; const canvas = target.closest<HTMLElement>(".dc-canvas");
    if (!canvas || target.closest("button,select,input,textarea") || event.button > 1 || !project) return;
    const pan = space || event.button === 1 || target === canvas || !!target.closest(".dc-frame-title,.dc-board-caption");
    if (!pan) return;
    event.preventDefault(); pointerCleanup?.(); canvas.classList.add("panning");
    const start = { x: event.clientX, y: event.clientY }; const before = { ...offset };
    for (const frame of frames) frame.iframe.style.pointerEvents = "none";
    const move = (event: PointerEvent) => { cameraSerial++; offset = { x: before.x + event.clientX - start.x, y: before.y + event.clientY - start.y }; transform(); };
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
    // Import completion announces a real independent copy; only its initiating intent may adopt it.
    if (data.importedFrom || data.archiveSha256) { try { rememberArchiveCopy(archiveResult(data).notice, !archiveOperation); } catch { /* An incomplete import response must not update current source metadata. */ } return; }
    if (typeof data.projectId === "string" && typeof data.connected === "boolean") {
      sourceStatuses.set(data.projectId, data as unknown as SourceStatus);
      if (Array.isArray(data.files) && data.files.every(file => file && typeof file === "object" && "status" in file)) sourceComparisons.set(data.projectId, data as unknown as SourceComparison);
      if (project?.id === data.projectId && leftTab === "source") renderFilePanel();
    }
    if (data.job && typeof data.job === "object" && "verification" in data.job) {
      try { const job = readGenerationJob(data.job); jobs.set(job.projectId, job); if (job.projectId === project?.id) renderInspector(); scheduleGenerationPoll(); } catch { /* Other tool results do not define a code-generation job. */ }
    }
    if (isProject(data.project) && (!project || data.project.id === project.id)) {
      if (Array.isArray(data.files)) { updateMetadata(data); accept(data.project); }
      else void loadProject(data.project.id);
    }
  }
  document.addEventListener("focusin", onHistoryFocusIn, true); document.addEventListener("pointerdown", onHistoryFocusIntent, true); document.addEventListener("keydown", onHistoryFocusIntent, true);
  root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onChange); root.addEventListener("focusin", onFocusIn); root.addEventListener("wheel", onWheel, { passive: false }); root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("message", onMessage); window.addEventListener("keydown", onKeyDown); window.addEventListener("keyup", onKeyUp);
  render();
  return {
    connecting() { status = "正在连接宿主…"; renderStatus(); },
    async connected() { if (disposed) return; connected = true; status = "已连接"; renderStatus(); await Promise.allSettled([listProjects().catch(error => notify(message(error), true)), loadDirections()]); schedulePoll(); },
    disconnected(error: unknown) { connected = false; status = `连接不可用：${message(error)}`; renderStatus(); notify(status, true); },
    async setProjectId(projectId: string) { if (connected && project?.id !== projectId) await loadProject(projectId); },
    receive,
    async teardown() { disposed = true; captionObserver.disconnect(); historyFocusOwner = undefined; document.removeEventListener("focusin", onHistoryFocusIn, true); document.removeEventListener("pointerdown", onHistoryFocusIntent, true); document.removeEventListener("keydown", onHistoryFocusIntent, true); invalidateArchiveIntent(); ++loadSerial; ++previewSerial; clearTimeout(pollTimer); clearTimeout(toastTimer); clearTimeout(jobTimer); clearFrames(); previewPool.setScope("disposed"); pointerCleanup?.(); root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onChange); root.removeEventListener("focusin", onFocusIn); root.removeEventListener("wheel", onWheel); root.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); await queue; },
  };
}
