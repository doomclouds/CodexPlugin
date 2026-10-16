import { z } from "zod";
import { assertSafeJson, DESIGN_LIMITS, DesignError, validateDocument } from "./model.ts";
import type { Artboard, DesignDocument, DesignNode } from "./model.ts";

export type DesignPatch = { op: "add" | "replace"; path: string; value: unknown } | { op: "remove"; path: string };

export const patchSchema: z.ZodType<DesignPatch> = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "replace"]), path: z.string().min(1).max(2_048), value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: z.string().min(1).max(2_048) }).strict(),
]);

export function parsePointer(path: string): string[] {
  if (!path.startsWith("/") || /~(?![01])/.test(path)) throw new DesignError("VALIDATION", "Patch paths must be valid RFC 6901 JSON pointers");
  const segments = path.slice(1).split("/").map((value) => value.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((value) => ["__proto__", "constructor", "prototype"].includes(value))) throw new DesignError("VALIDATION", "Unsafe patch path");
  if (segments.includes("id") || ["schemaVersion", "revision", "createdAt", "updatedAt", "id"].includes(segments[0] ?? "")) throw new DesignError("VALIDATION", "IDs and document metadata cannot be patched");
  return segments;
}

function arrayIndex(segment: string, length: number, add: boolean): number {
  if (segment === "-" && add) return length;
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) throw new DesignError("VALIDATION", "Invalid array index");
  const value = Number(segment);
  if (!Number.isSafeInteger(value) || value < 0 || value > length || (!add && value === length)) throw new DesignError("VALIDATION", "Array index is out of bounds");
  return value;
}

function preserveIdentity(previous: unknown, next: unknown): void {
  if (previous === null || typeof previous !== "object") return;
  if (next === null || typeof next !== "object") {
    if (Object.hasOwn(previous, "id")) throw new DesignError("VALIDATION", "Replacing an identified object must preserve its ID");
    return;
  }
  if (Object.hasOwn(previous, "id") && (previous as { id: unknown }).id !== (next as { id?: unknown }).id) throw new DesignError("VALIDATION", "Replacing an identified object must preserve its ID");
  if (Array.isArray(previous)) {
    // An explicit collection replacement can reorder, group, add or remove items.
    // Final document validation still requires globally unique, valid IDs.
    return;
  } else {
    for (const [key, value] of Object.entries(previous)) if (Object.hasOwn(next, key)) preserveIdentity(value, (next as Record<string, unknown>)[key]);
  }
}

export function applyPatches(document: DesignDocument, input: unknown): DesignDocument {
  assertSafeJson(input);
  const parsed = z.array(patchSchema).min(1).max(DESIGN_LIMITS.patches).safeParse(input);
  if (!parsed.success) throw new DesignError("VALIDATION", parsed.error.issues.map((issue) => issue.message).join("; "));
  const draft = structuredClone(document);
  for (const patch of parsed.data) {
    const segments = parsePointer(patch.path);
    const key = segments.pop();
    if (key === undefined) throw new DesignError("VALIDATION", "Root replacement is not supported");
    let parent: unknown = draft;
    for (const segment of segments) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length, false)];
      else if (parent && typeof parent === "object" && Object.hasOwn(parent, segment)) parent = (parent as Record<string, unknown>)[segment];
      else throw new DesignError("VALIDATION", `Patch parent does not exist: ${patch.path}`);
    }
    if (!parent || typeof parent !== "object") throw new DesignError("VALIDATION", "Patch parent must be an object or array");
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, patch.op === "add");
      if (patch.op === "remove") parent.splice(index, 1);
      else if (patch.op === "add") parent.splice(index, 0, structuredClone(patch.value));
      else { preserveIdentity(parent[index], patch.value); parent[index] = structuredClone(patch.value); }
    } else {
      const object = parent as Record<string, unknown>;
      if (patch.op !== "add" && !Object.hasOwn(object, key)) throw new DesignError("VALIDATION", `Patch target does not exist: ${patch.path}`);
      if (patch.op === "remove") delete object[key];
      else {
        if (Object.hasOwn(object, key)) preserveIdentity(object[key], patch.value);
        object[key] = structuredClone(patch.value);
      }
    }
  }
  return validateDocument(draft);
}

export function findNode(document: DesignDocument, id: string): { node: DesignNode; artboard: Artboard; path: string } | undefined {
  const walk = (nodes: DesignNode[], artboard: Artboard, path: string): { node: DesignNode; artboard: Artboard; path: string } | undefined => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (!node) continue;
      const nodePath = `${path}/${index}`;
      if (node.id === id) return { node, artboard, path: nodePath };
      const child = walk(node.children, artboard, `${nodePath}/children`);
      if (child) return child;
    }
    return undefined;
  };
  for (let index = 0; index < document.artboards.length; index++) {
    const artboard = document.artboards[index];
    if (!artboard) continue;
    const found = walk(artboard.nodes, artboard, `/artboards/${index}/nodes`);
    if (found) return found;
  }
  return undefined;
}
