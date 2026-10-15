import { elapsedLabel, renderWorkflowGraph } from "./panel-graph.ts";
import { readParameters, renderParameterFields } from "./panel-parameters.ts";
import type { WorkflowParameter } from "./panel-parameters.ts";
import { failureContext, failureErrorSummary, failureErrorText, resultCheckFailure } from "../src/failure-context.ts";
import { stopSummary } from "../src/stop-context.ts";
import type { WorkflowStopReason } from "../src/stop-context.ts";
import type { WorkflowFailureContext } from "../src/failure-context.ts";

export type WorkspaceMode = "snapshot" | "git-worktree" | "local";
export type ApprovalMode = "auto-review" | "never";

export interface ExecutionChoice { model?: string; reasoningEffort?: string }
export interface NodeExecutionChoice extends ExecutionChoice { identity?: string }
export type NodeSettings = Record<string, NodeExecutionChoice>;
export interface ExecutionSettings extends ExecutionChoice {
  source?: "task" | "phase" | "script" | "workflow-settings" | "codex-config";
  provenance?: "requested" | "configured" | "runtime";
}
export type RecordedExecutionSettings = ExecutionSettings & { source: NonNullable<ExecutionSettings["source"]> };
export interface ExecutionSettingsResponse {
  settings: ExecutionChoice & { revision: number };
  effectiveDefaults?: { model: string; reasoningEffort: string; source: string };
  codexDefaults: ExecutionChoice;
  defaultsStatus: { available: boolean; reason?: string };
  models: Array<{ id: string; displayName: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string }>;
  source: string;
  mainAgentContextAvailable: false;
}
export interface CodexProject { projectId: string; label: string; path: string; hostId: string }
export interface ProjectsResponse { contextSource?: "thread" | "global-or-unassigned"; bindingSource?: string; available: boolean; projects: CodexProject[]; currentProjectId?: string; reason?: string }

export interface WorkflowActivity { id: string; kind: "initializing" | "command" | "files" | "search" | "mcp" | "message" | "waiting"; label: string; status: "running" | "completed" | "failed" | "interrupted"; startedAt: string; endedAt?: string; detail?: string }
export interface Preparation { startedAt: string; endedAt?: string; stages: Array<{ id: "settings" | "project" | "workspace" | "validation"; label: string; status: "running" | "completed" | "failed" | "interrupted"; startedAt: string; endedAt?: string }> }
export interface WorkflowAttempt {
  activities?: WorkflowActivity[];
  id: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  threadId?: string;
  turnId?: string;
  output?: unknown;
  error?: string;
  usage?: unknown;
  executionSettings?: RecordedExecutionSettings;
}

export interface WorkflowTask {
  currentActivity?: WorkflowActivity;
  id: string;
  index: number;
  prompt: string;
  options: Record<string, unknown>;
  phase?: string;
  label?: string;
  mode: "read" | "write";
  status: "queued" | "running" | "completed" | "failed" | "interrupted" | "stopping";
  cached: boolean;
  attempts: WorkflowAttempt[];
  output?: unknown;
  error?: string;
  executionSettings?: RecordedExecutionSettings;
  configurationTarget?: string;
}

export interface MaintenanceStep {
  id: string; command: string[]; networkAccess?: boolean; timeoutMs?: number; retries?: number; idempotent?: boolean;
  protectedPaths?: string[];
}
export interface MaintenancePlan {
  steps: MaintenanceStep[];
  activation?: { serverName: string; command: string; args: string[] };
}

export interface WorkflowDiff {
  text: string; files: Array<{ path: string; status: string }>; fingerprint: string; conflicts?: string[];
  previewTruncated?: boolean; totalBytes?: number; contentSha256?: string;
}

export interface WorkflowRun {
  listSummary?: false;
  failureContext?: WorkflowFailureContext;
  stopReason?: WorkflowStopReason;
  deletionPending?: boolean;
  deletionTarget?: DeletionTarget;
  sourceDefinition?: { id: string; revision?: number };
  preparation?: Preparation;
  startedAt?: string;
  endedAt?: string;
  progressSequence?: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  meta: { name: string; description: string; phases?: Array<string | { title?: string; name?: string }>; parameters?: WorkflowParameter[] };
  script: string;
  args: unknown;
  projectPath: string;
  allowWrite: boolean;
  networkAccess?: boolean;
  allowedMcpServers?: string[];
  allowedMcpTools?: Record<string, string[]>;
  workspaceMode?: WorkspaceMode; approvalMode?: ApprovalMode;
  maintenance?: MaintenancePlan;
  nodeSettings?: NodeSettings;
  executionSettings?: ExecutionSettings;
  maintenanceReview?: unknown;
  activation?: { status: "pending_restart" | "verified" | "failed"; serverName: string; [key: string]: unknown };
  execution: "draft" | "preparing" | "running" | "stopping" | "stopped" | "completed" | "failed";
  review: "unavailable" | "pending" | "ready";
  application: "none" | "applying" | "applied" | "partial" | "conflict" | "failed";
  error?: string;
  result?: unknown;
  tasks: WorkflowTask[];
  logs: Array<{ at: string; level: "info" | "error"; message: string; taskId?: string }>;
  diff?: WorkflowDiff;
  limits: { maxReadWorkers: number; maxCalls: number; timeoutMs: number; maxTokens: number };
  workspacePath?: string;
}

export type WorkflowRunSummary = Pick<WorkflowRun, "id" | "revision" | "progressSequence" | "projectPath" | "meta" | "execution" | "review" | "application" | "createdAt" | "updatedAt" | "startedAt" | "endedAt" | "sourceDefinition" | "deletionPending" | "deletionTarget" | "failureContext" | "stopReason" | "error"> & { listSummary: true };
export type WorkflowListItem = WorkflowRun | WorkflowRunSummary;

export interface ToolResponse {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string | undefined }> | undefined;
  isError?: boolean | undefined;
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolResponse>;
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "saved";
  revision?: number;
}
export interface TemplateDefinition extends TemplateSummary {
  script: string;
  meta?: WorkflowRun["meta"];
  args?: unknown;
  allowWrite?: boolean;
  networkAccess?: boolean;
  allowedMcpServers?: string[];
  allowedMcpTools?: Record<string, string[]>;
  workspaceMode?: WorkspaceMode; approvalMode?: ApprovalMode;
  maintenance?: MaintenancePlan;
  nodeSettings?: NodeSettings;
  limits?: WorkflowRun["limits"];
}

export type PanelTab = "overview" | "tasks" | "diff" | "logs";
export type UserAction = "start" | "resume" | "stop" | "apply" | "cancel";
export interface WorkflowInput { sourceDefinition?: { id: string; revision?: number }; projectPath: string; script: string; args: unknown; allowWrite: boolean; networkAccess?: boolean; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; workspaceMode?: WorkspaceMode; approvalMode?: ApprovalMode; maintenance?: MaintenancePlan; nodeSettings?: NodeSettings; limits?: WorkflowRun["limits"] }
export interface PanelState {
  connection: "offline" | "connecting" | "connected" | "degraded" | "closed";
  reconnecting: boolean;
  runs: WorkflowListItem[];
  detailsBusy?: boolean;
  runTotal?: number;
  runNextOffset?: number | undefined;
  historyBusy?: boolean;
  templates: TemplateSummary[];
  templatesLoaded: boolean;
  selectedTemplate: string | undefined;
  definition?: TemplateDefinition;
  selectedRun: string | undefined;
  tab: PanelTab;
  task: string | undefined;
  busy: boolean;
  error: string;
  projectPath: string;
  projects: CodexProject[];
  projectsLoaded: boolean;
  projectsBusy: boolean;
  projectsError: string;
  selectedProjectId?: string | undefined;
  currentProjectId?: string | undefined;
  projectContextSource?: "thread" | "global-or-unassigned";
  projectBindingSource?: string | undefined;
  settings?: ExecutionSettingsResponse;
  settingsProjectPath: string;
  settingsBusy: boolean;
  settingsError: string;
}

export function executionSettingsPayload(value: Record<string, unknown>): ExecutionSettingsResponse {
  const settings = value.settings as Partial<ExecutionSettingsResponse["settings"]> | undefined;
  const defaults = value.effectiveDefaults as Partial<ExecutionSettingsResponse["effectiveDefaults"]> | undefined;
  const status = value.defaultsStatus as Partial<ExecutionSettingsResponse["defaultsStatus"]> | undefined;
  const codexDefaults = value.codexDefaults as ExecutionChoice | undefined;
  if (!settings || !Number.isSafeInteger(settings.revision) || Number(settings.revision) < 0 || settings.model !== undefined && typeof settings.model !== "string" || settings.reasoningEffort !== undefined && typeof settings.reasoningEffort !== "string" || !status || typeof status.available !== "boolean" || status.reason !== undefined && typeof status.reason !== "string" || !codexDefaults || codexDefaults.model !== undefined && typeof codexDefaults.model !== "string" || codexDefaults.reasoningEffort !== undefined && typeof codexDefaults.reasoningEffort !== "string" || defaults !== undefined && (!defaults || typeof defaults.model !== "string" || typeof defaults.reasoningEffort !== "string") || status.available && !defaults || !Array.isArray(value.models) || value.mainAgentContextAvailable !== false) throw new Error("宿主未返回有效的执行设置或模型目录");
  for (const model of value.models) {
    if (!model || typeof model.id !== "string" || typeof model.displayName !== "string" || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.some((effort: unknown) => typeof effort !== "string") || typeof model.defaultReasoningEffort !== "string") throw new Error("宿主返回的模型目录格式无效");
  }
  return value as unknown as ExecutionSettingsResponse;
}

export function projectsPayload(value: Record<string, unknown>): ProjectsResponse {
  if (typeof value.available !== "boolean" || !Array.isArray(value.projects) || value.reason !== undefined && typeof value.reason !== "string" || value.bindingSource !== undefined && typeof value.bindingSource !== "string" || value.currentProjectId !== undefined && typeof value.currentProjectId !== "string") throw new Error("宿主未返回有效的项目列表");
  const ids = new Set<string>();
  for (const project of value.projects) {
    if (!project || typeof project.projectId !== "string" || !project.projectId || typeof project.label !== "string" || typeof project.path !== "string" || !project.path || typeof project.hostId !== "string" || ids.has(project.projectId)) throw new Error("宿主项目列表包含无效项目");
    ids.add(project.projectId);
  }
  if (value.currentProjectId !== undefined && !ids.has(value.currentProjectId)) throw new Error("当前项目不在可选项目列表中");
  return value as unknown as ProjectsResponse;
}

const executionLabels: Record<string, string> = { draft: "待开始", preparing: "正在准备", running: "运行中", stopping: "正在停止", stopped: "已停止", completed: "执行已完成", failed: "执行失败" };
const taskLabels: Record<string, string> = { queued: "等待中", running: "运行中", stopping: "正在停止", interrupted: "已中断", completed: "已完成", failed: "失败" };
const applicationLabels: Record<string, string> = { none: "改动未应用", applying: "正在应用", applied: "已应用", partial: "部分改动已应用，等待重试", conflict: "应用冲突", failed: "应用失败" };
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export interface HostStyleEffects {
  theme: (theme: "light" | "dark") => void;
  variables: (variables: Record<string, string | undefined>) => void;
  fonts: (css: string) => void;
}

// Some hosts send only style variables. Keep native menus aligned with that
// surface instead of using an unrelated operating-system color preference.
function surfaceTheme(color: string | undefined): "light" | "dark" | undefined {
  if (!color) return undefined;
  const value = color.trim();
  let channels: number[];
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map(part => part + part).join("") : hex;
    if (expanded.length === 8 && expanded.slice(6).toLowerCase() !== "ff") return undefined;
    channels = expanded.slice(0, 6).match(/../g)!.map(part => parseInt(part, 16) / 255);
  }
  else {
    const rgb = /^rgba?\(\s*([\d.]+)(%)?[\s,]+([\d.]+)(%)?[\s,]+([\d.]+)(%)?(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/i.exec(value);
    if (!rgb) return undefined;
    if (rgb[7] !== undefined && Number(rgb[7]) / (rgb[8] ? 100 : 1) !== 1) return undefined;
    channels = [1, 3, 5].map(index => Number(rgb[index]) / (rgb[index + 1] ? 100 : 255));
  }
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) return undefined;
  const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722 > .179 ? "light" : "dark";
}

// The pinned SDK exposes separate theme, variable and font helpers.
export function applyPanelHostStyles(context: Record<string, unknown>, effects: HostStyleEffects): void {
  const styles = context.styles as { variables?: Record<string, string | undefined>; css?: { fonts?: string } } | undefined;
  const theme = context.theme === "light" || context.theme === "dark" ? context.theme : surfaceTheme(styles?.variables?.["--color-background-primary"]);
  if (theme) effects.theme(theme);
  if (styles?.variables) effects.variables(styles.variables);
  if (typeof styles?.css?.fonts === "string") effects.fonts(styles.css.fonts);
}

function actionError(prefix: string, error: unknown, action?: UserAction): string {
  const detail = errorMessage(error).trim();
  if (/REVISION[_ -]?CONFLICT|Workflow changed; refresh the preview|revision (?:mismatch|conflict)|stale (?:preview|revision)/i.test(detail)) return `${prefix}：${detail}。请刷新记录并核对当前版本后重试。`;
  if (/Unsupported workspace entry/i.test(detail)) {
    const state = action === "start" || action === "resume" ? "隔离工作区准备未完成，本次未启动新 worker。" : "工作区条目检查未通过。";
    return `${prefix}：${detail}。${state}请核对执行器支持情况和具体修复方案。`;
  }
  return `${prefix}：${detail}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function toolPayload(response: ToolResponse): Record<string, unknown> {
  const text = response.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
  if (response.isError) throw new Error(text || "工作流工具返回错误");
  let data = response.structuredContent;
  if (data === undefined && text) {
    try { data = JSON.parse(text); } catch { throw new Error("工作流工具未返回有效 JSON 数据"); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("工作流工具返回的数据格式不正确");
  return data as Record<string, unknown>;
}

function parseRun(value: unknown): WorkflowRun {
  if (!value || typeof value !== "object") throw new Error("工作流工具未返回运行记录");
  const candidate = value as Partial<WorkflowRun>;
  if (typeof candidate.id !== "string" || typeof candidate.revision !== "number" || !candidate.meta || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.logs)) throw new Error("运行记录缺少必要字段");
  return candidate as WorkflowRun;
}

export function parseRunSummary(value: unknown): WorkflowRunSummary {
  if (!value || typeof value !== "object") throw new Error("工作流工具未返回运行摘要");
  const candidate = value as Partial<WorkflowRunSummary>;
  if (typeof candidate.id !== "string" || typeof candidate.revision !== "number" || typeof candidate.projectPath !== "string" || typeof candidate.meta?.name !== "string" || typeof candidate.execution !== "string") throw new Error("运行摘要缺少必要字段");
  return { ...candidate, listSummary: true } as WorkflowRunSummary;
}

export function canApply(run: WorkflowRun, tab: PanelTab): boolean {
  return run.workspaceMode !== "local" && !run.deletionPending && tab === "diff" && run.execution === "completed" && (!!run.diff?.files.length || run.maintenanceReview !== undefined || run.activation !== undefined) && ["none", "partial", "conflict", "failed"].includes(run.application);
}

export function requiresNewLocalPreview(run?: WorkflowRun): boolean {
  if (!run || run.workspaceMode !== "local" || !["stopped", "failed"].includes(run.execution)) return false;
  if (run.failureContext?.recovery === "new-preview") return true;
  // Older records did not persist a structured recovery hint.
  return run.error === "Local project or build artifacts changed since the last checkpoint. Create a new preview; cached results cannot safely replay."
    || run.error === "Local project has previously started workers without a reliable checkpoint. Inspect existing edits and create a new preview before continuing.";
}

export function canChangeWorkspaceMode(input?: WorkflowRun | TemplateDefinition): boolean {
  if (!input) return false;
  if (!("execution" in input)) return true;
  return input.execution === "draft" && !input.deletionPending && !input.workspacePath && !input.startedAt && !input.preparation && !input.tasks.length;
}

export function workspaceModeRestriction(input: WorkflowRun | TemplateDefinition | undefined, mode: WorkspaceMode): string {
  if (input?.maintenance && mode !== "git-worktree") return "维护操作需要 Git 隔离工作区。";
  if (!input?.allowWrite && mode !== "snapshot") return `${mode === "local" ? "本地修改" : "Git 隔离工作区"}需要写入授权，请在对话中让 AI 调整执行范围。`;
  return "";
}

export function workspaceModeLabel(mode: WorkspaceMode = "snapshot", allowWrite = false): string {
  if (!allowWrite) return "只读分析";
  if (mode === "local") return "本地项目 · 直接修改";
  return mode === "git-worktree" ? "Git 隔离工作区" : "隔离快照";
}

export function workspaceModeDescription(mode: WorkspaceMode = "snapshot", allowWrite = false): string {
  if (!allowWrite) return "直接读取当前项目用于分析，未授权文件写入；隔离工作方式仅在允许写入时生效。";
  if (mode === "local") return "适合日常开发、修 Bug；直接在当前项目修改文件，改动立即生效，无需应用。停止或删除运行不会撤销已写入原项目的改动。";
  return mode === "git-worktree" ? "适合依赖 Git 历史、提交或子模块的任务；使用独立 Git 工作区，改动经审查后应用回原项目。" : "适合先隔离试验；在独立文件快照中执行，审查差异后再应用回原项目。";
}

export function partialApplicationMessage(run: WorkflowRun): string {
  if (run.application !== "partial") return "";
  return run.activation?.status === "failed"
    ? "仓库改动已应用，激活失败。重试仅处理激活，不重复应用仓库改动。"
    : "部分改动已应用，子模块工作区仍需核验与补齐。重试仅处理未完成步骤，请先核对实际结果。";
}

// Every timer reads the server; no timer invents execution state.
export class WorkflowPanelController {
  readonly state: PanelState = { connection: "offline", reconnecting: false, runs: [], templates: [], templatesLoaded: false, selectedTemplate: undefined, selectedRun: undefined, tab: "overview", task: undefined, busy: false, error: "", projectPath: "", projects: [], projectsLoaded: false, projectsBusy: false, projectsError: "", settingsProjectPath: "", settingsBusy: false, settingsError: "" };
  private readonly callTool: ToolCaller;
  private readonly changed: () => void;
  private readonly every: (callback: () => void, milliseconds: number) => () => void;
  private timers: Array<() => void> = [];
  private leaseId: string | undefined;
  private ownedRuns = new Set<string>();
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private pollingProject: string | undefined;
  private pollRequest = 0;
  private heartbeatAttempt: Promise<boolean | undefined> | undefined;
  private synchronizationAttempt: Promise<void> | undefined;
  private metadataRefresh: Promise<void> | undefined;
  private metadataProject: string | undefined;
  private reconnectFailures = 0;
  private reconnectAfter = 0;
  private initializing = false;
  private timersStarted = false;
  private readonly now: () => number;
  private definitionSelected = false;
  private templateRequest = 0;
  private settingsRequest = 0;
  private projectsRequest = 0;
  private detailRequest = 0;
  private historyRequest = 0;
  private firstPageIds = new Set<string>();
  private listedProject: string | undefined;
  private acceptedProjection = new Map<string, string>();
  private unresolvedDetails = new Set<string>();
  private latestSummaries = new Map<string, WorkflowRunSummary>();

  constructor(callTool: ToolCaller, changed: () => void = () => {}, every = (callback: () => void, milliseconds: number): (() => void) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  }, now: () => number = Date.now) {
    this.now = now;
    this.callTool = callTool;
    this.changed = changed;
    this.every = every;
  }

  get selected(): WorkflowRun | undefined { return this.state.runs.find((run): run is WorkflowRun => run.id === this.state.selectedRun && run.listSummary !== true); }
  get selectedSummary(): WorkflowRunSummary | undefined { return this.state.runs.find((run): run is WorkflowRunSummary => run.id === this.state.selectedRun && run.listSummary === true); }
  get stopTarget(): WorkflowListItem | undefined { return this.unresolvedDetails.has(this.state.selectedRun ?? "") ? this.latestSummaries.get(this.state.selectedRun ?? "") ?? this.selectedSummary ?? this.selected : this.selected ?? this.selectedSummary; }
  get currentProject(): CodexProject | undefined { return this.state.projectsLoaded && this.state.projectContextSource === "thread" ? this.state.projects.find(project => project.projectId === this.state.currentProjectId) : undefined; }
  get projectBound(): boolean { const project = this.currentProject; return !!project && this.state.selectedProjectId === project.projectId && this.state.projectPath === project.path; }
  get canAct(): boolean { return this.projectBound && !this.selectedSummary && !this.unresolvedDetails.has(this.state.selectedRun ?? "") && !this.state.detailsBusy && (!this.selected || this.selected.projectPath === this.state.projectPath) && this.state.connection === "connected" && !this.state.reconnecting && !this.initializing && !this.state.busy && !this.closing; }
  get canSelectWorkflow(): boolean {
    const run = this.stopTarget;
    return this.projectBound && this.state.connection === "connected" && !this.state.reconnecting && !this.initializing && !this.state.busy && !this.state.detailsBusy && !this.closing && !["preparing", "running", "stopping"].includes(run?.execution ?? "") && run?.application !== "applying";
  }

  setProjectPath(projectPath: string): void {
    // A tool argument is a hint, never evidence of the current chat's project.
    if (this.currentProject && projectPath !== this.currentProject.path) { this.state.error = "此工作流属于其他项目，请从所属项目的聊天打开。"; this.changed(); }
  }

  async refreshProjects(): Promise<void> {
    if (this.closing || this.state.connection !== "connected" || this.state.projectsBusy) return;
    const request = ++this.projectsRequest;
    this.state.projectsBusy = true;
    this.state.projectsError = "";
    this.changed();
    try {
      const data = projectsPayload(await this.request("workflow_get_projects", {}));
      if (this.closing || request !== this.projectsRequest) return;
      this.state.projects = data.projects;
      this.state.projectsLoaded = true;
      const project = data.available && data.contextSource !== "global-or-unassigned" ? data.projects.find(project => project.projectId === data.currentProjectId) : undefined;
      this.state.currentProjectId = project?.projectId;
      this.state.projectContextSource = project ? "thread" : "global-or-unassigned";
      this.state.projectBindingSource = project ? data.bindingSource : undefined;
      this.state.selectedProjectId = project?.projectId;
      this.state.projectPath = project?.path ?? "";
      if (!project) { this.state.runs = []; this.state.selectedRun = undefined; this.state.projectsError = data.reason ? `无法确认所属项目：${data.reason}` : data.available ? "工作流仅在项目聊天中使用，请从项目内打开。" : "暂时无法确认所属项目：宿主项目接口不可用。请从项目聊天打开并刷新。"; return; }
      this.state.runs = this.state.runs.filter(run => run.projectPath === project.path);
      if (!this.state.runs.some(run => run.id === this.state.selectedRun)) this.state.selectedRun = undefined;
    } catch (error) { if (!this.closing && request === this.projectsRequest) { this.state.currentProjectId = undefined; this.state.selectedProjectId = undefined; this.state.projectContextSource = "global-or-unassigned"; this.state.projectBindingSource = undefined; this.state.projectPath = ""; this.state.projectsError = `暂时无法确认所属项目：${errorMessage(error)}。请从项目聊天打开并刷新。`; } }
    finally { if (request === this.projectsRequest) this.state.projectsBusy = false; this.changed(); }
  }

  async selectProject(projectId: string): Promise<void> {
    if (projectId === this.currentProject?.projectId) return;
    this.state.projectsError = this.currentProject ? "项目所属工作流的目录固定；请从目标项目的聊天中新建运行。" : "工作流仅在项目聊天中使用，请从项目内打开。";
    this.changed();
  }

  private useRunProject(run: WorkflowRun): void {
    if (!this.currentProject || run.projectPath !== this.currentProject.path) throw new Error("此工作流属于其他项目，请从所属项目的聊天打开。");
  }

  connecting(): void { this.state.connection = "connecting"; this.changed(); }
  disconnected(error: unknown): void {
    if (this.closing) return;
    this.state.connection = "degraded";
    this.startPolling();
    this.reconnectFailures++;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.reconnectFailures - 1, 4));
    this.reconnectAfter = this.now() + delay;
    this.state.error = `宿主连接中断：${errorMessage(error)}。${this.reconnectFailures >= 6 ? "自动重试已暂停，请点击重新连接。" : "将自动重试，也可以点击重新连接。"}运行状态以服务端为准。`;
    this.changed();
  }

  async connected(): Promise<void> {
    if (this.closing) return;
    this.initializing = true;
    this.state.connection = "connecting";
    this.changed();
    try {
      await this.heartbeat(true);
      if (this.closing) return;
      // Initial callers can await the auxiliary catalogue without keeping the
      // main view or its lease blocked by model discovery.
      await this.metadataRefresh;
    } finally { this.initializing = false; this.changed(); }
  }

  private startPolling(): void {
    if (this.closing || this.timersStarted) return;
    this.timersStarted = true;
    this.timers.push(this.every(() => { void this.heartbeat(); }, 5000));
    this.timers.push(this.every(() => { if (this.state.connection === "connected" && !this.state.reconnecting) void this.refresh(); }, 2000));
  }

  async reconnect(): Promise<void> {
    if (this.closing) return;
    this.reconnectFailures = 0;
    this.reconnectAfter = 0;
    await this.heartbeat(true);
  }

  async visibilityChanged(visible: boolean): Promise<void> {
    if (visible && !this.closing) await this.reconnect();
  }

  async request(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return toolPayload(await this.callTool(name, args));
  }

  private replace(run: WorkflowRun): void {
    if (!this.projectBound || run.projectPath !== this.currentProject?.path) return;
    const index = this.state.runs.findIndex(existing => existing.id === run.id);
    if (index < 0) this.state.runs.unshift(run);
    else if (this.state.runs[index]!.revision < run.revision || this.state.runs[index]!.revision === run.revision && (this.state.runs[index]!.progressSequence ?? 0) <= (run.progressSequence ?? 0)) this.state.runs[index] = run;
    const latest = this.latestSummaries.get(run.id);
    if (!latest || run.revision > latest.revision || run.revision === latest.revision && (run.progressSequence ?? 0) >= (latest.progressSequence ?? 0)) this.unresolvedDetails.delete(run.id);
    this.changed();
  }

  private rememberSummary(run: WorkflowRunSummary): void {
    const previous = this.latestSummaries.get(run.id);
    if (!previous || run.revision > previous.revision || run.revision === previous.revision && (run.progressSequence ?? 0) >= (previous.progressSequence ?? 0)) this.latestSummaries.set(run.id, run);
    const detail = this.state.runs.find(item => item.id === run.id && item.listSummary !== true);
    if (detail && (run.revision > detail.revision || run.revision === detail.revision && (run.progressSequence ?? 0) > (detail.progressSequence ?? 0))) this.unresolvedDetails.add(run.id);
  }

  receive(response: ToolResponse): void {
    try {
      const data = toolPayload(response);
      if (data.run) {
        const run = parseRun(data.run);
        if (!this.projectBound || run.projectPath !== this.state.projectPath) { this.state.error = "此工作流属于其他项目，请从所属项目的聊天打开。"; this.changed(); return; }
        this.definitionSelected = false;
        this.state.selectedRun = run.id;
        this.useRunProject(run);
        this.replace(run);
        this.setProjectPath(run.projectPath);
      } else if (typeof data.projectPath === "string") this.setProjectPath(data.projectPath);
      this.changed();
    } catch (error) { this.state.error = errorMessage(error); this.changed(); }
  }

  async heartbeat(force = false): Promise<void> {
    if (this.closing) return;
    if (!force && !this.heartbeatAttempt && this.state.connection === "degraded" && (this.reconnectFailures >= 6 || this.now() < this.reconnectAfter)) return;
    const synchronize = force || this.state.connection !== "connected" || !this.leaseId;
    if (synchronize) { this.state.reconnecting = true; this.changed(); }
    // Only the lease request is shared. Slow project, run or catalogue reads
    // must never prevent later timer ticks from renewing the live lease.
    if (!this.heartbeatAttempt) {
      const attempt = this.readConnection().finally(() => { if (this.heartbeatAttempt === attempt) this.heartbeatAttempt = undefined; });
      this.heartbeatAttempt = attempt;
    }
    const recovered = await this.heartbeatAttempt;
    if (this.closing) return;
    if (recovered === undefined) {
      if (!this.synchronizationAttempt) { this.state.reconnecting = false; this.changed(); }
      return;
    }
    if (synchronize || recovered) await this.synchronizeConnection();
  }

  private async readConnection(): Promise<boolean | undefined> {
    let synchronize = this.state.connection !== "connected" || !this.leaseId;
    try {
      let data: Record<string, unknown>;
      try { data = await this.request("workflow_panel_lease", this.leaseId ? { leaseId: this.leaseId } : {}); }
      catch (error) {
        if (!this.leaseId || !/panel lease.*(?:unknown|expired)|(?:unknown|expired).*panel lease/i.test(errorMessage(error))) throw error;
        // A new lease restores viewing only. It never adopts or restarts runs
        // owned by the expired lease; their actual server state is read below.
        this.leaseId = undefined;
        synchronize = true;
        this.state.reconnecting = true;
        this.changed();
        if (this.closing) return undefined;
        data = await this.request("workflow_panel_lease", {});
      }
      if (typeof data.leaseId !== "string" || !data.leaseId) throw new Error("宿主未返回有效的面板租约");
      if (this.closing) { await this.request("workflow_panel_lease", { leaseId: data.leaseId, release: true }); return undefined; }
      this.leaseId = data.leaseId;
      synchronize ||= this.state.connection !== "connected";
      this.state.connection = "connected";
      this.startPolling();
      if (!synchronize && !this.state.reconnecting) {
        this.reconnectFailures = 0;
        this.reconnectAfter = 0;
      }
      return synchronize;
    } catch (error) { this.disconnected(error); return undefined; }
  }

  private synchronizeConnection(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.synchronizationAttempt) return this.synchronizationAttempt;
    this.state.reconnecting = true;
    this.changed();
    const synchronize = async () => {
      try {
        await this.refreshProjects();
        if (this.closing) return;
        if (!await this.refresh(true)) { if (this.state.connection === "connected") this.disconnected(new Error("无法确认最新运行状态，请重新连接")); return; }
        if (this.closing || this.state.connection !== "connected") return;
        this.reconnectFailures = 0;
        this.reconnectAfter = 0;
        if (this.state.error.startsWith("宿主连接中断：")) this.state.error = "";
      } catch (error) { this.disconnected(error); }
    };
    const attempt = synchronize().finally(() => {
      this.initializing = false;
      this.state.reconnecting = false;
      if (this.synchronizationAttempt === attempt) this.synchronizationAttempt = undefined;
      this.changed();
      if (!this.closing && this.state.connection === "connected") void this.refreshMetadata();
    });
    this.synchronizationAttempt = attempt;
    return attempt;
  }

  private refreshMetadata(): Promise<void> {
    const projectPath = this.state.projectPath;
    if (this.metadataRefresh && this.metadataProject === projectPath) return this.metadataRefresh;
    this.metadataProject = projectPath;
    const attempt = Promise.all([this.refreshTemplates(), this.refreshExecutionSettings(projectPath)]).then(() => {}).finally(() => {
      if (this.metadataRefresh === attempt) { this.metadataRefresh = undefined; this.metadataProject = undefined; }
    });
    this.metadataRefresh = attempt;
    return attempt;
  }

  async refresh(force = false): Promise<boolean> {
    if (!this.projectBound) return true;
    const projectPath = this.state.selectedProjectId ? this.state.projectPath : "";
    if (this.listedProject !== projectPath) { this.listedProject = projectPath; this.firstPageIds.clear(); this.historyRequest++; this.state.historyBusy = false; this.state.runNextOffset = undefined; this.state.runTotal = 0; }
    if (this.closing || !force && (this.pollingProject === projectPath || this.state.connection !== "connected" || this.state.reconnecting)) return false;
    const request = ++this.pollRequest;
    this.pollingProject = projectPath;
    const knownRuns = new Set(this.state.runs.map(run => run.id));
    try {
      const data = await this.request("workflow_list_runs", projectPath ? { projectPath } : {});
      if (this.closing || request !== this.pollRequest) return false;
      if (projectPath !== (this.state.selectedProjectId ? this.state.projectPath : "")) return false;
      if (!Array.isArray(data.runs)) throw new Error("宿主未返回运行列表");
      const runs: WorkflowListItem[] = data.runs.map(value => data.listSummary === true ? parseRunSummary(value) : parseRun(value)).filter(run => run.projectPath === projectPath);
      for (const run of runs) if (run.listSummary) this.rememberSummary(run);
      const selectedListing = runs.find(run => run.id === this.state.selectedRun);
      const completeListing = data.listSummary === true && data.nextOffset === undefined && typeof data.totalRuns === "number" && data.totalRuns === runs.length;
      if (completeListing) { this.historyRequest++; this.state.historyBusy = false; }
      // Keep the newer response when polling overlaps an explicit action.
      const createdDuringPoll = this.state.runs.filter(run => !knownRuns.has(run.id) && !runs.some(item => item.id === run.id));
      this.state.runs = [...createdDuringPoll, ...runs.map(run => {
        const existing = this.state.runs.find(item => item.id === run.id);
        if (run.listSummary && existing?.listSummary !== true && existing) return existing;
        return existing && (existing.revision > run.revision || existing.revision === run.revision && (existing.progressSequence ?? 0) > (run.progressSequence ?? 0)) ? existing : run;
      }), ...this.state.runs.filter(run => data.listSummary === true && !completeListing && knownRuns.has(run.id) && !runs.some(item => item.id === run.id) && (!this.firstPageIds.has(run.id) || run.id === this.state.selectedRun))];
      this.firstPageIds = new Set(runs.map(run => run.id));
      this.state.runTotal = typeof data.totalRuns === "number" ? data.totalRuns : this.state.runs.length;
      const pageNext = typeof data.nextOffset === "number" ? data.nextOffset : undefined;
      this.state.runNextOffset = pageNext === undefined || this.state.runs.length >= this.state.runTotal ? undefined : Math.max(this.state.runNextOffset ?? 0, pageNext);
      if (!this.definitionSelected && !this.state.runs.some(run => run.id === this.state.selectedRun)) this.state.selectedRun = this.state.runs[0]?.id;
      if (this.state.error.startsWith("宿主连接中断：")) this.state.error = "";
      this.changed();
      const detail = this.selected;
      if (this.selectedSummary || detail && (selectedListing ? selectedListing.revision > detail.revision || (selectedListing.progressSequence ?? 0) > (detail.progressSequence ?? 0) : knownRuns.has(detail.id))) await this.loadDetails(this.state.selectedRun!, selectedListing);
      return true;
    } catch (error) { if (request === this.pollRequest) this.disconnected(error); return false; }
    finally { if (request === this.pollRequest) this.pollingProject = undefined; }
  }

  async loadMoreRuns(): Promise<void> {
    if (!this.projectBound || this.state.historyBusy || this.state.runNextOffset === undefined) return;
    const projectPath = this.state.projectPath, offset = this.state.runNextOffset;
    const request = ++this.historyRequest;
    this.state.historyBusy = true; this.changed();
    try {
      const data = await this.request("workflow_list_runs", { projectPath, offset, limit: 100 });
      if (this.closing || request !== this.historyRequest || this.state.projectPath !== projectPath) return;
      if (!Array.isArray(data.runs)) throw new Error("宿主未返回运行摘要页");
      for (const value of data.runs) {
        const run = data.listSummary === true ? parseRunSummary(value) : parseRun(value);
        if (run.listSummary && run.projectPath === projectPath) this.rememberSummary(run);
        if (run.projectPath === projectPath && !this.state.runs.some(item => item.id === run.id)) this.state.runs.push(run);
      }
      this.state.runTotal = typeof data.totalRuns === "number" ? data.totalRuns : this.state.runs.length;
      this.state.runNextOffset = typeof data.nextOffset === "number" && data.nextOffset > offset ? data.nextOffset : undefined;
    } catch (error) { if (request === this.historyRequest) this.state.error = `读取更多运行失败：${errorMessage(error)}`; }
    finally { if (request === this.historyRequest) { this.state.historyBusy = false; this.changed(); } }
  }

  async refreshTemplates(): Promise<void> {
    if (this.closing || this.state.connection === "offline" || this.state.connection === "connecting") return;
    try {
      const data = await this.request("workflow_list_templates", {});
      if (this.closing) return;
      if (!Array.isArray(data.templates)) throw new Error("宿主未返回工作流库列表");
      this.state.templates = data.templates.map(item => {
        if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string") throw new Error("工作流定义缺少必要字段");
        return item as TemplateSummary;
      });
      this.state.templatesLoaded = true;
      if (!this.state.templates.some(template => template.id === this.state.selectedTemplate)) this.state.selectedTemplate = this.definitionSelected ? undefined : this.state.templates[0]?.id;
    } catch (error) { if (!this.closing) this.state.error = `读取工作流库失败：${errorMessage(error)}`; }
    finally { this.changed(); }
  }

  async refreshExecutionSettings(projectPath = this.selected?.projectPath ?? this.state.projectPath): Promise<void> {
    if (this.closing || this.state.connection !== "connected" || !this.projectBound || projectPath !== this.currentProject?.path) return;
    const request = ++this.settingsRequest;
    this.state.settingsBusy = true;
    this.state.settingsError = "";
    this.changed();
    try {
      const settings = executionSettingsPayload(await this.request("workflow_get_execution_settings", projectPath ? { projectPath } : {}));
      if (this.closing || request !== this.settingsRequest || projectPath !== this.currentProject?.path) return;
      this.state.settings = settings;
      this.state.settingsProjectPath = projectPath;
    } catch (error) {
      if (!this.closing && request === this.settingsRequest) this.state.settingsError = `读取执行设置失败：${errorMessage(error)}。可以刷新设置后重试。`;
    } finally { if (request === this.settingsRequest) this.state.settingsBusy = false; this.changed(); }
  }

  async saveExecutionSettings(choice: ExecutionChoice, projectPath = this.selected?.projectPath ?? this.state.projectPath): Promise<void> {
    if (!this.canAct || this.state.settingsBusy || !this.state.settings || projectPath !== this.currentProject?.path) return;
    const request = ++this.settingsRequest;
    this.state.settingsBusy = true;
    this.state.settingsError = "";
    this.changed();
    try {
      const settings = executionSettingsPayload(await this.request("workflow_update_execution_settings", {
        revision: this.state.settings.settings.revision,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
        ...(projectPath ? { projectPath } : {}),
      }));
      if (this.closing || request !== this.settingsRequest) return;
      this.state.settings = settings;
      this.state.settingsProjectPath = projectPath;
    } catch (error) {
      if (!this.closing && request === this.settingsRequest) this.state.settingsError = `保存默认设置失败：${errorMessage(error)}。请刷新设置并核对当前值后重试。`;
    } finally { if (request === this.settingsRequest) this.state.settingsBusy = false; this.changed(); }
  }

  async loadTemplate(id: string): Promise<TemplateDefinition | undefined> {
    if (!this.canAct) return undefined;
    const request = ++this.templateRequest;
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const data = await this.request("workflow_get_template", { id });
      if (this.closing || request !== this.templateRequest) return undefined;
      if (data.id !== id || typeof data.script !== "string") throw new Error("宿主未返回有效的工作流定义");
      this.state.selectedTemplate = data.id;
      this.state.definition = data as unknown as TemplateDefinition;
      return this.state.definition;
    } catch (error) { if (!this.closing && request === this.templateRequest) this.state.error = `载入工作流失败：${errorMessage(error)}`; return undefined; }
    finally { this.state.busy = false; this.changed(); }
  }

  selectTemplate(id: string | undefined): void {
    if (this.selected && ["preparing", "running", "stopping"].includes(this.selected.execution)) return;
    this.definitionSelected = true;
    this.templateRequest++;
    this.state.selectedTemplate = id;
    this.state.selectedRun = undefined;
    this.state.task = undefined;
    this.state.tab = "overview";
    if (this.state.definition?.id !== id) delete this.state.definition;
    this.changed();
  }

  async selectWorkflow(value: string): Promise<void> {
    if (!this.canSelectWorkflow) return;
    if (value === "more-runs") { await this.loadMoreRuns(); return; }
    if (value.startsWith("run:")) { await this.select(value.slice(4)); return; }
    if (value.startsWith("template:")) {
      const id = value.slice(9);
      if (this.state.templates.some(template => template.id === id)) this.selectTemplate(id);
    }
  }

  async saveTemplate(input: Pick<WorkflowInput, "script" | "args" | "allowWrite" | "limits" | "networkAccess" | "allowedMcpServers" | "allowedMcpTools" | "workspaceMode" | "approvalMode" | "maintenance" | "nodeSettings">, revision?: number): Promise<TemplateSummary | undefined> {
    if (!this.canAct) return undefined;
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const data = await this.request("workflow_save_template", { ...input, ...(revision === undefined ? {} : { revision }) });
      const template = data.template as TemplateSummary | undefined;
      if (!template || typeof template.id !== "string") throw new Error("宿主未返回已保存的工作流定义");
      this.state.selectedTemplate = template.id;
      await this.refreshTemplates();
      return template;
    } catch (error) { this.state.error = actionError("保存工作流定义失败", error); if (/already exists|changed\. Load it before saving|no longer exists/i.test(errorMessage(error))) this.state.error += "。请从工作流库载入当前定义后再修改。"; return undefined; }
    finally { this.state.busy = false; this.changed(); }
  }

  async select(id: string): Promise<void> {
    if (!this.projectBound || !this.state.runs.some(run => run.id === id && run.projectPath === this.state.projectPath)) return;
    this.definitionSelected = false;
    this.templateRequest++;
    this.state.selectedTemplate = undefined;
    delete this.state.definition;
    this.state.selectedRun = id;
    this.state.task = undefined;
    this.state.tab = "overview";
    const cached = this.selected;
    if (cached) this.useRunProject(cached);
    this.changed();
    await this.loadDetails(id);
  }

  private async loadDetails(id: string, minimum?: Pick<WorkflowListItem, "revision" | "progressSequence">): Promise<void> {
    const request = ++this.detailRequest;
    const expected = minimum ?? this.state.runs.find(run => run.id === id);
    this.unresolvedDetails.add(id);
    this.state.detailsBusy = true; this.changed();
    try {
      const run = parseRun((await this.request("workflow_get_run", { id })).run);
      const latest = this.latestSummaries.get(id);
      if ([expected, latest].some(required => required && (run.revision < required.revision || run.revision === required.revision && (run.progressSequence ?? 0) < (required.progressSequence ?? 0)))) throw new Error("详情版本落后于已确认摘要，请刷新后重试。");
      if (!this.closing && request === this.detailRequest && this.state.selectedRun === id) { this.useRunProject(run); this.replace(run); this.unresolvedDetails.delete(id); const accepted = this.acceptedProjection.get(id); this.acceptedProjection.delete(id); if (accepted && this.state.error.startsWith(accepted)) this.state.error = ""; }
    } catch (error) { if (!this.closing && request === this.detailRequest && this.state.selectedRun === id) this.state.error = `${this.acceptedProjection.get(id) ? this.acceptedProjection.get(id) + " " : ""}读取运行详情失败：${errorMessage(error)}。完整详情确认前不会重复启动、编辑或应用。`; }
    finally { if (request === this.detailRequest) { this.state.detailsBusy = false; this.changed(); } }
  }

  private async mutationRun(data: Record<string, unknown>, select = false): Promise<WorkflowRun | undefined> {
    if (data.operationAccepted !== true || data.listSummary !== true) return parseRun(data.run);
    const summary = parseRunSummary(data.run);
    if (!this.projectBound || summary.projectPath !== this.state.projectPath) { this.state.error = "操作已接受，请从目标项目聊天核对结果；当前面板不改变项目归属。"; this.changed(); return undefined; }
    const projection = data.projectionError as { message?: unknown } | undefined;
    const notice = `操作已接受，当前结果仅为摘要。${typeof projection?.message === "string" ? failureErrorSummary(projection.message) : "完整详情暂时无法读取。"}`;
    this.acceptedProjection.set(summary.id, notice);
    this.rememberSummary(summary);
    this.unresolvedDetails.add(summary.id);
    const index = this.state.runs.findIndex(run => run.id === summary.id);
    if (index < 0) this.state.runs.unshift(summary);
    else if (this.state.runs[index]!.revision <= summary.revision) this.state.runs[index] = summary;
    if (select) { this.definitionSelected = false; this.state.selectedRun = summary.id; }
    this.state.error = notice; this.changed();
    if (this.state.selectedRun === summary.id) await this.loadDetails(summary.id);
    return this.selected?.id === summary.id ? this.selected : undefined;
  }

  async readArtifactPage(offset: number): Promise<ReturnType<typeof summarizeMaintenanceReview>> {
    const run = this.selected;
    if (!run || !this.projectBound || !Number.isSafeInteger(offset) || offset < 0) throw new Error("请先读取当前项目的完整运行详情。");
    const expected = summarizeMaintenanceReview(run.maintenanceReview);
    const paged = parseRun((await this.request("workflow_get_run", { id: run.id, artifactOffset: offset, artifactLimit: 100 })).run);
    const page = summarizeMaintenanceReview(paged.maintenanceReview, 200);
    if (this.selected?.id !== run.id || this.selected.revision !== run.revision || paged.id !== run.id || paged.revision !== run.revision || page.artifactOffset !== offset || page.artifactCount !== expected.artifactCount || page.fingerprint !== expected.fingerprint || page.artifactFingerprint !== expected.artifactFingerprint) throw new Error("产物清单已变化，请刷新运行后重新查看。");
    return page;
  }

  async save(input: WorkflowInput, edit?: { id: string; revision: number }): Promise<WorkflowRun | undefined> {
    if (!this.canAct) return undefined;
    if (input.projectPath !== this.currentProject?.path) { this.state.error = "项目所属工作流的目录固定；请从目标项目的聊天中新建运行。"; this.changed(); return undefined; }
    if (edit && this.selected?.id === edit.id && this.selected.deletionPending) { this.state.error = "清理未完成，请先重试删除。"; this.changed(); return undefined; }
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const args: Record<string, unknown> = edit ? { id: edit.id, revision: edit.revision, script: input.script, args: input.args, allowWrite: input.allowWrite, ...(input.networkAccess !== undefined ? { networkAccess: input.networkAccess } : {}), ...(input.allowedMcpServers ? { allowedMcpServers: input.allowedMcpServers } : {}), ...(input.allowedMcpTools ? { allowedMcpTools: input.allowedMcpTools } : {}), ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}), ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}), ...(input.maintenance ? { maintenance: input.maintenance } : {}), ...(input.nodeSettings ? { nodeSettings: input.nodeSettings } : {}) } : { ...input };
      const run = await this.mutationRun(await this.request(edit ? "workflow_update" : "workflow_preview", args), true);
      if (!run) return undefined;
      this.useRunProject(run);
      this.definitionSelected = false;
      this.state.selectedRun = run.id;
      this.replace(run);
      this.state.tab = "overview";
      this.setProjectPath(run.projectPath);
      return run;
    } catch (error) { this.state.error = actionError("保存失败", error); return undefined; }
    finally { this.state.busy = false; this.changed(); }
  }

  async startWithInput(input: WorkflowInput): Promise<void> {
    if (!this.canAct) return;
    const current = this.selected;
    if (current?.deletionPending) { this.state.error = "清理未完成，请先重试删除。"; this.changed(); return; }
    if (current && current.projectPath !== input.projectPath) { this.state.error = "已有运行所属项目固定；请从工作流库在目标项目中新建运行。"; this.changed(); return; }
    if (current && ["preparing", "running", "stopping"].includes(current.execution)) return;
    if (requiresNewLocalPreview(current)) { this.state.error = "本地检查点无法继续复用。请点击“重新检查”创建新预览，再手动启动。"; this.changed(); return; }
    const scope = (value: WorkflowInput | WorkflowRun) => ({ projectPath: value.projectPath, script: value.script, args: value.args, sourceDefinition: value.sourceDefinition, allowWrite: value.allowWrite, networkAccess: value.networkAccess ?? false, allowedMcpServers: value.allowedMcpServers ?? [], allowedMcpTools: value.allowedMcpTools ?? {}, workspaceMode: value.workspaceMode ?? "snapshot", maintenance: value.maintenance, nodeSettings: value.nodeSettings ?? {} });
    const sameLimits = !current || !input.limits || Object.entries(input.limits).every(([key, value]) => current.limits[key as keyof WorkflowRun["limits"]] === value);
    if (current && sameLimits && JSON.stringify(scope(current)) === JSON.stringify(scope(input))) {
      if (current.execution === "draft" && (input.approvalMode === undefined || input.approvalMode === (current.approvalMode ?? "never"))) { await this.perform("start", true); return; }
      if (resultCheckFailure(current)) { this.state.error = "结果检查未通过。请查看失败原因，明确选择需要重新执行的节点。"; this.changed(); return; }
      if (["stopped", "failed"].includes(current.execution)) { await this.perform("resume", true, undefined, input.approvalMode); return; }
    }
    const sameNodes = !current || JSON.stringify(current.nodeSettings ?? {}) === JSON.stringify(input.nodeSettings ?? {});
    const saved = await this.save(input, current?.execution === "draft" && current.projectPath === input.projectPath && sameLimits && (sameNodes || !current.workspacePath) ? { id: current.id, revision: current.revision } : undefined);
    if (saved) await this.perform("start", true);
  }

  async recheckFromCurrent(approvalMode?: ApprovalMode): Promise<WorkflowRun | undefined> {
    const current = this.selected;
    if (!this.canAct || !current || !requiresNewLocalPreview(current) || current.deletionPending || current.application === "applying") return undefined;
    const input = structuredClone({
      projectPath: current.projectPath, script: current.script, args: current.args, allowWrite: current.allowWrite,
      workspaceMode: "local" as const, approvalMode: approvalMode ?? current.approvalMode ?? "never", networkAccess: current.networkAccess ?? false,
      allowedMcpServers: current.allowedMcpServers ?? [], allowedMcpTools: current.allowedMcpTools ?? {},
      nodeSettings: current.nodeSettings ?? {}, limits: current.limits,
      ...(current.maintenance ? { maintenance: current.maintenance } : {}),
      ...(current.sourceDefinition ? { sourceDefinition: current.sourceDefinition } : {}),
    });
    const saved = await this.save(input);
    if (!saved && /Workflow definition changed or does not match the planned script/i.test(this.state.error)) {
      this.state.error += "。工作流库中的定义已更新，请选择库中最新版本，核对参数后新建运行。";
      this.changed();
    }
    return saved;
  }

  async perform(action: UserAction, _userGesture = false, taskId?: string, approvalMode?: ApprovalMode): Promise<void> {
    const detail = this.selected, run = action === "stop" ? this.stopTarget : detail;
    const allowed = action === "stop" ? this.projectBound && this.state.connection === "connected" && !this.state.reconnecting && !this.state.busy && !this.closing : this.canAct;
    if (!run || !allowed || run.deletionPending) return;
    if (action === "start" && run.execution !== "draft") return;
    if (action === "resume" && !["stopped", "failed"].includes(run.execution)) return;
    if (action === "resume" && requiresNewLocalPreview(detail)) { this.state.error = "本地检查点无法继续复用。请点击“重新检查”创建新预览，再手动启动。"; this.changed(); return; }
    if (action === "stop" && !["preparing", "running"].includes(run.execution)) return;
    if (action === "apply" && (!detail || !canApply(detail, this.state.tab))) return;
    if (action === "cancel" && (!detail || run.execution !== "running" || !taskId || !detail.tasks.some(task => task.id === taskId && ["queued", "running"].includes(task.status)))) return;
    if (action === "resume" && taskId && !detail?.tasks.some(task => task.id === taskId)) return;
    const args: Record<string, unknown> = { id: run.id };
    if (["start", "resume", "apply"].includes(action)) args.revision = run.revision;
    if (["start", "resume"].includes(action)) {
      if (!this.leaseId) throw new Error("面板租约尚未建立，请重新打开面板");
      args.leaseId = this.leaseId;
    }
    if (action === "cancel") args.taskId = taskId;
    if (action === "resume" && taskId) args.retryFromTaskId = taskId;
    if (action === "resume" && approvalMode !== undefined) {
      if (!["auto-review", "never"].includes(approvalMode)) { this.state.error = "不支持的审批模式。"; this.changed(); return; }
      args.approvalMode = approvalMode;
    }
    if (action === "start" || action === "resume") this.ownedRuns.add(run.id);
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const updated = await this.mutationRun(await this.request(action === "cancel" ? "workflow_cancel_task" : `workflow_${action}`, args));
      if (updated) this.replace(updated);
    } catch (error) { this.state.error = actionError("操作失败", error, action); }
    finally { this.state.busy = false; this.changed(); }
  }

  teardown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.state.connection = "closed";
    this.state.reconnecting = false;
    this.timers.splice(0).forEach(dispose => dispose());
    this.changed();
    this.shutdown = (async () => {
      // Release is also a server-side stop fallback if an individual request fails.
      await Promise.allSettled([...this.ownedRuns].map(id => this.request("workflow_stop", { id })));
      if (this.leaseId) await this.request("workflow_panel_lease", { leaseId: this.leaseId, release: true });
    })().catch(error => { this.state.error = `面板关闭时无法确认停止：${errorMessage(error)}。服务端将按租约到期处理。`; });
    return this.shutdown;
  }
}

function tone(state: string): string { return ({ preparing: "blue", running: "blue", stopping: "amber", stopped: "amber", interrupted: "amber", failed: "red", completed: "green", pending: "amber", applying: "blue", applied: "green", conflict: "red", partial: "amber" } as Record<string, string>)[state] ?? "neutral"; }
function badge(label: string, state: string): string { return `<span class="wf-badge" data-tone="${tone(state)}">${escapeHtml(label)}</span>`; }
export function parseToolGrants(text: string): Record<string, string[]> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP 工具授权必须为 JSON 对象");
  const entries = Object.entries(value);
  if (entries.some(([name, tools]) => ["__proto__", "constructor", "prototype"].includes(name) || !Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim()))) throw new Error("MCP 工具授权的每个服务须对应工具名称数组，名称不能为空");
  return Object.fromEntries(entries) as Record<string, string[]>;
}
export function jsonInput(value: unknown): string { return JSON.stringify(value, null, 2) ?? "{}"; }
export function workflowSelectOptions(state: Pick<PanelState, "runs" | "templates" | "selectedRun" | "selectedTemplate" | "runNextOffset" | "historyBusy" | "projectPath">): string {
  const runs = state.runs.filter(run => run.projectPath === state.projectPath);
  const selectedRun = runs.find(run => run.id === state.selectedRun);
  const selectedTemplate = state.selectedRun ? undefined : state.templates.find(template => template.id === state.selectedTemplate);
  const placeholder = `<option value="" disabled${!selectedRun && !selectedTemplate ? " selected" : ""}>选择工作流</option>`;
  const runOptions = runs.length ? `<optgroup label="本项目运行">${runs.map(run => {
    const created = new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false });
    const label = `${run.meta.name} · ${executionLabels[run.execution] ?? run.execution} · ${created} · ${run.id.slice(-8)}`;
    return `<option value="${escapeHtml(`run:${run.id}`)}"${run.id === selectedRun?.id ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("")}</optgroup>` : "";
  const templateOptions = state.templates.length ? `<optgroup label="工作流库">${state.templates.map(template => `<option value="${escapeHtml(`template:${template.id}`)}"${template.id === selectedTemplate?.id ? " selected" : ""}>${escapeHtml(template.name)}${template.source === "builtin" ? " · 内置" : ""}</option>`).join("")}</optgroup>` : "";
  const more = state.runNextOffset !== undefined ? `<option value="more-runs"${state.historyBusy ? " disabled" : ""}>${state.historyBusy ? "正在加载更多运行…" : "加载更多本项目运行…"}</option>` : "";
  return placeholder + runOptions + templateOptions + more;
}
export function modelSelectOptions(models: ExecutionSettingsResponse["models"], selected: string, inherited: string): string {
  return `<option value="">${escapeHtml(inherited)}</option>` + (selected && !models.some(model => model.id === selected) ? `<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(selected)} · 当前不可用</option>` : "") + models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? "selected" : ""}>${escapeHtml(model.displayName || model.id)}</option>`).join("");
}
export function effortSelectOptions(models: ExecutionSettingsResponse["models"], model: string | undefined, selected: string, inherited: string): string {
  const efforts = model ? models.find(item => item.id === model)?.supportedReasoningEfforts ?? [] : [...new Set(models.flatMap(item => item.supportedReasoningEfforts))];
  return `<option value="">${escapeHtml(inherited)}</option>` + (selected && !efforts.includes(selected) ? `<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(selected)} · 当前模型不支持</option>` : "") + efforts.map(effort => `<option value="${escapeHtml(effort)}" ${effort === selected ? "selected" : ""}>${escapeHtml(effort)}</option>`).join("");
}
export function bindObservedNodeChoice(key: string, choice: ExecutionChoice, tasks: WorkflowTask[]): NodeExecutionChoice {
  const value = { ...(choice.model ? { model: choice.model } : {}), ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) };
  if (!key.startsWith("task:")) return value;
  const task = tasks.find(task => `task:${task.index}` === key);
  if (task && Object.hasOwn(task.options, "operation")) throw new Error("此节点执行固定命令，不使用模型，无需模型设置");
  if (typeof task?.configurationTarget !== "string" || !task.configurationTarget) throw new Error("当前任务记录未提供配置绑定标识，请使用阶段或默认设置");
  return { ...value, identity: task.configurationTarget };
}
function formatted(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }
function displayTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false }); }

export function summarizeMaintenanceReview(value: unknown, maximumArtifacts = 30): {
  base: string; target: string; branch: string; preparedClean: boolean | undefined;
  artifactCount: number; artifactFingerprint: string; fingerprint: string;
  artifactOffset: number; nextArtifactOffset?: number;
  artifacts: Array<{ path: string; size?: number; kind?: string }>;
} {
  const review = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const artifacts = Array.isArray(review.artifacts) ? review.artifacts : [];
  const text = (key: string): string => typeof review[key] === "string" ? review[key] : "";
  return {
    base: text("base"), target: text("target"), branch: text("branch"), preparedClean: typeof review.preparedClean === "boolean" ? review.preparedClean : undefined,
    artifactCount: Number.isSafeInteger(review.artifactCount) && Number(review.artifactCount) >= 0 ? Number(review.artifactCount) : artifacts.length,
    artifactOffset: Number.isSafeInteger(review.artifactOffset) && Number(review.artifactOffset) >= 0 ? Number(review.artifactOffset) : 0,
    ...(Number.isSafeInteger(review.nextArtifactOffset) && Number(review.nextArtifactOffset) >= 0 ? { nextArtifactOffset: Number(review.nextArtifactOffset) } : {}),
    artifactFingerprint: text("artifactFingerprint"), fingerprint: text("fingerprint"),
    artifacts: artifacts.slice(0, Math.max(0, Math.min(200, maximumArtifacts))).map((value: unknown) => {
      const artifact = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { path: typeof artifact.path === "string" ? artifact.path : "未知路径", ...(typeof artifact.size === "number" ? { size: artifact.size } : {}), ...(typeof artifact.kind === "string" ? { kind: artifact.kind } : {}) };
    }),
  };
}

export function maintenanceProtectedPathsSummary(plan?: MaintenancePlan): string {
  return (plan?.steps ?? []).filter(step => step.protectedPaths?.length).map(step => `${step.id}：${step.protectedPaths!.join("、")}`).join("；");
}
export function renderMaintenanceArtifacts(value: unknown, maximumArtifacts = 30): string {
  const page = summarizeMaintenanceReview(value, maximumArtifacts);
  if (!page.artifactCount) return "";
  return `<details data-detail="maintenance-artifacts"><summary>构建产物（当前 ${page.artifacts.length} 项 / 共 ${page.artifactCount} 项）</summary><pre>${escapeHtml(jsonInput(page.artifacts))}</pre><p class="wf-muted">当前显示第 ${page.artifacts.length ? page.artifactOffset + 1 : 0}—${page.artifactOffset + page.artifacts.length} 项，共 ${page.artifactCount} 项。完整清单按页读取，保存的审查指纹保持不变。</p>${page.artifactOffset > 0 ? '<button type="button" data-artifact-offset="0">返回产物首页</button>' : ""}${page.nextArtifactOffset !== undefined ? `<button type="button" data-artifact-offset="${page.nextArtifactOffset}">下一页产物</button>` : ""}<span class="wf-muted" id="wf-artifact-page-status" role="status"></span></details>`;
}
function maintenanceReview(run: WorkflowRun, artifactPage?: unknown): string {
  if (run.maintenanceReview === undefined) return "";
  const review = summarizeMaintenanceReview(run.maintenanceReview);
  const protectedPaths = maintenanceProtectedPathsSummary(run.maintenance);
  return `<h3 class="wf-section-title">维护审查</h3><div class="wf-facts"><span>分支 ${escapeHtml(review.branch || "未提供")}</span><span>基线 ${escapeHtml(review.base.slice(0, 12) || "未提供")} → ${escapeHtml(review.target.slice(0, 12) || "未提供")}</span><span>构建产物 ${review.artifactCount} 项</span><span>准备检查：${review.preparedClean === undefined ? "未报告" : review.preparedClean ? "已通过" : "未通过"}</span></div>${protectedPaths ? `<div class="wf-notice">命令目录授权：${escapeHtml(protectedPaths)}。仅对应命令生效，代理任务权限不变。</div>` : ""}<details data-detail="maintenance-fingerprint"><summary>审查标识</summary><div class="wf-muted">产物指纹：${escapeHtml(review.artifactFingerprint || "未提供")}<br>整体审查：${escapeHtml(review.fingerprint || "未提供")}</div></details>${renderMaintenanceArtifacts(artifactPage ?? run.maintenanceReview, artifactPage ? 200 : 30)}`;
}

function activationSummary(run: WorkflowRun): string {
  if (!run.activation && !run.maintenance?.activation) return "";
  const activation = run.activation;
  const plan = run.maintenance?.activation;
  const status = activation ? ({ pending_restart: "配置已更新，等待宿主重新加载并验证实际版本", verified: "服务激活已验证", failed: "激活失败，可按当前运行版本重试" })[activation.status] : "执行完成并按授权应用后激活";
  const command = typeof activation?.command === "string" ? activation.command : plan?.command;
  const args = Array.isArray(activation?.args) ? activation.args : plan?.args;
  return `<h3 class="wf-section-title">服务激活</h3><div class="wf-notice">${escapeHtml(activation?.serverName ?? plan?.serverName)}：${escapeHtml(status)}</div>${activation?.error ? `<div class="wf-alert" role="alert">${escapeHtml(activation.error)}</div>` : ""}${command ? `<details data-detail="activation-target"><summary>查看目标启动命令</summary><pre>${escapeHtml(jsonInput({ command, args: args ?? [] }))}</pre></details>` : ""}`;
}

export function renderWorkflowDiff(run: WorkflowRun, artifactPage?: unknown): string {
  const local = run.workspaceMode === "local";
  const localNotice = local ? `<div class="wf-notice">${escapeHtml(workspaceModeDescription("local", run.allowWrite))}</div>` : "";
  const localDiffAvailable = local && !!run.diff && ["completed", "stopped", "failed"].includes(run.execution);
  const reviewFailure = failureContext(run)?.kind === "review" ? `<h3 class="wf-section-title">改动审查失败</h3><div class="wf-alert" role="alert">${escapeHtml(failureErrorSummary(run.error ?? "无法完成改动审查"))}</div><p class="wf-muted">${run.tasks.every(task => task.status === "completed") ? "已完成任务结果保留。点击“重试审查”将回放有效缓存并重新汇总差异，无需从任务节点重跑。" : "部分任务未完成。点击“继续”按普通恢复处理，可能重新执行失败或中断的任务；有效结果按恢复检查保留。"}</p>` : "";
  if (reviewFailure && !localDiffAvailable) return `${localNotice}${reviewFailure}`;
  if (local && !localDiffAvailable) return `${localNotice}<div class="wf-empty">${["completed", "stopped", "failed"].includes(run.execution) ? "尚未取得本地差异，当前项目可能已有改动，请检查项目文件。" : "本次执行结束后汇总本地差异。执行期间改动直接写入当前项目。"}</div>`;
  if (!local && run.execution !== "completed") return '<div class="wf-empty">整个工作流执行完成后统一汇总差异。停止或失败时保留工作区，可恢复后继续。</div>';
  const conflicts = run.diff?.conflicts?.length ? `<div class="wf-alert" role="alert">存在应用冲突：${run.diff.conflicts.map(escapeHtml).join("、")}</div>` : "";
  const bytes = typeof run.diff?.totalBytes === "number" && Number.isSafeInteger(run.diff.totalBytes) && run.diff.totalBytes >= 0 ? `${run.diff.totalBytes.toLocaleString("zh-CN")} 字节` : "未提供";
  const preview = run.diff?.previewTruncated ? `<div class="wf-notice" role="status">以下仅显示部分差异预览。完整文件清单共 ${run.diff.files.length} 项；${local ? "本地改动已直接写入当前项目。" : "应用会处理完整清单中的变更。"}</div>` : "";
  const integrity = run.diff?.contentSha256 ? `<details data-detail="diff-integrity"><summary>完整差异校验信息</summary><div class="wf-muted">完整差异总量：${escapeHtml(bytes)}<br>完整差异 SHA-256：<code>${escapeHtml(run.diff.contentSha256)}</code></div></details>` : "";
  const changes = run.diff?.files.length ? `<h3 class="wf-section-title">${local ? "已记录的本地差异" : "变更文件"}（完整清单 · ${run.diff.files.length} 项）</h3>${run.diff.files.map(file => `<div class="wf-file-header"><span>${escapeHtml(file.path)}</span><span> · ${escapeHtml(file.status)}</span></div>`).join("")}${preview}${run.diff.previewTruncated ? `<p class="wf-muted">完整差异总量：${escapeHtml(bytes)}</p>` : ""}${integrity}<pre aria-label="${run.diff.previewTruncated ? "差异部分预览" : "统一差异"}">${escapeHtml(run.diff.text)}</pre>` : `<div class="wf-empty">${local ? "本次记录的差异为空。" : "本次执行没有文件改动。"}</div>`;

  if (local) return `${localNotice}${reviewFailure}<p class="wf-muted">以下为本次运行结束时记录的差异；当前项目的后续编辑不会自动更新到此记录。</p>${changes}`;
  return `${run.application === "partial" ? `<div class="wf-alert" role="alert">${escapeHtml(partialApplicationMessage(run))}</div>` : ""}${conflicts}${changes}${maintenanceReview(run, artifactPage)}${activationSummary(run)}<div class="wf-notice">${escapeHtml(applicationLabels[run.application] ?? run.application)}。${run.activation?.status === "pending_restart" ? "配置已更新；宿主仍需重新加载并核对实际版本，脚本完成不代表新版服务已生效。" : "应用前会检查当前项目；冲突时保留工作区供你处理。"}</div>`;
}

export interface NodeProcess {
  id: string; taskId?: string; phase?: string; scope?: "workflow" | "unphased"; label: string; status: string;
  currentActivity?: WorkflowActivity; activities: WorkflowActivity[]; summary: string; error?: string;
  logs?: Array<{ at: string; level: string; message: string; taskId?: string }>;
}
export interface NodeProcessTarget { id: string; taskId?: string; phase?: string; scope?: "workflow" | "unphased" }
export type NodeProcessDetail = "brief" | "developer";

// Keep one transport request alive while newer progress merely queues a refresh.
// Session changes discard results, not the in-flight ownership of that request.
export class NodeProcessReader {
  private session = 0;
  private target: NodeProcessTarget | undefined;
  private pending = new Map<NodeProcessDetail, string>();
  private completed = new Map<NodeProcessDetail, string>();
  private failed = new Set<NodeProcessDetail>();
  private active: { session: number; detail: NodeProcessDetail; signature: string } | undefined;
  private readonly read: (target: NodeProcessTarget, detail: NodeProcessDetail) => Promise<NodeProcess>;
  private readonly receive: (target: NodeProcessTarget, detail: NodeProcessDetail, process: NodeProcess) => void;
  private readonly reject: (target: NodeProcessTarget, detail: NodeProcessDetail, error: unknown) => void;
  constructor(
    read: (target: NodeProcessTarget, detail: NodeProcessDetail) => Promise<NodeProcess>,
    receive: (target: NodeProcessTarget, detail: NodeProcessDetail, process: NodeProcess) => void,
    reject: (target: NodeProcessTarget, detail: NodeProcessDetail, error: unknown) => void,
  ) { this.read = read; this.receive = receive; this.reject = reject; }
  open(target: NodeProcessTarget): void {
    this.close();
    this.target = { ...target };
  }
  close(): void {
    this.session++;
    this.target = undefined;
    this.pending.clear();
    this.completed.clear();
    this.failed.clear();
  }
  cancel(detail: NodeProcessDetail): void { this.pending.delete(detail); }
  request(detail: NodeProcessDetail, signature: string, retry = false): void {
    if (!this.target || this.failed.has(detail) && !retry) return;
    if (retry) this.failed.delete(detail);
    else if (this.completed.get(detail) === signature || this.active?.session === this.session && this.active.detail === detail && this.active.signature === signature) return;
    this.pending.set(detail, signature);
    this.drain();
  }
  private drain(): void {
    if (this.active || !this.target) return;
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [detail, signature] = next;
    this.pending.delete(detail);
    const target = { ...this.target }, active = { session: this.session, detail, signature };
    this.active = active;
    void (async () => {
      try {
        const process = await this.read(target, detail);
        if (active.session === this.session && this.target) { this.completed.set(detail, signature); this.receive(target, detail, process); }
      } catch (error) {
        if (active.session === this.session && this.target) { this.failed.add(detail); this.pending.delete(detail); this.reject(target, detail, error); }
      } finally {
        if (this.active === active) this.active = undefined;
        this.drain();
      }
    })();
  }
}
export interface DeletionTarget { kind: "run" | "definition"; id: string; revision: number; runIds?: string[]; includeAssociatedRuns?: true }
export interface DeletionPreview {
  fingerprint: string; target: DeletionTarget; runs: Array<{ id: string; revision: number; name: string; projectPath: string }>;
  definition?: unknown; objects: Array<{ path: string; kind: string; bytes: number; files: number }>;
  totalBytes: number; totalFiles: number; blocked: Array<{ code: string; path?: string; runId?: string; message: string; reference?: string }>; canDelete: boolean;
}
export function deletionPreviewPayload(value: Record<string, unknown>): DeletionPreview {
  const preview = value.preview as DeletionPreview | undefined;
  if (!preview || typeof preview.fingerprint !== "string" || !preview.target || !Array.isArray(preview.runs) || !Array.isArray(preview.objects) || !Array.isArray(preview.blocked) || typeof preview.canDelete !== "boolean" || typeof preview.totalBytes !== "number" || typeof preview.totalFiles !== "number") throw new Error("宿主未返回有效的删除清单");
  return preview;
}
export function renderDeletionPreview(preview: DeletionPreview): string {
  const bytes = preview.totalBytes < 1024 * 1024 ? `${Math.ceil(preview.totalBytes / 1024)} KB` : `${(preview.totalBytes / 1024 / 1024).toFixed(1)} MB`;
  const scopeLabels: Record<string, string> = { run: "运行、日志、缓存与隔离工作区", definition: "工作流定义", lock: "控制与锁文件" };
  const scopes = [...new Set(preview.objects.map(object => scopeLabels[object.kind] ?? object.kind))];
  return `<p>将清理${preview.target.kind === "definition" ? preview.target.runIds?.length ? "工作流定义、关联运行及你额外选择的旧运行" : "工作流定义及其明确关联的运行" : "本次运行"}，此操作无法撤销。</p><p class="wf-muted">已写入原项目的文件和提交会保留；停止或删除运行不会撤销这些改动。</p><ul class="wf-delete-stats"><li>运行记录：${preview.runs.length} 条</li><li>文件：${preview.totalFiles} 个 · ${escapeHtml(bytes)}</li><li>范围：${escapeHtml(scopes.join("、") || "无运行文件")}</li></ul>${preview.runs.length ? `<details><summary>查看将删除的运行（${preview.runs.length} 条）</summary><ul class="wf-delete-stats">${preview.runs.map(run => `<li><strong>${escapeHtml(run.name)}</strong><br><span class="wf-muted">${escapeHtml(run.id)} · ${escapeHtml(run.projectPath)}</span></li>`).join("")}</ul></details>` : ""}${preview.blocked.length ? `<div class="wf-alert" role="alert">当前无法完成删除：${preview.blocked.map(item => escapeHtml(item.message)).join("；")}</div>` : '<p class="wf-muted">日志、结果缓存、隔离工作区及控制文件会一并清理；清理未完成会保留可重试状态。</p>'}`;
}
export function renderNodeProcess(process: NodeProcess, now = Date.now()): string {
  const state = taskLabels[process.status] ?? executionLabels[process.status] ?? "等待中";
  const entries = process.activities.map(activity => `<li data-status="${escapeHtml(activity.status)}"><span class="wf-icon${activity.status === "running" ? " is-spinning" : ""}" data-icon="${activity.status === "running" ? "loader-2" : activity.status === "completed" ? "circle-check" : activity.status === "failed" ? "alert-circle" : "circle"}" aria-hidden="true"></span><span>${escapeHtml(activity.label)}</span><time>${elapsedLabel(activity.startedAt, activity.endedAt, now)}</time></li>`).join("");
  return `<div class="wf-facts"><span>${escapeHtml(state)}</span>${process.currentActivity ? `<span>${process.status === "running" ? "当前" : "最后活动"}：${escapeHtml(process.currentActivity.label)}</span>` : ""}</div>${process.error ? `<div class="wf-alert" role="alert">${escapeHtml(process.error)}</div>` : ""}${entries ? `<ol class="wf-timeline">${entries}</ol>` : '<p class="wf-muted">此节点尚未报告过程活动。</p>'}${process.summary ? `<div class="wf-process-result">${escapeHtml(process.summary)}</div>` : ""}`;
}
export function primaryWorkflowAction(run?: WorkflowRun): { action: "start" | "inspect-failure" | "retry-review" | "recheck"; label: string } {
  if (requiresNewLocalPreview(run)) return { action: "recheck", label: "重新检查" };
  if (run && failureContext(run)?.kind === "review" && run.tasks.every(task => task.status === "completed")) return { action: "retry-review", label: "重试审查" };
  return run && resultCheckFailure(run) ? { action: "inspect-failure", label: "查看失败原因" } : { action: "start", label: run && ["stopped", "failed"].includes(run.execution) ? "继续" : "启动" };
}

export function fullFailureDetails(error: string): string {
  const safe = failureErrorText(error);
  return `<details class="wf-failure-details"><summary>完整错误</summary><pre>${escapeHtml(safe)}</pre></details>`;
}

export function mountPanel(root: HTMLElement, callTool: ToolCaller): WorkflowPanelController {
  const element = <T extends HTMLElement>(selector: string): T => { const value = root.querySelector<T>(selector); if (!value) throw new Error(`Missing panel element: ${selector}`); return value; };
  const controller = new WorkflowPanelController(callTool, () => render());
  const project = element<HTMLSelectElement>("#wf-project-select");
  const parameterFields = element("#wf-parameter-fields");
  const parameterError = element("#wf-parameter-error");
  const parameterDialog = element<HTMLDialogElement>("#wf-parameters-dialog");
  const workspaceModeSelect = element<HTMLSelectElement>("#wf-workspace-mode-select");
  const approvalModeSelect = element<HTMLSelectElement>("#wf-approval-mode-select");
  const settingsDialog = element<HTMLDialogElement>("#wf-settings-dialog");
  const nodeDialog = element<HTMLDialogElement>("#wf-node-settings-dialog");
  const processDialog = element<HTMLDialogElement>("#wf-process-dialog");
  const historyDialog = element<HTMLDialogElement>("#wf-history-dialog");
  const reviewDialog = element<HTMLDialogElement>("#wf-review-dialog");
  const deleteDialog = element<HTMLDialogElement>("#wf-delete-dialog");
  const defaultModel = element<HTMLSelectElement>("#wf-default-model");
  const defaultEffort = element<HTMLSelectElement>("#wf-default-effort");
  const nodeModel = element<HTMLSelectElement>("#wf-node-model");
  const nodeEffort = element<HTMLSelectElement>("#wf-node-effort");
  const developerLogs = element<HTMLDetailsElement>("#wf-developer-logs");
  const menu = element("#wf-more-menu");
  let owner = "", parametersSignature = "", settingsSignature = "", templateRequest = "";
  let argsValue: unknown = {}, nodeSettings: NodeSettings = {}, nodeKey = "", nodeNotice = "", nodeDirty = false;
  let parameterSnapshot: unknown, parametersSaved = false, nodeSignature = "", zoom = 1;
  let workspaceModeValue: WorkspaceMode = "snapshot", workspaceModeSnapshot: WorkspaceMode = "snapshot", workspaceSourceMode: WorkspaceMode = "snapshot";
  let approvalModeValue: ApprovalMode = "auto-review", approvalModeSnapshot: ApprovalMode = "auto-review", approvalSnapshotSource: ApprovalMode = "auto-review", approvalSourceMode: ApprovalMode = "auto-review";
  const sourceApprovalMode = (value?: WorkflowRun | TemplateDefinition): ApprovalMode => value?.approvalMode ?? (value && ("execution" in value || value.source === "saved") ? "never" : "auto-review");
  let processTarget: NodeProcessTarget | undefined;
  let processSignature = "", developerRequested = false;
  let reviewSignature = "";
  let artifactPage: unknown, artifactOwner = "", artifactRequest = 0, artifactLoading = false;
  let deletionPreview: DeletionPreview | undefined, deletionLoading = false, deletionRequest = 0;
  let lastGraph = "", lastGraphOwner = "";
  const returns = new Map<HTMLDialogElement, { id?: string; task?: string; phase?: string; scope?: string; node?: string }>();
  const currentDefinition = (): TemplateDefinition | undefined => controller.state.definition?.id === controller.state.selectedTemplate ? controller.state.definition : undefined;
  const source = (): WorkflowRun | TemplateDefinition | undefined => controller.selected ?? currentDefinition();
  const executing = (): boolean => !!controller.selected && ["preparing", "running", "stopping"].includes(controller.selected.execution);
  const parameters = (): WorkflowParameter[] | undefined => source()?.meta?.parameters;
  const activeProject = (): CodexProject | undefined => controller.state.projects.find(item => item.projectId === controller.state.selectedProjectId);
  const closeMenu = (): void => { menu.hidden = true; element("#wf-more-toggle").setAttribute("aria-expanded", "false"); };
  const openDialog = (dialog: HTMLDialogElement, trigger?: HTMLElement): void => {
    closeMenu();
    if (trigger) returns.set(dialog, { ...(trigger.id ? { id: trigger.id } : {}), ...(trigger.dataset.task ? { task: trigger.dataset.task } : {}), ...(trigger.dataset.phase ?? trigger.dataset.phaseContainer ? { phase: (trigger.dataset.phase ?? trigger.dataset.phaseContainer)! } : {}), ...(trigger.dataset.processScope ? { scope: trigger.dataset.processScope } : {}), ...(trigger.dataset.nodeSettings ? { node: trigger.dataset.nodeSettings } : {}) });
    if (!dialog.open) dialog.showModal();
    const focus = dialog.querySelector<HTMLElement>("input:not(:disabled),select:not(:disabled),textarea:not(:disabled)") ?? dialog.querySelector<HTMLElement>("button:not(:disabled)");
    focus?.focus({ preventScroll: true });
  };
  const restoreFocus = (dialog: HTMLDialogElement): void => {
    const key = returns.get(dialog);
    const trigger = key?.id ? root.querySelector<HTMLElement>(`#${key.id}`) : Array.from(root.querySelectorAll<HTMLElement>("button[data-task],button[data-phase],button[data-process-scope],button[data-node-settings]")).find(value => key?.task && value.dataset.task === key.task || key?.phase && value.dataset.phase === key.phase || key?.node && value.dataset.nodeSettings === key.node || key?.scope && value.dataset.processScope === key.scope);
    trigger?.focus({ preventScroll: true });
  };
  const readInput = (): WorkflowInput => {
    const input = source();
    if (!input) throw new Error("请先选择工作流");
    const path = controller.selected?.projectPath ?? activeProject()?.path;
    if (!path) throw new Error("请先选择目标项目");
    const values = new Map(Array.from(parameterFields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-parameter]")).map(control => [control.dataset.parameter!, control.dataset.parameterType === "boolean" ? (control as HTMLInputElement).checked : control.value]));
    const definition = currentDefinition();
    return { projectPath: path, script: input.script, args: parameters()?.length ? readParameters(parameters()!, values, argsValue) : argsValue,
      allowWrite: input.allowWrite ?? false, networkAccess: input.networkAccess ?? false, allowedMcpServers: input.allowedMcpServers ?? [], allowedMcpTools: input.allowedMcpTools ?? {}, workspaceMode: workspaceModeValue, approvalMode: approvalModeValue, nodeSettings: structuredClone(nodeSettings), ...(input.maintenance ? { maintenance: input.maintenance } : {}), ...(input.limits ? { limits: input.limits } : {}),
      ...(controller.selected?.sourceDefinition ? { sourceDefinition: controller.selected.sourceDefinition } : definition ? { sourceDefinition: { id: definition.id, revision: definition.revision ?? 0 } } : {}),
    };
  };
  const defaultChoice = (): ExecutionChoice => controller.selected?.executionSettings ?? controller.state.settings?.effectiveDefaults ?? {};
  const inheritedChoice = (): ExecutionChoice => {
    const defaults = { ...defaultChoice() };
    const task = controller.selected?.tasks.find(item => `task:${item.index}` === nodeKey);
    if (typeof task?.options.model === "string") defaults.model = task.options.model;
    if (typeof task?.options.reasoningEffort === "string") defaults.reasoningEffort = task.options.reasoningEffort;
    return { ...defaults, ...(task?.phase ? nodeSettings[`phase:${task.phase}`] : {}) };
  };
  const validateChoice = (choice: ExecutionChoice, inherited: ExecutionChoice): void => {
    const models = controller.state.settings?.models ?? [];
    if (choice.model && !models.some(model => model.id === choice.model)) throw new Error("请选择目录中可用的模型");
    const model = models.find(item => item.id === (choice.model ?? inherited.model));
    const effort = choice.reasoningEffort ?? inherited.reasoningEffort;
    if (choice.reasoningEffort && !models.some(model => model.supportedReasoningEfforts.includes(choice.reasoningEffort!))) throw new Error("请选择可用的思考深度");
    if (model && effort && !model.supportedReasoningEfforts.includes(effort)) throw new Error(`模型 ${model.displayName || model.id} 不支持 ${effort} 思考深度`);
  };
  const processReader = new NodeProcessReader(async (target, detail) => {
      const data = await controller.request("workflow_get_node_process", { ...target, detail });
      const process = data.process as NodeProcess | undefined;
      if (!process || !Array.isArray(process.activities) || typeof process.summary !== "string" || typeof process.label !== "string") throw new Error("节点过程格式无效");
      return process;
    }, (target, detail, process) => {
      if (!processDialog.open || JSON.stringify(target) !== JSON.stringify(processTarget)) return;
      const run = controller.selected, failure = run && resultCheckFailure(run);
      element("#wf-process-title").textContent = run && failureContext(run)?.kind === "review" && target.scope === "workflow" ? "改动审查失败" : process.label;
      const relatedFailure = run?.execution === "failed" && (target.scope === "workflow" || failure && (failure.afterTaskId && target.taskId === failure.afterTaskId || failure.phase && target.phase === failure.phase));
      element("#wf-process-body").innerHTML = renderNodeProcess(process) + (relatedFailure && run?.error ? fullFailureDetails(run.error) : "");
      if (detail === "developer") element("#wf-process-developer").textContent = process.logs?.map(log => `${displayTime(log.at)} ${log.level} ${log.message}`).join("\n") || "此节点暂无开发日志。";
    }, (target, detail, error) => {
      if (!processDialog.open || JSON.stringify(target) !== JSON.stringify(processTarget)) return;
      element(detail === "developer" ? "#wf-process-developer" : "#wf-process-body").innerHTML = `${escapeHtml(`读取${detail === "developer" ? "开发日志" : "节点过程"}失败：${errorMessage(error)}`)}\n<button type="button" data-retry-process="${detail}">重试</button>`;
    });
  const fetchProcess = (developer = false, retry = false): void => {
    if (!processTarget || !processDialog.open) return;
    if (retry) element(developer ? "#wf-process-developer" : "#wf-process-body").textContent = developer ? "正在读取开发日志…" : "正在读取简要过程…";
    processReader.request(developer ? "developer" : "brief", processSignature, retry);
  };
  const loadArtifactPage = async (offset: number): Promise<void> => {
    const run = controller.selected;
    if (!run || artifactLoading || !Number.isSafeInteger(offset) || offset < 0) return;
    const owner = JSON.stringify([run.id, run.revision]);
    const request = ++artifactRequest;
    artifactLoading = true;
    const status = root.querySelector<HTMLElement>("#wf-artifact-page-status");
    if (status) status.textContent = "正在读取产物页…";
    try {
      const page = await controller.readArtifactPage(offset);
      if (request !== artifactRequest || !reviewDialog.open || JSON.stringify([controller.selected?.id, controller.selected?.revision]) !== owner) return;
      artifactPage = page; artifactOwner = owner;
      const details = root.querySelector<HTMLDetailsElement>('details[data-detail="maintenance-artifacts"]');
      const opened = details?.open ?? true, scroll = reviewDialog.scrollTop;
      if (details) details.outerHTML = renderMaintenanceArtifacts(page, 200);
      const next = root.querySelector<HTMLDetailsElement>('details[data-detail="maintenance-artifacts"]');
      if (next) next.open = opened;
      reviewDialog.scrollTop = scroll;
    } catch (error) { const current = root.querySelector<HTMLElement>("#wf-artifact-page-status"); if (request === artifactRequest && current) current.textContent = `读取失败：${errorMessage(error)}`; }
    finally { if (request === artifactRequest) artifactLoading = false; }
  };
  const openFailureProcess = (trigger?: HTMLElement): void => {
    const run = controller.selected;
    if (!run) return;
    const failure = resultCheckFailure(run), task = run.tasks.find(task => task.id === failure?.afterTaskId);
    const knownPhase = failure?.phase && ((run.meta.phases ?? []).some(phase => (typeof phase === "string" ? phase : phase.title ?? phase.name) === failure.phase) || run.tasks.some(task => task.phase === failure.phase));
    if (task) controller.state.task = task.id;
    processTarget = { id: run.id, ...(task ? { taskId: task.id } : knownPhase ? { phase: failure!.phase! } : { scope: "workflow" as const }) };
    processReader.open(processTarget);
    processSignature = ""; developerRequested = false; developerLogs.open = false;
    element("#wf-process-title").textContent = failureContext(run)?.kind === "review" ? "改动审查失败" : "结果检查失败";
    element("#wf-process-body").textContent = failureContext(run)?.kind === "review" ? "正在读取改动审查错误，已完成任务的有效结果保留。" : "正在读取失败原因与关联任务。重新执行需明确选择‘从此节点重试’。";
    openDialog(processDialog, trigger); render();
  };
  const targetForDeletion = (): DeletionTarget => {
    if (controller.selected?.deletionPending && controller.selected.deletionTarget) return controller.selected.deletionTarget;
    const scope = root.querySelector<HTMLInputElement>('input[name="wf-delete-scope"]:checked')?.value;
    if (scope === "template") {
      const definition = currentDefinition();
      const identity = controller.selected?.sourceDefinition;
      const summary = controller.state.templates.find(item => item.id === (definition?.id ?? identity?.id));
      if (!summary || summary.source !== "saved" || summary.revision === undefined) throw new Error("本次运行未关联可删除的用户定义；内置工作流不能删除。可仅删除本次运行。");
      const runIds = Array.from(root.querySelectorAll<HTMLInputElement>("[data-delete-legacy]:checked")).map(value => value.dataset.deleteLegacy!).sort();
      return { kind: "definition", id: summary.id, revision: summary.revision, ...(runIds.length ? { runIds } : {}) };
    }
    const run = controller.selected;
    if (!run) throw new Error("当前没有可删除的运行记录");
    return { kind: "run", id: run.id, revision: run.revision };
  };
  const configureDeletion = (): void => {
    const definition = currentDefinition(), run = controller.selected;
    const associated = controller.state.templates.find(item => item.id === (definition?.id ?? run?.sourceDefinition?.id));
    const runRadio = element<HTMLInputElement>('input[name="wf-delete-scope"][value="run"]');
    const templateRadio = element<HTMLInputElement>('input[name="wf-delete-scope"][value="template"]');
    runRadio.disabled = !run || !!run.deletionPending;
    templateRadio.disabled = associated?.source !== "saved" || !!run?.deletionPending;
    const target = run?.deletionPending ? run.deletionTarget : undefined;
    runRadio.checked = target ? target.kind === "run" : !!run;
    templateRadio.checked = target ? target.kind === "definition" : !run && !templateRadio.disabled;
    const projectPath = run?.projectPath ?? activeProject()?.path;
    const legacy = controller.state.runs.filter(item => !item.sourceDefinition && item.projectPath === projectPath && !item.deletionPending);
    element("#wf-delete-legacy-list").innerHTML = legacy.length ? legacy.map(item => `<label><input type="checkbox" data-delete-legacy="${escapeHtml(item.id)}"><span>${escapeHtml(item.meta.name)}<small class="wf-muted">${escapeHtml(item.id)} · ${escapeHtml(executionLabels[item.execution] ?? item.execution)}</small></span></label>`).join("") : '<p class="wf-muted">此项目没有未关联的旧运行。</p>';
    element("#wf-delete-legacy").hidden = !templateRadio.checked || !!target;
  };
  const previewDeletion = async (): Promise<void> => {
    const request = ++deletionRequest;
    deletionPreview = undefined; deletionLoading = true;
    element("#wf-delete-error").hidden = true;
    element("#wf-delete-preview").textContent = "正在核对文件、运行进程和服务引用…";
    element<HTMLButtonElement>("#wf-confirm-delete").disabled = true;
    try {
      const target = targetForDeletion();
      const preview = deletionPreviewPayload(await controller.request("workflow_preview_deletion", { ...target }));
      if (request !== deletionRequest || !deleteDialog.open) return;
      deletionPreview = preview;
      const stoppable = preview.blocked.some(block => block.runId && ["active", "locked"].includes(block.code) && controller.state.runs.find(run => run.id === block.runId)?.application !== "applying");
      element("#wf-delete-preview").innerHTML = renderDeletionPreview(preview) + (stoppable ? '<button type="button" id="wf-stop-for-delete">停止关联运行并重新检查</button>' : !preview.canDelete ? '<button type="button" id="wf-retry-delete-preview">重新检查</button>' : "");
    } catch (error) { if (request === deletionRequest) { element("#wf-delete-error").textContent = errorMessage(error); element("#wf-delete-error").hidden = false; } }
    finally { if (request === deletionRequest) { deletionLoading = false; element<HTMLButtonElement>("#wf-confirm-delete").disabled = !controller.canAct || !deletionPreview?.canDelete; } }
  };
  const render = (): void => {
    const state = controller.state, run = controller.selected, summary = controller.selectedSummary, definition = currentDefinition();
    const input = run ?? definition;
    const nextOwner = run ? `run:${run.id}` : summary ? `summary:${summary.id}` : definition ? `definition:${definition.id}:${definition.revision ?? 0}` : "";
    const currentArtifactOwner = JSON.stringify([run?.id, run?.revision]);
    if (artifactOwner !== currentArtifactOwner) { artifactPage = undefined; artifactOwner = currentArtifactOwner; artifactRequest++; artifactLoading = false; }
    if (nextOwner !== owner) {
      owner = nextOwner; argsValue = structuredClone(input?.args ?? {}); nodeSettings = structuredClone(input?.nodeSettings ?? {}); workspaceModeValue = workspaceSourceMode = input?.workspaceMode ?? "snapshot"; approvalModeValue = approvalSourceMode = sourceApprovalMode(input);
      parametersSignature = ""; parameterSnapshot = undefined; nodeDirty = false; nodeKey = "";
      if (nodeDialog.open) nodeDialog.close();
      if (processDialog.open) processDialog.close();
      if (parameterDialog.open) parameterDialog.close();
    }
    const template = state.templates.find(item => item.id === state.selectedTemplate);
    const templateKey = JSON.stringify([template?.id, template?.revision]);
    if (controller.canAct && !state.selectedRun && template && templateRequest !== templateKey && (!definition || definition.revision !== template.revision)) {
      templateRequest = templateKey;
      queueMicrotask(() => { if (controller.state.selectedTemplate === template.id && !controller.state.selectedRun) void controller.loadTemplate(template.id); });
    }
    const live = executing();
    if (workspaceSourceMode !== (input?.workspaceMode ?? "snapshot") || !canChangeWorkspaceMode(input)) workspaceModeValue = workspaceSourceMode = input?.workspaceMode ?? "snapshot";
    if (approvalSourceMode !== sourceApprovalMode(input) || live) approvalModeValue = approvalSourceMode = sourceApprovalMode(input);
    const stale = state.connection !== "connected" || state.reconnecting;
    root.dataset.connection = state.connection;
    root.dataset.reconnecting = String(state.reconnecting);
    const boundProject = controller.currentProject;
    const projectOptions = boundProject ? `<option value="${escapeHtml(boundProject.projectId)}" selected>${escapeHtml(boundProject.label)}</option>` : `<option value="">${state.projectsError && !state.projectsError.startsWith("工作流仅在项目聊天") ? "所属项目待确认" : "请从项目聊天打开"}</option>`;
    if (project.innerHTML !== projectOptions) project.innerHTML = projectOptions;
    project.disabled = true;
    project.title = "使用当前项目聊天，不能切换工作流目录";
    element("#wf-project-help").textContent = state.projectsError || (state.projectsBusy ? "正在确认当前聊天所属项目…" : boundProject ? "所属项目固定；跨项目复用请从另一个项目的聊天新建运行。" : "工作流仅在项目聊天中使用，请从项目内打开。");
    element<HTMLButtonElement>("#wf-refresh-projects").disabled = state.connection !== "connected" || state.projectsBusy || state.reconnecting;
    const connectionText = state.reconnecting ? "正在连接并同步…" : ({ offline: "离线预览", connecting: "正在连接…", connected: "已连接宿主", degraded: "连接异常", closed: "面板已关闭" })[state.connection];
    if (element("#wf-connection").textContent !== connectionText) element("#wf-connection").textContent = connectionText;
    const selector = element<HTMLSelectElement>("#wf-template-select");
    const options = workflowSelectOptions(state);
    if (selector.innerHTML !== options) selector.innerHTML = options;
    selector.value = state.selectedRun ? `run:${state.selectedRun}` : state.selectedTemplate ? `template:${state.selectedTemplate}` : "";
    selector.disabled = !controller.canSelectWorkflow || !state.templates.length && !state.runs.length && state.runNextOffset === undefined;
    const notification = element("#wf-notification");
    notification.textContent = failureErrorSummary(state.error || run?.error || ""); notification.hidden = !notification.textContent;
    element<HTMLButtonElement>("#wf-error-details").hidden = !run?.error;
    element<HTMLButtonElement>("#wf-error-details").disabled = stale;
    element<HTMLButtonElement>("#wf-parameters-toggle").disabled = !controller.canAct || !input;
    element<HTMLButtonElement>("#wf-settings-toggle").disabled = state.connection !== "connected" || !controller.projectBound;
    element<HTMLButtonElement>("#wf-history-toggle").disabled = state.connection !== "connected" || !controller.projectBound;
    element<HTMLButtonElement>("#wf-more-toggle").disabled = state.connection === "closed" || state.connection === "connecting" || state.busy;
    const reconnectButton = element<HTMLButtonElement>("#wf-reconnect");
    reconnectButton.hidden = state.connection === "connected" && !state.reconnecting || state.connection === "closed";
    reconnectButton.disabled = state.reconnecting || state.connection === "connecting";
    reconnectButton.textContent = state.reconnecting ? "正在同步…" : "重新连接";
    element<HTMLButtonElement>("#wf-review-toggle").disabled = !run;
    element<HTMLButtonElement>("#wf-save-definition").disabled = !controller.canAct || !input || live || !!run?.deletionPending;
    element<HTMLButtonElement>("#wf-delete-toggle").disabled = !controller.canAct || !input;
    element("#wf-delete-toggle").innerHTML = `<span class="wf-icon" data-icon="trash" aria-hidden="true"></span>${run?.deletionPending ? "重试删除…" : "删除工作流…"}`;
    element<HTMLButtonElement>("#wf-refresh").disabled = state.connection === "closed" || state.reconnecting;
    const stateElement = element("#wf-execution-status");
    const resultFailure = run && resultCheckFailure(run);
    const reviewFailed = run && failureContext(run)?.kind === "review";
    const executionText = run && stale ? "状态待确认" : !controller.projectBound ? "项目待确认" : summary ? state.detailsBusy ? "正在读取详情" : `${executionLabels[summary.execution] ?? summary.execution} · 仅摘要` : run?.deletionPending ? "清理未完成" : reviewFailed ? "改动审查失败" : resultFailure ? "结果检查失败" : run ? executionLabels[run.execution] ?? run.execution : input ? "待开始" : "待选择";
    if (stateElement.textContent !== executionText) stateElement.textContent = executionText;
    stateElement.dataset.tone = stale || run?.deletionPending ? "amber" : tone(run?.execution ?? "draft");
    const action = (name: string, label: string, enabled: boolean, primary = false): string => `<button type="button" data-action="${name}" ${primary ? 'class="wf-primary"' : ""} ${enabled ? "" : "disabled"}><span class="wf-icon" data-icon="${name === "stop" ? "player-stop" : name === "recheck" ? "refresh" : "player-play"}" aria-hidden="true"></span>${label}</button>`;
    const canStart = controller.canAct && !run?.deletionPending && !!input && (!!run || !!activeProject() && !state.projectsError) && !live && run?.application !== "applying";
    const liveRecord = controller.stopTarget ?? run ?? summary;
    const canStop = controller.projectBound && state.connection === "connected" && !state.reconnecting && !state.busy && !!liveRecord && ["preparing", "running"].includes(liveRecord.execution);
    const primaryAction = primaryWorkflowAction(run);
    const actionMarkup = action(primaryAction.action, primaryAction.label, canStart, true) + action("stop", liveRecord?.execution === "stopping" ? "正在停止…" : "停止", canStop);
    if (element("#wf-actions").innerHTML !== actionMarkup) element("#wf-actions").innerHTML = actionMarkup;
    const currentTask = run?.tasks.find(task => task.status === "running" || task.status === "stopping");
    const stage = run?.preparation?.stages.find(value => value.status === "running");
    element("#wf-current-action").textContent = (run && stale ? state.reconnecting ? "正在恢复连接，核对实际进度" : "连接已中断，显示上次读取的进度" : !controller.projectBound ? state.projectsBusy ? "正在确认当前聊天所属项目" : state.projectsError && !state.projectsError.startsWith("工作流仅在项目聊天") ? "无法确认当前聊天所属项目，请查看具体原因" : "请从项目聊天打开 Workflows" : summary ? state.detailsBusy ? "正在读取工作流详情" : "运行详情尚未就绪，请刷新后查看" : run?.deletionPending ? "清理未完成，可从更多操作中重试删除" : reviewFailed ? run!.tasks.every(task => task.status === "completed") ? "改动审查失败，已完成任务保留，可重试审查" : "改动审查失败，部分任务未完成，可继续恢复" : resultFailure ? `${resultFailure.phase ? resultFailure.phase + "：" : ""}结果检查未通过，查看原因后选择重试节点` : run?.execution === "preparing" ? stage?.label ?? "正在准备工作流" : run?.execution === "stopped" ? stopSummary(run.stopReason) : currentTask?.currentActivity?.label ?? currentTask?.label ?? (run?.execution === "failed" ? run.tasks.length ? "工作流执行失败，点击失败节点查看原因" : "启动准备失败，点击准备步骤查看原因" : run?.execution === "completed" ? "工作流执行完成" : input?.meta?.description || definition?.description || input?.meta?.name || "选择工作流，查看执行过程")).slice(0, 160);
    if (!stale && requiresNewLocalPreview(run)) element("#wf-current-action").textContent = "本地检查点无法继续复用，点击“重新检查”创建新预览；现有文件保留。";
    const latestAt = [currentTask?.currentActivity?.endedAt, currentTask?.currentActivity?.startedAt, run?.logs.at(-1)?.at, run?.updatedAt].filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    const observedNow = stale && run && Number.isFinite(Date.parse(run.updatedAt)) ? Date.parse(run.updatedAt) : Date.now();
    const elapsed = elapsedLabel(run?.startedAt ?? run?.preparation?.startedAt, run?.endedAt, observedNow);
    const recent = latestAt && Number.isFinite(Date.parse(latestAt)) ? Math.max(0, Math.floor((Date.now() - Date.parse(latestAt)) / 1000)) : undefined;
    const modeBadge = element("#wf-workspace-mode");
    modeBadge.textContent = input ? workspaceModeLabel(workspaceModeValue, input.allowWrite ?? false) : "";
    modeBadge.hidden = !input;
    modeBadge.title = input ? workspaceModeDescription(workspaceModeValue, input.allowWrite ?? false) : "";
    element("#wf-activity-time").textContent = run ? `${elapsed ? `已运行 ${elapsed} · ` : ""}${live && recent !== undefined ? `最近活动 ${recent < 60 ? `${recent} 秒` : `${Math.floor(recent / 60)} 分钟`}前` : `${run.tasks.filter(task => task.status === "completed").length}/${run.tasks.length} 个任务完成`}` : summary ? `当前状态：${executionLabels[summary.execution] ?? summary.execution}；完整详情尚未就绪` : "任务由 AI 生成，启动后显示实际进度";
    const preparationHtml = run?.preparation?.stages.map(value => `<li data-tone="${value.status === "completed" ? "green" : value.status === "failed" ? "red" : value.status === "running" ? "blue" : "amber"}"><span class="wf-icon${value.status === "running" ? " is-spinning" : ""}" data-icon="${value.status === "running" ? "loader-2" : value.status === "completed" ? "circle-check" : value.status === "failed" ? "alert-circle" : "circle"}" aria-hidden="true"></span><button type="button" id="wf-preparation-${escapeHtml(value.id)}" data-process-scope="workflow" aria-label="${escapeHtml(`查看 ${value.label} 的启动过程`)}">${escapeHtml(value.label)}${value.status === "running" ? ` · ${elapsedLabel(value.startedAt)}` : ""}</button></li>`).join("") ?? "";
    if (element("#wf-preparation").innerHTML !== preparationHtml) {
      const preparationFocus = document.activeElement instanceof HTMLElement && document.activeElement.id.startsWith("wf-preparation-") ? document.activeElement.id : undefined;
      element("#wf-preparation").innerHTML = preparationHtml;
      if (preparationFocus) root.querySelector<HTMLElement>(`#${preparationFocus}`)?.focus({ preventScroll: true });
    }
    const parameterKey = JSON.stringify([owner, parameters()]);
    if (parametersSignature !== parameterKey) {
      parametersSignature = parameterKey;
      try { parameterFields.innerHTML = parameters()?.length ? renderParameterFields(parameters()!, argsValue, live) : '<p class="wf-muted">此工作流无需填写参数。</p>'; }
      catch (error) { parameterFields.textContent = "无法读取参数"; parameterError.textContent = errorMessage(error); parameterError.hidden = false; }
    }
    parameterFields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-parameter]").forEach(value => { value.disabled = !controller.canAct || live || !!run?.deletionPending; });
    for (const option of Array.from(workspaceModeSelect.options)) option.disabled = !!workspaceModeRestriction(input, option.value as WorkspaceMode);
    workspaceModeSelect.value = workspaceModeValue;
    workspaceModeSelect.disabled = !controller.canAct || !input?.allowWrite || !canChangeWorkspaceMode(input);
    approvalModeSelect.value = approvalModeValue;
    approvalModeSelect.disabled = !controller.canAct || !input || live || !!run?.deletionPending || run?.application === "applying";
    element("#wf-approval-mode-help").textContent = approvalModeValue === "auto-review" ? "需要审批的操作交由 Codex 独立审核；拒绝或审核异常会停止当前任务。启动或继续时生效。" : "禁止审批：需要审批的操作会被拒绝。启动或继续时生效。";
    element("#wf-workspace-mode-help").textContent = `${workspaceModeDescription(workspaceModeValue, input?.allowWrite ?? false)}${input && !canChangeWorkspaceMode(input) ? " 工作方式已固定；请从工作流库创建新运行以更改。" : input?.maintenance ? " 维护操作需要 Git 隔离工作区。" : !input?.allowWrite ? " 本地修改需要写入授权，请在对话中让 AI 调整执行范围。" : " 工作方式将在启动后固定。"}`;
    element("#wf-parameter-status").textContent = live ? "运行期间参数固定。" : "保存后用于下次启动；已执行的记录不会被改写。";
    element<HTMLButtonElement>("#wf-save-parameters").disabled = !controller.canAct || live || !!run?.deletionPending;
    element("#wf-execution-scope").textContent = input ? `本工作流范围：${workspaceModeLabel(workspaceModeValue, input.allowWrite ?? false)} · ${input.allowWrite ? workspaceModeValue === "local" ? "允许直接修改当前项目" : "允许在隔离工作区修改文件" : "只读"} · ${input.networkAccess ? "允许联网" : "网络关闭"}${input.allowedMcpServers?.length ? ` · MCP：${input.allowedMcpServers.join("、")}` : ""}${maintenanceProtectedPathsSummary(input.maintenance) ? ` · 命令目录授权：${maintenanceProtectedPathsSummary(input.maintenance)}（仅对应命令）` : ""}。${workspaceModeValue === "local" ? "停止或删除运行不会撤销原项目改动。" : ""}调整执行范围可在对话中告诉 AI。` : "选择工作流后显示已声明的执行范围。";
    const settings = state.settings, models = settings?.models ?? [];
    const signature = JSON.stringify([state.settingsProjectPath, settings?.settings.revision, models]);
    if (signature !== settingsSignature) { settingsSignature = signature; defaultModel.innerHTML = modelSelectOptions(models, settings?.settings.model ?? "", "继承 Codex 配置"); defaultEffort.innerHTML = effortSelectOptions(models, defaultModel.value || settings?.codexDefaults.model, settings?.settings.reasoningEffort ?? "", "继承 Codex 配置"); }
    defaultModel.disabled = defaultEffort.disabled = !controller.canAct || state.settingsBusy || !models.length;
    element<HTMLButtonElement>("#wf-save-settings").disabled = defaultModel.disabled || !!state.settingsError;
    element<HTMLButtonElement>("#wf-refresh-settings").disabled = state.connection !== "connected" || state.settingsBusy;
    element("#wf-settings-error").textContent = state.settingsError; element("#wf-settings-error").hidden = !state.settingsError;
    element("#wf-settings-status").textContent = state.settingsBusy ? "正在读取或保存配置…" : settings?.effectiveDefaults ? `当前默认：${settings.effectiveDefaults.model} · ${settings.effectiveDefaults.reasoningEffort}` : settings?.defaultsStatus.reason ?? "模型目录尚未读取";
    const inherited = inheritedChoice();
    const nodeVersion = JSON.stringify([owner, nodeKey, nodeSettings[nodeKey], inherited, models]);
    if (nodeVersion !== nodeSignature && !nodeDirty) { nodeSignature = nodeVersion; nodeModel.innerHTML = modelSelectOptions(models, nodeSettings[nodeKey]?.model ?? "", `继承上级配置（${inherited.model ?? "未记录"}）`); nodeEffort.innerHTML = effortSelectOptions(models, nodeModel.value || inherited.model, nodeSettings[nodeKey]?.reasoningEffort ?? "", `继承上级配置（${inherited.reasoningEffort ?? "未记录"}）`); }
    nodeModel.disabled = nodeEffort.disabled = !controller.canAct || state.settingsBusy || !models.length || live || !nodeKey || !!run?.deletionPending;
    element<HTMLButtonElement>("#wf-save-node-settings").disabled = nodeModel.disabled;
    element("#wf-node-settings-status").textContent = nodeNotice || state.settingsError || (live ? "执行期间配置固定。" : "保存后用于下次启动。");
    element<HTMLButtonElement>("#wf-refresh-node-settings").hidden = !!models.length && !state.settingsError;
    const graphInput = summary ? undefined : run ? { ...run, stale, nodeSettings, executionSettings: defaultChoice() } : input?.meta ? { meta: input.meta, execution: "draft" as const, tasks: [], logs: [], nodeSettings, executionSettings: defaultChoice() } : undefined;
    const graph = renderWorkflowGraph(graphInput, state.task, observedNow);
    if (graph !== lastGraph || owner !== lastGraphOwner) {
      const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
      const focusedNode = focused?.dataset.nodeSettings, focusedTask = focused?.dataset.task, focusedPhase = focused?.dataset.phase, focusedScope = focused?.dataset.processScope;
      const graphDetails = owner === lastGraphOwner ? new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>("details[data-graph-detail]")).map(value => [value.dataset.graphDetail, value.open])) : new Map<string | undefined, boolean>();
      const scroller = root.querySelector<HTMLElement>(".wf-graph-scroll");
      const position = { left: owner === lastGraphOwner ? scroller?.scrollLeft ?? 0 : 0, top: scroller?.scrollTop ?? 0 };
      element("#wf-panel-overview").innerHTML = graph; lastGraph = graph; lastGraphOwner = owner;
      root.querySelectorAll<HTMLDetailsElement>("details[data-graph-detail]").forEach(value => { value.open = graphDetails.get(value.dataset.graphDetail) ?? false; });
      const next = root.querySelector<HTMLElement>(".wf-graph-scroll");
      if (next) { next.scrollLeft = position.left; next.scrollTop = position.top; }
      if (focusedNode || focusedTask || focusedPhase || focusedScope) Array.from(root.querySelectorAll<HTMLElement>("button[data-node-settings],button[data-task],button[data-phase],button[data-process-scope]")).find(value => focusedNode && value.dataset.nodeSettings === focusedNode || focusedTask && value.dataset.task === focusedTask || focusedPhase && value.dataset.phase === focusedPhase || focusedScope && value.dataset.processScope === focusedScope)?.focus({ preventScroll: true });
    }
    element("#wf-graph-viewport").style.setProperty("--wf-graph-zoom", String(zoom));
    element("#wf-zoom-value").textContent = `${Math.round(zoom * 100)}%`;
    for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-zoom]"))) control.disabled = !owner || control.dataset.zoom === "in" && zoom >= 1.75 || control.dataset.zoom === "out" && zoom <= .5;
    if (historyDialog.open) {
      const historyFocus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.historyRun ?? document.activeElement.dataset.historyDelete : undefined;
      const historyDeleteFocus = document.activeElement instanceof HTMLElement && !!document.activeElement.dataset.historyDelete;
      element("#wf-history-context").textContent = activeProject() ? `${activeProject()!.label} 的运行记录` : "所有可见运行记录";
      const historyScroll = historyDialog.scrollTop;
      element("#wf-history-list").innerHTML = state.runs.length ? state.runs.map(item => `<div class="wf-history-row"><button type="button" data-history-run="${escapeHtml(item.id)}"><strong>${escapeHtml(item.meta.name)}</strong><small>${escapeHtml(executionLabels[item.execution] ?? item.execution)} · ${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))}</small></button><button type="button" data-history-delete="${escapeHtml(item.id)}" class="wf-icon-button wf-danger" aria-label="${escapeHtml(`删除 ${item.meta.name} 的此条运行记录`)}"><span class="wf-icon" data-icon="trash" aria-hidden="true"></span></button></div>`).join("") : '<p class="wf-empty">暂无运行记录</p>';
      element("#wf-history-list").insertAdjacentHTML("beforeend", `<p class="wf-muted">已载入 ${state.runs.length} / 共 ${state.runTotal ?? state.runs.length} 条运行</p>${state.runNextOffset !== undefined ? `<button type="button" data-load-runs ${state.historyBusy ? "disabled" : ""}>${state.historyBusy ? "正在加载…" : "加载更多运行"}</button>` : ""}`);
      historyDialog.scrollTop = historyScroll;
      if (historyFocus) Array.from(element("#wf-history-list").querySelectorAll<HTMLElement>("[data-history-run],[data-history-delete]")).find(value => historyDeleteFocus ? value.dataset.historyDelete === historyFocus : value.dataset.historyRun === historyFocus)?.focus({ preventScroll: true });
    }
    if (reviewDialog.open) {
      const nextReview = JSON.stringify([run?.id, run?.revision, run?.progressSequence, run?.execution, run?.review, run?.application, run?.diff?.fingerprint, run?.diff?.previewTruncated, run?.diff?.totalBytes, run?.diff?.contentSha256]);
      if (nextReview !== reviewSignature) {
        reviewSignature = nextReview;
        element("#wf-review-body").innerHTML = run ? `${run.result !== undefined ? `<div class="wf-process-result">${escapeHtml(formatted(run.result))}</div>` : ""}${renderWorkflowDiff(run, artifactPage)}` : '<p class="wf-muted">暂无运行记录</p>';
      }
      const apply = element<HTMLButtonElement>("#wf-apply-changes");
      apply.hidden = run?.workspaceMode === "local";
      apply.disabled = !controller.canAct || !run || !canApply(run, "diff");
      apply.textContent = run?.application === "partial" ? "重试未完成步骤" : run?.diff?.previewTruncated ? "应用完整变更" : "应用改动";
    }
    const cancelTask = element<HTMLButtonElement>("#wf-cancel-task");
    const selectedProcessTask = run?.tasks.find(task => task.id === processTarget?.taskId);
    cancelTask.hidden = !selectedProcessTask || run?.execution !== "running" || !["queued", "running"].includes(selectedProcessTask.status);
    cancelTask.disabled = !controller.canAct || cancelTask.hidden;
    const retryTask = element<HTMLButtonElement>("#wf-retry-task");
    retryTask.hidden = !selectedProcessTask || !run || !["stopped", "failed"].includes(run.execution);
    const unsafeRetry = selectedProcessTask && run?.tasks.some(task => task.index >= selectedProcessTask.index && Object.hasOwn(task.options, "operation") && task.attempts.some(attempt => attempt.startedAt) && run.maintenance?.steps.find(step => step.id === (task.options.operation as { id?: string }).id)?.idempotent !== true);
    retryTask.disabled = !controller.canAct || retryTask.hidden || Boolean(unsafeRetry);
    retryTask.title = unsafeRetry ? "后续有已开始且未声明幂等的命令；请先核对实际效果并重新生成计划。" : "保留前面结果，重新执行此节点及后续节点。";
    const processSettings = element<HTMLButtonElement>("#wf-process-node-settings");
    processSettings.hidden = !selectedProcessTask || Object.hasOwn(selectedProcessTask.options, "operation") || !selectedProcessTask.configurationTarget;
    processSettings.disabled = !controller.canAct || live || !!run?.deletionPending;
    if (selectedProcessTask) processSettings.dataset.nodeSettings = `task:${selectedProcessTask.index}`;
    const nextProcess = JSON.stringify([run?.revision, run?.progressSequence, processTarget]);
    if (processDialog.open && nextProcess !== processSignature) { processSignature = nextProcess; fetchProcess(); if (developerRequested && developerLogs.open) fetchProcess(true); }
    if (state.connection === "closed") for (const dialog of Array.from(root.querySelectorAll<HTMLDialogElement>("dialog[open]"))) dialog.close();
  };
  for (const dialog of Array.from(root.querySelectorAll<HTMLDialogElement>("dialog"))) {
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      if (dialog === parameterDialog && !parametersSaved && parameterSnapshot !== undefined) { argsValue = parameterSnapshot; workspaceModeValue = workspaceModeSnapshot; approvalModeValue = approvalSnapshotSource === approvalSourceMode ? approvalModeSnapshot : approvalSourceMode; parametersSignature = ""; render(); }
      if (dialog === nodeDialog) { nodeDirty = false; nodeSignature = ""; }
      if (dialog === settingsDialog) { settingsSignature = ""; render(); }
      if (dialog === processDialog) { processTarget = undefined; processReader.close(); developerLogs.open = false; developerRequested = false; element("#wf-process-developer").textContent = ""; }
      if (dialog === deleteDialog) { deletionRequest++; deletionPreview = undefined; deletionLoading = false; }
      restoreFocus(dialog);
    });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  element("#wf-more-toggle").addEventListener("click", () => { menu.hidden = !menu.hidden; element("#wf-more-toggle").setAttribute("aria-expanded", String(!menu.hidden)); if (!menu.hidden) menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); });
  root.addEventListener("keydown", event => {
    if (menu.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); element("#wf-more-toggle").focus(); return; }
    if (event.key === "Tab") { closeMenu(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index]?.focus();
    }
  });
  document.addEventListener("pointerdown", event => { if (event.target instanceof Node && !element(".wf-more-wrap").contains(event.target)) closeMenu(); });
  project.addEventListener("change", () => { void controller.selectProject(project.value); });
  element("#wf-refresh-projects").addEventListener("click", () => { void controller.refreshProjects(); });
  element<HTMLSelectElement>("#wf-template-select").addEventListener("change", event => { const value = (event.target as HTMLSelectElement).value; templateRequest = ""; void controller.selectWorkflow(value).finally(render); });
  element("#wf-parameters-toggle").addEventListener("click", event => { parameterSnapshot = structuredClone(argsValue); workspaceModeSnapshot = workspaceModeValue; approvalModeSnapshot = approvalModeValue; approvalSnapshotSource = approvalSourceMode; parametersSaved = false; parameterError.hidden = true; openDialog(parameterDialog, event.currentTarget as HTMLElement); });
  element<HTMLFormElement>("#wf-parameters-form").addEventListener("submit", event => {
    event.preventDefault();
    try { const input = readInput(); argsValue = input.args; workspaceModeValue = input.workspaceMode ?? "snapshot"; approvalModeValue = input.approvalMode ?? approvalModeValue; parametersSaved = true; parameterError.hidden = true; parameterDialog.close(); controller.state.error = ""; render(); }
    catch (error) { parameterError.textContent = errorMessage(error); parameterError.hidden = false; }
  });
  parameterFields.addEventListener("input", () => { parameterError.hidden = true; });
  workspaceModeSelect.addEventListener("change", () => {
    if (!controller.canAct || !source()?.allowWrite || !canChangeWorkspaceMode(source())) return;
    if (!["snapshot", "git-worktree", "local"].includes(workspaceModeSelect.value)) return;
    const mode = workspaceModeSelect.value as WorkspaceMode;
    const restriction = workspaceModeRestriction(source(), mode);
    if (restriction) { parameterError.textContent = restriction; parameterError.hidden = false; render(); return; }
    workspaceModeValue = mode;
    parameterError.hidden = true; render();
  });
  approvalModeSelect.addEventListener("change", () => {
    if (approvalModeSelect.disabled || !["auto-review", "never"].includes(approvalModeSelect.value)) return;
    approvalModeValue = approvalModeSelect.value as ApprovalMode; parameterError.hidden = true; render();
  });
  element("#wf-settings-toggle").addEventListener("click", event => { openDialog(settingsDialog, event.currentTarget as HTMLElement); if (!controller.state.settings || controller.state.settingsError) void controller.refreshExecutionSettings(controller.selected?.projectPath ?? activeProject()?.path); });
  element("#wf-refresh-settings").addEventListener("click", () => { settingsSignature = ""; void controller.refreshExecutionSettings(); });
  defaultModel.addEventListener("change", () => { defaultEffort.innerHTML = effortSelectOptions(controller.state.settings?.models ?? [], defaultModel.value || controller.state.settings?.codexDefaults.model, defaultEffort.value, "继承 Codex 配置"); controller.state.settingsError = ""; });
  element<HTMLFormElement>("#wf-settings-form").addEventListener("submit", event => {
    event.preventDefault();
    const choice = { ...(defaultModel.value ? { model: defaultModel.value } : {}), ...(defaultEffort.value ? { reasoningEffort: defaultEffort.value } : {}) };
    try { validateChoice(choice, controller.state.settings?.codexDefaults ?? {}); void controller.saveExecutionSettings(choice).then(() => { if (!controller.state.settingsError) settingsDialog.close(); }); }
    catch (error) { controller.state.settingsError = errorMessage(error); render(); }
  });
  element("#wf-history-toggle").addEventListener("click", event => { openDialog(historyDialog, event.currentTarget as HTMLElement); render(); });
  element("#wf-review-toggle").addEventListener("click", event => { controller.state.tab = "diff"; openDialog(reviewDialog, event.currentTarget as HTMLElement); render(); });
  element("#wf-apply-changes").addEventListener("click", () => { controller.state.tab = "diff"; void controller.perform("apply", true); });
  element("#wf-refresh").addEventListener("click", () => { closeMenu(); void controller.reconnect(); });
  element("#wf-reconnect").addEventListener("click", () => { void controller.reconnect(); });
  document.addEventListener("visibilitychange", () => { void controller.visibilityChanged(document.visibilityState === "visible"); });
  element("#wf-save-definition").addEventListener("click", () => {
    closeMenu();
    void (async () => {
      try {
        const input = readInput(), definition = currentDefinition();
        const sourceDefinition = controller.selected?.sourceDefinition;
        const known = controller.state.templates.find(item => item.id === sourceDefinition?.id);
        const revision = definition?.source === "saved" ? definition.revision : known?.source === "saved" ? known.revision : undefined;
        const { projectPath: _path, sourceDefinition: _source, ...value } = input;
        const saved = await controller.saveTemplate(value, revision);
        if (saved) { controller.state.error = ""; element("#wf-notification").textContent = `已保存到工作流库：${saved.name}`; element("#wf-notification").hidden = false; }
      } catch (error) { controller.state.error = `保存失败：${errorMessage(error)}`; render(); }
    })();
  });
  element("#wf-delete-toggle").addEventListener("click", event => {
    configureDeletion(); openDialog(deleteDialog, event.currentTarget as HTMLElement); void previewDeletion();
  });
  root.querySelectorAll<HTMLInputElement>('input[name="wf-delete-scope"]').forEach(value => value.addEventListener("change", () => { element("#wf-delete-legacy").hidden = value.value !== "template"; void previewDeletion(); }));
  element("#wf-delete-legacy-list").addEventListener("change", () => { void previewDeletion(); });
  element("#wf-confirm-delete").addEventListener("click", () => {
    if (!controller.canAct || deletionLoading || !deletionPreview?.canDelete) return;
    const preview = deletionPreview, request = ++deletionRequest;
    deletionLoading = true; element<HTMLButtonElement>("#wf-confirm-delete").disabled = true;
    void (async () => {
      try {
        const data = await controller.request("workflow_delete", { ...preview.target, fingerprint: preview.fingerprint });
        const deletion = data.deletion as { deleted?: boolean; partial?: boolean; deletedRunIds?: string[]; remaining?: unknown; blocked?: Array<{ message: string }> } | undefined;
        if (!deletion || typeof deletion.deleted !== "boolean") throw new Error("宿主未返回有效的删除结果");
        if (!deletion.deleted || deletion.partial) throw new Error(deletion.blocked?.map(item => item.message).join("；") || "清理尚未完成，记录已保留。请核对剩余内容后重试。");
        if (deletion.deletedRunIds?.includes(controller.state.selectedRun ?? "") || preview.target.kind === "definition" && preview.target.id === controller.state.selectedTemplate) controller.selectTemplate(undefined);
        if (request === deletionRequest) deleteDialog.close(); await Promise.all([controller.refresh(), controller.refreshTemplates()]);
      } catch (error) { if (request === deletionRequest) { element("#wf-delete-error").textContent = errorMessage(error); element("#wf-delete-error").hidden = false; deletionPreview = undefined; element("#wf-delete-preview").insertAdjacentHTML("beforeend", '<button type="button" id="wf-retry-delete-preview">重新检查</button>'); } }
      finally { if (request === deletionRequest) { deletionLoading = false; element<HTMLButtonElement>("#wf-confirm-delete").disabled = true; } }
    })();
  });
  element("#wf-cancel-task").addEventListener("click", () => { if (processTarget?.taskId) void controller.perform("cancel", true, processTarget.taskId); });
  element("#wf-error-details").addEventListener("click", event => openFailureProcess(event.currentTarget as HTMLElement));
  element("#wf-retry-task").addEventListener("click", () => { if (processTarget?.taskId) { const taskId = processTarget.taskId; processDialog.close(); void controller.perform("resume", true, taskId, approvalModeValue); } });
  developerLogs.addEventListener("toggle", () => { if (developerLogs.open) { if (!developerRequested) element("#wf-process-developer").textContent = "正在读取开发日志…"; developerRequested = true; fetchProcess(true); } else processReader.cancel("developer"); });
  nodeModel.addEventListener("change", () => { nodeDirty = true; nodeEffort.innerHTML = effortSelectOptions(controller.state.settings?.models ?? [], nodeModel.value || inheritedChoice().model, nodeEffort.value, "继承上级配置"); nodeNotice = ""; });
  nodeEffort.addEventListener("change", () => { nodeDirty = true; nodeNotice = ""; });
  element("#wf-close-node-settings").addEventListener("click", () => nodeDialog.close());
  element("#wf-cancel-node-settings").addEventListener("click", () => nodeDialog.close());
  element("#wf-refresh-node-settings").addEventListener("click", () => { void controller.refreshExecutionSettings(); });
  element<HTMLFormElement>("#wf-node-settings-form").addEventListener("submit", event => {
    event.preventDefault();
    try { const choice = { ...(nodeModel.value ? { model: nodeModel.value } : {}), ...(nodeEffort.value ? { reasoningEffort: nodeEffort.value } : {}) }; validateChoice(choice, inheritedChoice()); const bound = bindObservedNodeChoice(nodeKey, choice, controller.selected?.tasks ?? []); if (choice.model || choice.reasoningEffort) nodeSettings[nodeKey] = bound; else delete nodeSettings[nodeKey]; nodeDirty = false; nodeDialog.close(); render(); }
    catch (error) { nodeNotice = errorMessage(error); render(); }
  });
  root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : undefined;
    const processRetry = target?.closest<HTMLButtonElement>("[data-retry-process]");
    if (processRetry) { fetchProcess(processRetry.dataset.retryProcess === "developer", true); return; }
    const artifactButton = target?.closest<HTMLButtonElement>("[data-artifact-offset]");
    if (artifactButton && !artifactButton.disabled) { void loadArtifactPage(Number(artifactButton.dataset.artifactOffset)); return; }
    if (target?.closest("[data-load-runs]")) { void controller.loadMoreRuns(); return; }
    const close = target?.closest<HTMLElement>("[data-close-dialog]");
    if (close) { close.closest<HTMLDialogElement>("dialog")?.close(); return; }
    const settingsButton = target?.closest<HTMLButtonElement>("[data-node-settings]");
    if (settingsButton && !settingsButton.disabled) {
      const processReturn = settingsButton.id === "wf-process-node-settings" ? returns.get(processDialog) : undefined;
      if (processReturn) processDialog.close();
      nodeKey = settingsButton.dataset.nodeSettings!; nodeNotice = ""; nodeDirty = false; nodeSignature = "";
      try { if (nodeKey.startsWith("task:")) bindObservedNodeChoice(nodeKey, {}, controller.selected?.tasks ?? []); element("#wf-node-settings-target").textContent = nodeKey.startsWith("phase:") ? `阶段：${nodeKey.slice(6)}` : controller.selected?.tasks.find(task => `task:${task.index}` === nodeKey)?.label || "任务节点"; render(); openDialog(nodeDialog, settingsButton); if (processReturn) returns.set(nodeDialog, processReturn); }
      catch (error) { controller.state.error = errorMessage(error); render(); }
      return;
    }
    const zoomButton = target?.closest<HTMLButtonElement>("[data-zoom]");
    if (zoomButton && !zoomButton.disabled) {
      const direction = zoomButton.dataset.zoom;
      if (direction === "fit") { const track = root.querySelector<HTMLElement>(".wf-graph-track"), scroll = root.querySelector<HTMLElement>(".wf-graph-scroll"); zoom = track && scroll ? Math.max(.5, Math.min(1, (scroll.clientWidth - 48) / (track.scrollWidth * zoom))) : 1; }
      else zoom = direction === "reset" ? 1 : Math.max(.5, Math.min(1.75, Math.round((zoom + (direction === "in" ? .25 : -.25)) * 100) / 100));
      render(); return;
    }
    if (target?.closest("summary")?.parentElement?.matches("details[data-graph-detail]")) return;
    const taskButton = target?.closest<HTMLElement>("[data-task],[data-phase],[data-phase-container],[data-process-scope]");
    if (taskButton && controller.selected) {
      const failure = resultCheckFailure(controller.selected);
      if (!taskButton.dataset.task && failure && (failure.phase && (taskButton.dataset.phase ?? taskButton.dataset.phaseContainer) === failure.phase || taskButton.dataset.processScope)) { openFailureProcess(taskButton); return; }
      controller.state.task = taskButton.dataset.task; processTarget = { id: controller.selected.id, ...(taskButton.dataset.task ? { taskId: taskButton.dataset.task } : taskButton.dataset.processScope ? { scope: taskButton.dataset.processScope as "workflow" | "unphased" } : { phase: taskButton.dataset.phase ?? taskButton.dataset.phaseContainer! }) }; processReader.open(processTarget); processSignature = ""; developerRequested = false; developerLogs.open = false; element("#wf-process-title").textContent = "节点过程"; element("#wf-process-body").textContent = "正在读取简要过程…"; openDialog(processDialog, taskButton); render(); return;
    }
    const historyRun = target?.closest<HTMLButtonElement>("[data-history-run]");
    if (historyRun) { historyDialog.close(); void controller.select(historyRun.dataset.historyRun!); return; }
    const historyDelete = target?.closest<HTMLButtonElement>("[data-history-delete]");
    if (historyDelete) { historyDialog.close(); void controller.select(historyDelete.dataset.historyDelete!).then(() => { configureDeletion(); openDialog(deleteDialog, element("#wf-history-toggle")); void previewDeletion(); }); return; }
    if (target?.closest("#wf-retry-delete-preview")) { void previewDeletion(); return; }
    const stopForDeletion = target?.closest<HTMLButtonElement>("#wf-stop-for-delete");
    if (stopForDeletion && deletionPreview && !deletionLoading) {
      stopForDeletion.disabled = true; stopForDeletion.textContent = "正在等待关联进程退出…";
      const ids = [...new Set(deletionPreview.blocked.filter(block => block.runId && ["active", "locked"].includes(block.code) && controller.state.runs.find(run => run.id === block.runId)?.application !== "applying").map(block => block.runId!))];
      void (async () => { try { for (const id of ids) { const current = parseRun((await controller.request("workflow_get_run", { id })).run); if (current.application === "applying") continue; const updated = parseRun((await controller.request("workflow_stop", { id })).run); controller.state.runs = controller.state.runs.map(run => run.id === updated.id ? updated : run); } await controller.refresh(); await previewDeletion(); } catch (error) { element("#wf-delete-error").textContent = errorMessage(error); element("#wf-delete-error").hidden = false; stopForDeletion.disabled = false; stopForDeletion.textContent = "停止关联运行并重新检查"; } })();
      return;
    }
    const action = target?.closest<HTMLButtonElement>("[data-action]");
    if (!action || action.disabled) return;
    if (action.dataset.action === "stop") { void controller.perform("stop", true); return; }
    if (action.dataset.action === "inspect-failure") { openFailureProcess(action); return; }
    if (action.dataset.action === "retry-review") { void controller.perform("resume", true, undefined, approvalModeValue); return; }
    if (action.dataset.action === "recheck") { void controller.recheckFromCurrent(approvalModeValue); return; }
    if (action.dataset.action === "start") {
      try { const input = readInput(); argsValue = input.args; parameterError.hidden = true; void controller.startWithInput(input); }
      catch (error) { parameterSnapshot = structuredClone(argsValue); workspaceModeSnapshot = workspaceModeValue; approvalModeSnapshot = approvalModeValue; approvalSnapshotSource = approvalSourceMode; parametersSaved = false; parameterError.textContent = errorMessage(error); parameterError.hidden = false; openDialog(parameterDialog, element("#wf-parameters-toggle")); }
    }
  });
  render();
  return controller;
}
