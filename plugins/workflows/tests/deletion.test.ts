import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { DeletionService } from "../src/deletion.ts";
import type { DeletionOptions } from "../src/deletion.ts";
import type { WorkflowRun } from "../src/types.ts";
import { createGitWorkspace } from "../src/maintenance.ts";
import { requireFileSymlinks } from "./fixtures/symlink.ts";
const exec = promisify(execFile);
const source = 'export const meta={name:"reusable",description:"Deletion fixture"}; return args;';
async function fixture(t: TestContext, options: DeletionOptions = {}, aliasDataRoot = false) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-delete-test-"));
  let dataParent = root;
  if (aliasDataRoot) {
    const realParent = path.join(root, "canonical-data");
    dataParent = path.join(root, "data-alias");
    await mkdir(realParent);
    await symlink(realParent, dataParent, process.platform === "win32" ? "junction" : "dir");
  }
  const store = new RunStore(path.join(dataParent, "state")); const templates = new TemplateStore(store);
  await mkdir(path.join(root, "original")); await writeFile(path.join(root, "original", "delivered.txt"), "Delivered project contents\n");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const service = new DeletionService(store, templates, { readEffectiveConfig: async () => ({}), ...options });
  async function run(extra: Partial<WorkflowRun> = {}) {
    const record: WorkflowRun = {
      id: `wf_${randomBytes(12).toString("hex")}`, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      script: source, scriptDigest: "test-digest", meta: { name: "reusable", description: "Deletion fixture" }, args: {},
      projectPath: path.join(root, "original"), allowWrite: false, limits: { maxCalls: 8, maxReadWorkers: 2, timeoutMs: 1000, maxTokens: 0 },
      execution: "completed", review: "ready", application: "none", tasks: [], logs: [{ at: new Date().toISOString(), level: "info", message: "Completed" }], ...extra,
    };
    await store.create(record); return record;
  }
  return { root, store, templates, service, run };
}
async function missing(filename: string) { await assert.rejects(stat(filename), (error: NodeJS.ErrnoException) => error.code === "ENOENT"); }

test("definition deletion removes all proven run data and locks, preserving same-name history, external files and other runs", async t => {
  const { root, store, templates, service, run } = await fixture(t);
  const definition = await templates.save({ script: source });
  const associated = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  const history = await run();
  const different = await templates.save({ script: source.replace("reusable", "different") });
  const other = await run({ sourceDefinition: { id: different.id, revision: different.revision } });
  const owned = store.directory(associated.id);
  for (const name of ["workspace/.git/objects", "baseline", "apply-transaction/staged", "controls", "disabled-hooks", "cache", "attempts"]) {
    await mkdir(path.join(owned, name), { recursive: true }); await writeFile(path.join(owned, name, "owned.fixture"), "Private fixture result");
  }
  await writeFile(path.join(owned, "activation-config.backup.toml"), "Private backup");
  await symlink(path.join(root, "original"), path.join(owned, "external-link"), process.platform === "win32" ? "junction" : "dir");
  const preview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked)); assert.deepEqual(preview.runs.map(item => item.id), [associated.id]);
  assert.ok(preview.totalFiles >= 10); assert.ok(preview.totalBytes > 0);
  const deleted = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(deleted.deleted, true); assert.equal(deleted.partial, false); assert.deepEqual(deleted.remaining, []);
  assert.deepEqual(deleted.deletedRunIds, [associated.id]); assert.equal(deleted.deletedDefinitionId, definition.id);
  await missing(owned); await missing(`${owned}.lock`); await missing(path.join(store.root, ".deletions")); assert.equal(await templates.get(definition.id), undefined);
  assert.equal((await store.load(history.id)).id, history.id); assert.equal((await store.load(other.id)).id, other.id);
  assert.equal(await readFile(path.join(root, "original", "delivered.txt"), "utf8"), "Delivered project contents\n");
  const anotherProcess = new RunStore(store.root);
  await assert.rejects(anotherProcess.save(associated), /deleted/); await assert.rejects(anotherProcess.acquire(associated.id), /deleted/);
  await assert.rejects(anotherProcess.requestControl(associated.id, "old", "stop"), /deleted/);
  await missing(owned); await missing(`${owned}.lock`);
});

test("single-run deletion leaves its saved definition and independent runs intact", async t => {
  const { store, templates, service, run } = await fixture(t);
  const definition = await templates.save({ script: source });
  const first = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } }); const second = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  const preview = await service.preview({ kind: "run", id: first.id, revision: first.revision });
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  assert.equal((await templates.get(definition.id))?.revision, definition.revision); assert.equal((await store.load(second.id)).id, second.id);
});

test("canonical Git workspaces under an aliased owned data root can be completely deleted", async t => {
  const { root, store, service, run } = await fixture(t, {}, true);
  const original = path.join(root, "original");
  await exec("git", ["init", "--quiet"], { cwd: original });
  await exec("git", ["add", "--all"], { cwd: original });
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--quiet", "-m", "Add deletion fixture"], { cwd: original });
  const record = await run({ allowWrite: true, workspaceMode: "git-worktree" });
  const directory = store.directory(record.id), canonical = await realpath(directory);
  assert.notEqual(directory, canonical, "The fixture must exercise a genuine data-root alias on every platform.");
  record.workspace = await createGitWorkspace(original, directory);
  record.workspacePath = record.workspace.root;
  assert.equal(record.workspace.root, path.join(canonical, "workspace"));
  await store.save(record);
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  const deleted = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(deleted.deleted, true, JSON.stringify(deleted));
  assert.equal(deleted.partial, false);
  await missing(directory); await missing(canonical); await missing(path.join(store.root, ".deletions"));
  assert.equal(await readFile(path.join(original, "delivered.txt"), "utf8"), "Delivered project contents\n");
});

test("legacy lexical workspace names under an owned data alias remain deletable even after workspace cleanup", async t => {
  const { store, service, run } = await fixture(t, {}, true);
  for (const workspacePresent of [true, false]) {
    const record = await run(), workspace = path.join(store.directory(record.id), "workspace");
    if (workspacePresent) await mkdir(workspace);
    record.workspace = { root: workspace, original: await realpath(record.projectPath), baseline: {}, kind: "snapshot" };
    await store.save(record);
    const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
    assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
    assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  }
});

test("canonical MCP paths still retain workspaces stored through a data-root alias", async t => {
  let config: Record<string, unknown> = {};
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => config }, true);
  const record = await run();
  const canonical = await realpath(store.directory(record.id));
  await mkdir(path.join(canonical, "workspace"));
  await writeFile(path.join(canonical, "workspace", "server.mjs"), "Owned MCP runtime fixture");
  record.workspace = { root: path.join(canonical, "workspace"), original: record.projectPath, baseline: {}, kind: "git-worktree", git: { base: "fixture", branch: "fixture" } };
  await store.save(record);
  config = { mcp_servers: { production: { command: "node", args: [path.join(canonical, "workspace", "server.mjs")] } } };
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.ok(preview.blocked.some(block => block.code === "config_reference" && block.reference?.serverName === "production"));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
  assert.equal(await readFile(path.join(canonical, "workspace", "server.mjs"), "utf8"), "Owned MCP runtime fixture");
});

test("pending deletion preserves canonical MCP reference protection after its aliased run directory is gone", async t => {
  let config: Record<string, unknown> = {}, fail = true;
  const { store, service, run } = await fixture(t, {
    readEffectiveConfig: async () => config,
    removeOwnedPath: async filename => {
      await rm(filename, { recursive: true, force: true });
      if (fail) { fail = false; throw new Error("Injected failure after owned directory removal"); }
    },
  }, true);
  const record = await run(), canonical = await realpath(store.directory(record.id));
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  const partial = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(partial.deleted, false); assert.equal(partial.partial, true);
  await missing(canonical);
  config = { mcp_servers: { retained: { command: "node", args: [path.join(canonical, "workspace", "server.mjs")] } } };
  const retained = await service.preview(preview.target);
  assert.ok(retained.blocked.some(block => block.code === "config_reference" && block.reference?.serverName === "retained"));
  assert.equal((await service.execute({ ...retained.target, fingerprint: retained.fingerprint })).deleted, false);
  assert.equal((await stat(path.join(store.root, ".deletions"))).isDirectory(), true);
  config = {};
  const cleared = await service.preview(preview.target);
  assert.equal((await service.execute({ ...cleared.target, fingerprint: cleared.fingerprint })).deleted, true);
  await missing(path.join(store.root, ".deletions"));
});

test("workspace aliases supplied by records and workspace symlinks cannot establish ownership", async t => {
  const { root, store, service, run } = await fixture(t, {}, true);
  const record = await run();
  const directory = store.directory(record.id), canonical = await realpath(directory), ownedWorkspace = path.join(canonical, "workspace");
  await mkdir(ownedWorkspace);
  const externalAlias = path.join(root, "record-supplied-alias");
  await symlink(ownedWorkspace, externalAlias, process.platform === "win32" ? "junction" : "dir");
  for (const unowned of [path.join(root, "original"), externalAlias]) {
    record.workspace = { root: unowned, original: record.projectPath, baseline: {}, kind: "git-worktree", git: { base: "fixture", branch: "fixture" } };
    await store.save(record);
    const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
    assert.ok(preview.blocked.some(block => block.code === "workspace_ownership"));
    assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
  }
  await rm(ownedWorkspace, { recursive: true });
  await symlink(path.join(root, "original"), ownedWorkspace, process.platform === "win32" ? "junction" : "dir");
  record.workspace = { root: ownedWorkspace, original: record.projectPath, baseline: {}, kind: "git-worktree", git: { base: "fixture", branch: "fixture" } };
  await store.save(record);
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.ok(preview.blocked.some(block => block.code === "workspace_ownership"));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
  assert.equal(await readFile(path.join(root, "original", "delivered.txt"), "utf8"), "Delivered project contents\n");
});

test("active preparation, worker execution, application and held run locks prevent deletion", async t => {
  const { store, service, run } = await fixture(t);
  for (const extra of [{ execution: "preparing" }, { execution: "running" }, { execution: "stopping" }, { application: "applying" }] as Array<Partial<WorkflowRun>>) {
    const record = await run(extra); const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
    assert.ok(preview.blocked.some(block => block.code === "active"));
    assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
    assert.equal((await store.load(record.id)).id, record.id);
  }
  const record = await run(); const release = await store.acquire(record.id);
  try { const preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.ok(preview.blocked.some(block => block.code === "locked")); }
  finally { await release(); }
  const preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
});

test("effective MCP references block deletion and stale configuration cannot authorize removal", async t => {
  let config: Record<string, unknown> = {};
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => config });
  const record = await run(); const directory = store.directory(record.id);
  config = { mcp_servers: { production: { command: "node", args: [path.join(directory, "workspace", "server.mjs")], env: { PRIVATE: "fixture-only" } } } };
  let preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.ok(preview.blocked.some(block => block.code === "config_reference" && block.reference?.serverName === "production"));
  assert.ok(!JSON.stringify(preview).includes("fixture-only"));
  config = { mcp_servers: { production: { command: "node", args: [path.join(directory + "-unrelated", "server.mjs")] } } };
  preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.equal(preview.canDelete, true);
  config = { mcp_servers: { production: { command: "node", args: [path.join(directory, "workspace", "server.mjs")] } } };
  const rejected = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(rejected.deleted, false); assert.ok(rejected.blocked.some(block => block.code === "preview_changed"));
  assert.equal((await store.load(record.id)).id, record.id);
  config = {}; preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true); assert.deepEqual(config, {});
});

test("Windows named-pipe MCP settings do not block unrelated run deletion", { skip: process.platform !== "win32" }, async t => {
  let config: Record<string, unknown> = {};
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => config });
  const record = await run();
  config = { scopes: [{ cwd: path.dirname(store.root), mcp_servers: { desktop: {
    command: process.execPath,
    env: { SKY_CUA_NATIVE_PIPE_DIRECTORY: "\\\\.\\pipe\\" },
  } } }] };
  const preview = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  config = { scopes: [{ cwd: path.dirname(store.root), mcp_servers: { desktop: {
    command: process.execPath,
    args: [path.join(store.directory(record.id), "server.mjs")],
    env: { SKY_CUA_NATIVE_PIPE_DIRECTORY: "\\\\.\\pipe\\" },
  } } }] };
  const referenced = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.equal(referenced.canDelete, false);
  assert.ok(referenced.blocked.some(block => block.code === "config_reference"));
  assert.ok(!referenced.blocked.some(block => block.code === "config_unavailable"));
});

test("effective configuration map ordering does not invalidate a fresh deletion preview", async t => {
  let reads = 0;
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => (++reads % 2 ? {
    scopes: [{ cwd: ".", mcp_servers: {
      alpha: { command: "node", args: ["--version", "--help"], env: { FIRST: "private-fixture", SECOND: "same-value" } },
      beta: { command: "node", args: ["--help"] },
    } }],
  } : {
    scopes: [{ mcp_servers: {
      beta: { args: ["--help"], command: "node" },
      alpha: { env: { SECOND: "same-value", FIRST: "private-fixture" }, args: ["--version", "--help"], command: "node" },
    }, cwd: "." }],
  }) });
  const record = await run();
  const input = { kind: "run" as const, id: record.id, revision: record.revision };
  const first = await service.preview(input); const second = await service.preview(input);
  assert.equal(first.canDelete, true); assert.equal(first.fingerprint, second.fingerprint);
  assert.ok(!JSON.stringify(first).includes("private-fixture"));
  const deleted = await service.execute({ ...input, fingerprint: first.fingerprint });
  assert.equal(deleted.deleted, true, JSON.stringify(deleted.blocked));
  await missing(store.directory(record.id)); await missing(path.join(store.root, ".deletions"));
});

test("canonical configuration fingerprints still reject changed values and argument order", async t => {
  let config: Record<string, unknown> = {};
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => config });
  const record = await run();
  const input = { kind: "run" as const, id: record.id, revision: record.revision };
  const server = { command: "node", args: ["--version", "--help"], env: { FIXTURE: "original" } };
  const changes = [
    { ...server, command: "another-command" },
    { ...server, args: [...server.args].reverse() },
    { ...server, env: { FIXTURE: "changed" } },
    { ...server, args: [path.join(store.directory(record.id), "workspace", "server.mjs")] },
  ];
  for (const changed of changes) {
    config = { mcp_servers: { production: server } };
    const preview = await service.preview(input); assert.equal(preview.canDelete, true);
    config = { mcp_servers: { production: changed } };
    const rejected = await service.execute({ ...input, fingerprint: preview.fingerprint });
    assert.equal(rejected.deleted, false); assert.ok(rejected.blocked.some(block => block.code === "preview_changed"));
    assert.equal((await store.load(record.id)).id, record.id);
  }
});

test("other activation journals retain both before and desired dependencies until references are explicitly resolved", async t => {
  const { store, service, run } = await fixture(t);
  const first = await run(); const second = await run();
  const filename = path.join(store.directory(second.id), "activation-journal.json");
  for (const state of ["before", "desired"]) {
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, [state]: { command: "node", args: [path.join(store.directory(first.id), "workspace", "server.mjs")] } }));
    const preview = await service.preview({ kind: "run", id: first.id, revision: 1 });
    assert.ok(preview.blocked.some(block => block.code === "run_reference" && block.reference?.source === second.id));
  }
  await writeFile(filename, JSON.stringify({ before: { command: "node", args: ["independent-server.mjs"] }, desired: { command: "node", args: ["independent-server.mjs"] } }));
  const preview = await service.preview({ kind: "run", id: first.id, revision: 1 });
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  assert.equal((await store.load(second.id)).id, second.id);
});

test("activation config failures and malformed journals fail closed without revealing private values", async t => {
  const { store, service, run } = await fixture(t, { readEffectiveConfig: async () => { throw new Error("Secret diagnostic fixture"); } });
  const record = await run({ activation: { serverName: "production", status: "failed" } });
  let preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.ok(preview.blocked.some(block => block.code === "config_unavailable")); assert.ok(!JSON.stringify(preview).includes("Secret diagnostic"));
  await writeFile(path.join(store.directory(record.id), "activation-journal.json"), "invalid-json");
  preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.ok(preview.blocked.some(block => block.code === "activation_journal"));
});

test("partial deletion is fenced, reports remaining data, and resumes cleanup after service restart", async t => {
  let fail = true; let failedPath = "";
  const { store, templates, service, run } = await fixture(t, { removeOwnedPath: async filename => { if (fail && filename === failedPath) throw new Error("Injected removal failure"); await rm(filename, { recursive: true, force: true }); } });
  const definition = await templates.save({ script: source });
  const first = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } }); const second = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  failedPath = store.directory(second.id);
  let preview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision });
  const partial = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(partial.deleted, false); assert.equal(partial.partial, true); assert.ok(partial.remaining.some(item => item.path === failedPath));
  await missing(store.directory(first.id)); assert.equal((await templates.get(definition.id))?.id, definition.id);
  await assert.rejects(store.save(first), /deleted/); await assert.rejects(store.save(second), /deleted/); assert.equal((await store.list()).every(record => record.deletionPending), true);
  await assert.rejects(templates.save({ script: source, revision: definition.revision }), /deletion is pending/);
  const restarted = new DeletionService(new RunStore(store.root), new TemplateStore(new RunStore(store.root)), { readEffectiveConfig: async () => ({}) });
  fail = false; preview = await restarted.preview({ kind: "definition", id: definition.id, revision: definition.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  const finished = await restarted.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(finished.deleted, true); assert.deepEqual(new Set(finished.deletedRunIds), new Set([first.id, second.id]));
  await missing(failedPath); await missing(`${failedPath}.lock`); await missing(path.join(store.root, ".deletions")); assert.equal(await templates.get(definition.id), undefined);
  const repeat = await restarted.preview({ kind: "definition", id: definition.id, revision: definition.revision });
  assert.equal((await restarted.execute({ ...repeat.target, fingerprint: repeat.fingerprint })).deleted, true);
});

test("recreating a definition advances its revision and never reauthorizes old run creation or old deletion", async t => {
  const { templates, store, service, run } = await fixture(t);
  const definition = await templates.save({ script: source }); const old = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  const preview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision }); await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  const recreated = await templates.save({ script: source }); assert.notEqual(recreated.revision, definition.revision);
  const oldPreview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision }); assert.equal(oldPreview.canDelete, false);
  assert.ok(oldPreview.blocked.some(block => block.code === "revision"));
  const delayed = { ...old, id: `wf_${randomBytes(12).toString("hex")}` };
  await assert.rejects(store.create(delayed), /definition changed/); await missing(store.directory(delayed.id));
  const fresh = await run({ sourceDefinition: { id: definition.id, revision: recreated.revision } }); assert.equal((await store.load(fresh.id)).id, fresh.id);
});

test("explicit historical runs are shown and deleted while built-in definitions remain protected", async t => {
  const { service, templates, store, run } = await fixture(t);
  const definition = await templates.save({ script: source }); const history = await run();
  const preview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision, runIds: [history.id, history.id] });
  assert.deepEqual(preview.runs.map(item => item.id), [history.id]); assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  await missing(store.directory(history.id));
  const builtin = await service.preview({ kind: "definition", id: "builtin:review-changes", revision: 1 });
  assert.ok(builtin.blocked.some(block => block.code === "builtin")); assert.equal((await service.execute({ ...builtin.target, fingerprint: builtin.fingerprint })).deleted, false);
});

test("unsafe run directory links never cause deletion outside the owned data root", async t => {
  const { root, store, service, run } = await fixture(t);
  const record = await run(); const directory = store.directory(record.id);
  await rm(directory, { recursive: true }); await symlink(path.join(root, "original"), directory, process.platform === "win32" ? "junction" : "dir");
  const preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.equal(preview.canDelete, false);
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
  assert.equal(await readFile(path.join(root, "original", "delivered.txt"), "utf8"), "Delivered project contents\n");
});

test("unsafe template file symlinks never cause deletion outside the owned data root", async t => {
  const { root, service, templates } = await fixture(t);
  if (!(await requireFileSymlinks(t, root))) return;
  const definition = await templates.save({ script: source });
  await rm(templates.filename(definition.id)); await symlink(path.join(root, "original", "delivered.txt"), templates.filename(definition.id));
  const definitionPreview = await service.preview({ kind: "definition", id: definition.id, revision: definition.revision }); assert.equal(definitionPreview.canDelete, false);
  await assert.rejects(templates.save({ script: source, revision: definition.revision }), /owned regular file/);
});

test("queued cross-instance late persistence cannot recreate an already removed run", async t => {
  const { store, run } = await fixture(t);
  const record = await run(); const separate = new RunStore(store.root); let late: Promise<void> | undefined;
  await store.withMutation(async () => {
    late = separate.save(record); late.catch(() => {});
    await store.markDeleted(record.id, "test-fence", record.revision);
    await rm(store.directory(record.id), { recursive: true });
  });
  await assert.rejects(late!, /deleted/); await missing(store.directory(record.id));
  assert.equal((await readdir(path.join(store.root, "locks"))).some(name => name.endsWith(".lock")), false);
});

test("changed revisions and changed owned file inventories invalidate deletion confirmation", async t => {
  const { store, service, run } = await fixture(t); const record = await run();
  const input = { kind: "run" as const, id: record.id, revision: 1 }; let preview = await service.preview(input);
  await writeFile(path.join(store.directory(record.id), "new-private-result.json"), "new");
  let result = await service.execute({ ...input, fingerprint: preview.fingerprint }); assert.equal(result.deleted, false); assert.ok(result.blocked.some(block => block.code === "preview_changed"));
  preview = await service.preview(input); await store.save({ ...record, revision: 2 });
  result = await service.execute({ ...input, fingerprint: preview.fingerprint }); assert.equal(result.deleted, false); assert.ok(result.blocked.some(block => block.code === "revision"));
  assert.equal((await store.load(record.id)).revision, 2);
});

test("already deleted runs and definitions are idempotent and leave no deletion metadata", async t => {
  const { store, templates, service, run } = await fixture(t);
  const definition = await templates.save({ script: source }); const record = await run();
  for (const input of [{ kind: "run" as const, id: record.id, revision: record.revision }, { kind: "definition" as const, id: definition.id, revision: definition.revision }]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const preview = await service.preview(input); assert.equal(preview.canDelete, true);
      const removed = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
      assert.equal(removed.deleted, true); assert.equal(removed.alreadyGone, attempt === 1);
      await missing(path.join(store.root, ".deletions"));
    }
  }
  await assert.rejects(store.save(record), /deleted/); await assert.rejects(store.acquire(record.id), /deleted/); await assert.rejects(store.requestControl(record.id, "old-control", "stop"), /deleted/);
  await missing(store.directory(record.id)); await missing(`${store.directory(record.id)}.lock`);
});

test("project-scoped relative MCP command arguments retain referenced run directories", async t => {
  let config: Record<string, unknown> = {};
  const { root, store, service, run } = await fixture(t, { readEffectiveConfig: async paths => { assert.ok(paths.includes(path.join(root, "original"))); return config; } });
  const record = await run(); const workspace = path.join(store.directory(record.id), "workspace");
  config = { scopes: [{ cwd: path.join(root, "original"), mcp_servers: { scoped: { command: "node", args: [path.relative(path.join(root, "original"), path.join(workspace, "server.mjs"))] } } }] };
  const preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.ok(preview.blocked.some(block => block.code === "config_reference" && block.reference?.serverName === "scoped"));
});

test("registered project atomic-write temporary files are counted and removed before their ownership journal", async t => {
  const { root, store, service, run } = await fixture(t);
  const record = await run(); const directory = store.directory(record.id); const original = await realpath(path.join(root, "original"));
  await mkdir(path.join(directory, "workspace")); await mkdir(path.join(directory, "apply-transaction"));
  const target = "delivered.txt", name = `${target}.wf-${randomBytes(8).toString("hex")}.tmp`, filename = path.join(original, name);
  await writeFile(filename, "Owned atomic-write temporary"); const info = await stat(filename);
  const expected = { kind: "file", hash: createHash("sha256").update(await readFile(filename)).digest("hex"), mode: info.mode & 0o777 };
  await writeFile(path.join(directory, "apply-transaction", "project-temporaries.json"), JSON.stringify({ project: original, files: [{ path: name, target, expected, dev: info.dev, ino: info.ino }] }));
  record.workspace = { root: path.join(directory, "workspace"), original, baseline: {}, kind: "snapshot" }; await store.save(record);
  const preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.ok(preview.objects.some(object => object.kind === "project-temp" && object.path === filename));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
  await missing(filename); await missing(directory); await missing(path.join(store.root, ".deletions"));
  assert.equal(await readFile(path.join(original, target), "utf8"), "Delivered project contents\n");
});

test("unregistered historical project temporaries block deletion without touching user files", async t => {
  const { root, store, service, run } = await fixture(t);
  const record = await run(); const directory = store.directory(record.id); const original = await realpath(path.join(root, "original"));
  await mkdir(path.join(directory, "workspace")); await mkdir(path.join(directory, "apply-transaction"));
  const filename = path.join(original, `delivered.txt.wf-${randomBytes(8).toString("hex")}.tmp`); await writeFile(filename, "Unproven user or legacy temporary");
  await writeFile(path.join(directory, "apply-transaction", "journal.json"), JSON.stringify({ files: [{ path: "delivered.txt" }], state: "prepared" }));
  record.workspace = { root: path.join(directory, "workspace"), original, baseline: {}, kind: "snapshot" }; await store.save(record);
  const preview = await service.preview({ kind: "run", id: record.id, revision: 1 });
  assert.ok(preview.blocked.some(block => block.code === "project_temp" && block.path === filename));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false);
  assert.equal(await readFile(filename, "utf8"), "Unproven user or legacy temporary"); assert.equal((await store.load(record.id)).id, record.id);
});

test("partial deletion survives lost run.json and exposes a cleanup-only record after restart", async t => {
  let fail = true;
  const { store, templates, service, run } = await fixture(t, { removeOwnedPath: async filename => {
    if (fail) { await rm(path.join(filename, "run.json")); throw new Error("Injected partial recursive deletion"); }
    await rm(filename, { recursive: true, force: true });
  } });
  const definition = await templates.save({ script: source });
  const record = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  await writeFile(path.join(store.directory(record.id), "retained-artifact.txt"), "Still needs cleanup");
  const input = { kind: "definition" as const, id: definition.id, revision: definition.revision };
  const preview = await service.preview(input); assert.equal((await service.execute({ ...input, fingerprint: preview.fingerprint })).partial, true);
  const wrongScope = await service.preview({ kind: "run", id: record.id, revision: record.revision });
  assert.ok(wrongScope.blocked.some(block => block.code === "pending_scope"));
  const restartedStore = new RunStore(store.root); const pending = await restartedStore.load(record.id);
  assert.equal(pending.deletionPending, true); assert.equal(pending.deletionTarget?.kind, "definition"); assert.equal(pending.deletionTarget?.id, definition.id);
  assert.equal(pending.script, ""); assert.deepEqual(pending.tasks, []); assert.deepEqual(pending.logs, []); assert.equal(pending.result, undefined); assert.match(pending.meta.description, /仅用于重试删除/);
  assert.deepEqual((await restartedStore.list()).map(item => item.id), [record.id]);
  await assert.rejects(restartedStore.save(record), /deleted/); await assert.rejects(restartedStore.acquire(record.id), /deleted/);
  const restarted = new DeletionService(restartedStore, new TemplateStore(restartedStore), { readEffectiveConfig: async () => ({}) });
  fail = false; const retry = await restarted.preview(input); assert.equal(retry.canDelete, true, JSON.stringify(retry.blocked));
  assert.equal((await restarted.execute({ ...input, fingerprint: retry.fingerprint })).deleted, true);
  await missing(store.directory(record.id)); await missing(path.join(store.root, ".deletions")); assert.deepEqual(await restartedStore.list(), []);
});

test("listing tolerates completed deletion after directory enumeration", async t => {
  const { store, service, run } = await fixture(t); const record = await run();
  const original = store.load.bind(store); let removed = false;
  store.load = async id => {
    if (id === record.id && !removed) {
      removed = true; const preview = await service.preview({ kind: "run", id, revision: record.revision });
      assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, true);
    }
    return original(id);
  };
  assert.deepEqual(await store.list(), []); await missing(store.directory(record.id)); await missing(path.join(store.root, ".deletions"));
});

test("a reader notices pending deletion created between marker read and run.json removal", async t => {
  const { store, run } = await fixture(t); const record = await run(); const original = store.loadForDeletion.bind(store); let once = false;
  store.loadForDeletion = async id => {
    if (id === record.id && !once) {
      once = true;
      await store.withMutation(async () => {
        await store.markDeleted(id, "race-fixture", record.revision, { id, revision: record.revision, name: record.meta.name, projectPath: record.projectPath, createdAt: record.createdAt }, { kind: "run", id, revision: record.revision });
        await rm(path.join(store.directory(id), "run.json"));
      });
    }
    return original(id);
  };
  const view = await store.load(record.id); assert.equal(view.deletionPending, true); assert.equal(view.script, ""); assert.match(view.meta.description, /仅用于重试删除/);
});

test("MCP executable and script symlinks retain their referenced workflow runtime", async t => {
  let config: Record<string, unknown> = {};
  const { root, store, service, run } = await fixture(t, { readEffectiveConfig: async () => config });
  if (!(await requireFileSymlinks(t, root))) return;
  const record = await run(); const workspace = path.join(store.directory(record.id), "workspace"); await mkdir(workspace);
  const owned = path.join(workspace, "server.mjs"); await writeFile(owned, "// Fixture runtime\n");
  const executable = path.join(root, "retained-tool"); await symlink(owned, executable);
  config = { scopes: [{ cwd: root, mcp_servers: { symlinked: { command: executable, args: [] } } }] };
  let preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.ok(preview.blocked.some(block => block.code === "config_reference"));
  config = { scopes: [{ cwd: root, mcp_servers: { symlinked: { command: "node", args: ["retained-tool"] } } }] };
  preview = await service.preview({ kind: "run", id: record.id, revision: 1 }); assert.ok(preview.blocked.some(block => block.code === "config_reference"));
  assert.equal((await service.execute({ ...preview.target, fingerprint: preview.fingerprint })).deleted, false); assert.equal(await readFile(owned, "utf8"), "// Fixture runtime\n");
});

test("crashed metadata-write temporaries are scoped, counted and completely cleaned", async t => {
  const { store, templates, service, run } = await fixture(t); const definition = await templates.save({ script: source });
  const record = await run({ sourceDefinition: { id: definition.id, revision: definition.revision } });
  const input = { kind: "definition" as const, id: definition.id, revision: definition.revision, includeAssociatedRuns: true as const };
  const requestId = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const filenames = [path.join(".deletions", "requests", `${requestId}.json.1234.0123456789abcdef.tmp`), path.join(".deletions", "runs", `${record.id}.json.1234.0123456789abcdef.tmp`), path.join(".deletions", "templates", `${definition.id.slice(6)}.json.1234.0123456789abcdef.tmp`), path.join("templates", `${definition.id.slice(6)}.json.1234.tmp`)];
  for (const filename of filenames) { await mkdir(path.dirname(path.join(store.root, filename)), { recursive: true }); await writeFile(path.join(store.root, filename), "Partial private metadata write"); }
  const preview = await service.preview(input); assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.equal(preview.objects.filter(object => object.kind === "metadata-temp").length, 4);
  assert.equal((await service.execute({ ...input, fingerprint: preview.fingerprint })).deleted, true);
  for (const filename of filenames) await missing(path.join(store.root, filename)); await missing(path.join(store.root, ".deletions"));
});
