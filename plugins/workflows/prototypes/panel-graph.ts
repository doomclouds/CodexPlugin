import type { WorkflowAttempt, WorkflowRun, WorkflowTask } from "./panel.ts";

export interface GraphExecutionSettings { model?: string; reasoningEffort?: string }
export interface GraphTaskExecutionSettings extends GraphExecutionSettings {
  source: "task" | "phase" | "script" | "workflow-settings" | "codex-config";
  provenance?: "requested" | "configured" | "runtime";
}
export type GraphTask = WorkflowTask & {
  executionSettings?: GraphTaskExecutionSettings;
  attempts: Array<WorkflowAttempt & { executionSettings?: GraphTaskExecutionSettings }>;
};
export type WorkflowGraphInput = Pick<WorkflowRun, "meta" | "execution" | "logs"> & {
  tasks: GraphTask[];
  executionSettings?: GraphExecutionSettings;
  nodeSettings?: Record<string, GraphExecutionSettings>;
};
export type GraphStatus = WorkflowTask["status"] | "planned" | "skipped" | "stopped" | "unknown";
export interface WorkflowGraphGroup {
  tasks: GraphTask[];
  concurrent: boolean;
  live: boolean;
}
export interface WorkflowGraphPhase {
  title: string;
  status: GraphStatus;
  kind: "phase" | "workflow";
  declared: boolean;
  groups: WorkflowGraphGroup[];
  placeholder: string;
}
export interface WorkflowGraph {
  name: string;
  phases: WorkflowGraphPhase[];
  taskCount: number;
}

const statusLabels: Record<GraphStatus, string> = {
  planned: "尚未派发", skipped: "未执行", queued: "等待中", running: "运行中", stopping: "正在停止",
  stopped: "已停止", interrupted: "已中断", completed: "已完成", failed: "失败", unknown: "状态未知",
};
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const isLive = (task: WorkflowTask): boolean => task.status === "running" || task.status === "stopping";
const taskStatuses = new Set<string>(["queued", "running", "stopping", "interrupted", "completed", "failed"]);
const workflowStatuses = new Set<string>(["running", "stopping", "stopped", "completed", "failed"]);
const taskStatus = (task: WorkflowTask): GraphStatus => taskStatuses.has(task.status) ? task.status : "unknown";

function interval(task: GraphTask): { start: number; end: number } | undefined {
  const attempt = task.attempts.at(-1);
  if (!attempt?.startedAt) return undefined;
  const start = Date.parse(attempt.startedAt);
  const end = attempt.endedAt ? Date.parse(attempt.endedAt) : isLive(task) ? Infinity : NaN;
  return Number.isFinite(start) && end > start ? { start, end } : undefined;
}

// Time overlap is observed concurrency, not a dependency inferred from launch order.
function groupTasks(tasks: GraphTask[]): WorkflowGraphGroup[] {
  const ordered = [...tasks].sort((left, right) => left.index - right.index);
  const observed = ordered.flatMap(task => {
    const time = interval(task);
    return time ? [{ task, ...time }] : [];
  }).sort((left, right) => left.start - right.start || left.task.index - right.task.index);
  const clusters: GraphTask[][] = [];
  let end = -Infinity;
  for (const observation of observed) {
    if (observation.start >= end) clusters.push([]);
    clusters.at(-1)!.push(observation.task);
    end = Math.max(observation.start >= end ? -Infinity : end, observation.end);
  }
  const membership = new Map<GraphTask, GraphTask[]>();
  for (const cluster of clusters) if (cluster.length > 1) {
    cluster.sort((left, right) => left.index - right.index);
    for (const task of cluster) membership.set(task, cluster);
  }
  const seen = new Set<GraphTask>();
  return ordered.flatMap(task => {
    if (seen.has(task)) return [];
    const members = membership.get(task) ?? [task];
    for (const member of members) seen.add(member);
    return [{ tasks: members, concurrent: members.length > 1, live: members.some(isLive) }];
  });
}

function phaseStatus(tasks: GraphTask[], run: WorkflowGraphInput): GraphStatus {
  if (tasks.some(task => task.status === "stopping")) return "stopping";
  if (tasks.some(task => task.status === "running")) return "running";
  if (tasks.some(task => task.status === "failed")) return "failed";
  if (tasks.some(task => task.status === "interrupted")) return "interrupted";
  if (tasks.some(task => task.status === "queued")) return "queued";
  if (tasks.some(task => taskStatus(task) === "unknown")) return "unknown";
  if (tasks.length) return "completed";
  return run.execution === "completed" ? "skipped" : "planned";
}

export function buildWorkflowGraph(run?: WorkflowGraphInput): WorkflowGraph {
  if (!run) return { name: "", phases: [], taskCount: 0 };
  const titles: string[] = [];
  const include = (title: string): void => { if (title && !titles.includes(title)) titles.push(title); };
  for (const phase of run.meta.phases ?? []) include(typeof phase === "string" ? phase : phase.title ?? phase.name ?? "");
  const declared = new Set(titles);
  for (const task of [...run.tasks].sort((left, right) => left.index - right.index)) if (task.phase) include(task.phase);
  const unphased = run.tasks.filter(task => !task.phase);
  const unphasedTitle = titles.length ? "未分阶段的任务" : "任务执行";
  const phases: WorkflowGraphPhase[] = titles.map(title => {
    const tasks = run.tasks.filter(task => task.phase === title);
    const status = phaseStatus(tasks, run);
    return { title, status, kind: "phase", declared: declared.has(title), groups: groupTasks(tasks), placeholder: status === "skipped" ? "本次没有派发任务" : "任务将在实际派发后显示" };
  });
  if (unphased.length || !phases.length) {
    const workflowOnly = !titles.length && !unphased.length;
    const status: GraphStatus = workflowOnly ? run.execution === "draft" ? "planned" : workflowStatuses.has(run.execution) ? run.execution : "unknown" : phaseStatus(unphased, run);
    phases.push({ title: workflowOnly ? run.meta.name : unphasedTitle, status, kind: workflowOnly ? "workflow" : "phase", declared: false, groups: groupTasks(unphased), placeholder: run.execution === "draft" ? "启动后展示动态任务" : run.execution === "running" ? "等待脚本派发任务" : "本次尚未派发任务" });
  }
  return { name: run.meta.name, phases, taskCount: run.tasks.length };
}

function statusIcon(status: GraphStatus): string {
  return status === "completed" ? "circle-check" : status === "failed" || status === "unknown" ? "alert-circle" : status === "running" ? "loader-2" : status === "stopping" || status === "interrupted" || status === "stopped" ? "player-stop" : "circle";
}

function settingsButton(key: string, label: string, run: WorkflowGraphInput): string {
  const disabled = run.execution === "running" || run.execution === "stopping";
  return `<button type="button" class="wf-node-settings-icon" data-node-settings="${escape(key)}" aria-label="${escape(`配置 ${label} 的模型与思考深度`)}" title="${disabled ? "运行期间不能修改当前节点配置" : "配置模型与思考深度"}"${disabled ? " disabled" : ""}><span class="wf-icon" data-icon="settings" aria-hidden="true"></span></button>`;
}

function mergeSettings(...values: Array<GraphExecutionSettings | undefined>): GraphExecutionSettings {
  const settings: GraphExecutionSettings = {};
  for (const value of values) {
    if (typeof value?.model === "string" && value.model) settings.model = value.model;
    if (typeof value?.reasoningEffort === "string" && value.reasoningEffort) settings.reasoningEffort = value.reasoningEffort;
  }
  return settings;
}

function configurationLabel(settings?: GraphExecutionSettings & { provenance?: GraphTaskExecutionSettings["provenance"] }): string {
  if (!settings?.model && !settings?.reasoningEffort) return "默认配置";
  if (settings.provenance === "runtime") return `运行模型：${settings.model ?? "未报告"} · 思考配置：${settings.reasoningEffort ?? "未报告"}`;
  if (settings.provenance === "configured") return `已确认配置：${settings.model ?? "模型未报告"} · ${settings.reasoningEffort ?? "深度未报告"}`;
  return `计划配置：${settings.model ?? "默认模型"} · ${settings.reasoningEffort ?? "默认深度"}`;
}

function taskConfiguration(task: GraphTask, run: WorkflowGraphInput): string {
  // Saved execution settings belong to the producing worker attempt; new overrides
  // must never relabel an already executed task as if it had used the next settings.
  const recorded = task.attempts.at(-1)?.executionSettings ?? task.executionSettings;
  if (recorded) return configurationLabel(recorded);
  const script = mergeSettings({
    ...(typeof task.options.model === "string" ? { model: task.options.model } : {}),
    ...(typeof task.options.reasoningEffort === "string" ? { reasoningEffort: task.options.reasoningEffort } : {}),
  });
  return configurationLabel(mergeSettings(run.executionSettings, script, task.phase ? run.nodeSettings?.[`phase:${task.phase}`] : undefined, run.nodeSettings?.[`task:${task.index}`]));
}

function renderTask(task: GraphTask, run: WorkflowGraphInput, selectedTaskId?: string): string {
  const title = (task.label?.trim() || task.prompt.split("\n")[0]?.trim() || `任务 ${task.index + 1}`).slice(0, 120);
  const state = taskStatus(task);
  const status = statusLabels[state];
  const fixedCommand = Object.hasOwn(task.options, "operation");
  const detail = `${fixedCommand ? "固定命令" : task.mode === "write" ? "写入任务" : "只读任务"}${task.cached ? " · 已复用结果" : task.attempts.length > 1 ? ` · 第 ${task.attempts.length} 次尝试` : ""}`;
  return `<div class="wf-graph-node-shell"><button type="button" class="wf-graph-node${selectedTaskId === task.id ? " is-selected" : ""}${task.cached ? " is-cached" : ""}" data-task="${escape(task.id)}" data-status="${state}" aria-pressed="${selectedTaskId === task.id}" aria-label="${escape(`${title}，${status}，${detail}`)}"><span class="wf-graph-node-icon wf-icon" data-icon="${fixedCommand ? "settings" : task.mode === "write" ? "pencil" : "search"}" aria-hidden="true"></span><span class="wf-graph-node-content"><span class="wf-graph-node-title">${escape(title)}</span><span class="wf-graph-node-status"><span class="wf-graph-status-icon wf-icon" data-icon="${statusIcon(state)}" aria-hidden="true"></span>${status}</span><span class="wf-graph-node-detail">${escape(detail)}</span>${fixedCommand ? "" : `<span class="wf-graph-node-model">${escape(taskConfiguration(task, run))}</span>`}</span></button>${fixedCommand ? "" : settingsButton(`task:${task.index}`, title, run)}</div>`;
}

export function renderWorkflowGraph(run?: WorkflowGraphInput, selectedTaskId?: string): string {
  const graph = buildWorkflowGraph(run);
  if (!run) return '<div class="wf-graph wf-graph-empty"><p class="wf-graph-placeholder">选择工作流并保存预览后，执行图将在这里显示。</p></div>';
  const connector = '<div class="wf-graph-connector" aria-label="阶段展示顺序"><svg viewBox="0 0 48 40" aria-hidden="true"><path d="M0 20H40m-7-7 7 7-7 7"/></svg><span class="wf-graph-connector-label">阶段顺序</span></div>';
  const phases = graph.phases.map((phase, index) => {
    const phaseSettings = configurationLabel(mergeSettings(run.executionSettings, phase.declared ? run.nodeSettings?.[`phase:${phase.title}`] : undefined));
    const placeholder = `<div class="wf-graph-node wf-graph-placeholder-node" data-status="${phase.status}"><span class="wf-graph-node-icon wf-icon" data-icon="file-text" aria-hidden="true"></span><span class="wf-graph-node-content"><span class="wf-graph-node-title">${escape(phase.title)}</span><span class="wf-graph-node-status"><span class="wf-graph-status-icon wf-icon" data-icon="${statusIcon(phase.status)}" aria-hidden="true"></span>${phase.kind === "workflow" && phase.status === "planned" ? "待开始" : statusLabels[phase.status]}</span><span class="wf-graph-node-detail wf-graph-placeholder">${escape(phase.placeholder)}</span><span class="wf-graph-node-model">${escape(phaseSettings)}</span></span></div>`;
    return `<section class="wf-graph-phase" data-status="${phase.status}" data-kind="${phase.kind}">${phase.kind === "phase" ? `<header class="wf-graph-phase-heading"><span class="wf-graph-phase-number">${index + 1}</span><span class="wf-graph-phase-title">${escape(phase.title)}</span><span class="wf-graph-status">${statusLabels[phase.status]}</span>${phase.declared ? settingsButton(`phase:${phase.title}`, phase.title, run) : ""}</header>` : ""}<div class="wf-graph-groups">${phase.groups.length ? phase.groups.map(group => `<div class="wf-graph-group" data-concurrent="${group.concurrent}">${group.concurrent ? `<div class="wf-graph-group-label">${group.live ? "并行任务组" : "曾有并行"} · ${group.tasks.length} 个任务</div>` : ""}<div class="wf-graph-nodes">${group.tasks.map(task => renderTask(task, run, selectedTaskId)).join("")}</div></div>`).join("") : placeholder}</div></section>`;
  }).join(connector);
  return `<div class="wf-graph" role="region" aria-label="${escape(`${graph.name} 工作流执行图`)}"><div class="wf-graph-scroll"><div class="wf-graph-track">${phases}</div></div><p class="wf-graph-caption">连线表示阶段展示顺序；节点展示实际派发任务，并行分组依据尝试时间重叠。</p></div>`;
}
