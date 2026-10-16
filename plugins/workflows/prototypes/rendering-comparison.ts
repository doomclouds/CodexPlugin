import type { PathArray } from "@antv/util/lib/path/types.js";
import type { Graph as G6Graph } from "@antv/g6/lib/runtime/graph.js";
import type { GraphOptions } from "@antv/g6/lib/spec/graph.js";
import type { GraphData } from "@antv/g6/lib/spec/data.js";
import type { BaseEdgeStyleProps } from "@antv/g6/lib/elements/edges/base-edge.js";
import type { RectComboStyleProps } from "@antv/g6/lib/elements/combos/rect.js";
import type { RectCombo } from "@antv/g6/lib/elements/combos/rect.js";
import type { BaseEdge } from "@antv/g6/lib/elements/edges/base-edge.js";
import type { StructuredRun } from "../src/structured-types.ts";
import type { StructuredProjection } from "../src/structured-projection.ts";
import type { CanvasInput, GraphFont, GraphGeometry, GraphPoint } from "./graph-types.ts";
import { buildGraphScene } from "./graph-model.ts";
import { createBrowserGraphLayout } from "./graph-browser-layout.ts";
import { WorkflowGraphCanvas, graphEdgeStatus, graphNodeStates } from "./graph-renderer.ts";
import { statusLabels } from "./panel-graph.ts";

interface Fixture { run: StructuredRun; projection: StructuredProjection; }
interface G6Module {
    Graph: new (options: GraphOptions) => G6Graph;
    RectCombo: typeof RectCombo;
    BaseEdge: typeof BaseEdge;
    register(category: string, name: string, extension: unknown): void;
    ExtensionCategory: { COMBO: string; EDGE: string; };
}
const aliases:Record<string,string>={"compare-x6":"comparison-x6-viewport","compare-g6":"g6-canvas","compare-size":"comparison-size","compare-fit":"comparison-fit","compare-error":"comparison-error","compare-selection":"comparison-selection","compare-x6-ms":"x6-metrics","compare-g6-ms":"g6-metrics","compare-state":"comparison-state","compare-node-count":"comparison-count","compare-layout-ms":"comparison-layout","compare-reload":"comparison-reload"};
const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(aliases[id]??id); if (!element) throw new Error(`Missing comparison element: ${id}`); return element as T;
};
const setText = (id: string, value: unknown): void => { node(id).textContent = String(value); };
const millis = (value: number): string => `${value.toFixed(1)} ms`;
const x6Host=document.createElement("div");x6Host.id="comparison-x6-viewport";node("x6-canvas").append(x6Host);
for(const [id,text] of [["comparison-state","正在准备…"],["comparison-layout","共享 ELK 布局：—"],["comparison-count","—"]]){const paragraph=document.createElement("p");paragraph.id=id!;paragraph.textContent=text!;node("comparison-error").before(paragraph);}
const reload=document.createElement("button");reload.type="button";reload.id="comparison-reload";reload.textContent="重新测量";node("comparison-fit").after(reload);
const note=document.createElement("p");note.textContent="同布局，不比较默认算法：两端共享测量后的 Scene、浏览器 Worker ELK 节点/容器坐标与边路径。G6 的固定几何 Combo/Edge 扩展不运行其默认布局。每一轮两端都销毁旧图并创建全新图实例。计时包含构造、适配、绘制与适应窗口，不含模块首次导入/注册、共享 ELK 布局及旧图销毁；页面脚本解析发生在计时之前。两端均关闭缩略图；形状、状态图标与交互适配仍有差异，数值不等于纯库内核性能。不推断通用性能胜负。";node("comparison-error").before(note);
const styles=document.createElement("style");styles.textContent="#comparison-error{color:#ff9c9c;white-space:pre-wrap}.comparison-panels{min-width:0}.comparison-panels section{min-width:0}.comparison-canvas{font:14px/20px system-ui;min-width:0}#x6-canvas{position:relative}#comparison-x6-viewport{position:absolute;inset:0}#comparison-selection{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:850px){.comparison-panels{grid-template-columns:1fr}}";document.head.append(styles);
const layout = createBrowserGraphLayout();
let fixture: Fixture | undefined, geometry: GraphGeometry | undefined, x6:WorkflowGraphCanvas|undefined,g6: G6Graph | undefined, g6Module: G6Module | undefined;
let generation = 0, closed = false, request: AbortController | undefined, sharedHits = 0;
const collapsed = new Set<string>();
function selection(renderer: string, id: string): void {
    const projected = fixture?.projection.nodes.find(item => item.id === id), logical = geometry?.nodes.find(item => item.id === id)?.ownerId ?? id;
    const source = projected ?? fixture?.projection.nodes.find(item => item.id === logical);
    const instances = fixture?.run.instances.filter(instance => source?.instanceIds.includes(instance.id)) ?? [];
    setText("compare-selection", JSON.stringify({ renderer, projectionNodeId: logical, label: source?.label, status: source?.status, inScope: source?.inScope, instances: instances.map(instance => ({ id: instance.id, iteration: instance.iteration, status: instance.status })), note: "只读验收；worker 为替身，不调度任务。" }, null, 2));
}
function createX6():WorkflowGraphCanvas{return new WorkflowGraphCanvas(node("compare-x6"), {
    onSelectNode: id => selection("X6", id),
    onToggleCollapse: id => { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); void compare(); },
    onError: error => setText("compare-error", `X6: ${error}`),
}, { miniMap:false,layout: async (scene, signal) => {
    if (geometry?.signature === scene.signature) { sharedHits++; return geometry; }
    throw new Error("X6 请求的 scene 与共享 ELK geometry 不一致；未执行不同布局来掩盖差异。");
} });}
function font(): GraphFont {
    const style = getComputedStyle(node("compare-x6")), size = Number.parseFloat(style.fontSize) || 14, line = Number.parseFloat(style.lineHeight);
    return { family: style.fontFamily, size, lineHeight: Number.isFinite(line) ? line : size * 1.45 };
}
async function loadG6(): Promise<G6Module> {
    if (g6Module) return g6Module;
    // Types and override points were checked against the installed G6 5.1.1 package.
    const module = await import("@antv/g6") as unknown as G6Module;
    class ElKCombo extends module.RectCombo {
        protected getKeySize(attributes: Required<RectComboStyleProps>): [number, number, number] {
            const size = attributes.size; return Array.isArray(size) ? [Number(size[0]), Number(size[1] ?? size[0]), 0] : [Number(size), Number(size), 0];
        }
        getComboPosition(attributes: Required<RectComboStyleProps>): [number, number, number] { return [Number(attributes.x), Number(attributes.y), 0]; }
    }
    class ElKEdge extends module.BaseEdge {
        protected getKeyPath(attributes: Required<BaseEdgeStyleProps>): PathArray {
            const sections = (attributes as Required<BaseEdgeStyleProps> & { geometrySections?: GraphPoint[][] }).geometrySections ?? [];
            const first=sections[0]?.[0]??{x:0,y:0},commands:PathArray=[["M",first.x,first.y]];
            sections.forEach((section,index)=>{if(index&&section[0])commands.push(["M",section[0].x,section[0].y]);for(const point of section.slice(1))commands.push(["L",point.x,point.y]);});return commands;
        }
    }
    module.register(module.ExtensionCategory.COMBO, "workflow-comparison-elk-combo", ElKCombo);
    module.register(module.ExtensionCategory.EDGE, "workflow-comparison-elk-edge", ElKEdge);
    g6Module = module; return module;
}
function color(status: string): { stroke: string; fill: string } {
    return status === "completed" ? { stroke: "#61bf8b", fill: "#213c2c" } : status === "running" ? { stroke: "#79a9ff", fill: "#203552" } : status === "failed" ? { stroke: "#ff8686", fill: "#482626" } : status === "unknown" || status === "waiting" ? { stroke: "#e9be73", fill: "#3e3422" } : { stroke: "#62646a", fill: "#1d1e21" };
}
function g6Data(value: GraphGeometry, input: CanvasInput, typography: GraphFont): GraphData {
    const states = graphNodeStates(value, input), groups = new Set(value.nodes.filter(item => item.kind === "group").map(item => item.id));
    return {
        nodes: value.nodes.filter(item => item.kind !== "group").map(item => {
            const state = states.get(item.id)!, palette = color(state.status), label = item.kind === "join" ? "" : `${(item.labelLines ?? [item.label]).join("\n")}\n${state.inScope ? statusLabels[state.status] ?? state.status : "当前范围外"}`;
            return { id: item.id, type: item.kind === "choice" ? "diamond" : item.kind === "join" ? "circle" : "rect", ...(item.parentId && groups.has(item.parentId) ? { combo: item.parentId } : {}), data: { projectionNodeId: item.ownerId ?? item.id }, style: {
                x: item.x + item.width / 2, y: item.y + item.height / 2, size: [item.width, item.height], radius: 10, fill: palette.fill, stroke: palette.stroke, lineWidth: 1.5, opacity: state.inScope ? 1 : .3,
                labelText: label, labelFill: "#e6e8eb", labelFontFamily: typography.family, labelFontSize: typography.size, labelLineHeight: typography.lineHeight, labelPlacement: "center", labelWordWrap: false,
            } };
        }),
        combos: value.nodes.filter(item => item.kind === "group").map(item => ({ id: item.id, type: "workflow-comparison-elk-combo", ...(item.parentId && groups.has(item.parentId) ? { combo: item.parentId } : {}), data: { projectionNodeId: item.ownerId ?? item.id }, style: {
            x: item.x + item.width / 2, y: item.y + item.height / 2, size: [item.width, item.height], padding: 0, collapsed: false, label: false, fill: "#22242a", fillOpacity: .2, stroke: "#62646a", lineWidth: 1, lineDash: [5, 5], radius: 14,
        } })),
        edges: value.edges.filter(edge => !edge.hidden).map(edge => {
            const state = graphEdgeStatus(edge, input), palette = color(state.status);
            return { id: edge.id, source: edge.source, target: edge.target, type: "workflow-comparison-elk-edge", data: { originalEdgeIds: edge.originalEdgeIds }, style: {
                geometrySections: edge.sections, stroke: palette.stroke, lineWidth: 1.5, lineDash: state.status === "planned" ? [4, 5] : [], opacity: state.inScope ? 1 : .3, endArrow: true, loop: false,
                labelText: edge.label, labelFill: "#babdc4", labelFontFamily: typography.family, labelFontSize: Math.max(10, typography.size - 1), labelBackground: true, labelBackgroundFill: "#191a1d", labelPlacement: "center",
            } };
        }),
    };
}
async function drawG6(value: GraphGeometry, input: CanvasInput, typography: GraphFont): Promise<void> {
    const module = await loadG6(), container = node("compare-g6");
    if (!g6) {
        g6 = new module.Graph({ container, width: container.clientWidth, height: container.clientHeight, animation: false, autoResize: false, padding: 32, data: { nodes: [], edges: [], combos: [] }, behaviors: ["drag-canvas", "zoom-canvas"], transforms: [], theme: "dark", zoomRange:[.001,3] });
        for (const event of ["node:click", "combo:click"]) g6.on(event, event => { const target=(event as {target?:{id?:string}}).target;if(target?.id)selection("G6",target.id); });
    }
    g6.setSize(container.clientWidth, container.clientHeight); g6.setData(g6Data(value, input, typography)); await g6.render(); await g6.fitView(undefined, false);
}
function input(): CanvasInput {
    if (!fixture) throw new Error("No comparison fixture loaded.");
    return { plan: fixture.projection, projection: fixture.projection, collapsed: new Set(collapsed), identity: `comparison:${fixture.run.id}` };
}
async function compare(): Promise<void> {
    if (closed) return;
    const current = ++generation; request?.abort(); request = new AbortController();
    const select = node<HTMLSelectElement>("compare-size"), size = [0,20, 100, 500].includes(Number(select.value)) ? Number(select.value) : 0;
    select.disabled = true; node<HTMLButtonElement>("compare-reload").disabled = true; setText("compare-error", ""); setText("compare-state", "正在获取并校验相同的后端 fixture…");setText("compare-x6-ms","—");setText("compare-g6-ms","—");
    try {
        const response = await fetch(`/fixture?size=${size}`, { signal: request.signal });
        if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
        const value = await response.json() as Fixture;
        if (value.run?.format !== "structured-v1" || value.projection?.definitionHash !== value.run.definitionHash || value.projection.revision !== value.run.revision) throw new Error("Fixture run/projection identity mismatch.");
        if (current !== generation || closed) return; fixture = value;
        x6?.dispose();x6=undefined;g6?.destroy();g6=undefined;
        const warmStarted=performance.now();await Promise.all([import("@antv/x6"),loadG6()]);const warmMs=performance.now()-warmStarted;
        if(current!==generation||closed)return;
        const typography = font(), scene = buildGraphScene(value.projection, { collapsed, font: typography }), layoutStarted = performance.now();
        geometry = await layout.layout(scene, request.signal);
        if (current !== generation || closed) return;
        const sharedMs=performance.now()-layoutStarted;setText("compare-layout-ms",`共享 ELK 布局：${millis(sharedMs)}`); setText("compare-node-count", `${scene.nodes.filter(item => item.kind !== "group").length} 节点 / ${scene.nodes.filter(item => item.kind === "group").length} 容器 / ${scene.edges.filter(edge => !edge.hidden).length} 边`);
        sharedHits = 0; const canvasInput = input(), x6Started = performance.now();x6=createX6();await x6.update(canvasInput);x6.fit();if(sharedHits!==1)throw new Error("本轮 X6 未完整读取一次共享几何，fresh graph 对照无效。");
        if (current !== generation || closed) return; setText("compare-x6-ms",`X6 全新实例：构造/适配/绘制/fit：${millis(performance.now() - x6Started)}\n共享布局：${millis(sharedMs)} · 节点 ${geometry.nodes.length}`);
        const g6Started = performance.now(); await drawG6(geometry, canvasInput, typography);
        if (current !== generation || closed) return; setText("compare-g6-ms",`G6 全新实例：构造/适配/绘制/fit：${millis(performance.now() - g6Started)}\n共享布局：${millis(sharedMs)} · 节点 ${geometry.nodes.length}`);
        setText("compare-state", `每轮两端均为 fresh graph；同一 Scene / ELK geometry；X6共享几何命中${sharedHits}次。模块预热/注册 ${millis(warmMs)}（不计入两端绘制；不含页面脚本解析）。run ${value.run.id} · revision ${value.run.revision} · ${value.run.status}。`);
    } catch (error) { if (current === generation && !closed && !(error instanceof Error && error.name === "AbortError")) { setText("compare-error", error instanceof Error ? error.message : String(error)); setText("compare-state", "对照未完成；不将失败数据记为性能结果。"); } }
    finally { if (current === generation && !closed) { select.disabled = false; node<HTMLButtonElement>("compare-reload").disabled = false; } }
}
node("compare-reload").addEventListener("click", () => { void compare(); }); node("compare-size").addEventListener("change", () => { collapsed.clear(); void compare(); });
node("compare-fit").addEventListener("click", () => { x6?.fit(); void g6?.fitView(undefined, false); });
const resize = new ResizeObserver(() => { if (g6 && !closed) g6.setSize(node("compare-g6").clientWidth, node("compare-g6").clientHeight); }); resize.observe(node("compare-g6"));
window.addEventListener("pagehide", () => { closed = true; generation++; request?.abort(); resize.disconnect(); x6?.dispose(); layout.dispose(); g6?.destroy(); });
void compare();
