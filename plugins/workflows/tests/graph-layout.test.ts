import assert from "node:assert/strict";
import test from "node:test";
import { compileDefinition } from "../src/definition.ts";
import type { DefinitionNode, DefinitionPlan, WorkflowDefinition } from "../src/definition.ts";
import { buildGraphScene } from "../prototypes/graph-model.ts";
import { layoutGraphScene } from "../prototypes/graph-layout.ts";
import type { GraphBounds, GraphGeometry, GraphPoint } from "../prototypes/graph-types.ts";

const measuredFixtureText = (text: string): number => Array.from(text).length * 8;
const epsilon = 0.0001;
const close = (a: number, b: number) => Math.abs(a - b) < epsilon;
function compoundFixture(): DefinitionPlan {
  return compileDefinition({ schemaVersion: 1, name: "compound-layout", description: "Nested branch, parallel, empty paths and loop routing", steps: [
    { id: "before", type: "transform", value: 1 },
    { id: "loop", type: "repeat", maxIterations: 3, steps: [
      { id: "route", type: "choice", label: "检查结果", cases: [{ id: "code", when: true, steps: [{ id: "parallel", type: "parallel", policy: "fail-fast", branches: [{ id: "tests", steps: [{ id: "test", type: "agent", task: "Test" }] }, { id: "docs", steps: [{ id: "docs", type: "agent", task: "Docs" }] }] }] }], default: [] },
      { id: "nested", type: "repeat", maxIterations: 2, steps: [{ id: "nestedTask", type: "transform", value: 1 }] },
    ] },
    { id: "after", type: "transform", value: 2 },
  ] }).plan;
}
function assertGeometry(geometry: GraphGeometry): void {
  const nodes = new Map(geometry.nodes.map(node => [node.id, node]));
  for (const node of geometry.nodes) {
    assert.ok([node.x, node.y, node.width, node.height].every(Number.isFinite), node.id);
    if (node.parentId) {
      const parent = nodes.get(node.parentId)!;
      assert.ok(parent.x <= node.x + epsilon && parent.y <= node.y + epsilon, `${node.id}: parent origin`);
      assert.ok(parent.x + parent.width >= node.x + node.width - epsilon && parent.y + parent.height >= node.y + node.height - epsilon, `${node.id}: parent bounds`);
    }
    for (const port of node.ports) {
      const position = node.portPositions[port.id]!;
      assert.ok(position, port.id);
      if (port.side === "WEST") assert.ok(close(position.x, node.x), port.id);
      if (port.side === "NORTH") assert.ok(close(position.y, node.y), port.id);
      if (port.side === "EAST") assert.ok(close(position.x, node.x + node.width), port.id);
      if (port.side === "SOUTH") assert.ok(close(position.y, node.y + node.height), port.id);
    }
  }
  for (const edge of geometry.edges) {
    if (edge.hidden) { assert.deepEqual(edge.sections, []); continue; }
    assert.ok(edge.sections.length, edge.id);
    const source = nodes.get(edge.source)!.portPositions[edge.sourcePort]!, target = nodes.get(edge.target)!.portPositions[edge.targetPort]!;
    const start = edge.sections[0]![0]!, end = edge.sections.at(-1)!.at(-1)!;
    assert.ok(close(source.x, start.x) && close(source.y, start.y), `${edge.id}: source uses root coordinates`);
    assert.ok(close(target.x, end.x) && close(target.y, end.y), `${edge.id}: target uses root coordinates`);
    for (const section of edge.sections) for (let index = 1; index < section.length; index++) {
      const a = section[index - 1]!, b = section[index]!;
      assert.ok(close(a.x, b.x) || close(a.y, b.y), `${edge.id}: orthogonal route`);
    }
    if (edge.label) { assert.ok(edge.labelBounds, `${edge.id}: measured label bounds`); assert.equal(edge.labelBounds.width, edge.labelSize!.width); }
  }
}
function segmentCrosses(a: GraphPoint, b: GraphPoint, box: GraphBounds): boolean {
  if (close(a.x, b.x)) return a.x > box.x + epsilon && a.x < box.x + box.width - epsilon && Math.max(a.y, b.y) > box.y + epsilon && Math.min(a.y, b.y) < box.y + box.height - epsilon;
  return a.y > box.y + epsilon && a.y < box.y + box.height - epsilon && Math.max(a.x, b.x) > box.x + epsilon && Math.min(a.x, b.x) < box.x + box.width - epsilon;
}

test("ELK lays out nested containers, cross-level ports, empty branches and loop edges in one root coordinate system", async () => {
  const plan = compoundFixture(), scene = buildGraphScene(plan, { measureText: measuredFixtureText });
  const before = JSON.stringify(scene), geometry = await layoutGraphScene(scene);
  assert.equal(geometry.signature, scene.signature);
  assert.equal(geometry.nodes.length, scene.nodes.length);
  assert.deepEqual(geometry.edges.map(edge => edge.id), plan.edges.map(edge => edge.id));
  assertGeometry(geometry);
  assert.equal(JSON.stringify(scene), before, "The worker must not mutate its scene input");
  const node = (id: string) => geometry.nodes.find(node => node.id === id)!;
  assert.ok(node("$join:loop").y >= node("nested").y + node("nested").height);
  assert.ok(node("after").y > node("$join:loop").y);
});

test("real edge routes avoid unrelated visible node interiors and preserve explicit return paths", async () => {
  const geometry = await layoutGraphScene(buildGraphScene(compoundFixture(), { measureText: measuredFixtureText }));
  for (const edge of geometry.edges) for (const section of edge.sections) for (let index = 1; index < section.length; index++) {
    for (const node of geometry.nodes.filter(node => node.kind !== "group" && node.id !== edge.source && node.id !== edge.target)) assert.equal(segmentCrosses(section[index - 1]!, section[index]!, node), false, `${edge.id} crosses ${node.id}`);
  }
  for (const edge of geometry.edges.filter(edge => edge.labelBounds)) for (const node of geometry.nodes.filter(node => node.kind !== "group")) {
    const label = edge.labelBounds!;
    const overlaps = label.x < node.x + node.width - epsilon && label.x + label.width > node.x + epsilon && label.y < node.y + node.height - epsilon && label.y + label.height > node.y + epsilon;
    assert.equal(overlaps, false, `${edge.id} label overlaps ${node.id}`);
  }
  for (const edge of geometry.edges.filter(edge => edge.kind === "repeat")) assert.ok(edge.sections.flat().length >= 3, "The loop back edge must remain a routed edge");
});

test("unrelated node and container bounds do not overlap and helper constraints never escape the adapter", async () => {
  const geometry = await layoutGraphScene(buildGraphScene(compoundFixture(), { measureText: measuredFixtureText }));
  const byId = new Map(geometry.nodes.map(node => [node.id, node]));
  function ancestor(child: string, parent: string): boolean { let id = byId.get(child)?.parentId; while (id) { if (id === parent) return true; id = byId.get(id)?.parentId; } return false; }
  for (let index = 0; index < geometry.nodes.length; index++) for (const b of geometry.nodes.slice(index + 1)) {
    const a = geometry.nodes[index]!;
    if (ancestor(a.id, b.id) || ancestor(b.id, a.id)) continue;
    const overlaps = a.x < b.x + b.width - epsilon && a.x + a.width > b.x + epsilon && a.y < b.y + b.height - epsilon && a.y + a.height > b.y + epsilon;
    assert.equal(overlaps, false, `${a.id} overlaps unrelated ${b.id}`);
  }
  assert.ok(geometry.edges.every(edge => !edge.id.startsWith("$layout:constraint")));
  assert.ok(geometry.nodes.every(node => Object.keys(node.portPositions).length === node.ports.length));
});

test("collapsed layouts route boundary edges while retaining hidden original edge identities", async () => {
  const scene = buildGraphScene(compoundFixture(), { measureText: measuredFixtureText, collapsed: new Set(["loop"]) });
  const geometry = await layoutGraphScene(scene);
  assertGeometry(geometry);
  assert.equal(geometry.edges.length, scene.edges.length);
  assert.ok(geometry.edges.some(edge => edge.hidden));
  assert.ok(geometry.edges.find(edge => edge.target === "after")!.sections.length);
});

test("empty bounded loops retain a genuine self edge with a valid route", async () => {
  const plan = compileDefinition({ schemaVersion: 1, name: "empty-loop", description: "Empty loop", steps: [{ id: "loop", type: "repeat", maxIterations: 2, steps: [] }] }).plan;
  const geometry = await layoutGraphScene(buildGraphScene(plan, { measureText: measuredFixtureText }));
  assertGeometry(geometry);
  assert.ok(geometry.edges.find(edge => edge.source === edge.target)!.sections.length);
});

test("cross-level joins from a nested loop or catch keep complete orthogonal sections", async () => {
  const cases: DefinitionNode[] = [
    { id: "parallel", type: "parallel", policy: "all-settled", branches: [{ id: "loop", steps: [{ id: "loop", type: "repeat", maxIterations: 3, steps: [{ id: "inside", type: "transform", value: 1 }] }] }, { id: "plain", steps: [{ id: "plain", type: "transform", value: 1 }] }] },
    { id: "guard", type: "try", steps: [{ id: "work", type: "transform", value: 1 }], catch: [{ id: "handler", type: "try", steps: [{ id: "handleWork", type: "transform", value: 1 }], finally: [{ id: "handleFinally", type: "transform", value: 1 }] }], finally: [{ id: "finally", type: "transform", value: 1 }] },
  ];
  for (const [index, node] of cases.entries()) {
    const plan = compileDefinition({ schemaVersion: 1, name: `cross-level-${index}`, description: "ELK DOWN postprocessor regression", steps: [node] }).plan;
    const scene = buildGraphScene(plan, { measureText: measuredFixtureText }), geometry = await layoutGraphScene(scene);
    assertGeometry(geometry);
    assert.deepEqual(geometry.edges.map(edge => [edge.id, edge.source, edge.target, edge.label]), scene.edges.map(edge => [edge.id, edge.source, edge.target, edge.label]));
    for (const edge of geometry.edges.filter(edge => edge.kind === "join")) {
      const source = geometry.nodes.find(node => node.id === edge.source)!.portPositions[edge.sourcePort]!;
      const target = geometry.nodes.find(node => node.id === edge.target)!.portPositions[edge.targetPort]!;
      assert.ok(target.y >= source.y, `${edge.id}: normal join must not be turned into a backward control path`);
    }
  }
});

test("seeded valid combinations of branch, loop, map, parallel and handlers retain orthogonal geometry", { timeout: 15000 }, async () => {
  let nextId = 0, seed = 123456789;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  function node(depth: number): DefinitionNode {
    const id = `n${++nextId}`, kind = depth ? random() % 6 : 5;
    switch (kind) {
      case 0: return { id, type: "choice", label: "多路条件判断", cases: [{ id: "first", label: "第一种情况", when: true, steps: [node(depth - 1)] }, { id: "second", label: "第二种情况", when: false, steps: [node(depth - 1)] }], default: random() % 2 ? [node(depth - 1)] : [] };
      case 1: return { id, type: "parallel", label: "并行核验", policy: "all-settled", branches: [{ id: "one", steps: [node(depth - 1)] }, { id: "two", steps: [node(depth - 1)] }] };
      case 2: return { id, type: "repeat", label: "有限循环", maxIterations: 3, steps: [node(depth - 1)] };
      case 3: return { id, type: "map", label: "遍历集合", items: [1, 2], itemKey: { ref: "item" }, steps: [node(depth - 1)] };
      case 4: return { id, type: "try", label: "异常与收尾", steps: [node(depth - 1)], catch: [node(depth - 1)], finally: [node(depth - 1)] };
      default: return { id, type: "transform", label: "保存观察结果", value: true };
    }
  }
  for (let index = 0; index < 20; index++) {
    nextId = 0;
    const definition: WorkflowDefinition = { schemaVersion: 1, name: `seeded-${index}`, description: "Reproducible legal compound geometry", steps: [node(3), node(3), node(3)] };
    const plan = compileDefinition(definition).plan;
    const geometry = await layoutGraphScene(buildGraphScene(plan, { measureText: measuredFixtureText }));
    assertGeometry(geometry);
    assert.equal(geometry.edges.length, plan.edges.length);
  }
});

test("the same presentation input yields stable geometry and cancelled jobs cannot return a scene", async () => {
  const scene = buildGraphScene(compoundFixture(), { measureText: measuredFixtureText });
  const a = await layoutGraphScene(scene), b = await layoutGraphScene(scene);
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.edges, b.edges);
  const before = new AbortController(); before.abort();
  await assert.rejects(layoutGraphScene(scene, before.signal), { name: "AbortError" });
  const during = new AbortController(), pending = layoutGraphScene(scene, during.signal); during.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("20, 100 and 500 node headless fixtures report observed layout timings without browser performance claims", { timeout: 30000 }, async t => {
  for (const count of [20, 100, 500]) {
    const plan: DefinitionPlan = { version: 1, nodes: Array.from({ length: count }, (_, index) => ({ id: `task${index}`, type: "agent", label: `Fixture ${index}` })), edges: Array.from({ length: count - 1 }, (_, index) => ({ id: `edge${index}`, from: `task${index}`, to: `task${index + 1}`, kind: "sequence" })) };
    const scene = buildGraphScene(plan, { measureText: measuredFixtureText }), geometry = await layoutGraphScene(scene);
    assertGeometry(geometry);
    assert.equal(geometry.nodes.length, count);
    assert.equal(geometry.edges.length, count - 1);
    t.diagnostic(JSON.stringify({ logicalNodes: count, sceneNodes: scene.nodes.length, edges: scene.edges.length, layoutMs: Number(geometry.durationMs.toFixed(2)), environment: "Node headless, injected test text metrics" }));
  }
});

test("a 500-node nested branch fixture preserves every real edge with compound layout", { timeout: 30000 }, async t => {
  const definition = { schemaVersion: 1 as const, name: "compound-benchmark", description: "Headless compound benchmark", steps: Array.from({ length: 50 }, (_, index) => ({
    id: `loop${index}`, type: "repeat" as const, maxIterations: 2, steps: [{ id: `choice${index}`, type: "choice" as const, cases: [{ id: "yes", when: true, steps: Array.from({ length: 3 }, (_, inner) => ({ id: `yes${index}_${inner}`, type: "transform" as const, value: inner })) }], default: Array.from({ length: 2 }, (_, inner) => ({ id: `no${index}_${inner}`, type: "transform" as const, value: inner })) }],
  })) };
  const plan = compileDefinition(definition).plan;
  const scene = buildGraphScene(plan, { measureText: measuredFixtureText }), geometry = await layoutGraphScene(scene);
  assertGeometry(geometry);
  assert.equal(geometry.nodes.length, scene.nodes.length);
  assert.equal(geometry.edges.length, plan.edges.length);
  t.diagnostic(JSON.stringify({ logicalNodes: plan.nodes.length, sceneNodes: scene.nodes.length, edges: scene.edges.length, layoutMs: Number(geometry.durationMs.toFixed(2)), environment: "Node headless compound, injected test text metrics" }));
});
