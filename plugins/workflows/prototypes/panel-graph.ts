import type { FlowBlock, FlowEvent, FlowPlan, WorkflowAttempt, WorkflowRun, WorkflowTask } from "./panel.ts";
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
  flowPlan?: FlowPlan;
  flowEvents?: FlowEvent[];
  flowTraceTruncated?: boolean;
  flowExecutionId?: string;
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
  if (run?.flowPlan?.version === 1 && run.flowPlan.blocks.length) return renderControlFlowGraph(run, selectedTaskId, now);
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

type Point = [number, number];
type RouteState = "active" | "inactive" | "planned";
interface FlowSize { width: number; height: number }
export interface ControlFlowNode extends FlowSize {
  block: FlowBlock; x: number; y: number; status: GraphStatus; tasks: GraphTask[];
  excluded: boolean; condition?: boolean; iterations: number[];
  loopId?: string;
}
export interface ControlFlowEdge { points: Point[]; state: RouteState; label?: string; back?: boolean }
export interface ControlFlowGraph extends FlowSize {
  nodes: ControlFlowNode[]; edges: ControlFlowEdge[]; joins: Point[];
  groups: Array<ControlFlowNode & { parallel: boolean }>;
  unmappedTasks: GraphTask[]; historicalTasks: GraphTask[]; warnings: string[]; traceAvailable: boolean;
}

const flowGap = 28;
const flowCard: FlowSize = { width: 286, height: 70 };

// Layout follows the declared syntax tree. Execution colors are driven only by
// recorded decisions and source-linked tasks; visual adjacency is not evidence.
export function buildControlFlowGraph(run: WorkflowGraphInput): ControlFlowGraph {
  const plan = run.flowPlan;
  const nodes: ControlFlowNode[] = [], groups: ControlFlowGraph["groups"] = [], edges: ControlFlowEdge[] = [], joins: Point[] = [];
  const warnings = [...(plan?.warnings ?? [])];
  const events = (run.flowEvents ?? []).filter(event => event && typeof event.nodeId === "string" && Number.isSafeInteger(event.sequence)).sort((a, b) => a.sequence - b.sequence);
  const observed = new Map<string, FlowEvent[]>();
  for (const event of events) observed.set(event.nodeId, [...observed.get(event.nodeId) ?? [], event]);
  const currentTasks = run.tasks.filter(task => run.flowExecutionId ? task.flowExecutionId === run.flowExecutionId : events.length > 0);
  const historicalTasks = run.tasks.filter(task => !currentTasks.includes(task));
  const linked = new Map<string, GraphTask[]>();
  for (const task of currentTasks) if (task.flowNodeId) linked.set(task.flowNodeId, [...linked.get(task.flowNodeId) ?? [], task]);
  const used = new Set<string>(), ids = new Set<string>();
  let visited = 0;
  const safeBlocks = (blocks: FlowBlock[] | undefined, depth = 0): FlowBlock[] => {
    if (!Array.isArray(blocks) || depth > 16) { if (depth > 16) warnings.push("嵌套层级过深，其余实际任务列在图下方。"); return []; }
    return blocks.flatMap(block => {
      if (!block || typeof block.id !== "string" || !block.id || ids.has(block.id) || !["task", "condition", "loop", "parallel", "opaque"].includes(block.kind) || ++visited > 200) return [];
      ids.add(block.id);
      const { terminal, ...rest } = block;
      return [{ ...rest, ...(terminal && ["return", "throw", "break", "continue"].includes(terminal) ? { terminal } : {}), label: typeof block.label === "string" ? block.label.slice(0, 160) : "未命名节点", yes: safeBlocks(block.yes, depth + 1), no: safeBlocks(block.no, depth + 1), body: safeBlocks(block.body, depth + 1) }];
    });
  };
  const blocks = safeBlocks(plan?.blocks);
  const sizes = new Map<FlowBlock, FlowSize>();
  const horizontalLoop = (block: FlowBlock): boolean => !!block.body && block.body.length > 1 && block.body.length <= 3 && block.body.every(child => ["task", "condition", "opaque"].includes(child.kind));
  const sequenceSize = (items: FlowBlock[]): FlowSize => {
    const measured = items.map(size);
    return { width: Math.max(flowCard.width, ...measured.map(value => value.width)), height: measured.length ? measured.reduce((sum, value) => sum + value.height, 0) + (measured.length - 1) * flowGap : 48 };
  };
  const size = (block: FlowBlock): FlowSize => {
    const cached = sizes.get(block); if (cached) return cached;
    let result = { ...flowCard };
    if (block.kind === "condition") {
      const yes = sequenceSize(block.yes ?? []), no = sequenceSize(block.no ?? []);
      result = { width: yes.width + no.width + 64, height: 110 + Math.max(yes.height, no.height) + 38 };
    } else if (block.kind === "loop") {
      const children = (block.body ?? []).map(size), body = sequenceSize(block.body ?? []);
      result = horizontalLoop(block) ? { width: children.reduce((sum, child) => sum + child.width, 0) + Math.max(0, children.length - 1) * flowGap + 112, height: Math.max(...children.map(child => child.height)) + 120 } : { width: Math.max(410, body.width + 112), height: body.height + 120 };
    } else if (block.kind === "parallel") {
      const lanes = (block.body ?? []).map(size);
      result = { width: Math.max(410, lanes.reduce((sum, lane) => sum + lane.width, 0) + Math.max(0, lanes.length - 1) * 40 + 56), height: Math.max(48, ...lanes.map(lane => lane.height)) + 116 };
    }
    sizes.set(block, result); return result;
  };
  const tasksIn = (block: FlowBlock): GraphTask[] => [...linked.get(block.id) ?? [], ...[...block.yes ?? [], ...block.no ?? [], ...block.body ?? []].flatMap(tasksIn)];
  const continues = (items: FlowBlock[]): boolean => items.every(block => !block.terminal && (block.kind !== "condition" || continues(block.yes ?? []) || continues(block.no ?? [])));
  const loopStack: Array<{ id: string; entry: Point; exit: Point; left: number; right: number }> = [];
  const route = (points: Point[], state: RouteState, label?: string, back?: boolean): void => { edges.push({ points, state, ...(label ? { label } : {}), ...(back ? { back } : {}) }); };
  const node = (block: FlowBlock, x: number, y: number, dimensions: FlowSize, excluded: boolean): ControlFlowNode => {
    const tasks = [...linked.get(block.id) ?? []].sort((a, b) => a.index - b.index);
    tasks.forEach(task => used.add(task.id));
    const decisions = observed.get(block.id) ?? [];
    const condition = run.flowTraceTruncated ? undefined : [...decisions].reverse().find(event => event.kind === "condition" && typeof event.value === "boolean")?.value;
    const iterations = [...new Set(decisions.filter(event => event.kind === "iteration" && Number.isSafeInteger(event.iteration) && event.iteration! > 0).map(event => event.iteration!))];
    const latest = tasks.at(-1);
    return { block, x, y, ...dimensions, tasks, excluded, ...(condition !== undefined ? { condition } : {}), ...(loopStack.at(-1) ? { loopId: loopStack.at(-1)!.id } : {}), iterations, status: excluded ? "skipped" : latest ? taskStatus(latest) : condition !== undefined ? "completed" : "planned" };
  };
  const sequence = (items: FlowBlock[], x: number, y: number, width: number, excluded: boolean): { start: Point; end: Point } => {
    let top = y, last: Point | undefined, first: Point | undefined;
    for (const block of items) {
      const dimensions = size(block), position = place(block, x + (width - dimensions.width) / 2, top, excluded);
      if (!first) first = position.start;
      if (last) route([last, [last[0], (last[1] + position.start[1]) / 2], [position.start[0], (last[1] + position.start[1]) / 2], position.start], excluded ? "inactive" : tasksIn(block).length || observed.has(block.id) ? "active" : "planned");
      last = continues([block]) ? position.end : undefined; top += dimensions.height + flowGap;
    }
    return { start: first ?? [x + width / 2, y], end: last ?? [x + width / 2, y + 48] };
  };
  const place = (block: FlowBlock, x: number, y: number, excluded: boolean): { start: Point; end: Point } => {
    const dimensions = size(block), center = x + dimensions.width / 2;
    if (block.kind === "condition") {
      const card = node(block, center - 112, y, { width: 224, height: 88 }, excluded); nodes.push(card);
      const yesSize = sequenceSize(block.yes ?? []), noSize = sequenceSize(block.no ?? []), branchY = y + 110;
      const yesX = x, noX = x + yesSize.width + 64;
      const yesExcluded = excluded || card.condition === false, noExcluded = excluded || card.condition === true;
      const yes = sequence(block.yes ?? [], yesX, branchY, yesSize.width, yesExcluded), no = sequence(block.no ?? [], noX, branchY, noSize.width, noExcluded);
      const yesState: RouteState = yesExcluded ? "inactive" : card.condition === true ? "active" : "planned";
      const noState: RouteState = noExcluded ? "inactive" : card.condition === false ? "active" : "planned";
      route([[center - 112, y + 44], [yes.start[0], y + 44], yes.start], yesState, "是");
      route([[center + 112, y + 44], [no.start[0], y + 44], no.start], noState, "否");
      const merge: Point = [center, y + dimensions.height - 12];
      if (continues(block.yes ?? []) || continues(block.no ?? [])) joins.push(merge);
      for (const [branch, state, items] of [[yes, yesState, block.yes ?? []], [no, noState, block.no ?? []]] as const) if (continues([...items])) route([branch.end, [branch.end[0], merge[1]], merge], state);
      if (continues(block.yes ?? []) || continues(block.no ?? [])) route([merge, [center, y + dimensions.height]], excluded ? "inactive" : card.condition === undefined ? "planned" : "active");
      return { start: [center, y], end: [center, y + dimensions.height] };
    }
    if (block.kind === "loop" || block.kind === "parallel") {
      const group = node(block, x, y, dimensions, excluded); groups.push({ ...group, parallel: block.kind === "parallel" });
      const children = tasksIn(block);
      const completedControlLoop = block.kind === "loop" && !run.flowTraceTruncated && group.iterations.length > 0;
      group.status = excluded ? "skipped" : children.some(isLive) ? "running" : children.some(task => task.status === "failed") ? "failed" : run.execution === "completed" && (children.length || completedControlLoop) ? "completed" : !run.flowTraceTruncated && group.iterations.length && ["running", "preparing"].includes(run.execution) ? "running" : "planned";
      // The displayed group and its underlying observation share the same status.
      groups.at(-1)!.status = group.status;
      if (block.kind === "loop") {
        const horizontal = horizontalLoop(block), first = block.body?.[0];
        const entry: Point = horizontal && first ? [x + 56, y + 92 + size(first).height / 2] : [center, y + 92];
        loopStack.push({ id: block.id, entry, exit: [center, y + dimensions.height], left: x + 22, right: x + dimensions.width - 22 });
        let body: { start: Point; end: Point };
        if (horizontal) {
          let left = x + 56, previous: { right: Point; continues: boolean } | undefined, end: Point = entry;
          for (const child of block.body ?? []) {
            const childSize = size(child), position = place(child, left, y + 92, excluded);
            const inlet: Point = child.kind === "condition" ? position.start : [left, y + 92 + childSize.height / 2];
            if (previous?.continues) route(child.kind === "condition" ? [previous.right, [previous.right[0] + 12, previous.right[1]], [previous.right[0] + 12, y + 80], [inlet[0], y + 80], inlet] : [previous.right, [inlet[0], previous.right[1]], inlet], excluded ? "inactive" : tasksIn(child).length || observed.has(child.id) ? "active" : "planned");
            previous = { right: child.kind === "condition" ? position.end : [left + childSize.width, y + 92 + childSize.height / 2], continues: continues([child]) };
            end = position.end; left += childSize.width + flowGap;
          }
          body = { start: entry, end };
        } else body = sequence(block.body ?? [], x + 56, y + 92, dimensions.width - 112, excluded);
        const firstInlet: Point = horizontal && first ? [x + 56 + size(first).width / 2, y + 92] : body.start;
        route([[center, y], [center, y + 72], [firstInlet[0], y + 72], firstInlet], excluded ? "inactive" : !run.flowTraceTruncated && group.iterations.length ? "active" : "planned");
        loopStack.pop();
        const backX = x + 22, bottom = y + dimensions.height - 24;
        if (continues(block.body ?? [])) route([body.end, [body.end[0], bottom], [backX, bottom], [backX, body.start[1]], body.start], excluded ? "inactive" : !run.flowTraceTruncated && group.iterations.length > 1 ? "active" : "planned", "下一轮", true);
      } else {
        const lanes = block.body ?? [], widths = lanes.map(child => size(child).width); let left = x + 28;
        const fork: Point = [center, y + 58], merge: Point = [center, y + dimensions.height - 18]; joins.push(fork, merge);
        for (const [index, child] of lanes.entries()) {
          const lane = place(child, left, y + 80, excluded);
          const state: RouteState = excluded ? "inactive" : tasksIn(child).length ? "active" : "planned";
          route([fork, [lane.start[0], fork[1]], lane.start], state);
          if (continues([child])) route([lane.end, [lane.end[0], merge[1]], merge], state); left += widths[index]! + 40;
        }
      }
      return { start: [center, y], end: [center, y + dimensions.height] };
    }
    const current = node(block, x, y, dimensions, excluded); nodes.push(current);
    const loop = loopStack.at(-1);
    if (loop && !block.terminalLabel && block.terminal === "break") route([[center, y + dimensions.height], [loop.right, y + dimensions.height + 12], [loop.right, loop.exit[1] - 12], loop.exit], excluded ? "inactive" : "planned", "退出循环");
    if (loop && !block.terminalLabel && block.terminal === "continue") route([[center, y + dimensions.height], [loop.left, y + dimensions.height + 12], [loop.left, loop.entry[1] - 12], loop.entry], excluded ? "inactive" : "planned", "继续下一轮", true);
    return { start: [center, y], end: [center, y + dimensions.height] };
  };
  const dimensions = sequenceSize(blocks);
  sequence(blocks, 28, 28, dimensions.width, false);
  if (plan?.truncated || visited > 200) warnings.push("控制流计划仅显示可解析的部分，实际任务仍完整列出。");
  if (run.flowTraceTruncated) warnings.push("本次路径记录已截断，缺失判断保持计划状态。");
  return { width: dimensions.width + 56, height: dimensions.height + 56, nodes, edges, joins, groups, warnings: [...new Set(warnings)], unmappedTasks: currentTasks.filter(task => !used.has(task.id)), historicalTasks, traceAvailable: events.length > 0 };
}

function renderControlFlowGraph(run: WorkflowGraphInput, selectedTaskId?: string, now = Date.now()): string {
  const graph = buildControlFlowGraph(run);
  const point = ([x, y]: Point): string => `${x},${y}`;
  const path = (points: Point[]): string => points.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
  const wires = graph.edges.map(edge => `<g class="wf-flow-route" data-route="${edge.state}"${edge.back ? ' data-loop-back="true"' : ""}><path d="${path(edge.points)}" marker-end="url(#wf-flow-arrow-${edge.state})"/>${edge.label ? `<text x="${edge.points[1]![0]}" y="${edge.points[1]![1] - 9}" text-anchor="middle">${escape(edge.label)}</text>` : ""}</g>`).join("");
  const groupCards = graph.groups.map(group => {
    const maximum = Number.isSafeInteger(group.block.maxIterations) && group.block.maxIterations! > 0 ? group.block.maxIterations : undefined;
    const iteration = group.iterations.at(-1);
    return `<section class="wf-flow-group" data-flow-group="${escape(group.block.id)}" data-status="${group.status}" style="left:${group.x}px;top:${group.y}px;width:${group.width}px;height:${group.height}px"><header><strong>${escape(group.block.label)}</strong><span class="wf-flow-group-badge">${group.parallel ? "并行" : iteration ? run.flowTraceTruncated ? `已记录至第 ${iteration} 轮 · 后续未记录` : `第 ${iteration}${maximum ? ` / ${maximum}` : ""} 轮` : "循环 · 尚未观测"}</span><span class="wf-muted">${group.parallel ? "各路独立执行后汇合" : maximum ? `最多 ${maximum} 轮` : "按脚本条件结束"}</span>${group.iterations.length > 1 ? `<span class="wf-flow-rounds" aria-label="已观测循环轮次">${group.iterations.slice(-8).map(value => `<span${value === iteration && !run.flowTraceTruncated ? ' aria-current="step"' : ""}>第 ${value} 轮</span>`).join("")}</span>` : ""}<button type="button" class="wf-node-process-icon" data-flow-inspect="${escape(group.block.id)}" aria-label="${escape(`查看 ${group.block.label} 的路径记录`)}"><span class="wf-icon" data-icon="file-text" aria-hidden="true"></span></button></header></section>`;
  }).join("");
  const cards = graph.nodes.map(node => {
    const task = node.tasks.at(-1), latest = task?.attempts.at(-1), condition = node.block.kind === "condition";
    const shape = condition ? `<svg class="wf-flow-condition-shape" viewBox="0 0 ${node.width} ${node.height}" aria-hidden="true"><polygon class="wf-flow-diamond" data-status="${node.status}" points="${[[1.5, node.height / 2], [node.width / 2, 1.5], [node.width - 1.5, node.height / 2], [node.width / 2, node.height - 1.5]].map(value => point(value as Point)).join(" ")}"/></svg>` : "";
    const status = node.excluded ? node.tasks.length ? "最近判断未进入 · 保留历史调用" : "最近判断未进入" : condition ? node.condition === undefined ? "等待实际判断" : `最近判断：${node.condition ? "是" : "否"}` : task ? `${node.loopId || node.tasks.length > 1 ? "最近调用 · " : ""}${task.cached ? "已复用结果" : statusLabels[taskStatus(task)]}` : node.block.terminalLabel ? `${node.block.terminal === "continue" ? "继续" : "退出"}至标签 ${node.block.terminalLabel} · 跳转范围待确认` : node.block.terminal ? "控制流指令 · 不代表执行成功" : node.block.kind === "opaque" ? "动态区域 · 查看下方实际任务" : "计划节点 · 尚未派发";
    const process = task ? `data-task="${escape(task.id)}"` : `data-flow-inspect="${escape(node.block.id)}"`;
    const activity = !node.excluded && task && isLive(task) && task.currentActivity?.status === "running" ? task.currentActivity.label : undefined;
    return `<article class="wf-flow-node${condition ? " wf-flow-condition" : ""}${task && task.id === selectedTaskId ? " is-selected" : ""}" data-flow-node="${escape(node.block.id)}" data-status="${node.status}"${node.block.terminal ? ` data-flow-terminal="${node.block.terminal}"` : ""} style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px">${shape}<button type="button" class="wf-flow-node-main" ${process} aria-label="${escape(`查看 ${node.block.label} 的过程`)}">${condition ? "" : icon(node.status)}<span class="wf-flow-node-copy"><strong>${escape(node.block.label)}</strong><small>${run.stale ? "上次记录 · " : ""}${escape(activity || status)}</small></span>${latest?.startedAt ? `<time>${elapsedLabel(latest.startedAt, latest.endedAt, now)}</time>` : ""}<span class="wf-icon wf-flow-process-mark" data-icon="file-text" aria-hidden="true"></span></button>${task && !Object.hasOwn(task.options, "operation") && !condition ? settingsButton(`task:${task.index}`, node.block.label, run) : ""}${node.tasks.length > 1 ? `<details class="wf-flow-invocations" data-graph-detail="flow:${escape(node.block.id)}"><summary>${node.tasks.length} 次实际调用</summary><div>${node.tasks.filter(value => value.id !== task?.id).map(value => renderTask(value, run, selectedTaskId, now)).join("")}</div></details>` : ""}</article>`;
  }).join("");
  const fallback = (graph.unmappedTasks.length ? `<section class="wf-flow-fallback"><h3>其他实际任务 <span>${graph.unmappedTasks.length}</span></h3><p class="wf-muted">这些调用来自动态区域或尚未关联结构节点，按真实执行记录展示。</p>${graph.unmappedTasks.map(task => renderTask(task, run, selectedTaskId, now)).join("")}</section>` : "") + (graph.historicalTasks.length ? `<details class="wf-flow-fallback" data-graph-detail="flow:historical"><summary>历史任务 · ${graph.historicalTasks.length} 项，不代表本轮进度</summary>${graph.historicalTasks.map(task => renderTask(task, run, selectedTaskId, now)).join("")}</details>` : "");
  const context = failureContext(run), resultFailure = resultCheckFailure(run);
  const failure = context?.kind === "review" || resultFailure ? `<button type="button" class="wf-flow-result-error" data-process-scope="workflow"><span class="wf-icon" data-icon="alert-circle" aria-hidden="true"></span>${context?.kind === "review" ? "改动审查失败 · 查看原因" : "结果检查失败 · 查看原因"}</button>` : "";
  return `<div class="wf-graph wf-control-flow" role="region" aria-label="${escape(`${run.meta.name} 控制流执行图`)}"><div class="wf-graph-scroll"><div class="wf-graph-track wf-flow-track" style="width:${graph.width}px;height:${graph.height}px">${groupCards}<svg class="wf-flow-wires" viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}" aria-hidden="true"><defs>${["active", "inactive", "planned"].map(state => `<marker id="wf-flow-arrow-${state}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z"/></marker>`).join("")}</defs>${wires}${graph.joins.map(([x, y]) => `<circle class="wf-flow-join" cx="${x}" cy="${y}" r="4"/>`).join("")}</svg>${cards}</div>${fallback}${failure}${graph.warnings.length ? `<div class="wf-flow-warnings" role="note">${graph.warnings.map(warning => `<p>${escape(warning)}</p>`).join("")}</div>` : ""}</div><div class="wf-flow-legend" aria-label="节点状态图例"><span data-status="completed">${icon("completed")}已完成</span><span data-status="running">${icon("running")}运行中</span><span data-status="failed">${icon("failed")}失败</span><span data-status="planned">${icon("planned")}待执行 / 未进入</span></div><p class="wf-graph-caption">${graph.traceAvailable ? "高亮路径来自实际判断，虚线保留未进入或尚未执行的路径。" : "当前仅展示计划结构；实际条件与循环轮次将在执行时出现。"}${run.stale ? "连接恢复后核对实际进度。" : ""}</p></div>`;
}

export function renderFlowObservation(run: WorkflowGraphInput, nodeId: string): { label: string; html: string } | undefined {
  const graph = buildControlFlowGraph(run);
  const node = [...graph.nodes, ...graph.groups].find(value => value.block.id === nodeId);
  if (!node) return undefined;
  const events = (run.flowEvents ?? []).filter(event => event.nodeId === nodeId && (event.kind === "condition" && typeof event.value === "boolean" || event.kind === "iteration" && Number.isSafeInteger(event.iteration) && event.iteration! > 0)).slice(-40);
  const entries = events.map(event => `<li data-status="completed">${icon("completed")}<span>${event.kind === "condition" ? `条件判断：${event.value ? "是" : "否"}` : `进入第 ${event.iteration} 轮`}</span><time>${escape(new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }))}</time></li>`).join("");
  return { label: node.block.label, html: `<div class="wf-facts"><span>${node.block.kind === "condition" ? "条件节点" : node.block.kind === "loop" ? "循环节点" : node.block.kind === "parallel" ? "并行区域" : "计划节点"}</span><span>${events.length ? "实际执行记录" : "尚无本轮执行记录"}</span></div><p class="wf-process-summary">${events.length ? "下方仅列出本轮实际观测到的路径；未观测分支保留计划状态。" : "这是计划中的结构节点，尚不能确认是否进入。"}</p><ol class="wf-timeline">${entries || '<li><span class="wf-icon" data-icon="circle" aria-hidden="true"></span><span>等待实际执行</span></li>'}</ol>${run.flowTraceTruncated ? '<p class="wf-notice">本轮路径记录已截断，当前只展示已保留的事件。</p>' : ""}` };
}
