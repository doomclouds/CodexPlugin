import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { StructuredStore } from "../src/structured-store.ts";
import type { StoredRun } from "../src/structured-store.ts";
import type { WorkflowDefinition } from "../src/definition.ts";

const definition: WorkflowDefinition = { schemaVersion: 1, name: "stored-definition", description: "A portable fixture", steps: [{ id: "value", type: "transform", value: 1 }] };
const record = (id = "fixture"): StoredRun & { value: number } => ({ id, revision: 1, status: "draft", projectPath: "/fixture", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", value: 0 });
async function fixture(t: TestContext) { const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-v010-store-"))); const store = new StructuredStore<ReturnType<typeof record>>(root); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); }); return { root, store }; }

test("structured storage is isolated from legacy JSON and survives a reopen", async t => {
  const { root, store } = await fixture(t); await writeFile(path.join(root, "run.json"), "not-json");
  store.create(record()); store.update("fixture", run => { run.value = 7; }, [{ type: "changed", payload: { observed: 7 } }], { fingerprint: "files-v1" });
  const other = new StructuredStore<ReturnType<typeof record>>(root); t.after(() => other.close());
  assert.equal(other.get("fixture").value, 7); assert.equal(other.get("fixture").revision, 2);
  assert.equal(other.events("fixture")[0]!.sequence, 1); assert.deepEqual(other.events("fixture")[0]!.payload, { observed: 7 });
  assert.equal(other.checkpoints("fixture")[0]!.revision, 2);
  assert.deepEqual(other.checkpoints("fixture")[0]!.snapshot, { format: "structured-checkpoint-v1", runId: "fixture", revision: 2, definitionHash: null, eventSequence: 0, fingerprint: "files-v1", committedAt: other.get("fixture").updatedAt });
  assert.equal(other.filename, path.join(root, "structured-v1", "workflows.sqlite"));
});

test("CAS and transaction rollback protect snapshot, events and checkpoints together", async t => {
  const { store } = await fixture(t); const initial = store.create(record());
  const next = { ...initial, revision: 2, value: 2 };
  store.save(next, { expectedRevision: 1, events: [{ type: "committed" }], checkpoint: { fingerprint: "one" } });
  assert.throws(() => store.save({ ...initial, revision: 2, value: 9 }, { expectedRevision: 1, events: [{ type: "stale" }], checkpoint: { fingerprint: "stale" } }), /revision changed/);
  assert.throws(() => store.update(initial.id, run => { run.value = 99; }, [{ type: "invalid", payload: BigInt(1) }], { fingerprint: "invalid" }), /BigInt/);
  assert.equal(store.get(initial.id).value, 2); assert.equal(store.get(initial.id).revision, 2);
  assert.deepEqual(store.events(initial.id).map(event => event.type), ["committed"]);
  assert.deepEqual(store.checkpoints(initial.id).map(checkpoint => checkpoint.fingerprint), ["one"]);
});

test("independent connections merge updates and owner claims prevent concurrent execution", async t => {
  const { root, store } = await fixture(t); store.create(record());
  const other = new StructuredStore<ReturnType<typeof record>>(root); t.after(() => other.close());
  store.update("fixture", run => { run.value++; }); other.update("fixture", run => { run.value++; });
  assert.equal(store.get("fixture").value, 2); assert.equal(store.get("fixture").revision, 3);
  store.claim("fixture", "first"); assert.throws(() => other.claim("fixture", "second"), /owned by another/);
  assert.throws(() => other.delete("fixture"), /owning workflow executor/);
  other.release("fixture", "wrong"); assert.equal(store.owner("fixture")!.token, "first");
  store.release("fixture", "first"); other.claim("fixture", "second"); other.release("fixture", "second");
});

test("definition revisions are immutable, compare-and-swap guarded, and retain portable defaults", async t => {
  const { store } = await fixture(t);
  const one = store.saveDefinition({ definition, args: { fixture: 1 }, grants: { allowWrite: false }, limits: { maxCalls: 4 } });
  const two = store.saveDefinition({ id: one.id, definition: { ...definition, description: "Updated" }, args: { fixture: 2 } }, one.revision);
  assert.equal(two.revision, 2);
  assert.equal(store.getDefinition(one.id, 1).definition.description, "A portable fixture");
  assert.deepEqual(store.getDefinition(one.id, 1).limits, { maxCalls: 4 });
  assert.deepEqual(store.getDefinition(one.id).args, { fixture: 2 });
  assert.throws(() => store.saveDefinition({ id: one.id, definition }, 1), /revision changed/);
  assert.equal(store.listDefinitions().length, 1);
  assert.throws(() => store.deleteDefinition(one.id, 1), /revision changed/);
  store.deleteDefinition(one.id, 2); assert.deepEqual(store.listDefinitions(), []);
});

test("deleting a run cascades its durable events, checkpoints and owners", async t => {
  const { store } = await fixture(t); store.create(record()); store.update("fixture", () => {}, [{ type: "done" }], { fingerprint: "checkpoint" });
  assert.throws(() => store.delete("fixture", 1), /revision changed/);
  store.delete("fixture", 2); assert.equal(store.has("fixture"), false); assert.deepEqual(store.events("fixture"), []); assert.deepEqual(store.checkpoints("fixture"), []);
  assert.throws(() => store.update("fixture", () => {}), /not found/);
});

test("SQLite storage is private and rejects a symlinked namespace", { skip: process.platform === "win32" }, async t => {
  const { root, store } = await fixture(t); assert.equal((await stat(store.filename)).mode & 0o777, 0o600); assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  const outside = await mkdtemp(path.join(tmpdir(), "workflows-v010-link-")); t.after(() => rm(outside, { recursive: true, force: true }));
  const holder = path.join(root, "redirect"); const { mkdir } = await import("node:fs/promises"); await mkdir(holder); await symlink(outside, path.join(holder, "structured-v1"));
  assert.throws(() => new StructuredStore(holder), /symbolic links/);
});

test("a deletion reservation atomically freezes all revisions and prevents a new linked run", async t => {
  const { root, store } = await fixture(t), saved = store.saveDefinition({ definition });
  const run = { ...record(), sourceDefinition: { id: saved.id, revision: 1 } }; store.create(run);
  const other = new StructuredStore<ReturnType<typeof record>>(root); t.after(() => other.close());
  const scope = { runs: [{ id: run.id, revision: 1 }], definition: { id: saved.id, revision: 1 } };
  store.beginDeletion(scope, "confirmed");
  assert.equal(store.deletionPending(run.id), true); assert.throws(() => other.claim(run.id, "late-start"), /deletion/);
  assert.throws(() => other.update(run.id, current => { current.value++; }), /deletion/);
  assert.throws(() => other.create({ ...run, id: "late" }), /being deleted/);
  assert.throws(() => other.saveDefinition({ id: saved.id, definition }, 1), /being deleted/);
  assert.throws(() => other.finishDeletion(scope, "wrong"), /scope changed/);
  store.finishDeletion(scope, "confirmed"); assert.equal(other.has(run.id), false); assert.deepEqual(other.listDefinitions(), []);
});

test("deletion verifies the complete definition association set inside the transaction", async t => {
  const { store } = await fixture(t), saved = store.saveDefinition({ definition });
  store.create({ ...record("one"), sourceDefinition: { id: saved.id, revision: 1 } });
  store.create({ ...record("two"), sourceDefinition: { id: saved.id, revision: 1 } });
  assert.equal(store.listForDefinition(saved.id).length, 2);
  assert.throws(() => store.beginDeletion({ runs: [{ id: "one", revision: 1 }], definition: { id: saved.id, revision: 1 } }, "stale"), /Associated workflow runs changed/);
  assert.equal(store.deletionPending("one"), false);
});

test("checkpoint history contains constant-size manifests instead of copying run outputs", async t => {
  const { store } = await fixture(t); store.create({ ...record(), payload: "x".repeat(512 * 1024) });
  for (let index = 0; index < 10; index++) store.update("fixture", run => { run.value++; }, [], { fingerprint: `checkpoint-${index}` });
  const checkpoints = store.checkpoints("fixture"); assert.equal(checkpoints.length, 10);
  assert.ok(checkpoints.every(checkpoint => JSON.stringify(checkpoint.snapshot).length < 400));
  assert.ok(checkpoints.every(checkpoint => !JSON.stringify(checkpoint.snapshot).includes("payload")));
});

test("control requests tolerate progress revisions only for the exact active owner", async t => {
  const { store } = await fixture(t); store.create(record()); store.claim("fixture", "first-owner"); store.update("fixture", run => { run.value++; });
  assert.throws(() => store.requestControl("fixture", 1, "stop"), /revision changed/);
  const accepted = store.requestControl("fixture", 1, "stop", "first-owner"); assert.equal(accepted.ownerToken, "first-owner");
  store.release("fixture", "first-owner"); store.claim("fixture", "next-owner");
  assert.throws(() => store.requestControl("fixture", 1, "stop", "first-owner"), /owner changed/);
  assert.throws(() => store.requestControl("fixture", store.get("fixture").revision, "pause", "first-owner"), /owner changed/);
  assert.deepEqual(store.readControls("fixture", "next-owner"), []); store.release("fixture", "next-owner");
});
