import type { DefinitionPlan, DefinitionPlanNode } from "../src/definition.ts";
import type { StructuredProjection } from "../src/structured-projection.ts";
export type GraphProjection = StructuredProjection;
export interface GraphPoint {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface GraphLayout {
    nodes: Array<DefinitionPlanNode & GraphPoint>;
    width: number;
    height: number;
}
export const statusLabels: Record<string, string> = {
    planned: "尚未激活", ready: "等待执行", running: "运行中", completed: "已完成", failed: "失败", skipped: "未进入",
    paused: "已暂停", pausing: "正在暂停", waiting: "等待确认", cancelled: "已取消", stopped: "已停止", stopping: "正在停止",
    interrupted: "已中断", unknown: "结果待核实", draft: "待开始", preparing: "正在准备", mixed: "多个实例状态不同",
};
export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function elapsedLabel(startedAt?: string, endedAt?: string, now = Date.now()): string {
    if (!startedAt || !Number.isFinite(Date.parse(startedAt)))
        return "";
    const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function visiblePlan(plan: DefinitionPlan, collapsed: ReadonlySet<string>): DefinitionPlan {
    if (!collapsed.size)
        return plan;
    const byId = new Map(plan.nodes.map(node => [node.id, node]));
    const visibleId = (id: string): string => {
        let result = id, parent = byId.get(id)?.parentId;
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
            visited.add(parent);
            if (collapsed.has(parent))
                result = parent;
            parent = byId.get(parent)?.parentId;
        }
        return result;
    };
    return {
        version: 1,
        nodes: plan.nodes.filter(node => visibleId(node.id) === node.id),
        edges: plan.edges.flatMap(edge => {
            const from = visibleId(edge.from), to = visibleId(edge.to);
            return from === to ? [] : [{ ...edge, from, to }];
        }),
    };
}
/** Geometry consumes declared topology; status always comes from the server projection. */
export function layoutWorkflowGraph(plan: DefinitionPlan): GraphLayout {
    const ids = new Set(plan.nodes.map(node => node.id)), ranks = new Map(plan.nodes.map(node => [node.id, 0]));
    const edges = plan.edges.filter(edge => edge.kind !== "repeat" && ids.has(edge.from) && ids.has(edge.to));
    // A join is placed below its container contents, including loops whose exit edge leaves the header.
    const constraints = [...edges.map(edge => ({ from: edge.from, to: edge.to })), ...plan.nodes.flatMap(join => join.type !== "join" || !join.parentId ? [] : plan.nodes.filter(node => node.id !== join.id && node.parentId === join.parentId).map(node => ({ from: node.id, to: join.id })))];
    for (let pass = 0; pass < plan.nodes.length; pass++) {
        let changed = false;
        for (const edge of constraints) {
            const next = Math.min(plan.nodes.length, (ranks.get(edge.from) ?? 0) + 1);
            if (next > (ranks.get(edge.to) ?? 0)) {
                ranks.set(edge.to, next);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    const rows = new Map<number, DefinitionPlanNode[]>();
    for (const node of plan.nodes) {
        const rank = ranks.get(node.id) ?? 0, row = rows.get(rank) ?? [];
        row.push(node);
        rows.set(rank, row);
    }
    const width = Math.max(760, Math.max(1, ...[...rows.values()].map(row => row.length)) * 300 + 100);
    return {
        width, height: Math.max(400, (Math.max(0, ...ranks.values()) + 1) * 138 + 90),
        nodes: [...rows].flatMap(([rank, row]) => row.map((node, index) => {
            const widthNode = node.type === "join" ? 16 : 240;
            return { ...node, width: widthNode, height: node.type === "join" ? 16 : node.type === "choice" ? 100 : 76, x: (width - row.length * 300) / 2 + index * 300 + 150 - widthNode / 2, y: 45 + rank * 138 };
        })),
    };
}
function symbol(status: string): string { return status === "running" ? "loader-2" : status === "completed" ? "circle-check" : status === "failed" || status === "unknown" ? "alert-circle" : "circle"; }
const containerLabels: Record<string, string> = { repeat: "循环", map: "逐项执行", parallel: "并行", try: "异常处理", subflow: "子流程", expand: "动态子流程" };
export function renderWorkflowGraph(plan?: DefinitionPlan, projection?: GraphProjection, selectedNodeId?: string, collapsed: ReadonlySet<string> = new Set()): string {
    if (!plan?.nodes.length)
        return '<p class="wf-graph-empty">在对话中描述任务，让 AI 创建工作流。</p>';
    const display = visiblePlan(plan, collapsed), layout = layoutWorkflowGraph(display), byId = new Map(layout.nodes.map(node => [node.id, node]));
    const states = new Map(projection?.nodes.map(node => [node.id, node]) ?? []), edgeStates = new Map(projection?.edges.map(edge => [edge.id, edge]) ?? []);
    const isDescendant = (node: DefinitionPlanNode, id: string): boolean => {
        let parent = node.parentId;
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
            if (parent === id)
                return true;
            visited.add(parent);
            parent = byId.get(parent)?.parentId;
        }
        return false;
    };
    const groups = layout.nodes.filter(node => !!containerLabels[node.type] && !collapsed.has(node.id)).map(node => {
        const members = [node, ...layout.nodes.filter(child => isDescendant(child, node.id))];
        if (members.length < 2)
            return "";
        const x = Math.min(...members.map(member => member.x)) - 18, y = node.y - 14, right = Math.max(...members.map(member => member.x + member.width)) + 18, bottom = Math.max(...members.map(member => member.y + member.height)) + 18;
        return `<div class="wf-container-region" style="left:${x}px;top:${y}px;width:${right - x}px;height:${bottom - y}px" aria-hidden="true"></div>`;
    }).join("");
    const paths = display.edges.map(edge => {
        const from = byId.get(edge.from), to = byId.get(edge.to);
        if (!from || !to)
            return "";
        const startX = from.x + from.width / 2, startY = from.y + from.height, endX = to.x + to.width / 2, endY = to.y;
        const path = edge.kind === "repeat" ? `M ${startX} ${startY} H ${Math.max(from.x + from.width, to.x + to.width) + 28} V ${endY - 20} H ${endX} V ${endY}` : `M ${startX} ${startY} V ${(startY + endY) / 2} H ${endX} V ${endY}`;
        const label = edge.kind === "case" ? edge.branchId ?? "条件满足" : edge.kind === "default" ? "默认" : edge.kind === "repeat" ? "下一轮" : edge.kind === "exit" ? "退出" : edge.kind === "catch" ? "异常" : edge.kind === "finally" ? "收尾" : edge.kind === "branch" ? edge.branchId ?? "并行" : "";
        const state = edgeStates.get(edge.id);
        return `<g data-edge="${escapeHtml(edge.id)}" data-status="${escapeHtml(state?.status ?? "planned")}"${state?.inScope === false ? ' class="is-out-of-scope"' : ""}><path d="${path}" marker-end="url(#wf-arrow)"/>${label ? `<text x="${(startX + endX) / 2 + 8}" y="${(startY + endY) / 2 - 8}">${escapeHtml(label)}</text>` : ""}</g>`;
    }).join("");
    const nodes = layout.nodes.map(node => {
        const state = states.get(node.id), status = state?.status ?? "planned", container = containerLabels[node.type];
        if (node.type === "join")
            return `<span class="wf-join" style="left:${node.x}px;top:${node.y}px" data-status="${escapeHtml(status)}" title="${escapeHtml(node.label)}" aria-label="${escapeHtml(node.label)}"></span>`;
        const instanceCount = state?.instanceIds.length ?? 0;
        const displayStatus=state?.inScope===false?"当前范围外":statusLabels[status]??status;
        const iterationLabel = state?.iterations?.length ? ` · ${state.iterations.length} 个轮次` : state?.itemKeys?.length ? ` · ${state.itemKeys.length} 项` : "";
        const toggle = container && plan!.nodes.some(child => child.parentId === node.id) ? `<button type="button" class="wf-collapse" style="left:${node.x + node.width - 27}px;top:${node.y + 5}px" data-collapse="${escapeHtml(node.id)}" aria-expanded="${!collapsed.has(node.id)}" aria-label="${escapeHtml(`${collapsed.has(node.id) ? "展开" : "收起"} ${node.label}`)}">${collapsed.has(node.id) ? "+" : "−"}</button>` : "";
        return `<button type="button" class="wf-graph-node${node.type === "choice" ? " wf-choice" : ""}${container ? " wf-container-node" : ""}${selectedNodeId === node.id ? " is-selected" : ""}${state?.inScope === false ? " is-out-of-scope" : ""}" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px" data-node="${escapeHtml(node.id)}" data-status="${escapeHtml(status)}" aria-pressed="${selectedNodeId === node.id}" aria-label="${escapeHtml(`${node.label}，${displayStatus}`)}"><span class="wf-node-shape" aria-hidden="true"></span><span class="wf-node-content"><span class="wf-node-title"><span class="wf-icon${status === "running" ? " is-spinning" : ""}" data-icon="${symbol(status)}" aria-hidden="true"></span>${escapeHtml(node.label)}</span><span class="wf-node-status">${escapeHtml(displayStatus)}${instanceCount ? ` · ${instanceCount} 个实例` : ""}${iterationLabel}${container ? ` · ${container}` : ""}</span></span></button>${toggle}`;
    }).join("");
    return `<div class="wf-graph-plane" style="width:${layout.width}px;height:${layout.height}px">${groups}<svg class="wf-graph-edges" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true"><defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${paths}</svg>${nodes}</div>`;
}
