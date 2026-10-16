import type { DefinitionPlan, DefinitionPlanNode } from "../src/definition.ts";
import type { GraphFont, GraphPort, GraphScene, SceneEdge, SceneNode, SceneOptions } from "./graph-types.ts";

export const GRAPH_SCENE_LIMITS = Object.freeze({ nodes: 2000, edges: 8000, depth: 48, labelCharacters: 512 });
export const DEFAULT_GRAPH_FONT: GraphFont = Object.freeze({ family: "system-ui, sans-serif", size: 14, lineHeight: 20 });
const containers = new Set<DefinitionPlanNode["type"]>(["repeat", "map", "parallel", "try", "subflow", "expand"]);
const groupId = (id: string): string => `$group:${id}`;

function validateFont(input: GraphFont): GraphFont {
  if (!input.family.trim() || input.family.length > 512 || /[\u0000-\u001f]/.test(input.family) || !Number.isFinite(input.size) || input.size < 1 || input.size > 100 || !Number.isFinite(input.lineHeight) || input.lineHeight < 1 || input.lineHeight > 160) throw new Error("Invalid graph font metrics.");
  return { family: input.family, size: input.size, lineHeight: input.lineHeight };
}
/** Production measures the actual host font. The headless fallback is for geometry tests only. */
function textMeasurer(font: GraphFont, supplied?: (text: string) => number): (text: string) => number {
  let measure = supplied;
  if (!measure && typeof document !== "undefined") {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Canvas font measurement is unavailable.");
    context.font = `${font.size}px ${font.family}`;
    measure = value => context.measureText(value).width;
  }
  measure ??= value => Array.from(value).reduce((width, char) => width + font.size * (/[^\u0000-\u024f]/u.test(char) ? 1 : 0.58), 0);
  return value => {
    const width = measure!(value);
    if (!Number.isFinite(width) || width < 0 || width > 1_000_000) throw new Error("Graph text measurement returned invalid dimensions.");
    return width;
  };
}
function wrapLabel(value: string, maximum: number, measure: (text: string) => number, maximumLines = 3): string[] {
  const result: string[] = [];
  let line = "";
  const characters = Array.from(value.replace(/[\r\n\t]/g, " "));
  for (let index = 0; index < characters.length; index++) {
    const next = line + characters[index];
    if (line && measure(next) > maximum) {
      if (result.length === maximumLines - 1) {
        while (line && measure(`${line}…`) > maximum) line = Array.from(line).slice(0, -1).join("");
        result.push(`${line}…`);
        return result;
      }
      result.push(line); line = characters[index]!;
    } else line = next;
  }
  if (line || !result.length) result.push(line);
  return result;
}
/** Non-security fingerprint of presentation inputs; execution trust never depends on this value. */
function signature(value: unknown): string {
  const source = JSON.stringify(value);
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193); b = Math.imul(b ^ code, 0x85ebca6b);
    c = Math.imul(c ^ code, 0xc2b2ae35); d = Math.imul(d ^ code, 0x27d4eb2f);
  }
  return `scene-v1:${[a, b, c, d].map(value => (value >>> 0).toString(16).padStart(8, "0")).join("")}:${source.length}`;
}
function edgeLabel(edge: DefinitionPlan["edges"][number]): string {
  if (edge.label !== undefined) return edge.label;
  switch (edge.kind) {
    case "case": return edge.branchId ?? "条件成立";
    case "default": return "其他";
    case "branch": return edge.branchId ?? "并行分支";
    case "repeat": return "下一轮";
    case "exit": return "退出";
    case "catch": return "异常";
    case "finally": return "收尾";
    default: return "";
  }
}

/** Convert the authoritative plan into presentation-only wrappers, ports and measured labels. */
export function buildGraphScene(plan: DefinitionPlan, options: SceneOptions = {}): GraphScene {
  if (plan.version !== 1 || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) throw new Error("Invalid graph plan.");
  if (plan.nodes.length > GRAPH_SCENE_LIMITS.nodes || plan.edges.length > GRAPH_SCENE_LIMITS.edges) throw new Error("The workflow exceeds the graph size budget; its complete structure cannot be displayed.");
  const byId = new Map<string, DefinitionPlanNode>();
  for (const node of plan.nodes) {
    if (!node.id || byId.has(node.id) || typeof node.label !== "string" || node.label.length > GRAPH_SCENE_LIMITS.labelCharacters) throw new Error("Invalid or duplicate graph node.");
    byId.set(node.id, node);
  }
  const ancestry = new Map<string, string[]>();
  for (const node of plan.nodes) {
    const parents: string[] = [], visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent !== undefined) {
      if (!byId.has(parent) || visited.has(parent)) throw new Error("The graph contains an invalid or cyclic parent relationship.");
      if (parents.length >= GRAPH_SCENE_LIMITS.depth) throw new Error("The graph exceeds the nesting budget.");
      parents.push(parent); visited.add(parent); parent = byId.get(parent)!.parentId;
    }
    ancestry.set(node.id, parents);
  }
  const edgeIds = new Set<string>();
  for (const edge of plan.edges) {
    if (!edge.id || edgeIds.has(edge.id) || !byId.has(edge.from) || !byId.has(edge.to)) throw new Error("Invalid graph edge identity or endpoint.");
    edgeIds.add(edge.id);
  }
  const collapsed = new Set([...options.collapsed ?? []].filter(id => byId.has(id) && containers.has(byId.get(id)!.type)));
  function visible(id: string): string { let result = id; for (const parent of ancestry.get(id) ?? []) if (collapsed.has(parent)) result = parent; return result; }
  function wrapperParent(id: string): string | undefined { return ancestry.get(id)?.find(parent => containers.has(byId.get(parent)!.type) && !collapsed.has(parent)); }
  const font = validateFont(options.font ?? DEFAULT_GRAPH_FONT), measure = textMeasurer(font, options.measureText);
  const nodes: SceneNode[] = [];
  for (const node of plan.nodes) {
    if (visible(node.id) !== node.id) continue;
    const parent = wrapperParent(node.id), compound = containers.has(node.type) && !collapsed.has(node.id);
    if (compound && byId.has(groupId(node.id))) throw new Error("A synthetic graph group collides with a workflow node identity.");
    let width: number, height: number, labelLines: string[];
    if (node.type === "join") { width = 18; height = 18; labelLines = []; }
    else {
      width = Math.ceil(Math.max(node.type === "choice" ? 252 : 218, Math.min(node.type === "choice" ? 380 : 340, measure(node.label) + (node.type === "choice" ? 132 : 88))));
      labelLines = wrapLabel(node.label, width - (node.type === "choice" ? 128 : 72), measure);
      if (node.type === "choice" && labelLines.length > 1) labelLines = wrapLabel(node.label, Math.floor(width * 0.44), measure);
      height = Math.max(node.type === "choice" ? 120 : 84, Math.ceil(labelLines.length * font.lineHeight + (node.type === "choice" ? 72 : 60)));
      if (node.type === "choice") {
        // The renderer centers lines at H/2 - lineCount*lineHeight/2 - 4.
        // Reserve horizontal padding at the narrowest (first-line top) diamond slice.
        const widest = Math.max(...labelLines.map(measure)), ratio = (widest + 16) / (width - 2);
        if (ratio >= 1) throw new Error("Measured choice text cannot fit inside the diamond width.");
        height = Math.max(height, Math.ceil((labelLines.length * font.lineHeight + 10) / (1 - ratio)));
      }
    }
    if (compound) nodes.push({ id: groupId(node.id), kind: "group", ownerId: node.id, label: node.label, width: width + 56, height: height + 56, ports: [], ...(parent ? { parentId: groupId(parent) } : {}) });
    nodes.push({ id: node.id, kind: node.type, label: node.label, width, height, ports: [], labelLines, ...(node.parentId ? { logicalParentId: node.parentId } : {}), ...(compound ? { parentId: groupId(node.id) } : parent ? { parentId: groupId(parent) } : {}), ...(containers.has(node.type) ? { collapsible: true, collapsed: collapsed.has(node.id) } : {}) });
  }
  if (nodes.length > GRAPH_SCENE_LIMITS.nodes) throw new Error("The expanded workflow exceeds the presentation node budget.");
  const sceneById = new Map(nodes.map(node => [node.id, node]));
  const edges: SceneEdge[] = plan.edges.map(edge => {
    const source = visible(edge.from), target = visible(edge.to);
    const hidden = source === target && (edge.from !== source || edge.to !== target);
    const sourcePort = `$port:${edge.id}:source`, targetPort = `$port:${edge.id}:target`;
    const loop = edge.kind === "repeat";
    const ports: [string, GraphPort][] = [[source, { id: sourcePort, side: loop ? "WEST" : "SOUTH", direction: "out" }], [target, { id: targetPort, side: loop ? "WEST" : "NORTH", direction: "in" }]];
    if (!hidden) for (const [id, port] of ports) sceneById.get(id)!.ports.push(port);
    const label = options.edgeLabels?.get(edge.id) ?? edgeLabel(edge);
    if (label.length > GRAPH_SCENE_LIMITS.labelCharacters) throw new Error("A graph edge label exceeds the presentation limit.");
    return { id: edge.id, source, target, sourcePort, targetPort, kind: edge.kind, label, originalEdgeIds: [edge.id], ...(hidden ? { hidden: true } : {}), ...(label ? { labelSize: { width: Math.ceil(measure(label)) + 12, height: Math.ceil(font.lineHeight) + 6 } } : {}) };
  });
  return { signature: signature({ font, nodes, edges }), nodes, edges, font };
}
