import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowGraphCanvas, WorkflowGraphController, GraphNodePatchCache, graphNodeStates, graphEdgeStatus } from "../prototypes/graph-renderer.ts";
import type { GraphCommit } from "../prototypes/graph-renderer.ts";
import type { CanvasInput, GraphGeometry, GraphScene, GraphFont } from "../prototypes/graph-types.ts";
import type { DefinitionPlan } from "../src/definition.ts";
import type { StructuredProjection, ProjectionStatus } from "../src/structured-projection.ts";

const plan = (ids = ["first", "second"]): DefinitionPlan => ({ version: 1, nodes: ids.map(id => ({ id, type: "transform", label: id })), edges: ids.slice(1).map((id, index) => ({ id: `edge-${index}`, from: ids[index]!, to: id, kind: "sequence" })) });
function projection(source: DefinitionPlan, status: ProjectionStatus, revision = 1): StructuredProjection { return { version: 1, definitionHash: "fixture", revision, eventCursor: revision, nodes: source.nodes.map(node => ({ ...node, definitionNodeId: node.id, status, instanceIds: [`instance-${node.id}`], inScope: true, counts: {} })), edges: source.edges.map(edge => ({ ...edge, status, instanceIds: [], eventSequences: [], transitionCount: 0, inScope: true })) }; }
const input = (source = plan(), extra: Partial<CanvasInput> = {}): CanvasInput => ({ plan: source, collapsed: new Set(), identity: "run-one", ...extra });
const font: GraphFont = { family: "Fixture Font", size: 14, lineHeight: 20 };
function geometry(scene: GraphScene): GraphGeometry { return { signature: scene.signature, width: 400, height: scene.nodes.length * 120, durationMs: 1, nodes: scene.nodes.map((node, index) => ({ ...node, x: 20, y: index * 120, portPositions: Object.fromEntries(node.ports.map(port => [port.id, { x: 20, y: index * 120 }])) })), edges: scene.edges.map(edge => ({ ...edge, sections: edge.hidden ? [] : [[{ x: 20, y: 20 }, { x: 20, y: 120 }]] })) }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const requests: Array<{ scene: GraphScene; signal?: AbortSignal; result: ReturnType<typeof deferred<GraphGeometry>> }> = [], commits: Array<{ geometry: GraphGeometry; commit: GraphCommit }> = [], patches: GraphCommit[] = [], errors: string[] = [];
  const controller = new WorkflowGraphController({ layout: (scene, signal) => { const result = deferred<GraphGeometry>(); requests.push({ scene, ...(signal ? { signal } : {}), result }); return result.promise; }, onGeometry: (geometry, commit) => commits.push({ geometry, commit }), onState: commit => patches.push(commit), onError: message => errors.push(message) });
  const finish = (index = requests.length - 1) => requests[index]!.result.resolve(geometry(requests[index]!.scene));
  return { requests, commits, patches, errors, controller, finish, update: (value: CanvasInput, selectedFont = font) => controller.update(value, { font: selectedFont, measureText: value => value.length * selectedFont.size * 0.6 }) };
}

test("graph controller can be imported without DOM or loading the X6 runtime", () => {
  assert.equal(typeof document, "undefined"); assert.equal(typeof WorkflowGraphCanvas, "function");
});

test("status, selection and scope patches do not invoke layout again", async () => {
  const f = fixture(), source = plan(), first = f.update(input(source)); f.finish(); await first;
  await f.update(input(source, { selectedNodeId: "second", projection: projection(source, "running", 5) }));
  assert.equal(f.requests.length, 1); assert.equal(f.commits.length, 1); assert.equal(f.patches.length, 1);
  assert.equal(f.patches[0]!.states.get("second")!.selected, true); assert.equal(f.patches[0]!.states.get("second")!.status, "running"); assert.equal(f.patches[0]!.fit, false);
  f.controller.dispose();
});

test("updates during pending layout coalesce and commit the latest state", async () => {
  const f = fixture(), source = plan(), one = f.update(input(source));
  const two = f.update(input(source, { projection: projection(source, "completed", 9), selectedNodeId: "first" }));
  assert.equal(f.requests.length, 1); f.finish(); await Promise.all([one, two]);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0]!.commit.states.get("first")!.status, "completed"); assert.equal(f.commits[0]!.commit.states.get("first")!.selected, true); assert.equal(f.commits[0]!.commit.fit, true); f.controller.dispose();
});

test("a slower obsolete layout cannot replace a newer topology", async () => {
  const f = fixture(), one = f.update(input(plan(["old"]))), two = f.update(input(plan(["new", "added"])));
  assert.equal(f.requests[0]!.signal!.aborted, true); f.finish(1); await two; f.finish(0); await one;
  assert.equal(f.commits.length, 1); assert.ok(f.commits[0]!.geometry.nodes.some(node => node.id === "new")); assert.deepEqual(f.errors, []); f.controller.dispose();
});

test("returning to the committed topology cancels a pending different topology", async () => {
  const f = fixture(), initial = f.update(input()); f.finish(); await initial;
  const pending = f.update(input(plan(["different"]))); await f.update(input());
  assert.equal(f.requests[1]!.signal!.aborted, true); f.finish(1); await pending;
  assert.equal(f.commits.length, 1); assert.equal(f.controller.geometry!.nodes[0]!.id, "first"); f.controller.dispose();
});

test("layout failures are observable and the same scene can retry", async () => {
  const f = fixture(), failed = f.update(input()); f.requests[0]!.result.reject(new Error("fixture layout failed")); await assert.rejects(failed, /fixture layout failed/);
  assert.deepEqual(f.errors, ["fixture layout failed"]); const retried = f.update(input()); f.finish(); await retried; assert.equal(f.commits.length, 1); f.controller.dispose();
});

test("disposing a pending controller aborts work and ignores late completion", async () => {
  const f = fixture(), pending = f.update(input()); f.controller.dispose(); assert.equal(f.requests[0]!.signal!.aborted, true); f.finish(); await pending;
  assert.equal(f.commits.length, 0); await f.update(input(plan(["later"]))); assert.equal(f.requests.length, 1);
});

test("identity switches fit once while geometry and status preserve their viewport", async () => {
  const f = fixture(), initial = f.update(input()); f.finish(); await initial;
  await f.update(input(plan(), { identity: "run-two" })); await f.update(input(plan(), { identity: "run-two", selectedNodeId: "first" }));
  assert.equal(f.requests.length, 1); assert.equal(f.patches[0]!.fit, true); assert.equal(f.patches[1]!.fit, false);
  const changed = f.update(input(plan(["new"]), { identity: "run-three" })); assert.equal(f.patches.at(-1)!.fit, false); f.finish(); await changed; assert.equal(f.commits.at(-1)!.commit.fit, true); f.controller.dispose();
});

test("real font metrics and collapse structure invalidate layout, selection does not", async () => {
  const f = fixture(), source: DefinitionPlan = { version: 1, nodes: [{ id: "loop", type: "repeat", label: "Loop" }, { id: "body", type: "transform", label: "Read fixture", parentId: "loop" }], edges: [{ id: "enter", from: "loop", to: "body", kind: "body" }, { id: "back", from: "body", to: "loop", kind: "repeat" }] };
  let pending = f.update(input(source)); f.finish(); await pending;
  pending = f.update(input(source), { ...font, size: 18, lineHeight: 26 }); f.finish(); await pending; assert.equal(f.requests.length, 2); assert.equal(f.commits.at(-1)!.commit.font.size, 18);
  pending = f.update(input(source, { collapsed: new Set(["loop"]) }), { ...font, size: 18, lineHeight: 26 }); f.finish(); await pending; assert.equal(f.requests.length, 3); assert.ok(!f.commits.at(-1)!.geometry.nodes.some(node => node.id === "body")); f.controller.dispose();
});

test("the first nonempty scene fits even if an empty scene was committed first", async () => {
  const f = fixture(); await f.update(input(plan([]))); assert.equal(f.requests.length, 0); assert.equal(f.commits[0]!.commit.fit, false);
  const nonempty = f.update(input()); f.finish(); await nonempty; assert.equal(f.commits[1]!.commit.fit, true); f.controller.dispose();
});

test("group state and callbacks use the owning logical node rather than its synthetic identity", async () => {
  const f = fixture(), source: DefinitionPlan = { version: 1, nodes: [{ id: "parallel", type: "parallel", label: "Branches" }], edges: [] }, pending = f.update(input(source, { selectedNodeId: "parallel", projection: projection(source, "running") })); f.finish(); await pending;
  const states = graphNodeStates(f.commits[0]!.geometry, input(source, { selectedNodeId: "parallel", projection: projection(source, "running") })); assert.equal(states.get("$group:parallel")!.status, "running"); assert.equal(states.get("$group:parallel")!.selected, true); f.controller.dispose();
});

test("edge status comes from authoritative edge instances rather than node colors", () => {
  const source = plan(), observed = projection(source, "failed"); observed.edges[0]!.status = "completed";
  assert.deepEqual(graphEdgeStatus({ originalEdgeIds: ["edge-0"] }, input(source, { projection: observed })), { status: "completed", inScope: true });
});

test("a failed renderer commit remains retryable instead of caching partially applied geometry", async () => {
  let fail = true, calls = 0; const commits: GraphCommit[] = [];
  const controller = new WorkflowGraphController({ layout: async scene => { calls++; return geometry(scene); }, onGeometry: (_geometry, commit) => { if (fail) throw new Error("Fixture rendering failure"); commits.push(commit); }, onState: () => {} });
  await assert.rejects(controller.update(input(), { font, measureText: value => value.length * 8 }), /Fixture rendering failure/); assert.equal(controller.geometry, undefined);
  fail = false; await controller.update(input(), { font, measureText: value => value.length * 8 }); assert.equal(calls, 2); assert.equal(commits[0]!.fit, true); controller.dispose();
});

test("moving the roving tab stop patches both nodes even when their execution state is unchanged", () => {
  const cache = new GraphNodePatchCache(), state = { status: "planned" as const, inScope: true, instanceCount: 0, iterationCount: 0, selected: false };
  const patch = (tabStop: string) => ["entry", "next", "other"].filter(id => cache.accept(id, state, id === tabStop));
  assert.deepEqual(patch("entry"), ["entry", "next", "other"]); assert.deepEqual(patch("entry"), []);
  assert.deepEqual(patch("next"), ["entry", "next"]); assert.deepEqual(patch("next"), []);
  cache.delete("entry"); assert.deepEqual(patch("next"), ["entry"]);
});
