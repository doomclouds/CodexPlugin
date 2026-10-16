import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { parse } from "acorn";
import { buildGraphScene } from "../prototypes/graph-model.ts";
import type { GraphGeometry, GraphScene } from "../prototypes/graph-types.ts";

/** Run the exact shipped worker, not a separate Node import or a stand-in Worker. */
async function shippedWorkerSource(): Promise<string> {
  const panel = await readFile(new URL("../runtime/panel.html", import.meta.url), "utf8");
  const scripts = [...panel.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  const workers: string[] = [];
  function visit(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "Literal" && typeof node.value === "string" && node.value.length > 100000 && node.value.includes("org.eclipse.elk") && node.value.includes("signature")) workers.push(node.value);
    if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
      const text = (node.quasis as Array<{ value: { cooked?: string } }>)[0]?.value.cooked;
      if (text && text.length > 100000 && text.includes("org.eclipse.elk") && text.includes("signature")) workers.push(text);
    }
    for (const child of Object.values(node)) visit(child);
  }
  for (const script of scripts) visit(parse(script, { ecmaVersion: "latest", sourceType: "script" }));
  assert.equal(workers.length, 1, "The shipped panel must contain one explicit self-contained ELK worker bundle");
  return workers[0]!;
}

test("the shipped minified browser worker lays out graphs with real self and no DOM or Node module globals", { timeout: 15000 }, async () => {
  const source = await shippedWorkerSource();
  const replies: Array<{ id: number; geometry?: GraphGeometry; error?: string }> = [];
  let nestedWorkers = 0;
  let pending: { id: number; resolve: (geometry: GraphGeometry) => void; reject: (error: Error) => void } | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const context = vm.createContext({
    console, performance,
    setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) { const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); clearTimeout(timer); },
    Worker: class { constructor() { nestedWorkers++; throw new Error("The outer worker must not create a nested browser worker."); } },
    postMessage(value: { id: number; geometry?: GraphGeometry; error?: string }) {
      replies.push(value);
      if (pending?.id !== value.id) return;
      if (value.error || !value.geometry) pending.reject(new Error(value.error ?? "Missing layout geometry"));
      else pending.resolve(value.geometry);
      pending = undefined;
    },
  });
  context.self = context;
  context.globalThis = context;
  const originalSelf = context.self;
  function request(id: number, scene: GraphScene): Promise<GraphGeometry> {
    return new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
      // A browser's postMessage clones arrays into the receiver's realm.
      context.requestJson = JSON.stringify({ id, scene });
      vm.runInContext("onmessage({ data: JSON.parse(requestJson) }); delete globalThis.requestJson;", context);
    });
  }
  try {
    vm.runInContext(source, context, { filename: "published-graph-layout-worker.js", timeout: 5000 });
    assert.equal(typeof context.onmessage, "function");
    const scene = buildGraphScene({ version: 1, nodes: [{ id: "a", type: "transform", label: "开始" }, { id: "b", type: "transform", label: "结束" }], edges: [{ id: "edge", from: "a", to: "b", kind: "sequence" }] }, { measureText: value => value.length * 8 });
    const first = await request(1, scene);
    assert.equal(first.signature, scene.signature);
    assert.equal(first.nodes.length, 2);
    assert.ok(first.edges[0]!.sections.length);
    const second = await request(2, scene);
    assert.equal(second.signature, scene.signature);
    assert.equal(second.nodes.length, 2);
    assert.equal(context.self, originalSelf, "ELK compatibility must not overwrite the real worker self");
    assert.equal(nestedWorkers, 0);
    assert.deepEqual(replies.map(reply => reply.id), [1, 2], "Only the application protocol may reach the outer message channel");
    assert.equal(context.document, undefined);
    assert.equal(context.module, undefined);
    assert.equal(context.process, undefined);
  } finally { for (const timer of timers) clearTimeout(timer); }
});
