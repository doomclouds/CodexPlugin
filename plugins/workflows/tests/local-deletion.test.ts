import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import type { DeletionOptions } from "../src/deletion.ts";
import { DeletionService } from "../src/deletion.ts";
import { createLocalWorkspace, localWorkspaceDiff } from "../src/local-workspace.ts";
import type { WorkflowRun } from "../src/types.ts";
const script = 'export const meta={name:"local-fixture",description:"Original project edit fixture"}; return args;';
async function fixture(t: TestContext, options: DeletionOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-delete-")));
  const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "code.txt"), "existing user edit\n");
  const store = new RunStore(path.join(root, "state")), templates = new TemplateStore(store);
  const service = new DeletionService(store, templates, { readEffectiveConfig: async () => ({}), ...options });
  t.after(() => rm(root, { recursive: true, force: true }));
  async function run(extra: Partial<WorkflowRun> = {}) {
    const record: WorkflowRun = { id: `wf_${randomBytes(12).toString("hex")}`, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      script, scriptDigest: "fixture", meta: { name: "local-fixture", description: "Original project edit fixture" }, args: {}, projectPath: project,
      allowWrite: true, workspaceMode: "local", limits: { maxCalls: 3, maxReadWorkers: 1, timeoutMs: 1000, maxTokens: 0 },
      execution: "completed", review: "ready", application: "none", tasks: [], logs: [], ...extra };
    await store.create(record); record.workspace = await createLocalWorkspace(project, store.directory(record.id)); record.workspacePath = project;
    await store.save(record); return record;
  }
  return { root, project, store, templates, service, run };
}
async function missing(filename: string) { await assert.rejects(stat(filename), { code: "ENOENT" }); }

test("local run deletion removes only owned records and baseline while preserving live code and parent transactions", async t => {
  const { root, project, store, service, run } = await fixture(t);
  const record = await run();
  await writeFile(path.join(project, "code.txt"), "worker edits already present\n");
  await writeFile(path.join(project, "new.txt"), "new live source\n");
  record.diff = await localWorkspaceDiff(record.workspace!); await store.save(record);
  const parentTransaction = path.join(root, "apply-transaction"); await mkdir(parentTransaction);
  await writeFile(path.join(parentTransaction, "journal.json"), "not a workflow transaction");
  await writeFile(path.join(parentTransaction, "keep.txt"), "unrelated private data");
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.ok(preview.objects.every(object => object.path.startsWith(store.root + path.sep)));
  const result = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(result.deleted, true, JSON.stringify(result)); await missing(store.directory(record.id));
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "worker edits already present\n");
  assert.equal(await readFile(path.join(project, "new.txt"), "utf8"), "new live source\n");
  assert.equal(await readFile(path.join(parentTransaction, "keep.txt"), "utf8"), "unrelated private data");
});

test("definition deletion cleans associated local runs without removing any original project files", async t => {
  const { project, store, templates, service, run } = await fixture(t);
  const definition = await templates.save({ script, allowWrite: true, workspaceMode: "local" });
  const first = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  const second = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  await writeFile(path.join(project, "code.txt"), "latest local edit\n");
  const preview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  const result = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(result.deleted, true, JSON.stringify(result)); await missing(store.directory(first.id)); await missing(store.directory(second.id));
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "latest local edit\n");
  assert.equal(await templates.get(definition.id), undefined);
});

test("tampered local workspace roots and baseline paths are rejected before deletion", async t => {
  const { root, project, store, service, run } = await fixture(t);
  const record = await run(); const external = path.join(root, "external"); await mkdir(external); await writeFile(path.join(external, "keep.txt"), "must remain");
  for (const workspace of [{ ...record.workspace!, root: external }, { ...record.workspace!, baselineRoot: project }, { ...record.workspace!, rootIdentity: { dev: -1, ino: -1 } }]) {
    await store.save({ ...record, workspace });
    const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
    assert.equal(preview.canDelete, false); assert.ok(preview.blocked.some(block => block.code === "workspace_ownership"));
    const result = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
    assert.equal(result.deleted, false); assert.equal(await readFile(path.join(external, "keep.txt"), "utf8"), "must remain");
    assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "existing user edit\n");
  }
});

test("local deletion does not follow a replaced baseline symlink into the original project", async t => {
  const { project, store, service, run } = await fixture(t);
  const record = await run(); await rm(record.workspace!.baselineRoot!, { recursive: true });
  await symlink(project, record.workspace!.baselineRoot!, process.platform === "win32" ? "junction" : "dir");
  const before = await readdir(project);
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(preview.canDelete, false);
  const result = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(result.deleted, false); assert.deepEqual(await readdir(project), before);
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "existing user edit\n");
});

test("partial local deletion can finish after baseline removal without rolling back original changes", async t => {
  let first = true;
  const { project, store, templates, service, run } = await fixture(t, { removeOwnedPath: async filename => {
    if (first) { first = false; await rm(path.join(filename, "local-baseline"), { recursive: true, force: true }); throw new Error("Fixture cleanup interruption"); }
    await rm(filename, { recursive: true, force: true });
  } });
  const record = await run(); await writeFile(path.join(project, "code.txt"), "live user and worker changes\n");
  const firstPreview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  const partial = await service.execute({ ...firstPreview.target, fingerprint: firstPreview.fingerprint });
  assert.equal(partial.deleted, false); assert.equal(partial.partial, true);
  await missing(record.workspace!.baselineRoot!);
  const restarted = new DeletionService(store, templates, { readEffectiveConfig: async () => ({}) });
  const preview = await restarted.preview(firstPreview.target);
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  const finished = await restarted.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(finished.deleted, true, JSON.stringify(finished)); await missing(store.directory(record.id));
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "live user and worker changes\n");
});

test("local records remain deletable after the original project is moved or removed", async t => {
  const { root, project, store, service, run } = await fixture(t);
  const first = await run(), second = await run();
  const moved = path.join(root, "moved-project"); await rename(project, moved);
  const preview = await service.preview({ kind: "run", id: first.id, revision: first.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  assert.equal(await readFile(path.join(moved, "code.txt"), "utf8"), "existing user edit\n");
  await rm(moved, { recursive: true });
  const missingPreview = await service.preview({ kind: "run", id: second.id, revision: second.revision });
  assert.equal(missingPreview.canDelete, true, JSON.stringify(missingPreview.blocked));
  assert.equal((await service.execute({ ...missingPreview.target, fingerprint: missingPreview.fingerprint })).deleted, true);
  await missing(store.directory(first.id)); await missing(store.directory(second.id));
});

test("corrupted local baseline content does not prevent complete owned-data deletion", async t => {
  const { project, store, service, run } = await fixture(t);
  const record = await run(); await writeFile(path.join(record.workspace!.baselineRoot!, "code.txt"), "corrupt baseline\n");
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  await missing(store.directory(record.id));
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "existing user edit\n");
});
