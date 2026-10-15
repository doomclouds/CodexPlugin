import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import filesystem, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { CheckpointStore } from "../src/checkpoint-store.ts";
import type { CheckpointNode, CheckpointRef } from "../src/checkpoint-store.ts";
import { RunStore } from "../src/store.ts";
import type { Task, WorkflowRun } from "../src/types.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function task(index = 0, output = "verified"): Task {
  return { id: `task_${index + 1}`, index, prompt: "Inspect only the fixture", options: {}, mode: "read", status: "completed", cached: false, label: "Fixture node", phase: "Fixture phase", output, attempts: [{ id: `task_${index + 1}_attempt_1`, status: "completed", output, threadId: "fixture-thread", activities: [{ id: "fixture", kind: "files", label: "Read fixture", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" }] }] };
}
function node(index = 0): CheckpointNode { return { taskId: `task_${index + 1}`, index, fingerprint: digest(`node-${index}`), status: "completed", outputDigest: digest("verified") }; }
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-store-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new RunStore(path.join(root, "state")), checkpoints = new CheckpointStore(store), createdAt = "2026-01-01T00:00:00.000Z";
  const run: WorkflowRun = { id: "wf_123456789012345678901234", revision: 1, createdAt, updatedAt: createdAt, meta: { name: "checkpoint-store", description: "Private test fixture" }, script: "fixture", scriptDigest: digest("fixture"), args: {}, projectPath: root, allowWrite: false, limits: { maxReadWorkers: 1, maxCalls: 10, timeoutMs: 1000, maxTokens: 0 }, execution: "stopped", review: "unavailable", application: "none", tasks: [], logs: [] };
  await store.create(run);
  const input = { reason: "node" as const, planDigest: digest("plan"), workspaceFingerprint: "fixture-v1:workspace", nodes: [node()] };
  const commit = async (ref: CheckpointRef) => { run.nodeCheckpoint = ref; run.revision++; await store.save(run, true); };
  return { root, store, checkpoints, run, input, commit };
}

test("checkpoint artifacts remain uncommitted until the atomic run pointer is saved", async t => {
  const f = await fixture(t), before = await f.store.load(f.run.id), orphan = await f.checkpoints.write(f.run, f.input);
  assert.deepEqual(await f.store.load(f.run.id), before);
  assert.deepEqual(await f.checkpoints.list(f.run), { checkpoints: [], total: 0 });
  await assert.rejects(f.checkpoints.read({ ...f.run, nodeCheckpoint: orphan }, orphan), /no committed/);
  const committed = await f.checkpoints.write(f.run, { ...f.input, reason: "initial", nodes: [] }); await f.commit(committed);
  assert.equal((await f.checkpoints.read(f.run)).id, committed.id);
  assert.deepEqual((await f.checkpoints.list(f.run)).checkpoints, [committed]);
  await assert.rejects(f.checkpoints.read(f.run, orphan), /not in the committed/);
  assert.equal((await readdir(path.join(f.store.directory(f.run.id), "checkpoints"))).length, 2);
});

test("committed checkpoint chains page newest first and verify previous links", async t => {
  const f = await fixture(t), refs: CheckpointRef[] = [];
  for (let index = 0; index < 4; index++) { const ref = await f.checkpoints.write(f.run, { ...f.input, nodes: [node(index)] }); refs.push(ref); await f.commit(ref); }
  assert.deepEqual(refs.map(ref => ref.sequence), [1, 2, 3, 4]);
  const first = await f.checkpoints.list(f.run, { limit: 2 });
  assert.deepEqual(first, { checkpoints: [refs[3], refs[2]], total: 4, nextOffset: 2 });
  assert.deepEqual(await f.checkpoints.list(f.run, { offset: 2, limit: 2 }), { checkpoints: [refs[1], refs[0]], total: 4 });
  assert.deepEqual(await f.checkpoints.list(f.run, { offset: 9 }), { checkpoints: [], total: 4 });
  assert.equal((await f.checkpoints.read(f.run, refs[1]!)).sequence, 2);
  const latest = await f.checkpoints.read(f.run); assert.deepEqual(latest.previous, refs[2]);
  await writeFile(path.join(f.store.directory(f.run.id), "checkpoints", `${refs[2]!.id}.json`), "{}");
  await assert.rejects(f.checkpoints.read(f.run), /digest/);
  await assert.rejects(f.checkpoints.list(f.run), /digest/);
});

test("checkpoint identity, digest, sequence and manifest limits fail visibly", async t => {
  const f = await fixture(t);
  await assert.rejects(f.checkpoints.write(f.run, { ...f.input, nodes: Array.from({ length: 1001 }, (_, index) => node(index)) }), /1000-node/);
  await assert.rejects(f.checkpoints.write(f.run, { ...f.input, nodes: Array.from({ length: 600 }, (_, index) => ({ ...node(index), label: "x".repeat(2048) })) }), /1 MiB/);
  await assert.rejects(f.checkpoints.write(f.run, { ...f.input, nodes: [node(), node()] }), /task entry/);
  await assert.rejects(f.checkpoints.write(f.run, { ...f.input, planDigest: "invalid" }), /input/);
  const ref = await f.checkpoints.write(f.run, f.input); await f.commit(ref);
  const filename = path.join(f.store.directory(f.run.id), "checkpoints", `${ref.id}.json`), value = JSON.parse(await readFile(filename, "utf8"));
  value.sequence = 2;
  const content = JSON.stringify(value); await writeFile(filename, content);
  f.run.nodeCheckpoint = { ...ref, sequence: 2, digest: digest(content) }; f.run.revision++; await f.store.save(f.run, true);
  await assert.rejects(f.checkpoints.read(f.run), /missing its previous/);
  await assert.rejects(f.checkpoints.list(f.run, { limit: 0 }), /page/);
  await assert.rejects(f.checkpoints.list(f.run, { offset: -1 }), /page/);
});

test("a failed durable run commit does not publish an orphan checkpoint or corrupt the old record", async t => {
  const f = await fixture(t), initial = await f.checkpoints.write(f.run, f.input); await f.commit(initial);
  const successor = await f.checkpoints.write(f.run, f.input), before = await f.store.load(f.run.id), originalOpen = filesystem.open, originalRename = filesystem.rename;
  const events: string[] = [];
  filesystem.open = (async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args), name = String(args[0]);
    if (name.includes("run.json.") && name.endsWith(".tmp")) handle.sync = async () => { events.push("file-sync"); throw new Error("Fixture disk sync failed"); };
    return handle;
  }) as typeof filesystem.open;
  filesystem.rename = (async (...args: Parameters<typeof filesystem.rename>) => { if (String(args[0]).includes("run.json.")) events.push("rename"); return originalRename(...args); }) as typeof filesystem.rename;
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.save({ ...f.run, nodeCheckpoint: successor, revision: f.run.revision + 1 }, true), /disk sync failed/);
  } finally { filesystem.open = originalOpen; filesystem.rename = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(events, ["file-sync"]);
  assert.deepEqual(await f.store.load(f.run.id), before);
  assert.deepEqual((await f.checkpoints.list(f.run)).checkpoints, [initial]);
  assert.ok(!(await readdir(f.store.directory(f.run.id))).some(name => name.endsWith(".tmp")));
});

test("durable saves flush contents before rename and sync the POSIX parent afterward", async t => {
  const f = await fixture(t), originalOpen = filesystem.open, originalRename = filesystem.rename, events: string[] = [];
  filesystem.open = (async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args), name = String(args[0]), originalSync = handle.sync.bind(handle);
    if (name.includes("run.json.") && name.endsWith(".tmp")) handle.sync = async () => { events.push("file-sync"); await originalSync(); };
    else if (name === f.store.directory(f.run.id)) handle.sync = async () => { events.push("parent-sync"); await originalSync(); };
    return handle;
  }) as typeof filesystem.open;
  filesystem.rename = (async (...args: Parameters<typeof filesystem.rename>) => { if (String(args[0]).includes("run.json.")) events.push("rename"); return originalRename(...args); }) as typeof filesystem.rename;
  syncBuiltinESMExports();
  try { await f.store.save({ ...f.run, revision: 2 }, true); }
  finally { filesystem.open = originalOpen; filesystem.rename = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(events, process.platform === "win32" ? ["file-sync", "rename"] : ["file-sync", "rename", "parent-sync"]);
  assert.equal((await f.store.load(f.run.id)).revision, 2);
});

test("a parent-sync failure reports uncertain durability even when the atomic rename is already visible", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), originalOpen = filesystem.open;
  filesystem.open = (async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.store.directory(f.run.id)) handle.sync = async () => { throw new Error("Fixture parent sync failed after rename"); };
    return handle;
  }) as typeof filesystem.open;
  syncBuiltinESMExports();
  try { await assert.rejects(f.store.save({ ...f.run, revision: 2 }, true), /parent sync failed after rename/); }
  finally { filesystem.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal((await f.store.load(f.run.id)).revision, 2, "A rejected post-rename flush cannot imply that the accepted data was rolled back.");
});

test("late checkpoint and task-history writes cannot recreate a deleted or missing run", async t => {
  const f = await fixture(t), release = await f.store.acquireNamed("data_mutation");
  const pending = f.checkpoints.write(f.run, f.input); const rejected = assert.rejects(pending, /deleted/);
  await f.store.markDeleted(f.run.id, "fixture-delete", f.run.revision); await rm(f.store.directory(f.run.id), { recursive: true }); await release(); await rejected;
  await assert.rejects(f.checkpoints.archiveTask(f.run.id, task(), "late archive"), /deleted/);
  await assert.rejects(lstat(f.store.directory(f.run.id)), { code: "ENOENT" });
  const missing = "wf_000000000000000000000000";
  await assert.rejects(f.checkpoints.archiveTask(missing, task(), "missing run"), /ENOENT/);
  await assert.rejects(lstat(f.store.directory(missing)), { code: "ENOENT" });
});

test("private checkpoint directories and artifacts refuse symbolic-link redirection", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), external = path.join(f.root, "external"); await mkdir(external);
  const target = path.join(f.store.directory(f.run.id), "checkpoints"); await symlink(external, target, "dir");
  await assert.rejects(f.checkpoints.write(f.run, f.input), /symbolic link/);
  assert.deepEqual(await readdir(external), []); await rm(target);
  const ref = await f.checkpoints.write(f.run, f.input); await f.commit(ref);
  const filename = path.join(target, `${ref.id}.json`), outside = path.join(external, "manifest.json");
  await writeFile(outside, await readFile(filename)); await rm(filename); await symlink(outside, filename);
  await assert.rejects(f.checkpoints.read(f.run), /private checkpoint artifact/);
  const history = path.join(f.store.directory(f.run.id), "history"); await symlink(external, history, "dir");
  await assert.rejects(f.checkpoints.archiveTask(f.run.id, task(), "redirected history"), /symbolic link/);
  assert.deepEqual(await readdir(external), ["manifest.json"]);
});

test("an aliased data-root parent preserves canonical checkpoint and task-history ownership", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), alias = path.join(f.root, "root-alias"); await symlink(f.root, alias, "dir");
  const store = new RunStore(path.join(alias, "state")), checkpoints = new CheckpointStore(store);
  const ref = await checkpoints.write(f.run, f.input); f.run.nodeCheckpoint = ref; f.run.revision++; await store.save(f.run, true);
  assert.equal((await checkpoints.read(f.run)).id, ref.id);
  assert.deepEqual((await f.checkpoints.list(f.run)).checkpoints, [ref]);
  const archived = await checkpoints.archiveTask(f.run.id, task(), "aliased owned data root");
  assert.deepEqual(await f.checkpoints.readTaskHistory(f.run.id, archived.id), task());
});

test("task archival is content-addressed, immutable and retains the full original attempt", async t => {
  const f = await fixture(t), original = task(), snapshot = structuredClone(original);
  const first = await f.checkpoints.archiveTask(f.run.id, original, "dynamic branch replaced this task");
  const duplicate = await f.checkpoints.archiveTask(f.run.id, { ...original, options: {} }, "a later duplicate reason");
  assert.deepEqual(duplicate, first);
  original.output = "changed after archiving"; original.attempts[0]!.output = "changed attempt";
  assert.deepEqual(await f.checkpoints.readTaskHistory(f.run.id, first.id), snapshot);
  assert.equal((await readdir(path.join(f.store.directory(f.run.id), "history"))).length, 1);
  assert.equal(first.digest, first.id.slice("history_".length));
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(f.store.directory(f.run.id), "history", `${first.id}.json`))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(f.store.directory(f.run.id), "history"))).mode & 0o777, 0o700);
  }
});

test("checkpoint and task-history inputs are frozen before waiting for the mutation lock", async t => {
  const f = await fixture(t), release = await f.store.acquireNamed("data_mutation"), originalTask = task(), snapshot = structuredClone(originalTask), request = structuredClone(f.input);
  const writing = f.checkpoints.write(f.run, request), archiving = f.checkpoints.archiveTask(f.run.id, originalTask, "freeze before queue");
  request.nodes[0]!.status = "failed"; originalTask.output = "changed while queued"; originalTask.attempts[0]!.output = "changed while queued";
  await release();
  const ref = await writing, archived = await archiving; await f.commit(ref);
  assert.equal((await f.checkpoints.read(f.run)).nodes[0]?.status, "completed");
  assert.deepEqual(await f.checkpoints.readTaskHistory(f.run.id, archived.id), snapshot);
});

test("task history pagination filters by node and detects metadata or content corruption", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.checkpoints.listTaskHistory(f.run.id), { history: [], total: 0 });
  const refs = [];
  for (let index = 0; index < 5; index++) refs.push(await f.checkpoints.archiveTask(f.run.id, task(index % 2, `result ${index}`), "branch replaced"));
  const all = await f.checkpoints.listTaskHistory(f.run.id, { limit: 100 }), first = await f.checkpoints.listTaskHistory(f.run.id, { limit: 2 });
  const second = await f.checkpoints.listTaskHistory(f.run.id, { offset: first.nextOffset!, limit: 3 });
  assert.equal(all.total, 5); assert.deepEqual([...first.history, ...second.history], all.history);
  const filtered = await f.checkpoints.listTaskHistory(f.run.id, { taskId: "task_1" });
  assert.equal(filtered.total, 3); assert.ok(filtered.history.every(ref => ref.taskId === "task_1"));
  await assert.rejects(f.checkpoints.listTaskHistory(f.run.id, { taskId: "../task_1" }), /filter/);
  const filename = path.join(f.store.directory(f.run.id), "history", `${refs[0]!.id}.json`), value = JSON.parse(await readFile(filename, "utf8"));
  value.history.reason = "tampered reason"; await writeFile(filename, JSON.stringify(value));
  await assert.rejects(f.checkpoints.readTaskHistory(f.run.id, refs[0]!.id), /digest or identity/);
  await assert.rejects(f.checkpoints.listTaskHistory(f.run.id), /digest or identity/);
});
