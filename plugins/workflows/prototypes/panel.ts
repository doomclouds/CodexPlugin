import { renderWorkflowGraph } from "./panel-graph.ts";
import { readParameters, renderParameterFields } from "./panel-parameters.ts";
import type { WorkflowParameter } from "./panel-parameters.ts";

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

export interface WorkflowAttempt {
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

export interface MaintenancePlan {
  steps: Array<{ id: string; command: string[]; networkAccess?: boolean; timeoutMs?: number; retries?: number; idempotent?: boolean }>;
  activation?: { serverName: string; command: string; args: string[] };
}

export interface WorkflowRun {
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
  workspaceMode?: "snapshot" | "git-worktree";
  maintenance?: MaintenancePlan;
  nodeSettings?: NodeSettings;
  executionSettings?: ExecutionSettings;
  maintenanceReview?: unknown;
  activation?: { status: "pending_restart" | "verified" | "failed"; serverName: string; [key: string]: unknown };
  execution: "draft" | "running" | "stopping" | "stopped" | "completed" | "failed";
  review: "unavailable" | "pending" | "ready";
  application: "none" | "applying" | "applied" | "partial" | "conflict" | "failed";
  error?: string;
  result?: unknown;
  tasks: WorkflowTask[];
  logs: Array<{ at: string; level: "info" | "error"; message: string; taskId?: string }>;
  diff?: { text: string; files: Array<{ path: string; status: string }>; fingerprint: string; conflicts?: string[] };
  limits: { maxReadWorkers: number; maxCalls: number; timeoutMs: number; maxTokens: number };
  workspacePath?: string;
}

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
  workspaceMode?: "snapshot" | "git-worktree";
  maintenance?: MaintenancePlan;
  nodeSettings?: NodeSettings;
  limits?: WorkflowRun["limits"];
}

export type PanelTab = "overview" | "tasks" | "diff" | "logs";
export type UserAction = "start" | "resume" | "stop" | "apply" | "cancel";
export interface WorkflowInput { projectPath: string; script: string; args: unknown; allowWrite: boolean; networkAccess?: boolean; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; workspaceMode?: "snapshot" | "git-worktree"; maintenance?: MaintenancePlan; nodeSettings?: NodeSettings; limits?: WorkflowRun["limits"] }
export interface PanelState {
  connection: "offline" | "connecting" | "connected" | "degraded" | "closed";
  runs: WorkflowRun[];
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

const executionLabels: Record<string, string> = { draft: "待开始", running: "运行中", stopping: "正在停止", stopped: "已停止", completed: "执行已完成", failed: "执行失败" };
const taskLabels: Record<string, string> = { queued: "等待中", running: "运行中", stopping: "正在停止", interrupted: "已中断", completed: "已完成", failed: "失败" };
const applicationLabels: Record<string, string> = { none: "改动未应用", applying: "正在应用", applied: "已应用", partial: "部分改动已应用，等待重试", conflict: "应用冲突", failed: "应用失败" };
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export interface HostStyleEffects {
  theme: (theme: "light" | "dark") => void;
  variables: (variables: Record<string, string | undefined>) => void;
  fonts: (css: string) => void;
}

// The pinned SDK exposes separate theme, variable and font helpers.
export function applyPanelHostStyles(context: Record<string, unknown>, effects: HostStyleEffects): void {
  if (context.theme === "light" || context.theme === "dark") effects.theme(context.theme);
  const styles = context.styles as { variables?: Record<string, string | undefined>; css?: { fonts?: string } } | undefined;
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

export function canApply(run: WorkflowRun, tab: PanelTab): boolean {
  return tab === "diff" && run.execution === "completed" && (!!run.diff?.files.length || run.maintenanceReview !== undefined || run.activation !== undefined) && ["none", "partial", "conflict", "failed"].includes(run.application);
}

export function partialApplicationMessage(run: WorkflowRun): string {
  if (run.application !== "partial") return "";
  return run.activation?.status === "failed"
    ? "仓库改动已应用，激活失败。重试仅处理激活，不重复应用仓库改动。"
    : "部分改动已应用，子模块工作区仍需核验与补齐。重试仅处理未完成步骤，请先核对实际结果。";
}

// Every timer reads the server; no timer invents execution state.
export class WorkflowPanelController {
  readonly state: PanelState = { connection: "offline", runs: [], templates: [], templatesLoaded: false, selectedTemplate: undefined, selectedRun: undefined, tab: "overview", task: undefined, busy: false, error: "", projectPath: "", settingsProjectPath: "", settingsBusy: false, settingsError: "" };
  private readonly callTool: ToolCaller;
  private readonly changed: () => void;
  private readonly every: (callback: () => void, milliseconds: number) => () => void;
  private timers: Array<() => void> = [];
  private leaseId: string | undefined;
  private ownedRuns = new Set<string>();
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private polling = false;
  private leasing = false;
  private definitionSelected = false;
  private templateRequest = 0;
  private settingsRequest = 0;

  constructor(callTool: ToolCaller, changed: () => void = () => {}, every = (callback: () => void, milliseconds: number): (() => void) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  }) {
    this.callTool = callTool;
    this.changed = changed;
    this.every = every;
  }

  get selected(): WorkflowRun | undefined { return this.state.runs.find(run => run.id === this.state.selectedRun); }
  get canAct(): boolean { return this.state.connection === "connected" && !this.state.busy && !this.closing; }

  setProjectPath(projectPath: string): void {
    if (!this.state.projectPath && projectPath) { this.state.projectPath = projectPath; this.changed(); if (this.state.connection === "connected") void this.refreshExecutionSettings(projectPath); }
  }

  connecting(): void { this.state.connection = "connecting"; this.changed(); }
  disconnected(error: unknown): void {
    if (this.closing) return;
    this.state.connection = "degraded";
    this.state.error = `宿主连接中断：${errorMessage(error)}。请刷新或重新打开面板；运行状态以服务端为准。`;
    this.changed();
  }

  async connected(): Promise<void> {
    if (this.closing) return;
    this.state.connection = "connected";
    await this.heartbeat();
    if (this.closing) return;
    this.timers.push(this.every(() => { void this.heartbeat(); }, 5000));
    this.timers.push(this.every(() => { void this.refresh(); }, 2000));
    await Promise.all([this.refresh(), this.refreshTemplates()]);
    if (!this.closing) await this.refreshExecutionSettings();
  }

  private async request(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return toolPayload(await this.callTool(name, args));
  }

  private replace(run: WorkflowRun): void {
    const index = this.state.runs.findIndex(existing => existing.id === run.id);
    if (index < 0) this.state.runs.unshift(run);
    else if (this.state.runs[index]!.revision <= run.revision) this.state.runs[index] = run;
    this.changed();
  }

  receive(response: ToolResponse): void {
    try {
      const data = toolPayload(response);
      if (data.run) {
        const run = parseRun(data.run);
        this.definitionSelected = false;
        this.state.selectedRun = run.id;
        this.replace(run);
        this.setProjectPath(run.projectPath);
      } else if (typeof data.projectPath === "string") this.setProjectPath(data.projectPath);
      this.changed();
    } catch (error) { this.state.error = errorMessage(error); this.changed(); }
  }

  async heartbeat(): Promise<void> {
    if (this.closing || this.leasing) return;
    this.leasing = true;
    try {
      const data = await this.request("workflow_panel_lease", this.leaseId ? { leaseId: this.leaseId } : {});
      if (typeof data.leaseId !== "string") throw new Error("宿主未返回有效的面板租约");
      if (this.closing) { await this.request("workflow_panel_lease", { leaseId: data.leaseId, release: true }); return; }
      this.leaseId = data.leaseId;
      this.state.connection = "connected";
    } catch (error) { this.disconnected(error); }
    finally { this.leasing = false; this.changed(); }
  }

  async refresh(): Promise<void> {
    if (this.closing || this.polling || this.state.connection === "offline" || this.state.connection === "connecting") return;
    this.polling = true;
    const knownRuns = new Set(this.state.runs.map(run => run.id));
    try {
      const data = await this.request("workflow_list_runs", {});
      if (this.closing) return;
      if (!Array.isArray(data.runs)) throw new Error("宿主未返回运行列表");
      const runs = data.runs.map(parseRun);
      // Keep the newer response when polling overlaps an explicit action.
      const createdDuringPoll = this.state.runs.filter(run => !knownRuns.has(run.id) && !runs.some(item => item.id === run.id));
      this.state.runs = [...createdDuringPoll, ...runs.map(run => {
        const existing = this.state.runs.find(item => item.id === run.id);
        return existing && existing.revision > run.revision ? existing : run;
      })];
      if (!this.definitionSelected && !this.state.runs.some(run => run.id === this.state.selectedRun)) this.state.selectedRun = this.state.runs[0]?.id;
      if (this.state.error.startsWith("宿主连接中断：")) this.state.error = "";
      this.changed();
    } catch (error) { this.disconnected(error); }
    finally { this.polling = false; }
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
    } catch (error) { this.state.error = `读取工作流库失败：${errorMessage(error)}`; }
    finally { this.changed(); }
  }

  async refreshExecutionSettings(projectPath = this.selected?.projectPath ?? this.state.projectPath): Promise<void> {
    if (this.closing || this.state.connection !== "connected") return;
    const request = ++this.settingsRequest;
    this.state.settingsBusy = true;
    this.state.settingsError = "";
    this.changed();
    try {
      const settings = executionSettingsPayload(await this.request("workflow_get_execution_settings", projectPath ? { projectPath } : {}));
      if (this.closing || request !== this.settingsRequest) return;
      this.state.settings = settings;
      this.state.settingsProjectPath = projectPath;
    } catch (error) {
      if (!this.closing && request === this.settingsRequest) this.state.settingsError = `读取执行设置失败：${errorMessage(error)}。可以刷新设置后重试。`;
    } finally { if (request === this.settingsRequest) this.state.settingsBusy = false; this.changed(); }
  }

  async saveExecutionSettings(choice: ExecutionChoice, projectPath = this.selected?.projectPath ?? this.state.projectPath): Promise<void> {
    if (!this.canAct || this.state.settingsBusy || !this.state.settings) return;
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
    if (this.selected && ["running", "stopping"].includes(this.selected.execution)) return;
    this.definitionSelected = true;
    this.templateRequest++;
    this.state.selectedTemplate = id;
    this.state.selectedRun = undefined;
    this.state.task = undefined;
    this.state.tab = "overview";
    if (this.state.definition?.id !== id) delete this.state.definition;
    this.changed();
  }

  async saveTemplate(input: Pick<WorkflowInput, "script" | "args" | "allowWrite" | "limits" | "networkAccess" | "allowedMcpServers" | "allowedMcpTools" | "workspaceMode" | "maintenance" | "nodeSettings">, revision?: number): Promise<TemplateSummary | undefined> {
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
    this.definitionSelected = false;
    this.state.selectedRun = id;
    this.state.task = undefined;
    this.state.tab = "overview";
    this.changed();
    try {
      const run = parseRun((await this.request("workflow_get_run", { id })).run);
      if (!this.closing && this.state.selectedRun === id) this.replace(run);
    } catch (error) { if (!this.closing && this.state.selectedRun === id) { this.state.error = errorMessage(error); this.changed(); } }
  }

  async save(input: WorkflowInput, edit?: { id: string; revision: number }): Promise<WorkflowRun | undefined> {
    if (!this.canAct) return undefined;
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const args: Record<string, unknown> = edit ? { id: edit.id, revision: edit.revision, script: input.script, args: input.args, allowWrite: input.allowWrite, ...(input.networkAccess !== undefined ? { networkAccess: input.networkAccess } : {}), ...(input.allowedMcpServers ? { allowedMcpServers: input.allowedMcpServers } : {}), ...(input.allowedMcpTools ? { allowedMcpTools: input.allowedMcpTools } : {}), ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}), ...(input.maintenance ? { maintenance: input.maintenance } : {}), ...(input.nodeSettings ? { nodeSettings: input.nodeSettings } : {}) } : { ...input };
      const run = parseRun((await this.request(edit ? "workflow_update" : "workflow_preview", args)).run);
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
    if (current && ["running", "stopping"].includes(current.execution)) return;
    const scope = (value: WorkflowInput | WorkflowRun) => ({ projectPath: value.projectPath, script: value.script, args: value.args, allowWrite: value.allowWrite, networkAccess: value.networkAccess ?? false, allowedMcpServers: value.allowedMcpServers ?? [], allowedMcpTools: value.allowedMcpTools ?? {}, workspaceMode: value.workspaceMode ?? "snapshot", maintenance: value.maintenance, nodeSettings: value.nodeSettings ?? {} });
    const sameLimits = !current || !input.limits || Object.entries(input.limits).every(([key, value]) => current.limits[key as keyof WorkflowRun["limits"]] === value);
    if (current && sameLimits && JSON.stringify(scope(current)) === JSON.stringify(scope(input))) {
      if (current.execution === "draft") { await this.perform("start", true); return; }
      if (["stopped", "failed"].includes(current.execution)) { await this.perform("resume", true); return; }
    }
    const sameNodes = !current || JSON.stringify(current.nodeSettings ?? {}) === JSON.stringify(input.nodeSettings ?? {});
    const saved = await this.save(input, current?.execution === "draft" && current.projectPath === input.projectPath && sameLimits && (sameNodes || !current.workspacePath) ? { id: current.id, revision: current.revision } : undefined);
    if (saved) await this.perform("start", true);
  }

  async perform(action: UserAction, _userGesture = false, taskId?: string): Promise<void> {
    const run = this.selected;
    if (!run || !this.canAct) return;
    if (action === "start" && run.execution !== "draft") return;
    if (action === "resume" && !["stopped", "failed"].includes(run.execution)) return;
    if (action === "stop" && run.execution !== "running") return;
    if (action === "apply" && !canApply(run, this.state.tab)) return;
    if (action === "cancel" && (run.execution !== "running" || !taskId || !run.tasks.some(task => task.id === taskId && ["queued", "running"].includes(task.status)))) return;
    const args: Record<string, unknown> = { id: run.id };
    if (["start", "resume", "apply"].includes(action)) args.revision = run.revision;
    if (["start", "resume"].includes(action)) {
      if (!this.leaseId) throw new Error("面板租约尚未建立，请重新打开面板");
      args.leaseId = this.leaseId;
    }
    if (action === "cancel") args.taskId = taskId;
    if (action === "start" || action === "resume") this.ownedRuns.add(run.id);
    this.state.busy = true;
    this.state.error = "";
    this.changed();
    try {
      const updated = parseRun((await this.request(action === "cancel" ? "workflow_cancel_task" : `workflow_${action}`, args)).run);
      this.replace(updated);
    } catch (error) { this.state.error = actionError("操作失败", error, action); }
    finally { this.state.busy = false; this.changed(); }
  }

  teardown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.state.connection = "closed";
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

function tone(state: string): string { return ({ running: "blue", stopping: "amber", stopped: "amber", interrupted: "amber", failed: "red", completed: "green", pending: "amber", applying: "blue", applied: "green", conflict: "red", partial: "amber" } as Record<string, string>)[state] ?? "neutral"; }
function badge(label: string, state: string): string { return `<span class="wf-badge" data-tone="${tone(state)}">${escapeHtml(label)}</span>`; }
export function parseToolGrants(text: string): Record<string, string[]> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP 工具授权必须为 JSON 对象");
  const entries = Object.entries(value);
  if (entries.some(([name, tools]) => ["__proto__", "constructor", "prototype"].includes(name) || !Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim()))) throw new Error("MCP 工具授权的每个服务须对应工具名称数组，名称不能为空");
  return Object.fromEntries(entries) as Record<string, string[]>;
}
export function jsonInput(value: unknown): string { return JSON.stringify(value, null, 2) ?? "{}"; }
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

export function summarizeMaintenanceReview(value: unknown): {
  base: string; target: string; branch: string; preparedClean: boolean | undefined;
  artifactCount: number; artifactFingerprint: string; fingerprint: string;
  artifacts: Array<{ path: string; size?: number; kind?: string }>;
} {
  const review = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const artifacts = Array.isArray(review.artifacts) ? review.artifacts : [];
  const text = (key: string): string => typeof review[key] === "string" ? review[key] : "";
  return {
    base: text("base"), target: text("target"), branch: text("branch"), preparedClean: typeof review.preparedClean === "boolean" ? review.preparedClean : undefined,
    artifactCount: artifacts.length, artifactFingerprint: text("artifactFingerprint"), fingerprint: text("fingerprint"),
    artifacts: artifacts.slice(0, 30).map((value: unknown) => {
      const artifact = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { path: typeof artifact.path === "string" ? artifact.path : "未知路径", ...(typeof artifact.size === "number" ? { size: artifact.size } : {}), ...(typeof artifact.kind === "string" ? { kind: artifact.kind } : {}) };
    }),
  };
}

function maintenanceReview(run: WorkflowRun): string {
  if (run.maintenanceReview === undefined) return "";
  const review = summarizeMaintenanceReview(run.maintenanceReview);
  return `<h3 class="wf-section-title">维护审查</h3><div class="wf-facts"><span>分支 ${escapeHtml(review.branch || "未提供")}</span><span>基线 ${escapeHtml(review.base.slice(0, 12) || "未提供")} → ${escapeHtml(review.target.slice(0, 12) || "未提供")}</span><span>构建产物 ${review.artifactCount} 项</span><span>准备检查：${review.preparedClean === undefined ? "未报告" : review.preparedClean ? "已通过" : "未通过"}</span></div><details data-detail="maintenance-fingerprint"><summary>审查标识</summary><div class="wf-muted">产物指纹：${escapeHtml(review.artifactFingerprint || "未提供")}<br>整体审查：${escapeHtml(review.fingerprint || "未提供")}</div></details>${review.artifactCount ? `<details data-detail="maintenance-artifacts"><summary>构建产物示例（前 ${review.artifacts.length} 项）</summary><pre>${escapeHtml(jsonInput(review.artifacts))}</pre><p class="wf-muted">显示 ${review.artifacts.length}/${review.artifactCount} 项；完整清单保存在运行记录中。</p></details>` : ""}`;
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

function runDetails(run: WorkflowRun): string {
  const operationPlan = run.maintenance ? `<h3 class="wf-section-title">维护操作范围</h3>${run.maintenance.steps.map(step => `<div class="wf-worker-detail"><strong>${escapeHtml(step.id)}</strong><pre>${escapeHtml(jsonInput(step.command))}</pre><div class="wf-muted">${step.networkAccess ? "此步骤允许联网" : "此步骤禁用联网"}${step.timeoutMs ? ` · 超时 ${escapeHtml(step.timeoutMs)} 毫秒` : ""}${step.retries !== undefined ? ` · 失败重试 ${escapeHtml(step.retries)} 次` : ""} · ${step.idempotent ? "已声明幂等，可安全重放" : "结果未知时暂停，不自动重发"}</div></div>`).join("")}` : "";
  const activation = activationSummary(run);
  return `<p class="wf-goal">${escapeHtml(run.meta.description || run.meta.name)}</p><details data-detail="execution-scope"><summary>执行范围与限制</summary><div class="wf-facts"><span>读取 worker 上限 ${escapeHtml(run.limits.maxReadWorkers)}</span><span>调用上限 ${escapeHtml(run.limits.maxCalls)}</span><span>超时 ${Math.round(run.limits.timeoutMs / 1000)} 秒</span><span>Token 上限 ${escapeHtml(run.limits.maxTokens)}</span><span>${run.allowWrite ? "允许隔离工作区写入" : "只读执行"}</span><span>${run.networkAccess ? "已授权网络访问" : "网络访问关闭"}</span><span>MCP：${escapeHtml(run.allowedMcpServers?.length ? run.allowedMcpServers.join("、") : "未开放")}</span><span>${run.workspaceMode === "git-worktree" ? "独立 Git checkout" : "独立快照"}</span></div>${run.allowedMcpTools ? `<pre>${escapeHtml(jsonInput(run.allowedMcpTools))}</pre>` : ""}${operationPlan}${activation}${run.workspacePath ? `<p class="wf-muted">工作区：${escapeHtml(run.workspacePath)}</p>` : ""}</details>${run.error ? `<div class="wf-alert" role="alert">${escapeHtml(run.error)}</div>` : ""}${run.result !== undefined ? `<h3 class="wf-section-title">最终结果</h3><pre>${escapeHtml(formatted(run.result))}</pre>` : ""}<details data-detail="script"><summary>查看动态脚本</summary><pre>${escapeHtml(run.script)}</pre></details><details data-detail="args"><summary>运行输入</summary><pre>${escapeHtml(formatted(run.args))}</pre></details>`;
}

function tasks(run: WorkflowRun, selected: string | undefined, enabled: boolean): string {
  if (!run.tasks.length) return '<div class="wf-empty">任务会随动态脚本执行生成。</div>';
  const groups = [...new Set(run.tasks.map(task => task.phase || "未分阶段"))];
  const rows = groups.map(phase => `<section><h3 class="wf-section-title">${escapeHtml(phase)}</h3>${run.tasks.filter(task => (task.phase || "未分阶段") === phase).map(task => `<div class="wf-worker"><button type="button" data-worker="${escapeHtml(task.id)}" aria-pressed="${selected === task.id}"><span class="wf-worker-name">${escapeHtml(task.label || task.prompt)}</span><span class="wf-worker-meta">${escapeHtml(task.id)} · ${task.mode === "write" ? "写入" : "只读"} · ${task.attempts.length} 次执行${task.cached ? " · 复用结果" : ""}</span></button><div class="wf-worker-actions">${badge(taskLabels[task.status] ?? task.status, task.status)}${["queued", "running"].includes(task.status) && run.execution === "running" ? `<button class="wf-cancel-task" type="button" data-cancel="${escapeHtml(task.id)}" ${enabled ? "" : "disabled"}>中断此任务</button>` : ""}</div></div>`).join("")}</section>`).join("");
  const task = run.tasks.find(item => item.id === selected);
  if (!task) return rows;
  return rows + `<div class="wf-worker-detail"><h3 class="wf-section-title">${escapeHtml(task.label || task.prompt)}</h3><p>${escapeHtml(task.prompt)}</p>${task.error ? `<div class="wf-alert">${escapeHtml(task.error)}</div>` : ""}${task.output !== undefined ? `<h4 class="wf-section-title">任务结果</h4><pre>${escapeHtml(formatted(task.output))}</pre>` : ""}${task.attempts.map((attempt, index) => `<details data-detail="attempt-${escapeHtml(attempt.id)}" ${index === task.attempts.length - 1 ? "open" : ""}><summary>第 ${index + 1} 次执行 · ${escapeHtml(taskLabels[attempt.status] ?? attempt.status)}</summary><div class="wf-muted">${escapeHtml(attempt.startedAt ?? "")} ${attempt.endedAt ? `至 ${escapeHtml(attempt.endedAt)}` : ""}${attempt.threadId ? `<br>线程 ${escapeHtml(attempt.threadId)}` : ""}</div>${attempt.output !== undefined ? `<pre>${escapeHtml(formatted(attempt.output))}</pre>` : ""}${attempt.error ? `<div class="wf-alert">${escapeHtml(attempt.error)}</div>` : ""}${attempt.usage !== undefined ? `<div class="wf-muted">用量 ${escapeHtml(formatted(attempt.usage))}</div>` : ""}</details>`).join("")}</div>`;
}

function diff(run: WorkflowRun): string {
  if (run.execution !== "completed") return '<div class="wf-empty">整个工作流执行完成后统一汇总差异。停止或失败时保留工作区，可恢复后继续。</div>';
  const conflicts = run.diff?.conflicts?.length ? `<div class="wf-alert" role="alert">存在应用冲突：${run.diff.conflicts.map(escapeHtml).join("、")}</div>` : "";
  const changes = run.diff?.files.length ? `<h3 class="wf-section-title">变更文件</h3>${run.diff.files.map(file => `<div class="wf-file-header"><span>${escapeHtml(file.path)}</span><span>${escapeHtml(file.status)}</span></div>`).join("")}<pre aria-label="统一差异">${escapeHtml(run.diff.text)}</pre>` : '<div class="wf-empty">本次执行没有文件改动。</div>';
  const verification = run.logs.filter(log => /test|验证|测试|command|命令|operation|维护|activation|激活/i.test(log.message));
  return `${run.application === "partial" ? `<div class="wf-alert" role="alert">${escapeHtml(partialApplicationMessage(run))}</div>` : ""}${conflicts}${changes}${maintenanceReview(run)}${activationSummary(run)}<h3 class="wf-section-title">验证日志</h3>${verification.length ? verification.map(log => `<div class="wf-log"><span class="wf-log-time">${escapeHtml(displayTime(log.at))}</span><span>${escapeHtml(log.message)}</span></div>`).join("") : '<p class="wf-muted">运行记录没有报告测试或命令结果。</p>'}<div class="wf-notice">${escapeHtml(applicationLabels[run.application] ?? run.application)}。${run.activation?.status === "pending_restart" ? "配置已更新；宿主仍需重新加载并核对实际版本，脚本完成不代表新版服务已生效。" : "应用前会检查当前项目；冲突时保留工作区供你处理。"}</div>`;
}

export function mountPanel(root: HTMLElement, callTool: ToolCaller): WorkflowPanelController {
  const element = <T extends HTMLElement>(selector: string): T => {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing panel element: ${selector}`);
    return found;
  };
  const editor = element<HTMLDetailsElement>("#wf-editor");
  const secondary = element<HTMLDetailsElement>("#wf-secondary");
  const parameterFields = element("#wf-parameter-fields");
  const parameterError = element("#wf-parameter-error");
  const settingsDrawer = element<HTMLDetailsElement>("#wf-execution-settings");
  const defaultModel = element<HTMLSelectElement>("#wf-default-model");
  const defaultEffort = element<HTMLSelectElement>("#wf-default-effort");
  const settingsError = element("#wf-settings-error");
  const nodeTarget = element<HTMLSelectElement>("#wf-node-settings-target");
  const nodeModel = element<HTMLSelectElement>("#wf-node-model");
  const nodeEffort = element<HTMLSelectElement>("#wf-node-effort");
  const project = element<HTMLInputElement>("#wf-project-path");
  const script = element<HTMLTextAreaElement>("#wf-script");
  const args = element<HTMLTextAreaElement>("#wf-args");
  const write = element<HTMLInputElement>("#wf-allow-write");
  const scopeFields = document.createElement("div");
  scopeFields.innerHTML = '<label class="wf-checkbox"><input id="wf-network-access" type="checkbox">已授权 worker 和声明的维护操作访问网络</label><label for="wf-mcp-servers">可复用 MCP 服务白名单（逗号分隔）</label><input id="wf-mcp-servers" type="text" autocomplete="off" placeholder="仅填用户已配置且已授权的服务名称"><label for="wf-mcp-tools">MCP 工具授权（按服务名称映射的 JSON）</label><textarea id="wf-mcp-tools" rows="3" spellcheck="false">{}</textarea><label for="wf-workspace-mode">工作区类型</label><select id="wf-workspace-mode"><option value="snapshot">独立快照</option><option value="git-worktree">Git worktree（保留 Git 元数据）</option></select>';
  scopeFields.style.display = "grid";
  scopeFields.style.gap = "8px";
  write.closest("label")?.after(scopeFields);
  const network = element<HTMLInputElement>("#wf-network-access");
  const workspaceMode = element<HTMLSelectElement>("#wf-workspace-mode");
  const mcpServers = element<HTMLInputElement>("#wf-mcp-servers");
  const mcpTools = element<HTMLTextAreaElement>("#wf-mcp-tools");
  const runInformation = document.createElement("div");
  runInformation.className = "wf-run-information";
  element("#wf-run-meta").after(runInformation);
  editor.querySelector("summary")!.textContent = "高级编辑（通常由 Codex 生成计划）";
  element("#wf-new").textContent = "高级编辑";
  const footer = root.querySelector(".wf-footer span:last-child");
  if (footer) footer.textContent = "按你的请求执行 · 按授权审查与应用";
  let maintenancePlan: MaintenancePlan | undefined;
  let editing: { id: string; revision: number } | undefined;
  let loadedTemplate: TemplateDefinition | undefined;
  let parameterOwner = "";
  let parameterSchema: string | undefined = "";
  let loadingTemplate: string | undefined;
  let templateAttempt = "";
  let zoom = 1;
  let nodeSettings: NodeSettings = {};
  let nodeTargetKey = "";
  let settingsRevision = "";
  let nodeEditorSignature = "";
  let nodeNotice = "";
  let lastRender = "";
  const applyInput = (input: Partial<WorkflowInput>): void => {
    project.value = input.projectPath ?? (project.value.trim() || controller.state.projectPath);
    script.value = input.script ?? "";
    args.value = jsonInput(input.args === undefined ? {} : input.args);
    write.checked = input.allowWrite ?? false;
    network.checked = input.networkAccess ?? false;
    mcpServers.value = (input.allowedMcpServers ?? []).join(", ");
    mcpTools.value = jsonInput(input.allowedMcpTools ?? {});
    workspaceMode.value = input.workspaceMode ?? "snapshot";
    maintenancePlan = input.maintenance;
    nodeSettings = structuredClone(input.nodeSettings ?? {});
    nodeTargetKey = "";
    nodeEditorSignature = "";
    nodeNotice = "";
  };
  const currentDefinition = (): TemplateDefinition | undefined => controller.state.definition?.id === controller.state.selectedTemplate ? controller.state.definition : undefined;
  const declaredParameters = (): WorkflowParameter[] | undefined => controller.selected ? controller.selected.meta.parameters : currentDefinition()?.meta?.parameters;
  const readInput = (): WorkflowInput => {
    const parsed: unknown = JSON.parse(args.value);
    const parameters = declaredParameters();
    const values = new Map(Array.from(parameterFields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-parameter]")).map(control => [control.dataset.parameter!, control.dataset.parameterType === "boolean" ? (control as HTMLInputElement).checked : control.value]));
    return {
      projectPath: project.value.trim(), script: script.value,
      args: parameters?.length ? readParameters(parameters, values, parsed) : parsed,
      allowWrite: write.checked, networkAccess: network.checked,
      allowedMcpServers: mcpServers.value.split(/[,，]/).map(name => name.trim()).filter(Boolean),
      allowedMcpTools: parseToolGrants(mcpTools.value), workspaceMode: workspaceMode.value as "snapshot" | "git-worktree",
      ...(maintenancePlan ? { maintenance: maintenancePlan } : {}),
      nodeSettings: structuredClone(nodeSettings),
      ...(controller.selected?.limits ? { limits: controller.selected.limits } : loadedTemplate?.limits ? { limits: loadedTemplate.limits } : {}),
    };
  };
  const workflowDefaultView = (): ExecutionChoice | undefined => {
    const run = controller.selected;
    if (run?.executionSettings) return run.executionSettings;
    const upcoming = !run || run.execution === "draft" && !run.executionSettings && !run.workspacePath && !run.tasks.length;
    return upcoming && controller.state.settingsProjectPath === project.value.trim() ? controller.state.settings?.effectiveDefaults : undefined;
  };
  const inheritedNodeSettings = (): ExecutionChoice => {
    const run = controller.selected;
    const defaults: ExecutionChoice = { ...workflowDefaultView() };
    if (!nodeTargetKey.startsWith("task:")) return defaults;
    const task = run?.tasks.find(task => `task:${task.index}` === nodeTargetKey);
    if (typeof task?.options.model === "string") defaults.model = task.options.model;
    if (typeof task?.options.reasoningEffort === "string") defaults.reasoningEffort = task.options.reasoningEffort;
    const phase = task?.phase ? nodeSettings[`phase:${task.phase}`] : undefined;
    return { ...defaults, ...phase };
  };
  const nodeTargets = (): Array<{ key: string; label: string }> => {
    const run = controller.selected;
    const meta = run?.meta ?? currentDefinition()?.meta;
    const phases = (meta?.phases ?? []).map(phase => typeof phase === "string" ? phase : phase.title ?? phase.name ?? "").filter(Boolean);
    return [...new Map([...phases.map(title => [`phase:${title}`, `阶段：${title}`] as const), ...(run?.tasks ?? []).filter(task => !Object.hasOwn(task.options, "operation")).map(task => [`task:${task.index}`, `任务：${task.label || task.prompt.split("\n")[0] || task.id}`] as const)]).entries()].map(([key, label]) => ({ key, label }));
  };
  const showSettings = (key?: string): void => {
    if (key?.startsWith("task:")) {
      try { bindObservedNodeChoice(key, {}, controller.selected?.tasks ?? []); }
      catch (error) { parameterError.textContent = errorMessage(error); parameterError.hidden = false; return; }
    }
    secondary.open = true;
    settingsDrawer.open = true;
    if (key) { nodeTargetKey = key; nodeEditorSignature = ""; nodeNotice = ""; }
    render();
    if (!controller.state.settings || controller.state.settingsError || controller.state.settingsProjectPath !== project.value.trim()) void controller.refreshExecutionSettings(project.value.trim());
  };
  const loadSelectedTemplate = (id: string, key: string): void => {
    loadingTemplate = key;
    templateAttempt = key;
    queueMicrotask(() => {
      void (async () => {
        if (controller.state.connection === "closed" || controller.state.selectedTemplate !== id) { if (loadingTemplate === key) loadingTemplate = undefined; render(); return; }
        try { await controller.loadTemplate(id); }
        finally { if (loadingTemplate === key) loadingTemplate = undefined; render(); }
      })();
    });
  };
  const render = (): void => {
    const state = controller.state;
    const run = controller.selected;
    const definition = currentDefinition();
    const executing = !!run && ["running", "stopping"].includes(run.execution);
    const template = state.templates.find(item => item.id === state.selectedTemplate);
    const templateKey = JSON.stringify([template?.id, template?.revision]);
    if (controller.canAct && !executing && template && !loadingTemplate && templateAttempt !== templateKey && (!definition || definition.revision !== template.revision)) loadSelectedTemplate(template.id, templateKey);
    const signature = JSON.stringify({ state: { ...state, runs: state.runs.map(run => ({ ...run, ...(run.maintenanceReview !== undefined ? { maintenanceReview: summarizeMaintenanceReview(run.maintenanceReview) } : {}) })) }, editing, loadedTemplate, loadingTemplate, zoom, nodeSettings, nodeTargetKey, nodeNotice });
    if (signature === lastRender) return;
    lastRender = signature;
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusKey = focused?.dataset.action ? ["action", focused.dataset.action] : focused?.dataset.worker ? ["worker", focused.dataset.worker] : focused?.dataset.task ? ["task", focused.dataset.task] : focused?.dataset.nodeSettings ? ["node-settings", focused.dataset.nodeSettings] : focused?.dataset.cancel ? ["cancel", focused.dataset.cancel] : undefined;
    const detailStates = new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>("details[data-detail]")).map(details => [details.dataset.detail, details.open]));
    const connection = { offline: "离线预览 · 不执行任务", connecting: "正在连接宿主…", connected: "已连接宿主 · 真实运行记录", degraded: "宿主连接异常 · 操作已禁用", closed: "面板已关闭 · 正在保存与停止" }[state.connection];
    element("#wf-connection").textContent = connection;
    element("#wf-project").textContent = run?.projectPath ?? (project.value.trim() || state.projectPath || "尚未选择");
    const notification = element("#wf-notification");
    notification.hidden = !state.error;
    notification.textContent = state.error;
    const owner = run ? `run:${run.id}` : definition ? `template:${definition.id}:${definition.revision ?? "builtin"}` : "";
    const parameters = declaredParameters();
    const schema = JSON.stringify(parameters);
    if (owner !== parameterOwner || schema !== parameterSchema) {
      if (owner !== parameterOwner) {
        editing = undefined;
        loadedTemplate = run ? undefined : definition;
        if (run || definition) applyInput(run ?? definition!);
        parameterError.hidden = true;
      }
      parameterOwner = owner;
      parameterSchema = schema;
      try {
        parameterFields.innerHTML = parameters?.length ? renderParameterFields(parameters, JSON.parse(args.value), !controller.canAct || executing) : `<p class="wf-muted">${!owner ? "选择工作流后显示所需参数。" : "此工作流无需填写参数。"}</p>`;
      } catch (error) {
        parameterFields.textContent = "无法显示当前工作流参数。";
        parameterError.textContent = errorMessage(error);
        parameterError.hidden = false;
      }
    }
    parameterFields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-parameter]").forEach(control => { control.disabled = !controller.canAct || executing; });
    element("#wf-parameter-status").textContent = executing ? "执行期间参数不可修改。" : loadingTemplate ? "正在读取工作流参数…" : owner ? "参数将随启动传入本次运行。" : "";
    const settings = state.settings;
    const models = settings?.models ?? [];
    const revision = settings ? JSON.stringify([state.settingsProjectPath, settings.settings.revision, models, settings.effectiveDefaults]) : "";
    if (revision !== settingsRevision) {
      settingsRevision = revision;
      defaultModel.innerHTML = modelSelectOptions(models, settings?.settings.model ?? "", "继承 Codex 配置");
      defaultEffort.innerHTML = effortSelectOptions(models, defaultModel.value || settings?.codexDefaults.model, settings?.settings.reasoningEffort ?? "", "继承 Codex 配置");
    }
    defaultModel.disabled = defaultEffort.disabled = !controller.canAct || state.settingsBusy || !settings || !models.length;
    element<HTMLButtonElement>("#wf-settings-toggle").disabled = state.connection !== "connected";
    element<HTMLButtonElement>("#wf-refresh-settings").disabled = state.connection !== "connected" || state.settingsBusy;
    element<HTMLButtonElement>("#wf-save-settings").disabled = !controller.canAct || state.settingsBusy || !settings || !models.length || !!state.settingsError;
    settingsError.hidden = !state.settingsError;
    settingsError.textContent = state.settingsError;
    element("#wf-settings-status").textContent = state.settingsBusy ? "正在读取或保存执行设置…" : settings?.effectiveDefaults ? `当前已保存默认：${settings.effectiveDefaults.model} · ${settings.effectiveDefaults.reasoningEffort}（${settings.source === "workflow-settings" ? "工作流设置" : "Codex 配置"}）。修改只影响新运行。` : settings ? `默认配置不可用：${settings.defaultsStatus.reason ?? "宿主未提供有效默认值"}。可选择可用模型与思考深度并保存。` : "模型目录尚未读取；可以刷新设置后重试。";
    const targets = nodeTargets();
    if (!targets.some(target => target.key === nodeTargetKey)) nodeTargetKey = "";
    nodeTarget.innerHTML = '<option value="">从流程图选择节点</option>' + targets.map(target => `<option value="${escapeHtml(target.key)}" ${target.key === nodeTargetKey ? "selected" : ""}>${escapeHtml(target.label)}</option>`).join("");
    const inherited = inheritedNodeSettings();
    const defaultUnavailable = !workflowDefaultView() && !!settings && !settings.defaultsStatus.available && (!run || run.execution === "draft" && !run.workspacePath && !run.tasks.length);
    const missingDefault = defaultUnavailable ? "当前默认不可用" : "当前默认未记录";
    const nodeSignature = JSON.stringify([owner, nodeTargetKey, nodeSettings[nodeTargetKey], inherited, models]);
    if (nodeSignature !== nodeEditorSignature) {
      nodeEditorSignature = nodeSignature;
      const choice = nodeSettings[nodeTargetKey];
      nodeModel.innerHTML = modelSelectOptions(models, choice?.model ?? "", `继承上级配置（${inherited.model ?? missingDefault}）`);
      nodeEffort.innerHTML = effortSelectOptions(models, nodeModel.value || inherited.model, choice?.reasoningEffort ?? "", `继承上级配置（${inherited.reasoningEffort ?? missingDefault}）`);
    }
    nodeTarget.disabled = !controller.canAct || executing || !targets.length;
    let bindingError = "";
    if (nodeTargetKey.startsWith("task:")) {
      try { bindObservedNodeChoice(nodeTargetKey, {}, run?.tasks ?? []); }
      catch (error) { bindingError = errorMessage(error); }
    }
    nodeModel.disabled = nodeEffort.disabled = !controller.canAct || state.settingsBusy || !settings || !models.length || !nodeTargetKey || executing || !!bindingError;
    element<HTMLButtonElement>("#wf-save-node-settings").disabled = nodeModel.disabled;
    element("#wf-node-settings-status").textContent = executing ? "执行期间不可修改当前节点设置。" : bindingError || nodeNotice || (defaultUnavailable ? `默认配置不可用：${settings.defaultsStatus.reason ?? "请先修正默认设置"}` : nodeTargetKey ? `上级配置：${inherited.model ?? "模型未记录"} · ${inherited.reasoningEffort ?? "思考深度未记录"}。节点修改在下次启动生效；现有执行记录保持原配置。` : "从流程图或上方列表选择阶段／任务，可覆盖模型与思考深度。");
    const selector = element<HTMLSelectElement>("#wf-run-select");
    selector.innerHTML = state.runs.length ? state.runs.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedRun ? "selected" : ""}>${escapeHtml(item.meta.name)} — ${escapeHtml(executionLabels[item.execution])}</option>`).join("") : '<option value="">暂无运行记录</option>';
    selector.disabled = !state.runs.length || state.busy;
    element<HTMLButtonElement>("#wf-refresh").disabled = ["offline", "connecting", "closed"].includes(state.connection) || state.busy;
    element<HTMLButtonElement>("#wf-new").disabled = !controller.canAct;
    const templateSelector = element<HTMLSelectElement>("#wf-template-select");
    const runTemplate = run ? state.templates.find(item => item.id === run.meta.name || item.id === `saved:${run.meta.name}`) : undefined;
    const selectedTemplate = run ? runTemplate?.id : state.selectedTemplate;
    templateSelector.innerHTML = '<option value="">选择工作流</option>' + (run && !runTemplate ? `<option value="__run__" selected disabled>${escapeHtml(run.meta.name)} · 当前运行</option>` : "") + state.templates.map(template => `<option value="${escapeHtml(template.id)}" ${template.id === selectedTemplate ? "selected" : ""}>${escapeHtml(template.name)} · ${template.source === "saved" ? "已保存" : "内置"}</option>`).join("");
    templateSelector.disabled = !controller.canAct || !state.templates.length || executing;
    element("#wf-template-count").textContent = state.templatesLoaded ? `${state.templates.length} 个工作流` : state.connection === "offline" ? "未连接" : "读取中";
    element<HTMLButtonElement>("#wf-load-template").disabled = !controller.canAct || !state.selectedTemplate;
    element<HTMLButtonElement>("#wf-save-definition").disabled = !controller.canAct;
    element("#wf-template-help").textContent = loadedTemplate ? `载入 ${loadedTemplate.name}${loadedTemplate.revision !== undefined ? ` · 定义版本 ${loadedTemplate.revision}` : ""}。选择目标项目并填写参数，点击启动后创建独立运行。` : "工作流定义可在不同项目复用；运行结果和工作区属于各次运行。";
    project.disabled = !controller.canAct || !!editing || executing;
    script.disabled = args.disabled = write.disabled = network.disabled = mcpServers.disabled = mcpTools.disabled = workspaceMode.disabled = !controller.canAct || executing;
    element<HTMLButtonElement>("#wf-save").disabled = !controller.canAct;
    if (!project.value && state.projectPath) project.value = state.projectPath;
    element("#wf-run-title").textContent = run?.meta.name ?? definition?.name ?? "暂无运行记录";
    element("#wf-run-meta").textContent = run ? `运行 ${run.id} · 版本 ${run.revision} · ${run.updatedAt}` : definition ? definition.description : "选择工作流并填写参数，点击启动后创建运行。";
    runInformation.innerHTML = run ? runDetails(run) : "";
    const execution = element("#wf-execution-status");
    execution.textContent = run ? executionLabels[run.execution] ?? run.execution : definition ? "待开始" : "待选择";
    execution.dataset.tone = tone(run?.execution ?? "draft");
    const change = element("#wf-change-status");
    change.textContent = run ? applicationLabels[run.application] ?? run.application : "";
    change.dataset.tone = tone(run?.application ?? "none");
    element("#wf-task-count").textContent = String(run?.tasks.length ?? 0);
    element("#wf-progress").textContent = run?.tasks.length ? `已完成 ${run.tasks.filter(task => task.status === "completed").length} · 运行中 ${run.tasks.filter(task => task.status === "running").length} · 等待 ${run.tasks.filter(task => task.status === "queued").length} · 中断 ${run.tasks.filter(task => task.status === "interrupted").length}` : "任务数量将在执行中确定";
    const action = (id: string, label: string, primary = false, enabled = controller.canAct, icon?: string): string => `<button type="button" data-action="${id}" class="${primary ? "wf-primary" : ""}" ${enabled ? "" : "disabled"}>${icon ? `<span class="wf-icon" data-icon="${icon}" aria-hidden="true"></span>` : ""}${label}</button>`;
    let actions = action("start", run && ["stopped", "failed"].includes(run.execution) ? "继续" : "启动", true, controller.canAct && !!owner && !executing && !loadingTemplate && run?.application !== "applying", "player-play") + action("stop", run?.execution === "stopping" ? "正在停止…" : "停止", false, controller.canAct && run?.execution === "running", "player-stop");
    if (run?.execution === "completed" && (run.diff?.files.length || run.maintenanceReview !== undefined || run.activation !== undefined) && run.application !== "applied") actions += canApply(run, state.tab) ? action("apply", run.application === "partial" ? "重试未完成步骤" : "应用改动") : action("review", "查看差异");
    element("#wf-actions").innerHTML = actions;
    root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(button => {
      const selected = button.dataset.tab === state.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (button.dataset.tab !== "overview") element(`#wf-panel-${button.dataset.tab}`).hidden = !selected;
    });
    element("#wf-panel-overview").hidden = false;
    element("#wf-graph-viewport").style.setProperty("--wf-graph-zoom", String(zoom));
    element("#wf-zoom-value").textContent = `${Math.round(zoom * 100)}%`;
    element<HTMLButtonElement>("#wf-zoom-out").disabled = !owner || zoom <= .5;
    element<HTMLButtonElement>("#wf-zoom-in").disabled = !owner || zoom >= 1.75;
    element<HTMLButtonElement>("#wf-zoom-reset").disabled = !owner || zoom === 1;
    const graphScroll = root.querySelector<HTMLElement>(".wf-graph-scroll");
    const graphPosition = { left: graphScroll?.scrollLeft ?? 0, top: graphScroll?.scrollTop ?? 0 };
    const graphDefaults = workflowDefaultView();
    element("#wf-panel-overview").innerHTML = renderWorkflowGraph(run ? { ...run, nodeSettings, ...(graphDefaults ? { executionSettings: graphDefaults } : {}) } : definition?.meta ? { meta: definition.meta, execution: "draft", tasks: [], logs: [], nodeSettings, ...(graphDefaults ? { executionSettings: graphDefaults } : {}) } : undefined, state.task);
    const updatedScroll = root.querySelector<HTMLElement>(".wf-graph-scroll");
    if (updatedScroll) { updatedScroll.scrollLeft = graphPosition.left; updatedScroll.scrollTop = graphPosition.top; }
    if (!run) {
      for (const tab of ["tasks", "diff", "logs"]) element(`#wf-panel-${tab}`).textContent = "暂无运行数据";
      return;
    }
    element("#wf-panel-tasks").innerHTML = tasks(run, state.task, controller.canAct);
    element("#wf-panel-diff").innerHTML = diff(run);
    element("#wf-panel-logs").innerHTML = run.logs.length ? run.logs.map(log => `<div class="wf-log"><span class="wf-log-time">${escapeHtml(displayTime(log.at))}</span><span>${log.level === "error" ? '<strong>错误</strong> ' : ""}${log.taskId ? `[${escapeHtml(log.taskId)}] ` : ""}${escapeHtml(log.message)}</span></div>`).join("") : '<div class="wf-empty">暂无日志</div>';
    root.querySelectorAll<HTMLDetailsElement>("details[data-detail]").forEach(details => {
      const saved = detailStates.get(details.dataset.detail);
      if (saved !== undefined) details.open = saved;
    });
    if (focusKey) {
      const restored = Array.from(root.querySelectorAll<HTMLButtonElement>(`[data-${focusKey[0]}]`)).find(button => button.getAttribute(`data-${focusKey[0]}`) === focusKey[1]);
      if (restored && !restored.disabled) restored.focus({ preventScroll: true });
    }
  };
  const controller = new WorkflowPanelController(callTool, render);
  const openEditor = (run?: WorkflowRun): void => {
    editing = run ? { id: run.id, revision: run.revision } : undefined;
    if (!run) loadedTemplate = currentDefinition();
    try { args.value = jsonInput(readInput().args); } catch { /* Incomplete required fields remain editable. */ }
    element("#wf-editor-error").hidden = true;
    element("#wf-editor-status").hidden = true;
    element("#wf-save").textContent = editing ? "保存修改" : "保存预览";
    secondary.open = true;
    editor.open = true;
    render();
    (run ? script : project).focus();
  };
  element<HTMLSelectElement>("#wf-run-select").addEventListener("change", event => {
    editor.open = false;
    editing = undefined;
    void controller.select((event.target as HTMLSelectElement).value);
  });
  element("#wf-refresh").addEventListener("click", () => { templateAttempt = ""; void (async () => { await controller.heartbeat(); await Promise.all([controller.refresh(), controller.refreshTemplates()]); })(); });
  element("#wf-new").addEventListener("click", () => openEditor(controller.selected));
  element<HTMLSelectElement>("#wf-template-select").addEventListener("change", event => {
    editing = undefined;
    editor.open = false;
    templateAttempt = "";
    controller.selectTemplate((event.target as HTMLSelectElement).value || undefined);
  });
  element("#wf-load-template").addEventListener("click", () => {
    const id = controller.state.selectedTemplate;
    if (!id) return;
    void (async () => {
      const definition = await controller.loadTemplate(id);
      if (!definition || controller.state.connection === "closed") return;
      controller.selectTemplate(id);
      openEditor();
      render();
      project.focus();
    })();
  });
  element("#wf-save-definition").addEventListener("click", () => {
    void (async () => {
      const notice = element("#wf-editor-error");
      try {
        const parsed: unknown = JSON.parse(args.value);
          const saved = await controller.saveTemplate({ script: script.value, args: parsed, allowWrite: write.checked, networkAccess: network.checked, allowedMcpServers: mcpServers.value.split(/[,，]/).map(name => name.trim()).filter(Boolean), allowedMcpTools: parseToolGrants(mcpTools.value), workspaceMode: workspaceMode.value as "snapshot" | "git-worktree", nodeSettings: structuredClone(nodeSettings), ...(maintenancePlan ? { maintenance: maintenancePlan } : {}), ...(loadedTemplate?.limits ? { limits: loadedTemplate.limits } : {}) }, loadedTemplate?.source === "saved" ? loadedTemplate.revision : undefined);
        if (saved) {
          loadedTemplate = { ...saved, script: script.value, args: parsed, allowWrite: write.checked, networkAccess: network.checked, allowedMcpServers: mcpServers.value.split(/[,，]/).map(name => name.trim()).filter(Boolean), allowedMcpTools: parseToolGrants(mcpTools.value), workspaceMode: workspaceMode.value as "snapshot" | "git-worktree", nodeSettings: structuredClone(nodeSettings), ...(maintenancePlan ? { maintenance: maintenancePlan } : {}), ...(loadedTemplate?.limits ? { limits: loadedTemplate.limits } : {}) };
          const status = element("#wf-editor-status");
          status.textContent = `已保存到工作流库：${saved.name}。可以选择不同项目创建新运行。`;
          status.hidden = false;
          notice.hidden = true;
          render();
        } else { notice.textContent = controller.state.error || "面板尚未连接宿主"; notice.hidden = false; }
      } catch (error) { notice.textContent = errorMessage(error); notice.hidden = false; }
    })();
  });
  element("#wf-editor-cancel").addEventListener("click", () => { editor.open = false; });
  const validateChoice = (choice: ExecutionChoice, inherited: ExecutionChoice): void => {
    const models = controller.state.settings?.models ?? [];
    if (choice.model && !models.some(model => model.id === choice.model)) throw new Error("请选择模型目录中可用的模型");
    const model = models.find(model => model.id === (choice.model ?? inherited.model));
    const effort = choice.reasoningEffort ?? inherited.reasoningEffort;
    if (choice.reasoningEffort && !models.some(model => model.supportedReasoningEfforts.includes(choice.reasoningEffort!))) throw new Error("请选择模型目录中可用的思考深度");
    if (model && effort && !model.supportedReasoningEfforts.includes(effort)) throw new Error(`模型 ${model.displayName || model.id} 不支持思考深度 ${effort}，请明确选择支持的值`);
  };
  element("#wf-settings-toggle").addEventListener("click", () => showSettings());
  element("#wf-refresh-settings").addEventListener("click", () => { settingsRevision = ""; void controller.refreshExecutionSettings(project.value.trim()); });
  defaultModel.addEventListener("change", () => {
    defaultEffort.innerHTML = effortSelectOptions(controller.state.settings?.models ?? [], defaultModel.value || controller.state.settings?.codexDefaults.model, defaultEffort.value, "继承 Codex 配置");
    controller.state.settingsError = "";
    render();
  });
  defaultEffort.addEventListener("change", () => { controller.state.settingsError = ""; render(); });
  element<HTMLFormElement>("#wf-settings-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!controller.canAct || controller.state.settingsBusy || !controller.state.settings) return;
    const choice: ExecutionChoice = { ...(defaultModel.value ? { model: defaultModel.value } : {}), ...(defaultEffort.value ? { reasoningEffort: defaultEffort.value } : {}) };
    try {
      if (choice.model || choice.reasoningEffort) validateChoice(choice, controller.state.settings.codexDefaults);
      void controller.saveExecutionSettings(choice, project.value.trim());
    } catch (error) { controller.state.settingsError = errorMessage(error); render(); }
  });
  nodeTarget.addEventListener("change", () => { nodeTargetKey = nodeTarget.value; nodeEditorSignature = ""; nodeNotice = ""; render(); });
  nodeModel.addEventListener("change", () => {
    nodeEffort.innerHTML = effortSelectOptions(controller.state.settings?.models ?? [], nodeModel.value || inheritedNodeSettings().model, nodeEffort.value, "继承上级配置");
    nodeNotice = "";
  });
  nodeEffort.addEventListener("change", () => { nodeNotice = ""; });
  element<HTMLFormElement>("#wf-node-settings-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!controller.canAct || !nodeTargetKey || nodeModel.disabled) return;
    try {
      const choice: ExecutionChoice = { ...(nodeModel.value ? { model: nodeModel.value } : {}), ...(nodeEffort.value ? { reasoningEffort: nodeEffort.value } : {}) };
      const boundChoice = bindObservedNodeChoice(nodeTargetKey, choice, controller.selected?.tasks ?? []);
      if (choice.model || choice.reasoningEffort) validateChoice(choice, inheritedNodeSettings());
      if (choice.model || choice.reasoningEffort) nodeSettings[nodeTargetKey] = boundChoice;
      else delete nodeSettings[nodeTargetKey];
      nodeNotice = "节点配置已加入待启动计划，点击启动后生效；保存到工作流库可复用。";
      render();
    } catch (error) { nodeNotice = errorMessage(error); render(); }
  });
  project.addEventListener("change", () => { render(); void controller.refreshExecutionSettings(project.value.trim()); });
  parameterFields.addEventListener("input", () => { parameterError.hidden = true; });
  args.addEventListener("change", () => {
    const parameters = declaredParameters();
    if (!parameters?.length) return;
    try {
      parameterFields.innerHTML = renderParameterFields(parameters, JSON.parse(args.value), !controller.canAct || !!controller.selected && ["running", "stopping"].includes(controller.selected.execution));
      parameterError.hidden = true;
    } catch (error) { parameterError.textContent = errorMessage(error); parameterError.hidden = false; }
  });
  element<HTMLFormElement>("#wf-form").addEventListener("submit", event => {
    event.preventDefault();
    void (async () => {
      const notice = element("#wf-editor-error");
      try {
        const run = await controller.save(readInput(), editing);
        if (run) { editor.open = false; editing = undefined; notice.hidden = true; render(); }
        else { notice.textContent = controller.state.error || "面板尚未连接宿主"; notice.hidden = false; }
      } catch (error) { notice.textContent = errorMessage(error); notice.hidden = false; }
    })();
  });
  root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : undefined;
    const nodeSettingsButton = target?.closest<HTMLButtonElement>("[data-node-settings]");
    if (nodeSettingsButton && !nodeSettingsButton.disabled) { showSettings(nodeSettingsButton.dataset.nodeSettings); nodeModel.focus(); return; }
    const zoomButton = target?.closest<HTMLButtonElement>("[data-zoom]");
    if (zoomButton && !zoomButton.disabled) {
      zoom = zoomButton.dataset.zoom === "reset" ? 1 : Math.max(.5, Math.min(1.75, Math.round((zoom + (zoomButton.dataset.zoom === "in" ? .25 : -.25)) * 100) / 100));
      render();
      return;
    }
    const tab = target?.closest<HTMLButtonElement>("[data-tab]");
    if (tab) { controller.state.tab = tab.dataset.tab as PanelTab; render(); return; }
    const task = target?.closest<HTMLButtonElement>("[data-worker], [data-task]");
    if (task) { controller.state.task = task.dataset.worker ?? task.dataset.task; controller.state.tab = "tasks"; secondary.open = true; render(); return; }
    const cancel = target?.closest<HTMLButtonElement>("[data-cancel]");
    if (cancel) { void controller.perform("cancel", true, cancel.dataset.cancel).catch(error => controller.disconnected(error)); return; }
    const action = target?.closest<HTMLButtonElement>("[data-action]")?.dataset.action;
    if (action === "edit" && controller.selected) { openEditor(controller.selected); return; }
    if (action === "review") { controller.state.tab = "diff"; secondary.open = true; render(); return; }
    if (action === "start" || action === "resume") {
      if (!controller.canAct) return;
      void (async () => {
        try {
          const input = readInput();
          if (!input.projectPath) { secondary.open = true; editor.open = true; project.focus(); throw new Error("请在高级编辑中填写目标项目目录"); }
          parameterError.hidden = true;
          args.value = jsonInput(input.args);
          await controller.startWithInput(input);
        } catch (error) { parameterError.textContent = errorMessage(error); parameterError.hidden = false; }
      })();
      return;
    }
    if (action && ["stop", "apply"].includes(action)) void controller.perform(action as UserAction, true).catch(error => controller.disconnected(error));
  });
  root.querySelector(".wf-tabs")?.addEventListener("keydown", event => {
    if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tab]"));
    const current = tabs.findIndex(tab => tab.dataset.tab === controller.state.tab);
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const tab = tabs[index];
    if (!tab) return;
    event.preventDefault();
    controller.state.tab = tab.dataset.tab as PanelTab;
    render();
    tab.focus();
  });
  render();
  return controller;
}
