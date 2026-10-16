import ELK from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { GraphBounds, GraphGeometry, GraphPoint, GraphScene, LayoutEdge, LayoutNode, SceneNode } from "./graph-types.ts";
import { GRAPH_SCENE_LIMITS } from "./graph-model.ts";

export const GRAPH_LAYOUT_LIMITS = Object.freeze({ timeoutMs: 15000, dimension: 10_000_000 });
const rootId = "$layout:root";
function abortError(): Error { const error = new Error("Workflow graph layout was cancelled."); error.name = "AbortError"; return error; }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function finite(value: unknown, label: string, minimum = -GRAPH_LAYOUT_LIMITS.dimension): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > GRAPH_LAYOUT_LIMITS.dimension) throw new Error(`The graph layout returned invalid ${label}.`);
  return value;
}
// ELK 0.12's DOWN postprocessor can leave diagonal tails on cross-hierarchy edges.
// Solve natively in RIGHT and transpose every input/output geometry component.
// This changes axes only: ELK remains the sole producer of every route segment.
const nativeSides = { NORTH: "WEST", SOUTH: "EAST", EAST: "SOUTH", WEST: "NORTH" } as const;
function point(value: { x?: number; y?: number }, label: string): GraphPoint { return { x: finite(value.y, `${label} y`), y: finite(value.x, `${label} x`) }; }
function bounds(value: { x?: number; y?: number; width?: number; height?: number }, label: string): GraphBounds { return { ...point(value, label), width: finite(value.height, `${label} height`, 0), height: finite(value.width, `${label} width`, 0) }; }

/** ELK is the only routing authority. The owner runs this adapter in its browser Worker. */
export async function layoutGraphScene(scene: GraphScene, signal?: AbortSignal): Promise<GraphGeometry> {
  checkSignal(signal);
  if (scene.nodes.length > GRAPH_SCENE_LIMITS.nodes || scene.edges.length > GRAPH_SCENE_LIMITS.edges) throw new Error("The workflow exceeds the graph layout budget.");
  const started = performance.now();
  const byId = new Map<string, SceneNode>();
  const ports = new Set<string>();
  for (const node of scene.nodes) {
    if (!node.id || node.id === rootId || byId.has(node.id)) throw new Error("Duplicate graph layout node identity.");
    finite(node.width, "input node width", 1); finite(node.height, "input node height", 1);
    for (const port of node.ports) { if (!port.id || ports.has(port.id) || !["NORTH", "SOUTH", "EAST", "WEST"].includes(port.side)) throw new Error("Invalid graph port identity or side."); ports.add(port.id); }
    byId.set(node.id, node);
  }
  if (!scene.nodes.length) return { signature: scene.signature, width: 0, height: 0, nodes: [], edges: [], durationMs: performance.now() - started };
  const elkNodes = new Map<string, ElkNode>();
  for (const node of scene.nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (node.parentId && (!parent || parent.kind !== "group")) throw new Error("Graph layout nodes must belong to a declared compound group.");
    const isHeader = parent?.ownerId === node.id;
    const isContainerJoin = node.kind === "join" && parent?.ownerId === node.logicalParentId;
    const elkPorts: ElkPort[] = node.ports.map(port => ({ id: port.id, width: 0, height: 0, layoutOptions: { "elk.port.side": nativeSides[port.side] } }));
    elkNodes.set(node.id, { id: node.id, width: node.height, height: node.width, ...(node.kind === "group" ? { children: [] } : {}), ports: elkPorts, layoutOptions: {
      "elk.portConstraints": "FIXED_ORDER",
      ...(node.kind === "group" ? { "elk.padding": "[top=28,left=28,bottom=28,right=28]", "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${node.height},${node.width})` } : {}),
      ...(isHeader ? { "elk.layered.layering.layerConstraint": "FIRST" } : isContainerJoin ? { "elk.layered.layering.layerConstraint": "LAST" } : {}),
    } });
  }
  const children: ElkNode[] = [];
  for (const node of scene.nodes) {
    const visited = new Set([node.id]); let parent = node.parentId;
    while (parent) { if (visited.has(parent) || visited.size > GRAPH_SCENE_LIMITS.depth + 2) throw new Error("The compound graph has invalid parent nesting."); visited.add(parent); parent = byId.get(parent)?.parentId; }
    if (node.parentId) elkNodes.get(node.parentId)!.children!.push(elkNodes.get(node.id)!); else children.push(elkNodes.get(node.id)!);
  }
  const edgeIds = new Set<string>();
  const edges: ElkExtendedEdge[] = scene.edges.flatMap(edge => {
    if (edgeIds.has(edge.id) || !byId.has(edge.source) || !byId.has(edge.target)) throw new Error("Invalid graph layout edge identity or endpoint.");
    edgeIds.add(edge.id);
    if (edge.hidden) return [];
    if (!byId.get(edge.source)!.ports.some(port => port.id === edge.sourcePort) || !byId.get(edge.target)!.ports.some(port => port.id === edge.targetPort)) throw new Error("An edge references a missing graph port.");
    if (edge.label && !edge.labelSize) throw new Error("Edge labels require measured font dimensions before layout.");
    return [{ id: edge.id, sources: [edge.sourcePort], targets: [edge.targetPort], ...(edge.labelSize && edge.label ? { labels: [{ id: `$label:${edge.id}`, text: edge.label, width: finite(edge.labelSize.height, "input label height", 0), height: finite(edge.labelSize.width, "input label width", 0) }] } : {}) }];
  });
  // These non-rendered edges express geometry constraints, never execution transitions.
  // A compound child's entire bounds, including its footer, must precede its owner's join.
  for (const group of scene.nodes.filter(node => node.kind === "group" && node.ownerId)) {
    const join = scene.nodes.find(node => node.kind === "join" && node.logicalParentId === group.ownerId && node.parentId === group.id);
    if (!join) continue;
    for (const child of scene.nodes.filter(node => node.parentId === group.id && node.id !== group.ownerId && node.id !== join.id)) {
      const id = `$layout:constraint:${group.id}:${child.id}`;
      const sourcePort = `${id}:source`, targetPort = `${id}:target`;
      elkNodes.get(child.id)!.ports!.push({ id: sourcePort, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } });
      elkNodes.get(join.id)!.ports!.push({ id: targetPort, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } });
      edges.push({ id, sources: [sourcePort], targets: [targetPort], layoutOptions: { "elk.layered.priority.direction": "1000" } });
    }
  }
  const graph: ElkNode = { id: rootId, children, edges, layoutOptions: {
    "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.hierarchyHandling": "INCLUDE_CHILDREN", "elk.edgeRouting": "ORTHOGONAL",
    "elk.json.shapeCoords": "ROOT", "elk.json.edgeCoords": "ROOT", "elk.padding": "[top=32,left=32,bottom=32,right=32]",
    "elk.spacing.nodeNode": "44", "elk.layered.spacing.nodeNodeBetweenLayers": "54", "elk.spacing.edgeNode": "18", "elk.spacing.edgeEdge": "14",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.randomSeed": "1",
  } };
  const elk = new (ELK as unknown as new () => ElkInstance)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Workflow graph layout exceeded its time budget.")), GRAPH_LAYOUT_LIMITS.timeoutMs);
    if (signal) { onAbort = () => reject(abortError()); signal.addEventListener("abort", onAbort, { once: true }); }
  });
  let result: ElkNode;
  try { result = await Promise.race([elk.layout(graph), interrupted]); }
  finally { if (timer !== undefined) clearTimeout(timer); if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
  checkSignal(signal);
  if (performance.now() - started > GRAPH_LAYOUT_LIMITS.timeoutMs) throw new Error("Workflow graph layout exceeded its time budget.");
  const placed = new Map<string, ElkNode>(), routed = new Map<string, ElkExtendedEdge>();
  function collect(node: ElkNode): void { placed.set(node.id, node); for (const edge of node.edges ?? []) routed.set(edge.id, edge); for (const child of node.children ?? []) collect(child); }
  collect(result);
  const layoutNodes: LayoutNode[] = scene.nodes.map(node => {
    const geometry = placed.get(node.id); if (!geometry) throw new Error("ELK omitted a workflow node from the layout.");
    const portPositions: Record<string, GraphPoint> = Object.create(null) as Record<string, GraphPoint>;
    for (const port of geometry.ports ?? []) if (node.ports.some(original => original.id === port.id)) portPositions[port.id] = point(port, "port position");
    for (const port of node.ports) if (!portPositions[port.id]) throw new Error("ELK omitted a workflow port from the layout.");
    return { ...node, ...bounds(geometry, "node"), portPositions };
  });
  const layoutEdges: LayoutEdge[] = scene.edges.map(edge => {
    if (edge.hidden) return { ...edge, sections: [] };
    const geometry = routed.get(edge.id); if (!geometry?.sections?.length) throw new Error("ELK omitted a workflow edge route.");
    const sections = geometry.sections.map(section => [point(section.startPoint, "edge start"), ...(section.bendPoints ?? []).map(bend => point(bend, "edge bend")), point(section.endPoint, "edge end")]);
    const label = geometry.labels?.[0];
    return { ...edge, sections, ...(label ? { labelBounds: bounds(label, "edge label") } : {}) };
  });
  return { signature: scene.signature, width: finite(result.height, "graph height", 0), height: finite(result.width, "graph width", 0), nodes: layoutNodes, edges: layoutEdges, durationMs: performance.now() - started };
}
