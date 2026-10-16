import type { Graph, Node, Edge, CellAttrs } from "@antv/x6";
import type { DefinitionPlan } from "../src/definition.ts";
import type { ProjectionStatus } from "../src/structured-projection.ts";
import { buildGraphScene } from "./graph-model.ts";
import type { CanvasCallbacks, CanvasInput, GraphFont, GraphGeometry, GraphLayoutFunction, GraphPoint, GraphScene, GraphState, LayoutEdge, LayoutNode, SceneOptions } from "./graph-types.ts";

export interface GraphCommit { input: CanvasInput; states: ReadonlyMap<string, GraphState>; fit: boolean; generation: number; font: GraphFont; }
export interface GraphControllerOptions {
  layout: GraphLayoutFunction;
  onGeometry: (geometry: GraphGeometry, commit: GraphCommit) => void;
  onState: (commit: GraphCommit) => void;
  onError?: (message: string) => void;
  buildScene?: (plan: DefinitionPlan, options?: SceneOptions) => GraphScene;
}
const fallbackFont: GraphFont = { family: "system-ui, sans-serif", size: 13, lineHeight: 19 };
const minimumZoom = 0.001;
const stateLabels: Record<ProjectionStatus, string> = { planned: "尚未派发", ready: "等待执行", running: "正在执行", waiting: "等待输入", completed: "已完成", failed: "执行失败", cancelled: "已取消", interrupted: "已中断", unknown: "结果待核对", mixed: "多种状态", skipped: "本次未进入" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** DOM-independent scheduling: stale layout results never replace a newer scene. */
export class WorkflowGraphController {
  readonly #options: GraphControllerOptions;
  #generation = 0;
  #disposed = false;
  #geometry?: GraphGeometry;
  #font: GraphFont = fallbackFont;
  #input?: CanvasInput;
  #identity: string | undefined;
  #hasCommit = false;
  #pending: { signature: string; abort: AbortController; promise: Promise<void> } | undefined;
  constructor(options: GraphControllerOptions) { this.#options = options; }
  get geometry(): GraphGeometry | undefined { return this.#geometry; }
  async update(input: CanvasInput, options: { font?: GraphFont; measureText?: (value: string) => number } = {}): Promise<void> {
    if (this.#disposed) return;
    this.#input = { ...input, collapsed: new Set(input.collapsed), ...(input.edgeLabels ? { edgeLabels: new Map(input.edgeLabels) } : {}) };
    const plan: DefinitionPlan = input.projection ? { version: 1, nodes: input.projection.nodes, edges: input.projection.edges } : input.plan ?? { version: 1, nodes: [], edges: [] };
    const scene = (this.#options.buildScene ?? buildGraphScene)(plan, { collapsed: this.#input.collapsed, font: options.font ?? fallbackFont, ...(options.measureText ? { measureText: options.measureText } : {}), ...(input.edgeLabels ? { edgeLabels: input.edgeLabels } : {}) });
    if (scene.signature === this.#geometry?.signature) {
      this.#options.onState(this.#commit(this.#geometry, true));
      this.#pending?.abort.abort(); this.#pending = undefined; this.#generation++;
      return;
    }
    if (this.#geometry) this.#options.onState(this.#commit(this.#geometry, false));
    if (!scene.nodes.length) {
      this.#pending?.abort.abort(); this.#pending = undefined; this.#generation++;
      this.#geometry = { signature: scene.signature, width: 0, height: 0, nodes: [], edges: [], durationMs: 0 }; this.#font = scene.font;
      this.#options.onGeometry(this.#geometry, this.#commit(this.#geometry, true)); return;
    }
    if (scene.signature === this.#pending?.signature) return this.#pending.promise;
    this.#pending?.abort.abort();
    const abort = new AbortController(), generation = ++this.#generation;
    const promise = (async () => {
      try {
        const geometry = await this.#options.layout(scene, abort.signal);
        if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
        if (geometry.signature !== scene.signature) throw new Error("Layout result does not match the requested workflow scene.");
        const previous = { font: this.#font, identity: this.#identity, hasCommit: this.#hasCommit };
        this.#font = scene.font;
        try { this.#options.onGeometry(geometry, this.#commit(geometry, true)); }
        catch (error) { this.#font = previous.font; this.#identity = previous.identity; this.#hasCommit = previous.hasCommit; throw error; }
        this.#geometry = geometry;
      } catch (error) {
        if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
        this.#options.onError?.(errorMessage(error)); throw error;
      } finally { if (generation === this.#generation) this.#pending = undefined; }
    })();
    this.#pending = { signature: scene.signature, abort, promise };
    return promise;
  }
  #commit(geometry: GraphGeometry, allowFit: boolean): GraphCommit {
    const input = this.#input!, fit = allowFit && geometry.nodes.length > 0 && (!this.#hasCommit || this.#identity !== input.identity);
    if (allowFit && geometry.nodes.length > 0) { this.#hasCommit = true; this.#identity = input.identity; }
    return { input, states: graphNodeStates(geometry, input), fit, generation: this.#generation, font: this.#font };
  }
  dispose(): void { if (!this.#disposed) { this.#disposed = true; this.#generation++; this.#pending?.abort.abort(); this.#pending = undefined; } }
}

export function graphNodeStates(geometry: Pick<GraphGeometry, "nodes">, input: CanvasInput): Map<string, GraphState> {
  const projected = new Map(input.projection?.nodes.map(node => [node.id, node]));
  return new Map(geometry.nodes.map(node => {
    const logicalId = node.ownerId ?? node.id, source = projected.get(logicalId);
    return [node.id, { status: source?.status ?? "planned", inScope: source?.inScope ?? true, instanceCount: source?.instanceIds.length ?? 0, iterationCount: source?.iterations?.length ?? source?.itemKeys?.length ?? 0, selected: input.selectedNodeId === logicalId }];
  }));
}
export function graphEdgeStatus(edge: Pick<LayoutEdge, "originalEdgeIds">, input: CanvasInput): { status: ProjectionStatus; inScope: boolean } {
  const entries = input.projection?.edges.filter(item => edge.originalEdgeIds.includes(item.id)) ?? [];
  if (!entries.length) return { status: "planned", inScope: true };
  const priorities: ProjectionStatus[] = ["running", "unknown", "failed", "waiting", "interrupted", "cancelled", "mixed", "completed", "ready", "skipped", "planned"];
  return { status: priorities.find(status => entries.some(item => item.status === status)) ?? "planned", inScope: entries.some(item => item.inScope) };
}
/** Keyboard focus is presentation state even when execution and selection stay unchanged. */
export class GraphNodePatchCache {
  readonly #keys = new Map<string, string>();
  accept(id: string, state: GraphState, tabStop: boolean): boolean {
    const key = JSON.stringify({ ...state, tabStop });
    if (this.#keys.get(id) === key) return false;
    this.#keys.set(id, key); return true;
  }
  delete(id: string): void { this.#keys.delete(id); }
  clear(): void { this.#keys.clear(); }
}
const colors = (status: ProjectionStatus) => status === "completed" ? { stroke: "var(--wf-green,#5bbf8a)", fill: "var(--wf-green-bg,#193c2d)" }
  : status === "running" ? { stroke: "var(--wf-blue,#5d94f5)", fill: "var(--wf-blue-bg,#1d304f)" }
  : status === "failed" ? { stroke: "var(--wf-red,#ef6b6b)", fill: "var(--wf-red-bg,#411c1c)" }
  : ["unknown", "waiting", "interrupted"].includes(status) ? { stroke: "var(--wf-amber,#d9a84c)", fill: "var(--wf-bg,#191919)" }
  : { stroke: "var(--wf-border,#444)", fill: "var(--wf-bg,#191919)" };
function statusPath(status: ProjectionStatus, x: number, y: number): string {
  if (status === "completed") return `M${x - 5},${y} l3,3 l7,-7`;
  if (status === "failed" || status === "cancelled") return `M${x - 4},${y - 4} l8,8 M${x + 4},${y - 4} l-8,8`;
  if (status === "unknown" || status === "waiting") return `M${x},${y - 5} v6 M${x},${y + 4} v1`;
  return `M${x + 7},${y} a7,7 0 1,1 -14,0 a7,7 0 1,1 14,0`;
}
function midpoint(points: GraphPoint[]): GraphPoint {
  if (!points.length) return { x: 0, y: 0 };
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index++) { const length = lengths[index]!; if (left <= length) { const start = points[index]!, end = points[index + 1]!, ratio = length ? left / length : 0; return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }; } left -= length; }
  return points.at(-1)!;
}

export interface GraphCellCache { nodes: Map<string, Node>; edges: Map<string, Edge>; }
export interface GraphCellCallbacks {
  createNode: (node: LayoutNode) => Node;
  updateNode: (cell: Node, node: LayoutNode) => void;
  configureEdge: (cell: Edge, edge: LayoutEdge, section: GraphPoint[], index: number) => void;
}
type GraphModelAdapter = Pick<Graph, "batchUpdate" | "getEdges" | "removeEdge" | "removeNode" | "addEdge">;
function layoutPorts(node: LayoutNode): Array<{ id: string; group: "absolute"; args: { x: number; y: number } }> {
  return node.ports.map(port => { const point = node.portPositions[port.id]; if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Layout is missing an authoritative workflow port position."); return { id: port.id, group: "absolute", args: { x: point.x - node.x, y: point.y - node.y } }; });
}
/** X6 may remove connected edges when a port disappears; never retain those detached objects. */
export function replaceGraphGeometry(graph: GraphModelAdapter, geometry: GraphGeometry, cache: GraphCellCache, callbacks: GraphCellCallbacks): void {
  const wanted = new Set(geometry.nodes.map(node => node.id));
  // Validate ports before changing the current graph.
  const ports = new Map(geometry.nodes.map(node => [node.id, layoutPorts(node)]));
  graph.batchUpdate("workflow-layout", () => {
    // Geometry changes rebuild display edges; ordinary state updates never enter this path.
    for (const edge of graph.getEdges()) graph.removeEdge(edge);
    cache.edges.clear();
    for (const cell of cache.nodes.values()) cell.getParent()?.unembed(cell);
    for (const [id, node] of cache.nodes) if (!wanted.has(id)) { graph.removeNode(node, { disconnectEdges: true }); cache.nodes.delete(id); }
    for (const node of geometry.nodes) {
      let cell = cache.nodes.get(node.id);
      if (!cell) { cell = callbacks.createNode(node); cache.nodes.set(node.id, cell); }
      else callbacks.updateNode(cell, node);
      const desired = ports.get(node.id)!, desiredIds = new Set(desired.map(port => port.id!));
      const removed = cell.getPorts().filter(port => port.id && !desiredIds.has(port.id)); if (removed.length) cell.removePorts(removed);
      for (const port of desired) if (cell.hasPort(port.id!)) cell.setPortProp(port.id!, { group: port.group, args: port.args }); else cell.addPort(port);
    }
    for (const node of geometry.nodes) if (node.parentId) { const parent = cache.nodes.get(node.parentId), child = cache.nodes.get(node.id); if (parent && child) parent.addChild(child); }
    for (const edge of geometry.edges) {
      if (edge.hidden) continue;
      edge.sections.forEach((section, index) => {
        if (section.length < 2) return;
        const id = `${edge.id}::section:${index}`, source = index === 0 ? { cell: edge.source, port: edge.sourcePort } : section[0]!, target = index === edge.sections.length - 1 ? { cell: edge.target, port: edge.targetPort } : section.at(-1)!;
        const cell = graph.addEdge({ id, source, target, vertices: section.slice(1, -1), router: { name: "normal" }, connector: { name: "normal" }, zIndex: -1, attrs: { line: { stroke: "var(--wf-border,#444)", strokeWidth: 1.5, targetMarker: index === edge.sections.length - 1 ? { name: "classic", size: 6 } : null } } });
        cache.edges.set(id, cell); cell.setData({ originalId: edge.id }); callbacks.configureEdge(cell, edge, section, index);
      });
    }
  });
}

export interface GraphCanvasOptions { layout?: GraphLayoutFunction; miniMap?: boolean; }
/** A single persistent X6 viewport; ELK owns all geometry and routing. */
export class WorkflowGraphCanvas {
  readonly #container: HTMLElement;
  readonly #callbacks: CanvasCallbacks;
  readonly #controller: WorkflowGraphController;
  readonly #options: GraphCanvasOptions;
  readonly #nodes = new Map<string, Node>();
  readonly #edges = new Map<string, Edge>();
  readonly #nodeStateKeys = new GraphNodePatchCache();
  readonly #edgeStateKeys = new Map<string, string>();
  #graph?: Graph;
  #initializing?: Promise<void>;
  #layoutService?: { layout: GraphLayoutFunction; dispose: () => void };
  #layoutServicePromise?: Promise<{ layout: GraphLayoutFunction; dispose: () => void }>;
  #resizeObserver?: ResizeObserver;
  #themeObserver?: MutationObserver;
  #input?: CanvasInput;
  #disposed = false;
  #fontKey = "";
  #context?: CanvasRenderingContext2D | null;
  #lastGeometry?: GraphGeometry;
  #gridColor = "";
  #miniMapHost?: HTMLElement;
  #miniMapObserver?: MutationObserver;
  #userViewport = false;
  #userViewportIdentity: string | undefined;
  readonly #onWheel: (event: WheelEvent) => void;
  readonly #onKey: (event: KeyboardEvent) => void;
  readonly #onClick: (event: MouseEvent) => void;
  readonly #onFonts: () => void;

  constructor(container: HTMLElement, callbacks: CanvasCallbacks, options: GraphCanvasOptions = {}) {
    this.#container = container; this.#callbacks = callbacks; this.#options = options;
    this.#controller = new WorkflowGraphController({ layout: (scene, signal) => this.#layout(scene, signal), onGeometry: (geometry, commit) => this.#applyGeometry(geometry, commit), onState: commit => this.#patchState(commit), ...(callbacks.onError ? { onError: callbacks.onError } : {}) });
    container.classList.add("wf-x6-canvas"); container.setAttribute("role", "region"); container.setAttribute("aria-label", "工作流图；滚轮平移，按住 Command 或 Ctrl 缩放，方向键选择节点"); container.tabIndex = 0;
    this.#onWheel = event => {
      if (!this.#graph || this.#disposed) return; event.preventDefault(); event.stopPropagation();
      this.#markUserViewport();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = container.getBoundingClientRect(), factor = Math.exp(-event.deltaY * unit * 0.002);
        this.#graph.zoomTo(Math.max(minimumZoom, Math.min(3, this.#graph.zoom() * factor)), { center: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
      } else this.#graph.translateBy(-event.deltaX * unit, -event.deltaY * unit);
    };
    this.#onKey = event => this.#key(event);
    this.#onClick = event => { if (event.target instanceof Element && event.target.closest(".wf-x6-minimap")) return; const target = event.target instanceof Element ? event.target.closest("[data-wf-collapse]") : null; if (!target) return; const id = target.getAttribute("data-wf-collapse"); if (id) { event.preventDefault(); event.stopPropagation(); this.#callbacks.onToggleCollapse(id); } };
    this.#onFonts = () => { if (this.#input && !this.#disposed) void this.update(this.#input).catch(() => {}); };
    container.addEventListener("wheel", this.#onWheel, { passive: false }); container.addEventListener("keydown", this.#onKey); container.addEventListener("click", this.#onClick, true);
    container.ownerDocument.fonts?.addEventListener("loadingdone", this.#onFonts);
  }
  async #layout(scene: GraphScene, signal?: AbortSignal): Promise<GraphGeometry> {
    if (this.#options.layout) return this.#options.layout(scene, signal);
    this.#layoutServicePromise ??= import("./graph-browser-layout.ts").then(module => module.createBrowserGraphLayout());
    const service = await this.#layoutServicePromise;
    if (this.#disposed) { service.dispose(); throw new Error("Workflow graph has been disposed."); }
    this.#layoutService = service; return service.layout(scene, signal);
  }
  async #initialize(): Promise<void> {
    if (this.#graph || this.#disposed) return;
    this.#initializing ??= (async () => {
      const { Graph: X6Graph, MiniMap } = await import("@antv/x6");
      if (this.#disposed) return;
      const graph = new X6Graph({ container: this.#container, width: Math.max(1, this.#container.clientWidth), height: Math.max(1, this.#container.clientHeight), autoResize: true, async: false,
        background: { color: "transparent" }, grid: { visible: true, size: 20, type: "dot", args: { color: this.#container.ownerDocument.defaultView!.getComputedStyle(this.#container).getPropertyValue("--wf-border").trim() || "#444", thickness: 1 } },
        interacting: { nodeMovable: false, edgeMovable: false, edgeLabelMovable: false, arrowheadMovable: false, vertexMovable: false, vertexAddable: false, vertexDeletable: false, magnetConnectable: false, toolsAddable: false },
        embedding: { enabled: false }, panning: { enabled: true, eventTypes: ["leftMouseDown", "mouseWheelDown"] }, mousewheel: false,
        scaling: { min: minimumZoom, max: 3 }, connecting: { allowBlank: false, allowNode: false, allowEdge: false, allowPort: false, allowLoop: false, allowMulti: false, router: "normal", connector: "normal", anchor: "center", connectionPoint: "anchor" } });
      this.#graph = graph;
      if (this.#options.miniMap !== false) {
      const overview = this.#container.ownerDocument.createElement("div"); overview.className = "wf-x6-minimap"; overview.tabIndex = 0; overview.setAttribute("role", "region"); overview.setAttribute("aria-label", "流程概览；拖动或方向键平移，回车定位当前节点"); this.#container.appendChild(overview); this.#miniMapHost = overview;
      graph.use(new MiniMap({ container: overview, width: 180, height: 120, padding: 8, scalable: false, graphOptions: { async: false, scaling: { min: 0.00005, max: 1 } } }));
      const accessibleOverview = () => { overview.querySelectorAll("[tabindex]:not([tabindex='-1'])").forEach(element => element.setAttribute("tabindex", "-1")); overview.querySelectorAll("svg").forEach(svg => svg.setAttribute("aria-hidden", "true")); };
      accessibleOverview();
      if (typeof MutationObserver !== "undefined") { this.#miniMapObserver = new MutationObserver(accessibleOverview); this.#miniMapObserver.observe(overview, { subtree: true, childList: true, attributes: true, attributeFilter: ["tabindex"] }); }
      overview.addEventListener("mousedown", () => this.#markUserViewport());
      overview.addEventListener("keydown", event => { event.stopPropagation(); const direction = ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, [number, number]>)[event.key]; if (direction) { event.preventDefault(); this.#markUserViewport(); graph.translateBy(...direction); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.focusCurrent(); } });
      }
      graph.on("node:click", ({ node, e }) => { if ((e.target as Element | null)?.closest?.("[data-wf-collapse]")) return; const id = node.getData<{ logicalId?: string }>()?.logicalId; if (id) this.#callbacks.onSelectNode(id); });
      graph.on("blank:mousedown", () => this.#markUserViewport()); graph.on("node:unhandled:mousedown", () => this.#markUserViewport());
      graph.on("scale", () => this.#callbacks.onZoom?.(graph.zoom()));
      if (typeof ResizeObserver !== "undefined") { this.#resizeObserver = new ResizeObserver(() => { if (this.#disposed) return; const font = this.#readFont(); if (this.#input && JSON.stringify(font) !== this.#fontKey) this.#onFonts(); }); this.#resizeObserver.observe(this.#container); }
      if (typeof MutationObserver !== "undefined") {
        this.#themeObserver = new MutationObserver(this.#onFonts);
        for (const element of new Set([this.#container.ownerDocument.documentElement, this.#container.ownerDocument.body, this.#container.closest("#workflow-panel-prototype")].filter((value): value is HTMLElement => !!value))) this.#themeObserver.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
      }
    })();
    return this.#initializing;
  }
  #readFont(): GraphFont {
    const style = this.#container.ownerDocument.defaultView!.getComputedStyle(this.#container), size = Number.parseFloat(style.fontSize) || fallbackFont.size;
    const line = Number.parseFloat(style.lineHeight);
    return { family: style.fontFamily || fallbackFont.family, size, lineHeight: Number.isFinite(line) ? line : size * 1.45 };
  }
  async update(input: CanvasInput): Promise<void> {
    if (this.#disposed) return; this.#input = input;
    try { await this.#initialize(); }
    catch (error) { this.#callbacks.onError?.(errorMessage(error)); throw error; }
    if (this.#disposed) return;
    const font = this.#readFont(); this.#fontKey = JSON.stringify(font);
    const gridColor = this.#container.ownerDocument.defaultView!.getComputedStyle(this.#container).getPropertyValue("--wf-border").trim() || "#444";
    if (gridColor !== this.#gridColor) { this.#gridColor = gridColor; this.#graph?.drawGrid({ type: "dot", args: { color: gridColor, thickness: 1 } }); }
    this.#context ??= this.#container.ownerDocument.createElement("canvas").getContext("2d");
    if (this.#context) this.#context.font = `${font.size}px ${font.family}`;
    this.#container.setAttribute("aria-busy", "true");
    try { await this.#controller.update(input, { font, ...(this.#context ? { measureText: (value: string) => this.#context!.measureText(value).width } : {}) }); }
    finally { if (!this.#disposed) this.#container.setAttribute("aria-busy", "false"); }
  }
  #applyGeometry(geometry: GraphGeometry, commit: GraphCommit): void {
    const graph = this.#graph; if (!graph || this.#disposed) return;
    const font = commit.font;
    const active = this.#container.ownerDocument.activeElement, focusId = active instanceof Element && this.#container.contains(active) ? active.closest("[data-wf-node-id]")?.getAttribute("data-wf-node-id") : undefined;
    this.#lastGeometry = geometry;
    replaceGraphGeometry(graph, geometry, { nodes: this.#nodes, edges: this.#edges }, {
      createNode: node => graph.addNode(this.#nodeMetadata(node, font)),
      updateNode: (cell, node) => { cell.position(node.x, node.y); cell.resize(node.width, node.height); cell.setProp("markup", this.#nodeMarkup(node)); cell.setAttrs(this.#nodeBaseAttrs(node, font)); cell.setData({ logicalId: node.ownerId ?? node.id, kind: node.kind, collapsible: node.collapsible === true }); },
      configureEdge: (cell, edge, section, index) => {
        const middle = midpoint(section), labelBounds = edge.labelBounds;
        cell.setLabels(index === 0 && edge.label ? [{ attrs: { label: { text: edge.label, fontFamily: font.family, fontSize: Math.max(10, font.size - 1), fill: "var(--wf-muted,#aaa)" }, body: { fill: "var(--wf-bg,#191919)", stroke: "none", rx: 3, ry: 3 } }, position: { distance: 0.5, ...(labelBounds ? { offset: { x: labelBounds.x + labelBounds.width / 2 - middle.x, y: labelBounds.y + labelBounds.height / 2 - middle.y } } : {}), options: { absoluteOffset: true, keepGradient: false } } }] : []);
      }
    });
    this.#nodeStateKeys.clear(); this.#edgeStateKeys.clear();
    this.#patchState(commit);
    if (focusId && (!active || !this.#container.contains(active))) { const cell = this.#nodes.get(focusId), element = cell ? graph.findViewByCell(cell)?.container : this.#container; (element as HTMLElement | undefined)?.focus({ preventScroll: true }); }
  }
  #ports(node: LayoutNode) { return layoutPorts(node); }
  #nodeMarkup(node: LayoutNode) {
    if (node.kind === "group") return [{ tagName: "rect", selector: "body" }];
    if (node.kind === "join") return [{ tagName: "circle", selector: "body" }];
    return [{ tagName: node.kind === "choice" ? "path" : "rect", selector: "body" }, { tagName: "path", selector: "statusIcon" }, { tagName: "text", selector: "label" }, { tagName: "text", selector: "statusText" }, ...(node.collapsible ? [{ tagName: "g", selector: "collapse", children: [{ tagName: "circle", selector: "collapseBody" }, { tagName: "path", selector: "collapseIcon" }] }] : [])];
  }
  #nodeBaseAttrs(node: LayoutNode, font: GraphFont): CellAttrs {
    const root = { role: node.kind === "group" ? "group" : "button", tabindex: node.kind === "group" || node.kind === "join" ? -1 : 0, "data-wf-node-id": node.id, "aria-label": node.label };
    if (node.kind === "group") return { root, body: { x: 0, y: 0, width: node.width, height: node.height, rx: 14, ry: 14, fill: "var(--wf-surface,#242424)", fillOpacity: 0.18, stroke: "var(--wf-border,#444)", strokeWidth: 1, strokeDasharray: "5 5", pointerEvents: "stroke" } };
    if (node.kind === "join") return { root, body: { cx: node.width / 2, cy: node.height / 2, r: Math.max(2, Math.min(node.width, node.height) / 2 - 1), fill: "var(--wf-bg,#191919)", stroke: "var(--wf-border,#444)", strokeWidth: 1.5 } };
    const choice = node.kind === "choice", lines = node.labelLines ?? [node.label], labelX = choice ? node.width / 2 : 42, labelY = choice ? node.height / 2 - font.lineHeight * lines.length / 2 - 4 : 17;
    return { root, text: { ref: null, refX: null, refY: null }, body: choice ? { d: `M${node.width / 2},1 L${node.width - 1},${node.height / 2} L${node.width / 2},${node.height - 1} L1,${node.height / 2} Z`, fill: "var(--wf-bg,#191919)", stroke: "var(--wf-border,#444)", strokeWidth: 1.5 } : { x: 0, y: 0, width: node.width, height: node.height, rx: 10, ry: 10, fill: "var(--wf-bg,#191919)", stroke: "var(--wf-border,#444)", strokeWidth: 1.5 },
      label: { ref: null, refX: null, refY: null, text: lines.join("\n"), x: labelX, y: labelY, fontFamily: font.family, fontSize: font.size, fontWeight: 400, fill: "var(--wf-text,#eee)", textAnchor: choice ? "middle" : "start", textVerticalAnchor: "top", lineHeight: font.lineHeight, pointerEvents: "none" },
      statusIcon: { d: statusPath("planned", choice ? node.width / 2 : 22, choice ? 18 : 25), stroke: "var(--wf-muted,#aaa)", strokeWidth: 1.8, fill: "none", strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none" },
      statusText: { ref: null, refX: null, refY: null, x: choice ? node.width / 2 : 42, y: choice ? node.height / 2 + font.lineHeight * lines.length / 2 + 3 : 24 + font.lineHeight * lines.length, textAnchor: choice ? "middle" : "start", textVerticalAnchor: "top", fontFamily: font.family, fontSize: Math.max(10, font.size - 1), fill: "var(--wf-muted,#aaa)", pointerEvents: "none" },
      ...(node.collapsible ? { collapse: { "data-wf-collapse": node.ownerId ?? node.id, role: "button", tabindex: -1, "aria-label": `${node.collapsed ? "展开" : "折叠"}${node.label}`, "aria-expanded": !node.collapsed }, collapseBody: { cx: node.width - 19, cy: 21, r: 11, fill: "var(--wf-bg,#191919)", stroke: "var(--wf-border,#444)", cursor: "pointer" }, collapseIcon: { d: `M${node.width - 23},21 h8${node.collapsed ? ` M${node.width - 19},17 v8` : ""}`, fill: "none", stroke: "var(--wf-muted,#aaa)", strokeWidth: 1.5, pointerEvents: "none" } } : {}) };
  }
  #nodeMetadata(node: LayoutNode, font: GraphFont) { return { id: node.id, shape: "rect", x: node.x, y: node.y, width: node.width, height: node.height, zIndex: node.kind === "group" ? -5 : node.kind === "join" ? 0 : 1, markup: this.#nodeMarkup(node), attrs: this.#nodeBaseAttrs(node, font), data: { logicalId: node.ownerId ?? node.id, kind: node.kind, collapsible: node.collapsible === true }, ports: { groups: { absolute: { position: "absolute", attrs: { circle: { r: 0, magnet: false, fill: "none", stroke: "none" } } } }, items: this.#ports(node) } }; }
  #patchState(commit: GraphCommit): void {
    const graph = this.#graph, geometry = this.#lastGeometry; if (!graph || !geometry || this.#disposed) return;
    const focused = this.#container.ownerDocument.activeElement;
    const focusedId = focused instanceof Element && this.#container.contains(focused) ? focused.closest("[data-wf-node-id]")?.getAttribute("data-wf-node-id") : undefined;
    const tabStop = this.#visibleNode(focusedId ?? commit.input.selectedNodeId)?.id ?? this.#entryNode()?.id;
    graph.batchUpdate("workflow-status", () => {
      for (const node of geometry.nodes) {
        const state = commit.states.get(node.id); if (!state) continue;
        if (!this.#nodeStateKeys.accept(node.id, state, node.id === tabStop)) continue;
        const cell = this.#nodes.get(node.id); if (!cell) continue;
        const palette = colors(state.status), stroke = state.selected ? "var(--wf-blue,#5d94f5)" : palette.stroke;
        const choice = node.kind === "choice", label = !state.inScope ? "当前范围外" : `${stateLabels[state.status]}${state.iterationCount ? ` · ${state.iterationCount} 轮/项` : state.instanceCount > 1 ? ` · ${state.instanceCount} 个实例` : ""}`;
        cell.attr({ root: { "data-status": state.status, "data-selected": state.selected ? "true" : "false", tabindex: node.kind !== "group" && node.kind !== "join" && node.id === tabStop ? 0 : -1, ...(node.collapsible ? { "aria-expanded": !node.collapsed, "aria-keyshortcuts": "C" } : {}), opacity: state.inScope && state.status !== "skipped" ? 1 : 0.45, "aria-label": `${node.label}，${label}`, ...(node.kind !== "group" && node.kind !== "join" ? { "aria-pressed": state.selected } : {}) }, body: { stroke, strokeWidth: state.selected ? 2.5 : node.kind === "group" ? 1 : 1.5, ...(node.kind === "group" ? {} : { fill: palette.fill }) }, ...(node.kind === "group" || node.kind === "join" ? {} : { statusIcon: { d: statusPath(state.status, choice ? node.width / 2 : 22, choice ? 18 : 25), stroke: ["planned", "ready", "skipped", "mixed"].includes(state.status) ? "var(--wf-muted,#aaa)" : palette.stroke, strokeDasharray: state.status === "running" ? "24 20" : "none", class: state.status === "running" ? "wf-x6-status-icon wf-x6-running" : "wf-x6-status-icon" }, statusText: { text: label, fill: ["planned", "ready", "skipped", "mixed"].includes(state.status) ? "var(--wf-muted,#aaa)" : palette.stroke } }) });
      }
      for (const edge of geometry.edges) { const state = graphEdgeStatus(edge, commit.input), key = JSON.stringify(state); edge.sections.forEach((_, index) => { const id = `${edge.id}::section:${index}`, cell = this.#edges.get(id); if (!cell || this.#edgeStateKeys.get(id) === key) return; this.#edgeStateKeys.set(id, key); const color = colors(state.status).stroke; cell.attr({ root: { opacity: state.inScope ? 1 : 0.35 }, line: { stroke: color, strokeWidth: state.status === "running" || state.status === "completed" ? 2 : 1.5, strokeDasharray: state.status === "planned" || state.status === "skipped" ? "5 5" : "none", class: state.status === "running" ? "wf-x6-edge-running" : "" } }); }); }
    });
    if (commit.fit && !(this.#userViewport && this.#userViewportIdentity === commit.input.identity)) this.#readableEntry();
  }
  #key(event: KeyboardEvent): void {
    if (!this.#graph || this.#disposed || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null, collapse = target?.closest("[data-wf-collapse]");
    const nodeElement = target?.closest("[data-wf-node-id]"), id = nodeElement?.getAttribute("data-wf-node-id"), cell = id ? this.#nodes.get(id) : undefined;
    if (event.key === "Enter" || event.key === " ") { const collapseId = collapse?.getAttribute("data-wf-collapse"); const logicalId = cell?.getData<{ logicalId?: string }>()?.logicalId; if (collapseId || logicalId) { event.preventDefault(); if (collapseId) this.#callbacks.onToggleCollapse(collapseId); else this.#callbacks.onSelectNode(logicalId!); } return; }
    if (event.key === "+" || event.key === "=") { event.preventDefault(); this.zoomBy(0.15); return; }
    if (event.key === "-") { event.preventDefault(); this.zoomBy(-0.15); return; }
    if (event.key === "0") { event.preventDefault(); this.resetZoom(); return; }
    if (event.key.toLowerCase() === "f") { event.preventDefault(); this.fit(); return; }
    if (event.key.toLowerCase() === "c" && cell?.getData<{ collapsible?: boolean }>()?.collapsible) { event.preventDefault(); this.#callbacks.onToggleCollapse(cell.getData<{ logicalId: string }>().logicalId); return; }
    const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[event.key];
    if (!direction || !this.#lastGeometry) return; event.preventDefault();
    const current = this.#lastGeometry.nodes.find(node => node.id === id), nodes = this.#lastGeometry.nodes.filter(node => node.kind !== "group" && node.kind !== "join");
    const candidates = current ? nodes.filter(node => node.id !== current.id).map(node => { const dx = node.x + node.width / 2 - current.x - current.width / 2, dy = node.y + node.height / 2 - current.y - current.height / 2; return { node, forward: dx * direction[0] + dy * direction[1], side: Math.abs(dx * direction[1] - dy * direction[0]) }; }).filter(entry => entry.forward > 0).sort((a, b) => a.forward + a.side * 2 - b.forward - b.side * 2).map(entry => entry.node) : nodes;
    const next = candidates[0], nextCell = next ? this.#nodes.get(next.id) : undefined;
    const element = nextCell ? this.#graph.findViewByCell(nextCell)?.container : undefined;
    if (element) {
      nodeElement?.setAttribute("tabindex", "-1"); element.setAttribute("tabindex", "0");
      const viewport = this.#container.getBoundingClientRect(), target = element.getBoundingClientRect();
      if (nextCell && (target.top < viewport.top + 24 || target.bottom > viewport.bottom - 24 || target.left < viewport.left + 24 || target.right > viewport.right - 24)) { this.#markUserViewport(); this.#graph.centerCell(nextCell); }
      (element as SVGElement & { focus(options?: FocusOptions): void }).focus({ preventScroll: true });
    }
  }
  #markUserViewport(): void { this.#userViewport = true; this.#userViewportIdentity = this.#input?.identity; }
  #visibleNode(id: string | undefined): Node | undefined {
    const visited = new Set<string>(), plan = this.#input?.projection ?? this.#input?.plan;
    while (id && !visited.has(id)) { const cell = this.#nodes.get(id); if (cell) return cell; visited.add(id); id = plan?.nodes.find(node => node.id === id)?.parentId; }
    return undefined;
  }
  #currentNode(): Node | undefined {
    const geometry = this.#lastGeometry, projected = this.#input?.projection; if (!geometry) return undefined;
    for (const status of ["running", "waiting", "unknown", "failed", "ready"] as ProjectionStatus[]) {
      const observed = projected?.nodes.filter(node => node.status === status && node.inScope) ?? [];
      const active = observed.find(node => ["agent", "command", "wait", "expand"].includes(node.type)) ?? observed.find(node => node.type !== "join");
      const cell = this.#visibleNode(active?.id); if (cell) return cell;
    }
    return this.#visibleNode(this.#input?.selectedNodeId) ?? this.#entryNode();
  }
  #entryNode(): Node | undefined { const first = this.#lastGeometry?.nodes.filter(node => node.kind !== "group" && node.kind !== "join").sort((left, right) => left.y - right.y || left.x - right.x)[0]; return first ? this.#nodes.get(first.id) : undefined; }
  #readableEntry(): void {
    const graph = this.#graph, geometry = this.#lastGeometry; if (!graph || !geometry?.nodes.length) return;
    const fitScale = Math.min(Math.max(1, this.#container.clientWidth - 64) / Math.max(1, geometry.width), Math.max(1, this.#container.clientHeight - 64) / Math.max(1, geometry.height));
    if (fitScale >= 0.7) { this.#fitAll(); return; }
    graph.zoomTo(1);
    const cell = this.#currentNode(), entry = this.#entryNode(); if (!cell) return;
    if (cell === entry) { graph.positionCell(cell, "top"); graph.translateBy(0, 32); } else graph.centerCell(cell);
  }
  #fitAll(): void { if (this.#graph && this.#lastGeometry && this.#lastGeometry.nodes.length) this.#graph.zoomToRect({ x: 0, y: 0, width: Math.max(1, this.#lastGeometry.width), height: Math.max(1, this.#lastGeometry.height) }, { padding: 32, minScale: minimumZoom, maxScale: 1 }); }
  focusSelected(): void { const cell = this.#visibleNode(this.#input?.selectedNodeId); if (!cell || !this.#graph) return; this.#markUserViewport(); if (this.#graph.zoom() < 0.7) this.#graph.zoomTo(0.7); this.#graph.centerCell(cell); }
  focusCurrent(): void { const cell = this.#currentNode(); if (!cell || !this.#graph) return; this.#markUserViewport(); if (this.#graph.zoom() < 0.7) this.#graph.zoomTo(0.7); this.#graph.centerCell(cell); }
  zoomBy(delta: number): void { if (this.#graph && Number.isFinite(delta)) { this.#markUserViewport(); this.#graph.zoomTo(Math.max(minimumZoom, Math.min(3, this.#graph.zoom() + delta))); } }
  fit(): void { this.#markUserViewport(); this.#fitAll(); }
  resetZoom(): void { this.#markUserViewport(); this.#graph?.zoomTo(1); }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true; this.#controller.dispose(); this.#resizeObserver?.disconnect(); this.#themeObserver?.disconnect(); this.#miniMapObserver?.disconnect(); this.#layoutService?.dispose();
    this.#container.removeEventListener("wheel", this.#onWheel); this.#container.removeEventListener("keydown", this.#onKey); this.#container.removeEventListener("click", this.#onClick, true); this.#container.ownerDocument.fonts?.removeEventListener("loadingdone", this.#onFonts);
    this.#graph?.dispose(); this.#nodes.clear(); this.#edges.clear(); this.#nodeStateKeys.clear(); this.#edgeStateKeys.clear();
    this.#miniMapHost?.remove();
    this.#container.removeAttribute("aria-busy");
  }
}
