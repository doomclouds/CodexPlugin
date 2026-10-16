import assert from "node:assert/strict";
import { test } from "node:test";
import { compileDefinition } from "../src/definition.ts";
import { projectStructuredRun } from "../src/structured-projection.ts";
import type { NodeInstance, StructuredEvent, StructuredRun } from "../src/structured-types.ts";

const at = "2026-10-16T00:00:00.000Z";
const compiled = compileDefinition({ schemaVersion: 1, name: "projection-test", description: "Authoritative instance projections", steps: [
  { id: "loop", type: "repeat", maxIterations: 3, steps: [
    { id: "route", type: "choice", cases: [{ id: "yes", when: true, steps: [{ id: "left", type: "transform", value: true }] }], default: [{ id: "right", type: "transform", value: false }] },
  ] },
  { id: "finish", type: "transform", value: true },
] });
function instance(id: string, nodeId: string, status: NodeInstance["status"], extra: Partial<NodeInstance> = {}): NodeInstance {
  const plan = compiled.plan.nodes.find(node => node.id === nodeId)!;
  return { id, nodeId, type: plan.type as NodeInstance["type"], label: plan.label, path: `/root/${id}`, status, attempts: [], ...extra };
}
function run(instances: NodeInstance[] = [], events: StructuredEvent[] = []): StructuredRun {
  return { format: "structured-v1", id: "wf_projection", revision: 3, createdAt: at, updatedAt: at, definition: compiled.definition, definitionHash: compiled.hash, compiled, args: {}, projectPath: ".", grants: { allowWrite: false, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot", approvalMode: "never" }, limits: { maxReadWorkers: 2, maxCalls: 10, timeoutMs: 60000, maxTokens: 10000, maxInstances: 100 }, status: "running", instances, events };
}
function status(value: ReturnType<typeof projectStructuredRun>, id: string): string { return value.nodes.find(node => node.id === id)!.status; }

test("a later branch result cannot grey out a still active instance from another iteration", () => {
  const snapshot = run([
    instance("loop-i", "loop", "running"),
    instance("route-0", "route", "completed", { parentId: "loop-i", iteration: 0, cursor: { selectedCase: "yes" } }),
    instance("left-0", "left", "running", { parentId: "route-0", iteration: 0 }),
    instance("route-1", "route", "completed", { parentId: "loop-i", iteration: 1, cursor: { selectedCase: "default" } }),
    instance("right-1", "right", "completed", { parentId: "route-1", iteration: 1 }),
  ]);
  const projection = projectStructuredRun(snapshot);
  assert.equal(status(projection, "left"), "running");
  assert.equal(status(projection, "right"), "completed");
  assert.deepEqual(projection.nodes.find(node => node.id === "left")!.instanceIds, ["left-0"]);
  assert.equal(projection.nodes.find(node => node.id === "left")!.currentInstanceId, "left-0");
  assert.equal(status(projection, "$join:loop"), "planned");
});

test("scope selection projects one activation and its descendants with the full plan retained", () => {
  const snapshot = run([
    instance("loop-i", "loop", "running"),
    instance("route-0", "route", "completed", { parentId: "loop-i", cursor: { selectedCase: "yes" } }),
    instance("left-0", "left", "completed", { parentId: "route-0" }),
    instance("route-1", "route", "completed", { parentId: "loop-i", cursor: { selectedCase: "default" } }),
    instance("right-1", "right", "completed", { parentId: "route-1" }),
  ]);
  const scoped = projectStructuredRun(snapshot, { scopeInstanceId: "route-0" });
  assert.equal(scoped.scopeInstanceId, "route-0");
  assert.equal(scoped.nodes.length, compiled.plan.nodes.length);
  assert.equal(status(scoped, "left"), "completed");
  assert.equal(status(scoped, "right"), "skipped");
  assert.equal(status(scoped, "finish"), "planned");
  assert.equal(scoped.nodes.find(node => node.id === "loop")!.inScope, false);
  assert.equal(scoped.nodes.find(node => node.id === "left")!.inScope, true);
  assert.throws(() => projectStructuredRun(snapshot, { scopeInstanceId: "route" }), /does not exist/);
});

test("only persisted edge transitions highlight connections; task order never invents edges", () => {
  const edge = compiled.plan.edges.find(edge => edge.from === "route" && edge.branchId === "yes")!;
  const snapshot = run([instance("loop-i", "loop", "running"), instance("route-0", "route", "completed", { parentId: "loop-i", cursor: { selectedCase: "yes" } }), instance("left-0", "left", "completed", { parentId: "route-0" })]);
  let projection = projectStructuredRun(snapshot);
  assert.equal(projection.edges.find(item => item.id === edge.id)!.status, "planned");
  snapshot.events.push({ sequence: 5, at, type: "transition", edgeId: edge.id, instanceId: "route-0", toInstanceId: "left-0" });
  projection = projectStructuredRun(snapshot);
  assert.equal(projection.edges.find(item => item.id === edge.id)!.status, "completed");
  assert.deepEqual(projection.edges.find(item => item.id === edge.id)!.eventSequences, [5]);
  assert.equal(projection.eventCursor, 5);
});

test("edge evidence from another scope cannot leak into selected loop iterations", () => {
  const edge = compiled.plan.edges.find(edge => edge.from === "route" && edge.branchId === "yes")!;
  const snapshot = run([
    instance("loop-i", "loop", "running"),
    instance("route-0", "route", "completed", { parentId: "loop-i", cursor: { selectedCase: "yes" } }),
    instance("left-0", "left", "completed", { parentId: "route-0" }),
    instance("route-1", "route", "completed", { parentId: "loop-i", cursor: { selectedCase: "default" } }),
  ], [{ sequence: 4, at, type: "transition", edgeId: edge.id, instanceId: "route-0", toInstanceId: "left-0" }]);
  const scoped = projectStructuredRun(snapshot, { scopeInstanceId: "route-1" });
  assert.equal(scoped.edges.find(item => item.id === edge.id)!.status, "skipped");
  assert.deepEqual(scoped.edges.find(item => item.id === edge.id)!.eventSequences, []);
});

test("active instances take precedence while completed, failed and interrupted histories remain visible", () => {
  const snapshot = run([
    instance("left-failed", "left", "failed", { iteration: 0 }),
    instance("left-completed", "left", "completed", { iteration: 1 }),
    instance("left-new", "left", "running", { iteration: 2 }),
  ]);
  let projected = projectStructuredRun(snapshot).nodes.find(node => node.id === "left")!;
  assert.equal(projected.status, "running");
  assert.equal(projected.currentInstanceId, "left-new");
  assert.deepEqual(projected.counts, { failed: 1, completed: 1, running: 1 });
  assert.deepEqual(projected.iterations, [0, 1, 2]);
  snapshot.instances[2]!.status = "interrupted";
  projected = projectStructuredRun(snapshot).nodes.find(node => node.id === "left")!;
  assert.equal(projected.status, "mixed");
  snapshot.instances[2]!.status = "unknown";
  assert.equal(status(projectStructuredRun(snapshot), "left"), "unknown");
});

test("refresh and persisted snapshot replay produce identical projections without mutations", () => {
  const snapshot = run([instance("loop-i", "loop", "completed"), instance("finish-i", "finish", "completed")]);
  snapshot.status = "completed";
  const before = JSON.stringify(snapshot);
  const first = projectStructuredRun(snapshot);
  assert.equal(status(first, "$join:loop"), "completed");
  assert.deepEqual(projectStructuredRun(snapshot), first);
  assert.deepEqual(projectStructuredRun(JSON.parse(before) as StructuredRun), first);
  assert.equal(JSON.stringify(snapshot), before);
});

test("a plan without execution evidence remains planned and does not claim branch outcomes", () => {
  const projection = projectStructuredRun(run());
  assert.ok(projection.nodes.every(node => node.status === "planned"));
  assert.ok(projection.edges.every(edge => edge.status === "planned"));
  assert.equal(projection.eventCursor, 0);
});

test("frozen dynamic subflows receive separate frame identities even when local node ids collide", () => {
  const child = compileDefinition({ schemaVersion: 1, name: "child", description: "Frozen child", steps: [{ id: "same", type: "transform", value: 1 }, { id: "next", type: "transform", value: 2 }] });
  const parent = compileDefinition({ schemaVersion: 1, name: "parent", description: "Two distinct calls", steps: [{ id: "same", type: "transform", value: 0 }, { id: "callA", type: "subflow", definition: child.definition }, { id: "callB", type: "expand", task: "Produce a child definition" }] });
  const snapshot = run(); snapshot.compiled = parent; snapshot.definition = parent.definition; snapshot.definitionHash = parent.hash;
  snapshot.instances = [
    { id: "root-same", nodeId: "same", type: "transform", label: "root", path: "/root/same", status: "completed", attempts: [] },
    { id: "call-a", nodeId: "callA", type: "subflow", label: "A", path: "/root/callA", status: "completed", attempts: [], cursor: { definition: child.definition as unknown as import("../src/definition.ts").JsonValue } },
    { id: "a-same", nodeId: "same", type: "transform", label: "child A", path: "/root/callA/subflow/same", status: "completed", attempts: [], parentId: "call-a" },
    { id: "a-next", nodeId: "next", type: "transform", label: "child A next", path: "/root/callA/subflow/next", status: "completed", attempts: [], parentId: "call-a" },
    { id: "call-b", nodeId: "callB", type: "expand", label: "B", path: "/root/callB", status: "running", attempts: [], cursor: { expanded: child.definition as unknown as import("../src/definition.ts").JsonValue } },
    { id: "b-same", nodeId: "same", type: "transform", label: "child B", path: "/root/callB/expand/same", status: "running", attempts: [], parentId: "call-b" },
  ];
  const edge = child.plan.edges.find(edge => edge.from === "same" && edge.to === "next")!;
  snapshot.events = [{ sequence: 10, at, type: "transition", edgeId: edge.id, instanceId: "a-same", fromInstanceId: "a-same", toInstanceId: "a-next", data: { definitionHash: child.hash } }];
  const projection = projectStructuredRun(snapshot);
  assert.equal(status(projection, "same"), "completed");
  assert.equal(status(projection, "$frame:call-a:same"), "completed");
  assert.equal(status(projection, "$frame:call-b:same"), "running");
  assert.deepEqual(projection.nodes.find(node => node.id === "$frame:call-b:same")!.instanceIds, ["b-same"]);
  assert.equal(projection.edges.find(item => item.id === `$frame:call-a:${edge.id}`)!.status, "completed");
  assert.equal(projection.edges.find(item => item.id === `$frame:call-b:${edge.id}`)!.status, "planned");
  assert.equal(projection.edges.some(item => item.from === "callA" && item.to === "$join:callA"), false);
  assert.ok(projection.edges.some(item => item.from === "$frame:call-a:next" && item.to === "$join:callA" && item.status === "completed"));
  assert.deepEqual(projectStructuredRun(JSON.parse(JSON.stringify(snapshot)) as StructuredRun), projection);
});

test("a real iteration scope selects all its steps without treating scope wrappers as extra loop activations", () => {
  const snapshot = run([
    instance("loop-i", "loop", "running"),
    { id: "round-0", nodeId: "loop", type: "scope", label: "Round 1", path: "/root/loop/iteration:0", parentId: "loop-i", iteration: 0, status: "completed", attempts: [], cursor: { role: "iteration" } },
    instance("route-0", "route", "completed", { parentId: "round-0", cursor: { selectedCase: "yes" } }),
    instance("left-0", "left", "completed", { parentId: "route-0" }),
    { id: "round-1", nodeId: "loop", type: "scope", label: "Round 2", path: "/root/loop/iteration:1", parentId: "loop-i", iteration: 1, status: "running", attempts: [], cursor: { role: "iteration" } },
    instance("route-1", "route", "running", { parentId: "round-1" }),
  ]);
  const global = projectStructuredRun(snapshot).nodes.find(node => node.id === "loop")!;
  assert.deepEqual(global.instanceIds, ["loop-i"]);
  assert.deepEqual(global.scopeInstanceIds, ["round-0", "round-1"]);
  assert.deepEqual(global.iterations, [0, 1]);
  const scoped = projectStructuredRun(snapshot, { scopeInstanceId: "round-0" });
  assert.equal(status(scoped, "loop"), "completed");
  assert.equal(status(scoped, "route"), "completed");
  assert.equal(status(scoped, "left"), "completed");
  assert.equal(status(scoped, "right"), "skipped");
  assert.equal(status(scoped, "$join:loop"), "planned");
  assert.deepEqual(scoped.nodes.find(node => node.id === "loop")!.availableScopeInstanceIds, ["round-0", "round-1"], "Selecting one round must retain the sibling round selector without mixing their statuses");
});

test("durable transition cursors survive progress-event truncation and remain scoped to their round", () => {
  const edge = compiled.plan.edges.find(edge => edge.from === "route" && edge.branchId === "yes")!;
  const snapshot = run([
    instance("loop-i", "loop", "running"),
    { id: "round-0", nodeId: "loop", type: "scope", label: "Round 1", path: "/root/loop/iteration:0", parentId: "loop-i", iteration: 0, status: "completed", attempts: [] },
    instance("route-0", "route", "completed", { parentId: "round-0", cursor: { selectedCase: "yes", transitions: [`${compiled.hash}:${edge.id}:/root/loop/iteration:0/route/case:yes`] } }),
    instance("left-0", "left", "completed", { parentId: "route-0" }),
    { id: "round-1", nodeId: "loop", type: "scope", label: "Round 2", path: "/root/loop/iteration:1", parentId: "loop-i", iteration: 1, status: "running", attempts: [] },
    instance("route-1", "route", "completed", { parentId: "round-1", cursor: { selectedCase: "default" } }),
  ], [{ sequence: 25000, at, type: "worker.progress", instanceId: "route-1", data: "Only the recent bounded progress window remains" }]);
  const first = projectStructuredRun(snapshot, { scopeInstanceId: "round-0" }).edges.find(item => item.id === edge.id)!;
  assert.equal(first.status, "completed");
  assert.equal(first.transitionCount, 1);
  assert.deepEqual(first.eventSequences, []);
  const second = projectStructuredRun(snapshot, { scopeInstanceId: "round-1" }).edges.find(item => item.id === edge.id)!;
  assert.equal(second.status, "skipped");
  assert.equal(second.transitionCount, 0);
  snapshot.instances.find(instance => instance.id === "route-0")!.cursor!.transitions = [];
  assert.equal(projectStructuredRun(snapshot).edges.find(item => item.id === edge.id)!.status, "planned", "Invalidated transition evidence must not survive an explicit retry");
});
