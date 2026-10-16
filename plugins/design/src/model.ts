import { z } from "zod";

export const DESIGN_LIMITS = {
  artboards: 100,
  nodes: 10_000,
  depth: 32,
  components: 200,
  comments: 2_000,
  assets: 200,
  assetBytes: 20 * 1024 * 1024,
  documentBytes: 32 * 1024 * 1024,
  patches: 500,
} as const;

export class DesignError extends Error {
  readonly code: "VALIDATION" | "NOT_FOUND" | "REVISION_CONFLICT" | "LOCKED";
  constructor(code: "VALIDATION" | "NOT_FOUND" | "REVISION_CONFLICT" | "LOCKED", message: string) {
    super(message);
    this.name = "DesignError";
    this.code = code;
  }
}

export interface NodeStyle {
  fill?: string | undefined;
  color?: string | undefined;
  stroke?: string | undefined;
  strokeWidth?: number | undefined;
  radius?: number | undefined;
  opacity?: number | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  lineHeight?: number | undefined;
  textAlign?: "left" | "center" | "right" | "justify" | undefined;
  shadow?: string | undefined;
}

export interface DesignNode {
  id: string;
  name: string;
  type: "frame" | "text" | "rectangle" | "ellipse" | "image" | "button" | "input" | "component";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string | undefined;
  assetId?: string | undefined;
  componentId?: string | undefined;
  style: NodeStyle;
  layout?: {
    mode: "absolute" | "row" | "column" | "grid";
    gap: number;
    padding: number;
    columns?: number | undefined;
    align?: "start" | "center" | "end" | "stretch" | undefined;
    justify?: "start" | "center" | "end" | "space-between" | "space-around" | undefined;
  } | undefined;
  children: DesignNode[];
  interaction?: { action: "navigate" | "url" | "toggle"; target: string } | undefined;
  visible?: boolean | undefined;
  locked?: boolean | undefined;
}

export interface Artboard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  nodes: DesignNode[];
}

export interface DesignDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  designSystem: {
    name: string;
    tokens: Record<string, string>;
    components: Array<{ id: string; name: string; node: DesignNode }>;
  };
  artboards: Artboard[];
  assets: Array<{ id: string; name: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }>;
  comments: Array<{ id: string; artboardId: string; nodeId?: string | undefined; text: string; status: "open" | "resolved"; createdAt: string }>;
}

export const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const nameSchema = z.string().trim().min(1).max(200);
const finite = z.number().finite();
const coordinate = finite.min(-100_000).max(100_000);
const dimension = finite.positive().max(20_000);
const tokenReference = /^\$[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const safeCss = (value: string): boolean => value.length <= 300 && !/[;{}<>\\\x00-\x1f]/.test(value) && !/(?:url\s*\(|expression\s*\(|@import|javascript:|data:|\/\*)/i.test(value);
const color = z.string().max(150).refine((value) => tokenReference.test(value) || /^(?:none|transparent|currentColor|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|navy|teal|lime|cyan|magenta|silver|maroon|olive|aqua|fuchsia)$/i.test(value) || /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || /^(?:rgb|rgba|hsl|hsla)\([\d.,%+\- /]+\)$/i.test(value), "Unsupported color value");
const cssText = z.string().min(1).max(300).refine(safeCss, "Unsafe style value");

export const nodeStyleSchema: z.ZodType<NodeStyle> = z.object({
  fill: color.optional(),
  color: color.optional(),
  stroke: color.optional(),
  strokeWidth: finite.min(0).max(200).optional(),
  radius: finite.min(0).max(10_000).optional(),
  opacity: finite.min(0).max(1).optional(),
  fontFamily: cssText.optional(),
  fontSize: finite.min(1).max(1_000).optional(),
  fontWeight: finite.int().min(100).max(1_000).optional(),
  lineHeight: finite.min(0.5).max(4).optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  shadow: cssText.optional(),
}).strict();

export const nodeSchema: z.ZodType<DesignNode> = z.lazy(() => z.object({
  id: idSchema,
  name: nameSchema,
  type: z.enum(["frame", "text", "rectangle", "ellipse", "image", "button", "input", "component"]),
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  text: z.string().max(100_000).optional(),
  assetId: idSchema.optional(),
  componentId: idSchema.optional(),
  style: nodeStyleSchema,
  layout: z.object({
    mode: z.enum(["absolute", "row", "column", "grid"]),
    gap: finite.min(0).max(10_000),
    padding: finite.min(0).max(10_000),
    columns: finite.int().min(1).max(100).optional(),
    align: z.enum(["start", "center", "end", "stretch"]).optional(),
    justify: z.enum(["start", "center", "end", "space-between", "space-around"]).optional(),
  }).strict().optional(),
  children: z.array(nodeSchema).max(DESIGN_LIMITS.nodes),
  interaction: z.object({ action: z.enum(["navigate", "url", "toggle"]), target: z.string().min(1).max(2_048) }).strict().optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
}).strict());

export const artboardSchema: z.ZodType<Artboard> = z.object({
  id: idSchema,
  name: nameSchema,
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  background: color,
  nodes: z.array(nodeSchema).max(DESIGN_LIMITS.nodes),
}).strict();

const rawDocumentSchema: z.ZodType<DesignDocument> = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  name: nameSchema,
  revision: finite.int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  designSystem: z.object({
    name: nameSchema,
    tokens: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/), cssText).refine((tokens) => Object.keys(tokens).length <= 500, "Too many design tokens"),
    components: z.array(z.object({ id: idSchema, name: nameSchema, node: nodeSchema }).strict()).max(DESIGN_LIMITS.components),
  }).strict(),
  artboards: z.array(artboardSchema).min(1).max(DESIGN_LIMITS.artboards),
  assets: z.array(z.object({ id: idSchema, name: nameSchema, mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().max(Math.ceil(DESIGN_LIMITS.assetBytes / 3) * 4) }).strict()).max(DESIGN_LIMITS.assets),
  comments: z.array(z.object({ id: idSchema, artboardId: idSchema, nodeId: idSchema.optional(), text: z.string().min(1).max(10_000), status: z.enum(["open", "resolved"]), createdAt: z.string().datetime({ offset: true }) }).strict()).max(DESIGN_LIMITS.comments),
}).strict();

export function assertSafeJson(value: unknown): void {
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  let entries = 0;
  let textBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > DESIGN_LIMITS.depth * 3 + 12 || ++entries > 250_000) throw new DesignError("VALIDATION", "Document nesting or entry budget exceeded");
    if (typeof item === "string") {
      textBytes += encoder.encode(item).length;
      if (textBytes > DESIGN_LIMITS.documentBytes) throw new DesignError("VALIDATION", "Document size budget exceeded");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new DesignError("VALIDATION", "Numbers must be finite");
    if (item === null || typeof item !== "object") {
      if (["function", "symbol", "bigint", "undefined"].includes(typeof item)) throw new DesignError("VALIDATION", "Values must be JSON serializable");
      return;
    }
    if (seen.has(item)) throw new DesignError("VALIDATION", "Circular or shared object references are not supported");
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new DesignError("VALIDATION", "Values must be plain JSON objects");
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw new DesignError("VALIDATION", "Unsafe property name");
      if (Array.isArray(item) && key === "length") continue;
      textBytes += encoder.encode(key).length;
      if (textBytes > DESIGN_LIMITS.documentBytes) throw new DesignError("VALIDATION", "Document size budget exceeded");
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !property.enumerable || !("value" in property)) throw new DesignError("VALIDATION", "Accessors and hidden properties are not supported");
      visit(property.value, depth + 1);
    }
  };
  visit(value, 0);
}

function inspectDocument(document: DesignDocument, issue: (message: string) => void): void {
  const ids = new Set<string>();
  const addId = (id: string): void => { if (ids.has(id)) issue(`Duplicate ID: ${id}`); ids.add(id); };
  addId(document.id);
  const boards = new Set(document.artboards.map((board) => board.id));
  const assets = new Set(document.assets.map((asset) => asset.id));
  const components = new Map(document.designSystem.components.map((component) => [component.id, component]));
  const nodes = new Map<string, { node: DesignNode; artboardId?: string }>();
  const edges = new Map<string, Set<string>>();
  let nodeCount = 0;
  const checkToken = (value: string): void => {
    if (tokenReference.test(value) && !Object.hasOwn(document.designSystem.tokens, value.slice(1))) issue(`Unknown design token: ${value}`);
  };
  const walk = (node: DesignNode, depth: number, artboardId?: string, componentId?: string): void => {
    if (++nodeCount > DESIGN_LIMITS.nodes || depth > DESIGN_LIMITS.depth) { issue("Node count or nesting budget exceeded"); return; }
    addId(node.id);
    nodes.set(node.id, { node, ...(artboardId ? { artboardId } : {}) });
    for (const value of Object.values(node.style)) if (typeof value === "string") checkToken(value);
    if (node.assetId && !assets.has(node.assetId)) issue(`Unknown asset: ${node.assetId}`);
    if (node.type === "component" && !node.componentId) issue(`Component instance ${node.id} requires componentId`);
    if (node.componentId) {
      if (!components.has(node.componentId)) issue(`Unknown component: ${node.componentId}`);
      if (componentId) edges.get(componentId)?.add(node.componentId);
    }
    for (const child of node.children) walk(child, depth + 1, artboardId, componentId);
  };
  for (const asset of document.assets) addId(asset.id);
  for (const component of document.designSystem.components) { addId(component.id); edges.set(component.id, new Set()); }
  for (const component of document.designSystem.components) walk(component.node, 1, undefined, component.id);
  for (const board of document.artboards) {
    addId(board.id);
    checkToken(board.background);
    for (const node of board.nodes) walk(node, 1, board.id);
  }
  for (const { node } of nodes.values()) {
    const interaction = node.interaction;
    if (!interaction) continue;
    if (interaction.action === "navigate" && !boards.has(interaction.target)) issue(`Unknown navigation artboard: ${interaction.target}`);
    if (interaction.action === "toggle" && !nodes.has(interaction.target)) issue(`Unknown toggle node: ${interaction.target}`);
    if (interaction.action === "url") {
      try { if (!["https:", "http:", "mailto:"].includes(new URL(interaction.target).protocol)) issue("Interaction URL protocol is not allowed"); }
      catch { issue("Invalid interaction URL"); }
    }
  }
  for (const comment of document.comments) {
    addId(comment.id);
    if (!boards.has(comment.artboardId)) issue(`Unknown comment artboard: ${comment.artboardId}`);
    if (comment.nodeId && nodes.get(comment.nodeId)?.artboardId !== comment.artboardId) issue(`Comment node does not belong to its artboard: ${comment.nodeId}`);
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  const checkCycle = (id: string): void => {
    if (active.has(id)) { issue(`Component reference cycle: ${id}`); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const next of edges.get(id) ?? []) checkCycle(next);
    active.delete(id);
    visited.add(id);
  };
  for (const id of components.keys()) checkCycle(id);
  for (const [key, value] of Object.entries(document.designSystem.tokens)) {
    checkToken(value);
    const chain = new Set([key]);
    let current = value;
    while (tokenReference.test(current)) {
      const next = current.slice(1);
      if (chain.has(next)) { issue(`Design token cycle: ${key}`); break; }
      chain.add(next);
      current = document.designSystem.tokens[next] ?? "";
    }
  }
  let bytes = 0;
  for (const asset of document.assets) {
    if (!asset.data || asset.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) { issue(`Invalid base64 asset: ${asset.id}`); continue; }
    let data: string;
    try { data = atob(asset.data); }
    catch { issue(`Invalid base64 asset: ${asset.id}`); continue; }
    bytes += data.length;
    const valid = asset.mimeType === "image/png" ? data.startsWith("\x89PNG\r\n\x1a\n") : asset.mimeType === "image/jpeg" ? data.length >= 4 && data.charCodeAt(0) === 255 && data.charCodeAt(1) === 216 && data.charCodeAt(2) === 255 : data.length >= 12 && data.slice(0, 4) === "RIFF" && data.slice(8, 12) === "WEBP";
    if (!valid || btoa(data) !== asset.data) issue(`Asset content does not match its media type: ${asset.id}`);
  }
  if (bytes > DESIGN_LIMITS.assetBytes) issue("Asset size budget exceeded");
}

export const designDocumentSchema: z.ZodType<DesignDocument> = z.any().superRefine((value, context) => {
  try { assertSafeJson(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Unsafe document" }); }
}).pipe(rawDocumentSchema).superRefine((document, context) => inspectDocument(document, (message) => context.addIssue({ code: "custom", message })));

export function validateDocument(value: unknown): DesignDocument {
  const result = designDocumentSchema.safeParse(value);
  if (!result.success) throw new DesignError("VALIDATION", result.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`).join("; "));
  return result.data;
}
