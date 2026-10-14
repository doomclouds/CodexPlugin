import type { WorkflowAttempt, WorkflowRun, WorkflowTask } from "./panel.ts";
import { failureContext, resultCheckFailure } from "../src/failure-context.ts";
import type { WorkflowFailureContext } from "../src/failure-context.ts";

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
  deletionPending?: boolean;
  stale?: boolean;
  failureContext?: WorkflowFailureContext;
  preparation?: NonNullable<WorkflowRun["preparation"]>;
  startedAt?: string;
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
  resultCheckFailed?: boolean;
  reviewFailed?: boolean;
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
  return run.execution === "completed" || failureContext(run)?.kind === "review" ? "skipped" : "planned";
}

export function buildWorkflowGraph(run?: WorkflowGraphInput): WorkflowGraph {
  if (!run) return { name: "", phases: [], taskCount: 0 };
  const titles: string[] = [];
  const include = (title: string): void => { if (title && !titles.includes(title)) titles.push(title); };
  for (const phase of run.meta.phases ?? []) include(typeof phase === "string" ? phase : phase.title ?? phase.name ?? "");
  const declared = new Set(titles);
  for (const task of [...run.tasks].sort((left, right) => left.index - right.index)) if (task.phase) include(task.phase);
  const resultFailure = resultCheckFailure(run);
  const reviewFailure = failureContext(run)?.kind === "review";
  if (resultFailure?.phase) include(resultFailure.phase);
  const unphased = run.tasks.filter(task => !task.phase);
  const unphasedTitle = titles.length ? "未分阶段的任务" : "任务执行";
  const phases: WorkflowGraphPhase[] = titles.map(title => {
    const tasks = run.tasks.filter(task => task.phase === title);
    const status = phaseStatus(tasks, run);
    return { title, status, kind: "phase", declared: declared.has(title), groups: groupTasks(tasks), placeholder: status === "skipped" ? "本次没有派发任务" : "任务将在实际派发后显示" };
  });
  if (unphased.length || !phases.length && !reviewFailure) {
    const workflowOnly = !titles.length && !unphased.length;
    const status: GraphStatus = workflowOnly ? run.execution === "draft" ? "planned" : run.execution === "preparing" ? "running" : workflowStatuses.has(run.execution) ? run.execution : "unknown" : phaseStatus(unphased, run);
    phases.push({ title: workflowOnly ? run.meta.name : unphasedTitle, status, kind: workflowOnly ? "workflow" : "phase", declared: false, groups: groupTasks(unphased), placeholder: run.execution === "draft" ? "启动后展示动态任务" : run.execution === "running" ? "等待脚本派发任务" : "本次尚未派发任务" });
  }
  if (resultFailure) {
    const relatedTask = run.tasks.find(task => task.id === resultFailure.afterTaskId);
    const target = phases.find(phase => phase.title === resultFailure.phase) ?? phases.find(phase => phase.title === relatedTask?.phase) ?? phases.find(phase => phase.groups.some(group => group.tasks.some(task => task.id === relatedTask?.id))) ?? phases.at(-1);
    if (target) { target.status = "failed"; target.resultCheckFailed = true; }
  }
  if (reviewFailure) phases.push({ title: "改动审查", status: "failed", kind: "workflow", declared: false, groups: [], placeholder: run.tasks.every(task => task.status === "completed") ? "已完成任务结果保留，可重试审查" : "部分任务未完成，可继续恢复", reviewFailed: true });
  return { name: run.meta.name, phases, taskCount: run.tasks.length };
}

function statusIcon(status: GraphStatus): string {
  return status === "completed" ? "circle-check" : status === "failed" || status === "unknown" ? "alert-circle" : status === "running" ? "loader-2" : status === "stopping" || status === "interrupted" || status === "stopped" ? "player-stop" : "circle";
}

function settingsButton(key: string, label: string, run: WorkflowGraphInput): string {
  const disabled = !!run.deletionPending || ["preparing", "running", "stopping"].includes(run.execution);
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

export function elapsedLabel(startedAt?: string, endedAt?: string, now = Date.now()): string {
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return "";
  const end = endedAt && Number.isFinite(Date.parse(endedAt)) ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function icon(status: GraphStatus, extra = ""): string {
  return `<span class="wf-icon${status === "running" ? " is-spinning" : ""}${extra}" data-icon="${statusIcon(status)}" aria-hidden="true"></span>`;
}
function renderTask(task: GraphTask, run: WorkflowGraphInput, selectedTaskId?: string, now = Date.now(), compact = false, allowSettings = true): string {
  const title = (task.label?.trim() || `任务 ${task.index + 1}`).slice(0, 120);
  const state = taskStatus(task), fixedCommand = Object.hasOwn(task.options, "operation");
  const latest = task.attempts.at(-1);
  const detail = `${fixedCommand ? "固定命令" : task.mode === "write" ? "写入任务" : "只读任务"}${task.cached ? " · 已复用结果" : task.attempts.length > 1 ? ` · 第 ${task.attempts.length} 次尝试` : ""}`;
  const label = state === "running" && task.currentActivity?.label ? task.currentActivity.label : title;
  return `<div class="wf-graph-node-shell"><button type="button" class="wf-graph-node${selectedTaskId === task.id ? " is-selected" : ""}${task.cached ? " is-cached" : ""}" data-task="${escape(task.id)}" data-status="${state}" data-compact="${compact}" aria-pressed="${selectedTaskId === task.id}" aria-label="${escape(`${title}，${statusLabels[state]}，${detail}`)}">${compact && state === "running" ? "" : icon(state, " wf-graph-node-icon")}<span class="wf-graph-node-content"><span class="wf-graph-node-title">${escape(label)}</span>${compact ? "" : `<span class="wf-graph-node-status">${escape(statusLabels[state])}${latest?.startedAt ? ` · ${elapsedLabel(latest.startedAt, latest.endedAt, now)}` : ""}</span>`}${fixedCommand ? "" : `<span class="wf-graph-node-model">${escape(taskConfiguration(task, run))}</span>`}</span></button>${allowSettings && !fixedCommand ? settingsButton(`task:${task.index}`, title, run) : ""}</div>`;
}
export function renderWorkflowGraph(run?: WorkflowGraphInput, selectedTaskId?: string, now = Date.now()): string {
  const graph = buildWorkflowGraph(run);
  if (!run) return '<div class="wf-graph wf-graph-empty"><p class="wf-graph-placeholder">选择工作流并保存预览后，执行图将在这里显示。</p></div>';
  const connector = '<div class="wf-graph-connector" aria-label="阶段展示顺序"><span class="wf-icon" data-icon="chevron-right" aria-hidden="true"></span></div>';
  const phases = graph.phases.map(phase => {
    const tasks = phase.groups.flatMap(group => group.tasks);
    const active = tasks.find(task => task.status === "running" || task.status === "stopping") ?? [...tasks].reverse().find(task => task.status === "failed");
    const primary = active ?? tasks.at(-1), latest = primary?.attempts.at(-1);
    const label = phase.reviewFailed ? "审查失败" : phase.resultCheckFailed ? "结果检查失败" : phase.status === "planned" ? phase.kind === "workflow" ? "待开始" : "待派发" : statusLabels[phase.status];
    const identity = phase.kind === "workflow" ? 'data-process-scope="workflow"' : !phase.declared && tasks.length && tasks.every(task => !task.phase) ? 'data-process-scope="unphased"' : `data-phase="${escape(phase.title)}"`;
    const containerIdentity = identity.startsWith("data-phase=") ? `data-phase-container="${escape(phase.title)}"` : identity;
    const settings = configurationLabel(mergeSettings(run.executionSettings, phase.declared ? run.nodeSettings?.[`phase:${phase.title}`] : undefined));
    const single = tasks.length === 1;
    const nodeSettings = phase.declared ? settingsButton(`phase:${phase.title}`, phase.title, run) : single && !Object.hasOwn(primary!.options, "operation") ? settingsButton(`task:${primary!.index}`, phase.title, run) : "";
    const completedActivity = primary?.status === "running" ? [...(latest?.activities ?? [])].reverse().find(activity => activity.status === "completed" && ["command", "files", "search", "mcp"].includes(activity.kind)) : undefined;
    const taskList = tasks.length > 1 ? `<details class="wf-graph-task-list" data-graph-detail="${escape(phase.title)}"><summary>${tasks.length} 个实际任务 · 查看明细</summary><div class="wf-graph-groups">${phase.groups.map(group => `<div class="wf-graph-group" data-concurrent="${group.concurrent}">${group.concurrent ? `<div class="wf-graph-group-label">${group.live ? "并行任务组" : "曾有并行"} · ${group.tasks.length} 个任务</div>` : ""}<div class="wf-graph-nodes">${group.tasks.filter(task => task.id !== primary?.id).map(task => renderTask(task, run, selectedTaskId, now)).join("")}</div></div>`).join("")}</div></details>` : "";
    return `<section class="wf-graph-phase" data-status="${phase.status}" data-kind="${phase.kind}" ${containerIdentity}><header class="wf-graph-phase-heading">${icon(phase.status)}<span class="wf-graph-phase-title">${escape(phase.title)}</span><button type="button" class="wf-node-process-icon" ${phase.kind === "workflow" ? 'id="wf-whole-workflow-process"' : identity.includes("unphased") ? 'id="wf-unphased-process"' : ""} ${identity} aria-label="${escape(`查看 ${phase.title} 的过程与错误`)}"><span class="wf-icon" data-icon="file-text" aria-hidden="true"></span></button>${nodeSettings}</header><div class="wf-graph-phase-state" data-tone="${phase.status === "running" ? "blue" : phase.status === "failed" ? "red" : phase.status === "completed" ? "green" : "neutral"}">${run.stale ? "上次记录 · " : ""}${escape(label)}${latest?.startedAt ? ` · ${elapsedLabel(latest.startedAt, latest.endedAt, now)}` : ""}</div>${phase.reviewFailed ? `<p class="wf-muted">${escape(phase.placeholder)}</p>` : ""}${primary ? renderTask(primary, run, selectedTaskId, now, true, false) : phase.kind === "workflow" && phase.status === "planned" ? '<p class="wf-graph-node-model">启动后展示动态任务</p>' : ""}${completedActivity ? `<p class="wf-graph-completed-activity"><span class="wf-icon" data-icon="circle-check" aria-hidden="true"></span>${escape(completedActivity.label)}</p>` : ""}${taskList}${["running", "failed", "stopping", "interrupted"].includes(phase.status) ? `<button type="button" class="wf-node-view-process" ${identity}>${phase.status === "failed" ? "查看错误" : "查看过程"}<span class="wf-icon" data-icon="chevron-right" aria-hidden="true"></span></button>` : ""}${phase.reviewFailed ? "" : `<span class="wf-graph-node-model">${escape(settings)}</span>`}</section>`;
  }).join(connector);
  return `<div class="wf-graph" role="region" aria-label="${escape(`${graph.name} 工作流执行图`)}"><div class="wf-graph-scroll"><div class="wf-graph-track">${phases}</div></div><p class="wf-graph-caption">连线表示阶段展示顺序，动态分支与循环以实际派发节点为准。${run.stale ? "连接恢复后核对实际进度。" : ""}</p></div>`;
}
