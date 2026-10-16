import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { TestContext } from "node:test";
import { StructuredExecutor } from "../src/structured-executor.ts";
import { StructuredStore } from "../src/structured-store.ts";
import type { ActivityDriver, ActivityRequest, StructuredRun } from "../src/structured-types.ts";
import type { DefinitionNode, JsonValue, WorkflowDefinition } from "../src/definition.ts";

const definition = (steps: DefinitionNode[], name = "execution-fixture"): WorkflowDefinition => ({ schemaVersion: 1, name, description: "Controlled driver fixture, no native model calls", steps });
const agent = (id: string): DefinitionNode => ({ id, type: "agent", task: `Inspect ${id}` });
const ref = (value: string) => ({ ref: value });
function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
async function fixture(t: TestContext, execute: ActivityDriver["execute"] = async request => ({ node: request.node.id }), options: Partial<ActivityDriver> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-v010-executor-")), store = new StructuredStore<StructuredRun>(root);
  const executor = new StructuredExecutor({ store, driver: { execute, ...options }, resolveDefinition: (id, revision) => store.getDefinition(id, revision) });
  t.after(async () => { await executor.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const run = (steps: DefinitionNode[], args: JsonValue = {}, grants: { allowWrite?: boolean } = {}) => executor.preview({ definition: definition(steps), args, projectPath: root, grants });
  return { root, store, executor, run, async start(steps: DefinitionNode[], args: JsonValue = {}, grants: { allowWrite?: boolean } = {}) { const initial = run(steps, args, grants); executor.start({ id: initial.id, revision: initial.revision }); return executor.wait(initial.id); } };
}

test("one normalized tree produces executed choices, nested loops and independent instances", async t => {
  const calls: string[] = [], f = await fixture(t, async request => { calls.push(request.instance.path); return { iteration: request.env.iteration ?? -1 }; });
  const result = await f.start([
    { id: "route", type: "choice", cases: [{ id: "yes", when: ref("args.selected"), steps: [{ id: "outer", type: "repeat", maxIterations: 2, while: true, steps: [{ id: "inner", type: "repeat", maxIterations: 3, until: { op: "eq", args: [ref("iteration"), 1] }, steps: [agent("inspect")] }] }] }], default: [agent("not-selected")] },
    { id: "finish", type: "transform", value: ref("steps.route.output") }
  ], { selected: true });
  assert.equal(result.status, "completed"); assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
  assert.equal(result.instances.filter(instance => instance.nodeId === "inspect").length, 4);
  assert.ok(result.instances.every(instance => instance.nodeId !== "not-selected"));
  assert.deepEqual(result.instances.filter(instance => instance.nodeId === "inspect").map(instance => instance.iteration), [0, 1, 0, 1]);
  const edges = result.events.filter(event => event.type === "transition"); assert.ok(edges.length > 5); assert.ok(edges.every(event => result.compiled.plan.edges.some(edge => edge.id === event.edgeId)));
  assert.ok(f.store.checkpoints(result.id).length > 0);
});

test("pretested loops allow zero iterations; posttested loops run at least once", async t => {
  const f = await fixture(t);
  const result = await f.start([{ id: "zero", type: "repeat", maxIterations: 3, while: false, steps: [agent("never")] }, { id: "once", type: "repeat", maxIterations: 5, until: true, steps: [agent("one")] }]);
  assert.equal(result.status, "completed"); assert.equal(result.instances.filter(instance => instance.nodeId === "one").length, 1); assert.ok(!result.instances.some(instance => instance.nodeId === "never"));
});

test("parallel completion order cannot overwrite branch outputs and obeys worker limits", async t => {
  let active = 0, peak = 0;
  const f = await fixture(t, async request => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, request.node.id === "slow" ? 30 : 5)); active--; return request.node.id; });
  const initial = f.executor.preview({ definition: definition([{ id: "concurrent", type: "parallel", policy: "fail-fast", branches: ["slow", "fast", "third"].map(id => ({ id, steps: [agent(id)] })) }]), projectPath: f.root, limits: { maxReadWorkers: 2 } });
  f.executor.start({ id: initial.id, revision: 1 }); const result = await f.executor.wait(initial.id);
  assert.equal(result.status, "completed"); assert.equal(peak, 2);
  assert.deepEqual(result.instances.find(instance => instance.nodeId === "concurrent")!.output, { slow: { slow: "slow" }, fast: { fast: "fast" }, third: { third: "third" } });
});

test("fail-fast waits for the cancelled branch to actually settle before releasing the run", async t => {
  let siblingExited = false; const siblingStarted = deferred();
  const f = await fixture(t, async (request, signal) => {
    if (request.node.id === "fail") { await siblingStarted.promise; throw new Error("primary failure"); }
    siblingStarted.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(() => { siblingExited = true; resolve(); }, 25); }, { once: true })); throw signal.reason;
  });
  const result = await f.start([{ id: "parallel", type: "parallel", policy: "fail-fast", branches: [{ id: "a", steps: [agent("fail")] }, { id: "b", steps: [agent("sibling"), agent("unstarted")] }] }]);
  assert.equal(result.status, "failed"); assert.equal(siblingExited, true); assert.ok(!result.instances.some(instance => instance.nodeId === "unstarted"));
});

test("all-settled explicitly handles one branch failure", async t => {
  const f = await fixture(t, async request => { if (request.node.id === "bad") throw new Error("handled"); return 1; });
  const result = await f.start([{ id: "all", type: "parallel", policy: "all-settled", branches: [{ id: "bad", steps: [agent("bad")] }, { id: "good", steps: [agent("good")] }] }]);
  assert.equal(result.status, "completed"); assert.equal((result.instances.find(instance => instance.nodeId === "all")!.output as Record<string, Record<string, JsonValue>>).bad!.status, "failed");
});

test("map freezes its items and stable keys; duplicate keys fail before any worker is dispatched", async t => {
  const f = await fixture(t, async request => ({ key: request.env.key!, value: request.env.item! }));
  const steps: DefinitionNode[] = [{ id: "items", type: "map", items: ref("args.items"), itemKey: ref("item.id"), concurrency: 2, steps: [agent("item-task")] }];
  const result = await f.start(steps, { items: [{ id: "alpha", n: 1 }, { id: "beta", n: 2 }] });
  assert.equal(result.status, "completed"); assert.deepEqual(result.instances.filter(instance => instance.nodeId === "item-task").map(instance => instance.itemKey).sort(), ["alpha", "beta"]);
  const invalid = await f.start(steps, { items: [{ id: "same" }, { id: "same" }] }); assert.equal(invalid.status, "failed"); assert.match(invalid.error!, /unique/); assert.equal(invalid.instances.length, 1);
});

test("try/catch/finally preserves the primary error and runs declared cleanup", async t => {
  const calls: string[] = [], f = await fixture(t, async request => { calls.push(request.node.id); if (request.node.id === "body") throw new Error("primary"); if (request.node.id === "cleanup") throw new Error("cleanup error"); return true; });
  const failed = await f.start([{ id: "guard", type: "try", steps: [agent("body")], finally: [agent("cleanup")] }]);
  assert.equal(failed.status, "failed"); assert.match(failed.error!, /primary/); assert.deepEqual(calls, ["body", "cleanup"]);
  const handled = await f.start([{ id: "guard", type: "try", steps: [agent("body")], catch: [agent("recover")], finally: [{ id: "clean", type: "transform", value: true }] }]); assert.equal(handled.status, "completed");
});

test("pause completes the current activity, persists its result, and resumes without replay", async t => {
  const started = deferred(), release = deferred(), calls: string[] = [];
  const f = await fixture(t, async request => { calls.push(request.node.id); if (request.node.id === "first") { started.resolve(); await release.promise; } return request.node.id; });
  const initial = f.run([agent("first"), agent("second")]); f.executor.start({ id: initial.id, revision: 1 }); await started.promise;
  const pausing = f.executor.pause({ id: initial.id, revision: f.executor.get(initial.id).revision }); release.resolve(); const paused = await pausing;
  assert.equal(paused.status, "paused"); assert.deepEqual(calls, ["first"]);
  await f.executor.resume({ id: paused.id, revision: paused.revision, fingerprint: paused.checkpoint!.fingerprint }); const completed = await f.executor.wait(paused.id);
  assert.equal(completed.status, "completed"); assert.deepEqual(calls, ["first", "second"]); assert.equal(completed.instances.find(instance => instance.nodeId === "first")!.attempts.length, 1);
});

test("wait is an explicit persisted state with validated host resolution", async t => {
  const f = await fixture(t);
  const waiting = await f.start([{ id: "decision", type: "wait", message: "Approve fixture", schema: { type: "boolean" } }, { id: "result", type: "transform", value: ref("steps.decision.output") }]);
  assert.equal(waiting.status, "waiting"); const instance = waiting.instances.find(item => item.nodeId === "decision")!;
  assert.throws(() => f.executor.resolveWait({ id: waiting.id, revision: waiting.revision, instanceId: instance.id, value: "wrong" }), /validation/);
  const resolved = f.executor.resolveWait({ id: waiting.id, revision: waiting.revision, instanceId: instance.id, value: true });
  await f.executor.resume({ id: resolved.id, revision: resolved.revision, fingerprint: resolved.checkpoint!.fingerprint }); assert.equal((await f.executor.wait(resolved.id)).status, "completed");
});

test("subflows pin their revision and expand persists a validated definition before child dispatch", async t => {
  let expansions = 0; const f = await fixture(t, async request => { if (request.node.type === "expand") { expansions++; return definition([agent("expanded-child")]) as unknown as JsonValue; } return request.node.id; });
  const saved = f.store.saveDefinition({ definition: definition([agent("sub-child")]) });
  const result = await f.start([{ id: "fixed", type: "subflow", ref: { id: saved.id, revision: 1 } }, { id: "dynamic", type: "expand", task: "Create read-only fixture tasks" }]);
  assert.equal(result.status, "completed"); assert.equal(expansions, 1); assert.ok(result.instances.find(instance => instance.nodeId === "dynamic")!.cursor!.expanded); assert.ok(result.instances.find(instance => instance.nodeId === "fixed")!.cursor!.definition);
});

test("expanded plans cannot increase write grants", async t => {
  const f = await fixture(t, async () => definition([{ id: "unauthorized", type: "agent", task: "Write", mode: "write" }]) as unknown as JsonValue);
  const result = await f.start([{ id: "expand", type: "expand", task: "Generate" }]); assert.equal(result.status, "failed"); assert.match(result.error!, /write access/); assert.equal(result.instances.length, 1);
});

test("node retry preserves successful siblings and old attempts", async t => {
  let failure = true; const calls: string[] = [], f = await fixture(t, async request => { calls.push(request.node.id); if (request.node.id === "flaky" && failure) throw new Error("transient"); return request.node.id; });
  const failed = await f.start([agent("stable"), agent("flaky"), agent("after")]); failure = false;
  const prepared = f.executor.retryNode({ id: failed.id, revision: failed.revision, instanceId: failed.instances.find(instance => instance.nodeId === "flaky")!.id });
  await f.executor.resume({ id: prepared.id, revision: prepared.revision, fingerprint: prepared.checkpoint!.fingerprint }); const completed = await f.executor.wait(prepared.id);
  assert.equal(completed.status, "completed"); assert.deepEqual(calls, ["stable", "flaky", "flaky", "after"]); assert.equal(completed.instances.find(instance => instance.nodeId === "flaky")!.attempts.length, 2);
});

test("stop waits for the real activity exit and unknown writes require explicit evidence", async t => {
  const started = deferred(); let exited = false;
  const f = await fixture(t, async (_request, signal) => { started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(() => { exited = true; resolve(); }, 10); }, { once: true })); throw signal.reason; });
  const initial = f.run([{ id: "write", type: "agent", task: "Authorized fixture write", mode: "write" }], {}, { allowWrite: true }); f.executor.start({ id: initial.id, revision: 1 }); await started.promise;
  const stopped = await f.executor.stop({ id: initial.id, revision: f.executor.get(initial.id).revision }); assert.equal(exited, true); assert.equal(stopped.status, "unknown");
  const instance = stopped.instances.find(item => item.nodeId === "write")!;
  assert.throws(() => f.executor.retryNode({ id: stopped.id, revision: stopped.revision, instanceId: instance.id }), /Reconcile/);
  const resolved = f.executor.resolveUnknown({ id: stopped.id, revision: stopped.revision, instanceId: instance.id, resolution: "completed", output: "observed", fingerprint: f.executor.unknownFingerprint(stopped, instance), evidence: "Verified the fixture effect independently" }); assert.equal(resolved.status, "stopped");
});

test("actual process exit leaves durable dispatch intent; read resumes and write remains unknown", async t => {
  for (const mode of ["read", "write"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "workflows-v010-crash-")); t.after(() => rm(root, { recursive: true, force: true }));
    const script = `import {StructuredStore} from ${JSON.stringify(new URL("../src/structured-store.ts", import.meta.url).href)}; import {StructuredExecutor} from ${JSON.stringify(new URL("../src/structured-executor.ts", import.meta.url).href)}; const store=new StructuredStore(${JSON.stringify(root)}); const executor=new StructuredExecutor({store,driver:{execute:async()=>process.exit(73)}}); const run=executor.preview({definition:{schemaVersion:1,name:'crash-fixture',description:'Fixture',steps:[{id:'activity',type:'agent',task:'Fixture',mode:${JSON.stringify(mode)}}]},projectPath:${JSON.stringify(root)},grants:{allowWrite:true}}); console.log(run.id); executor.start({id:run.id,revision:1}); await executor.wait(run.id);`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 }); assert.equal(child.status, 73, child.stderr);
    const id = child.stdout.trim(), store = new StructuredStore<StructuredRun>(root), executor = new StructuredExecutor({ store, driver: { execute: async () => "recovered" } });
    const recovered = executor.get(id); assert.equal(recovered.status, mode === "write" ? "unknown" : "stopped"); assert.equal(recovered.instances[0]!.attempts[0]!.status, mode === "write" ? "unknown" : "interrupted");
    if (mode === "read") { await executor.resume({ id, revision: recovered.revision, fingerprint: recovered.checkpoint!.fingerprint }); assert.equal((await executor.wait(id)).status, "completed"); }
    await executor.close(); store.close();
  }
});

test("another SQLite connection requests stop and observes actual owner settlement", async t => {
  const started = deferred(); let exited = false;
  const f = await fixture(t, async (_request, signal) => { started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(() => { exited = true; resolve(); }, 20); }, { once: true })); throw signal.reason; });
  const secondStore = new StructuredStore<StructuredRun>(f.root), second = new StructuredExecutor({ store: secondStore, driver: { execute: async () => { throw new Error("Remote controller must not execute the activity"); } } });
  t.after(async () => { await second.close(); secondStore.close(); });
  const run = f.run([agent("long-running")]); f.executor.start({ id: run.id, revision: 1 }); await started.promise;
  const stopped = await second.stop({ id: run.id, revision: second.get(run.id).revision });
  assert.equal(exited, true); assert.equal(stopped.status, "stopped"); assert.equal(secondStore.owner(run.id), undefined);
  assert.ok(stopped.events.some(event => event.type === "run.stop-requested" && event.data));
});

test("another connection can pause without aborting the current activity", async t => {
  const started = deferred(), release = deferred(); let aborted = false;
  const f = await fixture(t, async (request, signal) => { if (request.node.id === "first") { started.resolve(); signal.addEventListener("abort", () => { aborted = true; }); await release.promise; } return true; });
  const secondStore = new StructuredStore<StructuredRun>(f.root), second = new StructuredExecutor({ store: secondStore, driver: { execute: async () => true } }); t.after(async () => { await second.close(); secondStore.close(); });
  const run = f.run([agent("first"), agent("second")]); f.executor.start({ id: run.id, revision: 1 }); await started.promise;
  const pending = second.pause({ id: run.id, revision: second.get(run.id).revision });
  await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(second.get(run.id).status, "pausing"); release.resolve(); const paused = await pending;
  assert.equal(paused.status, "paused"); assert.equal(aborted, false); assert.ok(!paused.instances.some(instance => instance.nodeId === "second"));
});

test("retrying a completed read activity makes a fresh attempt and invalidates actual later loop rounds", async t => {
  let count = 0;
  const f = await fixture(t, async request => ({ count: ++count, round: request.env.iteration! }));
  const result = await f.start([{ id: "loop", type: "repeat", maxIterations: 3, while: true, steps: [agent("inspect")] }]);
  const first = result.instances.find(instance => instance.nodeId === "inspect" && instance.iteration === 0)!;
  const prepared = f.executor.retryNode({ id: result.id, revision: result.revision, instanceId: first.id });
  await f.executor.resume({ id: prepared.id, revision: prepared.revision, fingerprint: prepared.checkpoint!.fingerprint }); const repeated = await f.executor.wait(result.id);
  assert.equal(repeated.status, "completed"); assert.equal(count, 6);
  assert.deepEqual(repeated.instances.filter(instance => instance.nodeId === "inspect").map(instance => instance.attempts.length), [2, 2, 2]);
  assert.equal(repeated.instances.filter(instance => instance.type === "scope").length, 3);
});

test("a cancelled write cannot be hidden by catch or all-settled", async t => {
  const f = await fixture(t, async request => { if (request.node.id === "write") throw Object.assign(new Error("transport lost"), { outcome: "unknown" }); return true; });
  const result = await f.start([{ id: "guard", type: "try", steps: [{ id: "write", type: "agent", mode: "write", task: "Fixture write" }], catch: [agent("must-not-run")] }], {}, { allowWrite: true });
  assert.equal(result.status, "unknown"); assert.ok(!result.instances.some(instance => instance.nodeId === "must-not-run"));
  const unknown = result.instances.find(instance => instance.nodeId === "write")!;
  const fixed = f.executor.resolveUnknown({ id: result.id, revision: result.revision, instanceId: unknown.id, resolution: "completed", output: true, fingerprint: f.executor.unknownFingerprint(result, unknown), evidence: "Confirmed the write completed" });
  await f.executor.resume({ id: fixed.id, revision: fixed.revision, fingerprint: fixed.checkpoint!.fingerprint }); const completed = await f.executor.wait(result.id); assert.equal(completed.status, "completed");
});

test("checkpoints never capture while a sibling worker is still active", async t => {
  let active = 0, captures = 0;
  const f = await fixture(t, async () => { active++; await new Promise(resolve => setTimeout(resolve, 10)); active--; return true; }, { captureCheckpoint: async () => { assert.equal(active, 0); captures++; await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(active, 0); return "stable"; } });
  const result = await f.start([{ id: "parallel", type: "parallel", policy: "fail-fast", branches: [{ id: "a", steps: [agent("one"), agent("two")] }, { id: "b", steps: [agent("three"), agent("four")] }] }]);
  assert.equal(result.status, "completed"); assert.ok(captures > 1);
});

test("pause and restart reuse an expanded plan instead of asking the generator again", async t => {
  let generated = 0, calls = 0; const childStarted = deferred(), release = deferred();
  const f = await fixture(t, async request => { if (request.node.type === "expand") { generated++; return definition([agent("one"), agent("two")]) as unknown as JsonValue; } calls++; if (request.node.id === "one") { childStarted.resolve(); await release.promise; } return true; });
  const initial = f.run([{ id: "dynamic", type: "expand", task: "Generate fixture" }]); f.executor.start({ id: initial.id, revision: 1 }); await childStarted.promise;
  const pending = f.executor.pause({ id: initial.id, revision: f.executor.get(initial.id).revision }); release.resolve(); const paused = await pending;
  const secondStore = new StructuredStore<StructuredRun>(f.root), second = new StructuredExecutor({ store: secondStore, driver: { execute: async request => { assert.notEqual(request.node.type, "expand"); calls++; return true; } } }); t.after(async () => { await second.close(); secondStore.close(); });
  await second.resume({ id: initial.id, revision: paused.revision, fingerprint: paused.checkpoint!.fingerprint }); const completed = await second.wait(initial.id);
  assert.equal(completed.status, "completed"); assert.equal(generated, 1); assert.equal(calls, 2);
});

test("five thousand log events batch into bounded progress commits without losing identity or usage", async t => {
  const f = await fixture(t, async (_request, _signal, event) => {
    event({ type: "identity", threadId: "verified-thread", turnId: "verified-turn" });
    for (let index = 0; index < 5000; index++) event({ type: "log", message: `fixture log ${index}` });
    event({ type: "usage", inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    event({ type: "activity", activity: { id: "read", kind: "files", label: "Read fixture", status: "completed", startedAt: "2026-01-01T00:00:00Z" } });
    return true;
  });
  let commits = 0; const update = f.store.update.bind(f.store); f.store.update = (...args) => { commits++; return update(...args); };
  const started = performance.now(), result = await f.start([agent("logs")]), attempt = result.instances[0]!.attempts[0]!;
  assert.equal(result.status, "completed"); assert.ok(commits < 25, `Expected batching, observed ${commits} commits`); assert.ok(performance.now() - started < 2000);
  assert.equal(attempt.threadId, "verified-thread"); assert.equal(attempt.turnId, "verified-turn"); assert.equal(attempt.usage!.totalTokens, 15); assert.equal(attempt.logs.length, 200); assert.equal(attempt.logs.at(-1)!.message, "fixture log 4999"); assert.equal(attempt.activities[0]!.id, "read");
});

test("pause inside try does not execute finally early; successful finally sees a null error", async t => {
  const started = deferred(), release = deferred(), calls: string[] = [];
  const f = await fixture(t, async request => { calls.push(request.node.id); if (request.node.id === "one") { started.resolve(); await release.promise; } return true; });
  const draft = f.run([{ id: "guard", type: "try", steps: [agent("one"), agent("two")], finally: [{ id: "cleanup", type: "transform", value: ref("error") }] }]);
  f.executor.start({ id: draft.id, revision: 1 }); await started.promise; const pending = f.executor.pause({ id: draft.id, revision: f.executor.get(draft.id).revision }); release.resolve(); const paused = await pending;
  assert.equal(paused.status, "paused"); assert.ok(!paused.instances.some(instance => instance.nodeId === "cleanup"));
  await f.executor.resume({ id: paused.id, revision: paused.revision, fingerprint: paused.checkpoint!.fingerprint }); const result = await f.executor.wait(draft.id);
  assert.equal(result.status, "completed"); assert.deepEqual(calls, ["one", "two"]); assert.equal(result.instances.find(instance => instance.nodeId === "cleanup")!.output, null);
});

test("all-settled treats unknown writes as unresolved and cannot complete their container", async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error("unknown write"), { outcome: "unknown" }); });
  const result = await f.start([{ id: "all", type: "parallel", policy: "all-settled", branches: [{ id: "write", steps: [{ id: "write", type: "agent", mode: "write", task: "Fixture" }] }] }], {}, { allowWrite: true });
  assert.equal(result.status, "unknown"); assert.notEqual(result.instances.find(instance => instance.nodeId === "all")!.status, "completed");
});

test("a crash after a write result but before its filesystem checkpoint requires reconciliation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-v010-result-crash-")); t.after(() => rm(root, { recursive: true, force: true }));
  const script = `import {StructuredStore} from ${JSON.stringify(new URL("../src/structured-store.ts", import.meta.url).href)}; import {StructuredExecutor} from ${JSON.stringify(new URL("../src/structured-executor.ts", import.meta.url).href)}; let checks=0; const store=new StructuredStore(${JSON.stringify(root)}); const executor=new StructuredExecutor({store,driver:{execute:async()=>({observed:true}),captureCheckpoint:async()=>{if(++checks===2)process.exit(74);return 'before-write';}}}); const run=executor.preview({definition:{schemaVersion:1,name:'crash-result',description:'Fixture',steps:[{id:'write',type:'agent',task:'Fixture',mode:'write'}]},projectPath:${JSON.stringify(root)},grants:{allowWrite:true}});console.log(run.id);executor.start({id:run.id,revision:1});await executor.wait(run.id);`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 }); assert.equal(child.status, 74, child.stderr);
  let replayed = false; const store = new StructuredStore<StructuredRun>(root), executor = new StructuredExecutor({ store, driver: { execute: async () => { replayed = true; return true; } } });
  const recovered = executor.get(child.stdout.trim()); assert.equal(recovered.status, "unknown"); assert.equal(recovered.instances[0]!.status, "unknown"); assert.deepEqual(recovered.instances[0]!.attempts[0]!.output, { observed: true }); assert.equal(replayed, false);
  await executor.close(); store.close();
});

test("unknown completion validates schema and acceptance from its frozen dynamic frame", async t => {
  const child: WorkflowDefinition = definition([{ id: "write", type: "agent", mode: "write", task: "Fixture", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, accept: { type: "object", properties: { ok: { const: true } }, required: ["ok"] } }]);
  const f = await fixture(t, async request => { if (request.node.type === "expand") return child as unknown as JsonValue; throw Object.assign(new Error("unknown write"), { outcome: "unknown" }); });
  const run = await f.start([{ id: "dynamic", type: "expand", task: "Fixture plan" }], {}, { allowWrite: true }), target = run.instances.find(instance => instance.status === "unknown")!;
  const input = { id: run.id, revision: run.revision, instanceId: target.id, fingerprint: f.executor.unknownFingerprint(run, target), resolution: "completed" as const, evidence: "Independently observed the fixture effect" };
  assert.throws(() => f.executor.resolveUnknown({ ...input, output: "wrong shape" }), /validation/); assert.throws(() => f.executor.resolveUnknown({ ...input, output: { ok: false } }), /validation/);
  assert.equal(f.executor.get(run.id).status, "unknown"); const result = f.executor.resolveUnknown({ ...input, output: { ok: true } }); assert.equal(result.instances.find(instance => instance.id === target.id)!.status, "completed");
});

test("local pause and stop bind stale progress revisions to exactly one execution owner", async t => {
  const firstStarted = deferred(), secondStarted = deferred(), releaseFirst = deferred();
  let emitFirst!: Parameters<ActivityDriver["execute"]>[2], emitSecond!: Parameters<ActivityDriver["execute"]>[2];
  const f = await fixture(t, async (request, signal, emit) => {
    if (request.node.id === "first") { emitFirst = emit; firstStarted.resolve(); await releaseFirst.promise; return true; }
    emitSecond = emit; secondStarted.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); throw signal.reason;
  });
  const draft = f.run([agent("first"), agent("second")]); f.executor.start({ id: draft.id, revision: 1 }); await firstStarted.promise;
  const first = f.executor.get(draft.id); emitFirst({ type: "log", message: "Progress after the UI snapshot" }); await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(f.executor.get(draft.id).revision > first.revision);
  await assert.rejects(f.executor.pause({ id: draft.id, revision: first.revision }), /revision changed/);
  const pausing = f.executor.pause({ id: draft.id, revision: first.revision, expectedOwnerToken: first.ownerToken! }); releaseFirst.resolve(); const paused = await pausing; assert.equal(paused.status, "paused");
  await f.executor.resume({ id: paused.id, revision: paused.revision, fingerprint: paused.checkpoint!.fingerprint }); await secondStarted.promise;
  const second = f.executor.get(draft.id); assert.notEqual(second.ownerToken, first.ownerToken); emitSecond({ type: "log", message: "More progress after the next UI snapshot" }); await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(f.executor.stop({ id: draft.id, revision: first.revision, expectedOwnerToken: first.ownerToken! }), /owner changed/);
  await assert.rejects(f.executor.stop({ id: draft.id, revision: second.revision }), /revision changed/);
  const stopped = await f.executor.stop({ id: draft.id, revision: second.revision, expectedOwnerToken: second.ownerToken! }); assert.equal(stopped.status, "stopped");
});

test("cross-connection stop accepts stale progress only with the matching owner token", async t => {
  const started = deferred(); let emitProgress!: Parameters<ActivityDriver["execute"]>[2], actuallyExited = false;
  const f = await fixture(t, async (_request, signal, emit) => { emitProgress = emit; started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(() => { actuallyExited = true; resolve(); }, 15); }, { once: true })); throw signal.reason; });
  const otherStore = new StructuredStore<StructuredRun>(f.root), other = new StructuredExecutor({ store: otherStore, driver: { execute: async () => { throw new Error("The controller must not dispatch an activity"); } } }); t.after(async () => { await other.close(); otherStore.close(); });
  const draft = f.run([agent("active")]); f.executor.start({ id: draft.id, revision: 1 }); await started.promise;
  const snapshot = other.get(draft.id); emitProgress({ type: "log", message: "A fresh activity update" }); await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(other.get(draft.id).revision > snapshot.revision);
  await assert.rejects(other.stop({ id: draft.id, revision: snapshot.revision }), /revision changed/);
  await assert.rejects(other.stop({ id: draft.id, revision: other.get(draft.id).revision, expectedOwnerToken: "different-owner" }), /owner changed/);
  const stopped = await other.stop({ id: draft.id, revision: snapshot.revision, expectedOwnerToken: snapshot.ownerToken! }); assert.equal(stopped.status, "stopped"); assert.equal(actuallyExited, true);
});
