import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import type { Edge, Node, Model, Graph } from "@antv/x6";
import { replaceGraphGeometry } from "../prototypes/graph-renderer.ts";
import { buildGraphScene } from "../prototypes/graph-model.ts";
import { layoutGraphScene } from "../prototypes/graph-layout.ts";
import type { DefinitionPlan } from "../src/definition.ts";
import type { GraphGeometry } from "../prototypes/graph-types.ts";

/** Bundle the actual installed X6 model classes, without browser views or a DOM substitute. */
async function realModels(): Promise<{ Model: typeof Model; Node: typeof Node; Edge: typeof Edge }> {
  const output = await build({ stdin: { contents: "export {Model} from '@antv/x6/es/model/model.js';export {Node} from '@antv/x6/es/model/node.js';export {Edge} from '@antv/x6/es/model/edge.js';", resolveDir: fileURLToPath(new URL("../", import.meta.url)) }, bundle: true, write: false, platform: "node", format: "cjs", target: "node24" });
  const module = { exports: {} }, execute = vm.runInThisContext(`(function(module,exports,require){${output.outputFiles[0]!.text}\n})`) as (module: object, exports: object, require: NodeJS.Require) => void;
  execute(module, module.exports, createRequire(import.meta.url)); return module.exports as Awaited<ReturnType<typeof realModels>>;
}
const source: DefinitionPlan = { version: 1, nodes: [{ id: "start", type: "transform", label: "Start" }, { id: "loop", type: "repeat", label: "Verify and repair" }, { id: "body", type: "agent", label: "Read fixture", parentId: "loop" }, { id: "$join:loop", type: "join", label: "Join", parentId: "loop" }, { id: "end", type: "transform", label: "End" }], edges: [{ id: "start-loop", from: "start", to: "loop", kind: "sequence" }, { id: "body-entry", from: "loop", to: "body", kind: "body" }, { id: "repeat", from: "body", to: "loop", kind: "repeat" }, { id: "exit", from: "loop", to: "$join:loop", kind: "exit" }, { id: "end-loop", from: "$join:loop", to: "end", kind: "sequence" }] };

test("real X6 model retains exactly the visible edges after collapse, expansion, font changes and added nodes", async () => {
  assert.equal(typeof document, "undefined");
  const real = await realModels(), model = new real.Model(), nodes = new Map<string, Node>(), edges = new Map<string, Edge>();
  const adapter = { getEdges: () => model.getEdges(), removeEdge: (edge: Edge) => model.removeCell(edge), removeNode: (node: Node, options: object) => model.removeCell(node, options), addEdge: (metadata: object) => { const edge = new real.Edge(metadata); model.addCell(edge); return edge; }, batchUpdate: (name: string, execute: () => void) => model.batchUpdate(name, execute) } as unknown as Pick<Graph, "getEdges" | "removeEdge" | "removeNode" | "addEdge" | "batchUpdate">;
  const apply = (geometry: GraphGeometry) => {
    replaceGraphGeometry(adapter, geometry, { nodes, edges }, { createNode(node) { const cell = new real.Node({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height, ports: { groups: { absolute: { position: "absolute" } }, items: [] } }); model.addCell(cell); return cell; }, updateNode(cell, node) { cell.position(node.x, node.y); cell.resize(node.width, node.height); }, configureEdge() {} });
    const expected = geometry.edges.filter(edge => !edge.hidden).flatMap(edge => edge.sections.map((_, index) => `${edge.id}::section:${index}`)).sort();
    assert.deepEqual(model.getEdges().map(edge => edge.id).sort(), expected); assert.deepEqual([...edges.keys()].sort(), expected);
    for (const [id, edge] of edges) assert.equal(model.getCell(id), edge, "Every cached edge must belong to the live X6 model");
    for (const node of geometry.nodes) assert.deepEqual(nodes.get(node.id)!.getPorts().map(port => port.id).sort(), node.ports.map(port => port.id).sort());
  };
  const layout = (plan: DefinitionPlan, collapsed = new Set<string>(), size = 14) => layoutGraphScene(buildGraphScene(plan, { collapsed, font: { family: "Fixture", size, lineHeight: size * 1.45 }, measureText: value => value.length * size * 0.6 }));
  try {
    const expanded = await layout(source); apply(expanded); const header = nodes.get("loop"), originalEdge = edges.get("start-loop::section:0");
    apply(await layout(source, new Set(["loop"]))); assert.equal(nodes.get("loop"), header); assert.equal(model.getEdges().length, 2);
    apply(expanded); assert.equal(nodes.get("loop"), header); assert.notEqual(edges.get("start-loop::section:0"), originalEdge); assert.equal(model.getEdges().length, 5);
    apply(await layout(source, new Set(), 19)); assert.equal(nodes.get("loop"), header); assert.equal(model.getEdges().length, 5);
    const added: DefinitionPlan = { version: 1, nodes: [...source.nodes, { id: "added", type: "agent", label: "Generated activity" }], edges: [...source.edges, { id: "generated", from: "end", to: "added", kind: "sequence" }] }; const dynamic = await layout(added); apply(dynamic); assert.equal(model.getEdges().length, 6);
    nodes.get("loop")!.removePorts(); assert.ok(model.getEdges().length < edges.size, "X6 itself deletes connected edges when ports are removed");
    apply(dynamic); assert.equal(model.getEdges().length, 6, "A relayout must recover stale cached Edge objects removed by X6");
  } finally { model.dispose(); }
});
