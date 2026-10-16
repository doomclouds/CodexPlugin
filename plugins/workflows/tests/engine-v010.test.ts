import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, lstat, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { createWorkspace } from "../src/workspace.ts";
import type { ActivityDriver } from "../src/structured-types.ts";
import type { WorkflowDefinition } from "../src/definition.ts";

const definition: WorkflowDefinition = { schemaVersion: 1, name: "engine-fixture", description: "Safety fixture without native model calls", steps: [{ id: "value", type: "transform", value: 1 }] };
async function fixture(t: TestContext, driver: ActivityDriver = { execute: async () => true }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-v010-engine-"))), project = path.join(root, "project"); await mkdir(project); await writeFile(path.join(project, "keep.txt"), "original");
  const engine = new WorkflowEngine({ root: path.join(root, "state"), driver }); t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); }); return { root, project, engine };
}

test("definition deletion removes every linked revision and owned directory while preserving project files", async t => {
  const { engine, project } = await fixture(t);
  const saved = engine.saveDefinition({ definition }), runs = [];
  for (let i = 0; i < 3; i++) {
    const run = await engine.preview({ definition, sourceDefinition: { id: saved.id, revision: 1 }, projectPath: project }); runs.push(run);
    await mkdir(path.join(engine.store.directory, "runs", run.id), { recursive: true }); await writeFile(path.join(engine.store.directory, "runs", run.id, "log.txt"), "owned");
  }
  const preview = await engine.deletionPreview({ kind: "definition", id: saved.id, revision: 1 }); assert.equal(preview.runIds.length, 3);
  await engine.delete({ kind: "definition", id: saved.id, revision: 1, fingerprint: preview.fingerprint });
  for (const run of runs) { assert.equal(engine.store.has(run.id), false); await assert.rejects(lstat(path.join(engine.store.directory, "runs", run.id)), { code: "ENOENT" }); }
  assert.deepEqual(engine.store.listDefinitions(), []); assert.equal(await readFile(path.join(project, "keep.txt"), "utf8"), "original");
});

test("reserved deletion prevents a concurrent start before any owned files are removed", async t => {
  let calls = 0; const { engine, project } = await fixture(t, { execute: async () => { calls++; return true; } });
  const run = await engine.preview({ definition: { ...definition, steps: [{ id: "agent", type: "agent", task: "Read fixture" }] }, projectPath: project });
  const preview = await engine.deletionPreview({ kind: "run", id: run.id, revision: run.revision });
  const original = engine.store.beginDeletion.bind(engine.store); let checked = false;
  engine.store.beginDeletion = (scope, fingerprint) => { original(scope, fingerprint); checked = true; assert.throws(() => engine.start({ id: run.id, revision: run.revision }), /deletion/); };
  await engine.delete({ kind: "run", id: run.id, revision: run.revision, fingerprint: preview.fingerprint }); assert.equal(checked, true); assert.equal(calls, 0);
});

test("changing a deletion parent into a link cannot delete project files and keeps the reservation", { skip: process.platform === "win32" }, async t => {
  const { engine, project } = await fixture(t), run = await engine.preview({ definition, projectPath: project });
  const parent = path.join(engine.store.directory, "runs"); await mkdir(path.join(parent, run.id), { recursive: true }); await writeFile(path.join(parent, run.id, "owned"), "fixture");
  const preview = await engine.deletionPreview({ kind: "run", id: run.id, revision: run.revision }), original = engine.store.beginDeletion.bind(engine.store);
  engine.store.beginDeletion = (scope, fingerprint) => { original(scope, fingerprint); renameSync(parent, `${parent}-saved`); symlinkSync(project, parent); };
  await assert.rejects(engine.delete({ kind: "run", id: run.id, revision: run.revision, fingerprint: preview.fingerprint }), /parent directory changed/);
  assert.equal(await readFile(path.join(project, "keep.txt"), "utf8"), "original"); assert.equal(engine.store.has(run.id), true); assert.equal(engine.store.deletionPending(run.id), true);
  await rm(parent); await rename(`${parent}-saved`, parent);
  engine.store.beginDeletion = original;
  const fresh = await engine.deletionPreview({ kind: "run", id: run.id, revision: run.revision }); await engine.delete({ kind: "run", id: run.id, revision: run.revision, fingerprint: fresh.fingerprint });
});

test("unknown reconciliation captures first and commits evidence plus checkpoint atomically", async t => {
  let captureFails = false, checkpoint = "before";
  const { engine, project } = await fixture(t, { execute: async () => { throw Object.assign(new Error("write outcome unknown"), { outcome: "unknown" }); }, captureCheckpoint: async () => { if (captureFails) throw new Error("capture failed"); return checkpoint; } });
  const draft = await engine.preview({ definition: { ...definition, steps: [{ id: "write", type: "agent", task: "Write fixture", mode: "write" }] }, projectPath: project, grants: { allowWrite: true } });
  engine.start({ id: draft.id, revision: 1 }); const run = await engine.wait(draft.id), instance = run.instances.find(item => item.status === "unknown")!;
  const input = { id: run.id, revision: run.revision, instanceId: instance.id, fingerprint: engine.unknownPreview(run.id, instance.id).fingerprint, resolution: "completed" as const, output: true, evidence: "Inspected the fixture effect" };
  captureFails = true; await assert.rejects(engine.resolveUnknown(input), /capture failed/); assert.equal(engine.get(run.id).status, "unknown"); assert.equal(engine.get(run.id).revision, run.revision);
  captureFails = false; checkpoint = "observed-current-files"; const resolved = await engine.resolveUnknown(input);
  assert.equal(resolved.status, "stopped"); assert.equal(resolved.checkpoint!.fingerprint, checkpoint); assert.equal(engine.store.checkpoints(run.id)[0]!.fingerprint, checkpoint);
  assert.equal((engine.store.checkpoints(run.id)[0]!.snapshot as { definitionHash: string }).definitionHash, resolved.definitionHash); assert.equal(engine.store.checkpoints(run.id)[0]!.revision, resolved.revision);
});

test("apply claims the run before changing files and blocks concurrent start and review", async t => {
  const { engine, project } = await fixture(t), draft = await engine.preview({ definition, projectPath: project, grants: { allowWrite: true } });
  assert.equal(spawnSync("git", ["init", "--quiet", project]).status, 0);
  const owned = path.join(engine.store.directory, "runs", draft.id); await mkdir(owned, { recursive: true }); const workspace = await createWorkspace(project, owned);
  await writeFile(path.join(workspace.root, "keep.txt"), "updated"); const prepared = engine.store.update(draft.id, run => { run.workspace = workspace; }); const reviewed = await engine.review({ id: draft.id, revision: prepared.revision });
  const original = engine.store.claim.bind(engine.store); let checked = false; const reviews: Promise<void>[] = [];
  engine.store.claim = (id, token, revision) => { original(id, token, revision); if (token.startsWith("apply_")) { checked = true; assert.throws(() => engine.start({ id, revision: engine.get(id).revision }), /owned by another/); reviews.push(assert.rejects(engine.review({ id, revision: engine.get(id).revision }), /Stop and reconcile/)); } };
  const applied = await engine.apply({ id: draft.id, revision: reviewed.revision, fingerprint: reviewed.diff!.fingerprint });
  await Promise.all(reviews); assert.equal(checked, true); assert.equal(applied.application, "applied"); assert.equal(engine.store.owner(draft.id), undefined); assert.equal(await readFile(path.join(project, "keep.txt"), "utf8"), "updated");
});

test("inline subflows recursively freeze referenced definitions", async t => {
  const { engine, project } = await fixture(t), saved = engine.saveDefinition({ definition });
  const outer: WorkflowDefinition = { ...definition, steps: [{ id: "inline", type: "subflow", definition: { ...definition, steps: [{ id: "linked", type: "subflow", ref: { id: saved.id, revision: 1 } }] } }] };
  const run = await engine.preview({ definition: outer, projectPath: project });
  const inline = run.definition.steps[0]; assert.equal(inline!.type, "subflow"); if (inline!.type !== "subflow") throw new Error("Unexpected node"); const linked = inline.definition!.steps[0]; assert.equal(linked!.type, "subflow"); if (linked!.type !== "subflow") throw new Error("Unexpected node"); assert.equal(linked.ref, undefined); assert.deepEqual(linked.definition, definition);
});
test("a large persisted failure history remains readable without losing instance identities", async t => {
  const { engine, project } = await fixture(t), run = await engine.preview({ definition: { ...definition, steps: [{ id: "work", type: "agent", task: "Read-only fixture" }] }, projectPath: project });
  engine.store.update(run.id, current => {
    current.status = "failed";
    current.instances = Array.from({ length: 5000 }, (_, index) => ({ id: `instance_${index}`, nodeId: "work", type: "agent", label: "范围与轮次".repeat(30), path: `/root/items/${index}/work`, status: "failed", error: "Observed read failure: ".repeat(100), attempts: [{ id: `attempt_${index}`, status: "failed", startedAt: run.createdAt, error: "Observed read failure: ".repeat(100), activities: [], logs: [] }] }));
  });
  const view = engine.view(run.id);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 6 * 1024 * 1024);
  assert.equal(view.run.instances.length, 5000);
  assert.ok(view.run.instances.every(instance => instance.status === "failed"));
  assert.equal(view.run.instances.at(-1)!.id, "instance_4999");
  assert.match(String(engine.nodeProcess({ id: run.id, instanceId: "instance_4999", detail: "developer" }).error), /Observed read failure/);
});
