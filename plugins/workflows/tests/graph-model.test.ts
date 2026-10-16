import assert from "node:assert/strict";
import test from "node:test";
import { compileDefinition } from "../src/definition.ts";
import type { DefinitionPlan } from "../src/definition.ts";
import { buildGraphScene, GRAPH_SCENE_LIMITS } from "../prototypes/graph-model.ts";

const measureText = (text: string): number => Array.from(text).reduce((width, char) => width + (/[^\u0000-\u024f]/u.test(char) ? 14 : 8), 0);
function fixture(): DefinitionPlan {
  return compileDefinition({ schemaVersion: 1, name: "scene-test", description: "Presentation semantics", steps: [
    { id: "before", type: "transform", value: true },
    { id: "loop", type: "repeat", label: "验证与修复循环", maxIterations: 3, steps: [
      { id: "route", type: "choice", label: "按实际结果选择", cases: [{ id: "yes", when: true, steps: [{ id: "work", type: "agent", task: "Inspect" }] }], default: [] },
      { id: "parallel", type: "parallel", policy: "all-settled", branches: [{ id: "a", steps: [{ id: "left", type: "transform", value: 1 }] }, { id: "b", steps: [{ id: "right", type: "transform", value: 2 }] }] },
    ] },
    { id: "after", type: "transform", value: true },
  ] }).plan;
}

test("compound wrappers preserve original logical headers, nested choice ownership and edge identities", () => {
  const plan = fixture(), before = JSON.stringify(plan);
  const scene = buildGraphScene(plan, { measureText });
  assert.equal(scene.nodes.find(node => node.id === "$group:loop")?.ownerId, "loop");
  assert.equal(scene.nodes.find(node => node.id === "loop")?.parentId, "$group:loop");
  assert.equal(scene.nodes.find(node => node.id === "$group:parallel")?.parentId, "$group:loop");
  assert.equal(scene.nodes.find(node => node.id === "work")?.parentId, "$group:loop");
  assert.equal(scene.nodes.find(node => node.id === "work")?.logicalParentId, "route");
  assert.equal(scene.nodes.some(node => node.id === "$group:route"), false);
  assert.deepEqual(scene.edges.map(edge => edge.id), plan.edges.map(edge => edge.id));
  assert.ok(scene.edges.every(edge => edge.originalEdgeIds.length === 1 && edge.originalEdgeIds[0] === edge.id));
  assert.equal(JSON.stringify(plan), before);
});

test("folding affects presentation only and retains internal edges without painting invented self loops", () => {
  const plan = fixture(), scene = buildGraphScene(plan, { measureText, collapsed: new Set(["loop"]) });
  assert.deepEqual(scene.nodes.map(node => node.id), ["before", "loop", "after"]);
  assert.equal(scene.nodes.find(node => node.id === "loop")?.collapsed, true);
  assert.equal(scene.edges.length, plan.edges.length);
  const incoming = scene.edges.find(edge => plan.edges.find(original => original.id === edge.id)?.from === "before")!;
  assert.deepEqual([incoming.source, incoming.target, incoming.hidden], ["before", "loop", undefined]);
  const outgoing = scene.edges.find(edge => edge.target === "after")!;
  assert.equal(outgoing.source, "loop");
  assert.equal(outgoing.hidden, undefined);
  assert.ok(scene.edges.filter(edge => edge.source === "loop" && edge.target === "loop").every(edge => edge.hidden));
  const expanded = buildGraphScene(plan, { measureText });
  assert.deepEqual(expanded.edges.map(edge => edge.id), scene.edges.map(edge => edge.id));
  assert.equal(expanded.edges.some(edge => edge.hidden), false);
});

test("a genuine empty-loop self edge is not mistaken for collapsed internal content", () => {
  const plan = compileDefinition({ schemaVersion: 1, name: "empty-loop", description: "Empty bounded loop", steps: [{ id: "loop", type: "repeat", maxIterations: 2, steps: [] }] }).plan;
  const scene = buildGraphScene(plan, { measureText });
  const self = scene.edges.find(edge => edge.source === "loop" && edge.target === "loop")!;
  assert.ok(self);
  assert.equal(self.hidden, undefined);
  assert.equal(scene.nodes.find(node => node.id === "loop")!.ports.length, 3);
});

test("status, scope, selection and progress never change a geometry signature", () => {
  const plan = fixture();
  const first = { ...plan, revision: 1, selectedNodeId: "work", nodes: plan.nodes.map(node => ({ ...node, status: "mixed", inScope: false, instanceIds: ["old", "active"] })) };
  const next = { ...plan, revision: 99, selectedNodeId: "after", nodes: plan.nodes.map(node => ({ ...node, status: "running", inScope: true, instanceIds: ["new"] })) };
  assert.equal(buildGraphScene(first, { measureText }).signature, buildGraphScene(next, { measureText }).signature);
  assert.notEqual(buildGraphScene(plan, { measureText }).signature, buildGraphScene(plan, { measureText, collapsed: new Set(["loop"]) }).signature);
});

test("dynamic frame identities and cross-level endpoints are never rewritten into task-order guesses", () => {
  const plan: DefinitionPlan = { version: 1, nodes: [{ id: "expand", type: "expand", label: "动态展开" }, { id: "$frame:one:same", type: "agent", label: "同名任务一", parentId: "expand" }, { id: "$frame:two:same", type: "agent", label: "同名任务二", parentId: "expand" }], edges: [{ id: "$frame:e", from: "$frame:one:same", to: "$frame:two:same", kind: "sequence" }] };
  const scene = buildGraphScene(plan, { measureText });
  assert.ok(scene.nodes.some(node => node.id === "$frame:one:same"));
  assert.ok(scene.nodes.some(node => node.id === "$frame:two:same"));
  assert.equal(scene.edges[0]!.source, "$frame:one:same");
  assert.equal(scene.edges[0]!.target, "$frame:two:same");
});

test("measured host-font dimensions and text wrapping are presentation inputs, never HTML", () => {
  const label = '<img src=x onerror="alert(1)">这是一个很长的中文工作流节点标题';
  const plan: DefinitionPlan = { version: 1, nodes: [{ id: "task", type: "agent", label }], edges: [] };
  let calls = 0;
  const scene = buildGraphScene(plan, { font: { family: "Host Test Font", size: 16, lineHeight: 24 }, measureText: value => { calls++; return Array.from(value).length * 16; } });
  const node = scene.nodes[0]!;
  assert.ok(calls > 1);
  assert.equal(node.label, label);
  assert.ok(node.labelLines!.length > 1);
  assert.ok(node.labelLines!.every(line => measureText(line) <= node.width));
  assert.equal("html" in node, false);
  assert.equal("markup" in node, false);
  assert.notEqual(scene.signature, buildGraphScene(plan, { measureText }).signature);
});

test("multiline choice text fits the diamond at every line's top and bottom, including larger host fonts", () => {
  for (const typography of [{ size: 14, lineHeight: 20 }, { size: 20, lineHeight: 28 }, { size: 28, lineHeight: 40 }]) {
    const measured = (value: string) => Array.from(value).length * typography.size;
    const scene = buildGraphScene({ version: 1, nodes: [{ id: "route", type: "choice", label: "这是一段足够长的条件判断文字用于验证三行文字不会超过菱形内部可绘制的区域以及轮廓边界" }], edges: [] }, { font: { family: "Test font metrics", ...typography }, measureText: measured });
    const node = scene.nodes[0]!, lines = node.labelLines!;
    assert.equal(lines.length, 3);
    const firstTop = node.height / 2 - typography.lineHeight * lines.length / 2 - 4;
    for (let index = 0; index < lines.length; index++) {
      const top = firstTop + index * typography.lineHeight, bottom = top + typography.lineHeight;
      for (const y of [top, bottom]) {
        const sliceWidth = (node.width - 2) * Math.min((y - 1) / (node.height / 2 - 1), (node.height - 1 - y) / (node.height / 2 - 1));
        assert.ok(measured(lines[index]!) + 12 <= sliceWidth, `Font ${typography.size}, line ${index}, y=${y}: text must fit the diamond slice, not only its rectangular bounds`);
      }
    }
  }
});

test("short single-line conditions retain the original compact diamond dimensions", () => {
  const scene = buildGraphScene({ version: 1, nodes: [{ id: "route", type: "choice", label: "条件成立" }], edges: [] }, { measureText });
  const node = scene.nodes[0]!;
  assert.deepEqual(node.labelLines, ["条件成立"]);
  assert.equal(node.width, 252);
  assert.equal(node.height, 120);
});

test("branch labels are measured once for the worker and ports have stable unique identities", () => {
  const plan = fixture(), special = plan.edges.find(edge => edge.kind === "case")!;
  special.label = "检查结果符合要求";
  assert.equal(buildGraphScene(plan, { measureText }).edges.find(edge => edge.id === special.id)!.label, "检查结果符合要求");
  const scene = buildGraphScene(plan, { measureText, edgeLabels: new Map([[special.id, "核对通过"]]) });
  const edge = scene.edges.find(edge => edge.id === special.id)!;
  assert.equal(edge.label, "核对通过");
  assert.equal(edge.labelSize!.width, measureText("核对通过") + 12);
  const ports = scene.nodes.flatMap(node => node.ports.map(port => port.id));
  assert.equal(new Set(ports).size, ports.length);
  assert.ok(scene.edges.filter(edge => !edge.hidden).every(edge => ports.includes(edge.sourcePort) && ports.includes(edge.targetPort)));
});

test("invalid graph identities, hierarchy and budget violations fail explicitly instead of dropping elements", () => {
  for (const plan of [
    { version: 1, nodes: [{ id: "a", type: "agent", label: "a" }, { id: "a", type: "agent", label: "b" }], edges: [] },
    { version: 1, nodes: [{ id: "a", type: "agent", label: "a", parentId: "missing" }], edges: [] },
    { version: 1, nodes: [{ id: "a", type: "agent", label: "a", parentId: "b" }, { id: "b", type: "agent", label: "b", parentId: "a" }], edges: [] },
    { version: 1, nodes: [{ id: "a", type: "agent", label: "a" }], edges: [{ id: "e", from: "a", to: "missing", kind: "sequence" }] },
    { version: 1, nodes: Array.from({ length: GRAPH_SCENE_LIMITS.nodes + 1 }, (_, index) => ({ id: `a${index}`, type: "agent", label: "a" })), edges: [] },
  ]) assert.throws(() => buildGraphScene(plan as DefinitionPlan, { measureText }));
  assert.throws(() => buildGraphScene(fixture(), { measureText: () => NaN }), /measurement/);
});
