import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { validateMaintenanceScope } from "../src/maintenance.ts";
import type { CommandRequest, CommandResult, WorkerAdapter } from "../src/adapter.ts";
import type { MaintenancePlan, WorkspaceMode } from "../src/types.ts";

const exec = promisify(execFile);
const script = (body: string) => `export const meta={name:"operation-scope",description:"Execute only explicitly declared fixture commands"}; ${body}`;
const command = (source: string) => [process.execPath, "-e", source];
const plan = (source: string): MaintenancePlan => ({ steps: [{ id: "run", command: command(source) }] });

async function fixture(t: TestContext, handler?: (request: CommandRequest, signal: AbortSignal) => Promise<CommandResult>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-operation-scope-")));
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "source.txt"), "original\n");
  await writeFile(path.join(project, "unrelated.txt"), "user content\n");
  await exec("git", ["init", "--quiet"], { cwd: project });
  const calls: CommandRequest[] = [];
  const adapter: WorkerAdapter = {
    run: async () => { throw new Error("Deterministic operations must not invoke a model"); },
    command: async (request, signal) => {
      calls.push(structuredClone(request));
      if (handler) return handler(request, signal);
      try {
        const result = await exec(request.command[0]!, request.command.slice(1), { cwd: request.cwd, encoding: "utf8", signal });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, attempts: 1 };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code !== "number") throw error;
        return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", attempts: 1 };
      }
    },
    close: async () => {},
  };
  const store = new RunStore(path.join(root, "state"));
  const engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, engine, store, calls };
}

test("maintenance scope validates every supported mode and keeps activation, protected paths and network separate", () => {
  const maintenance = plan("0");
  for (const workspaceMode of ["snapshot", "local", "git-worktree"] as const) {
    assert.deepEqual(validateMaintenanceScope({ maintenance, workspaceMode, allowWrite: true }), maintenance);
    assert.throws(() => validateMaintenanceScope({ maintenance, workspaceMode, allowWrite: false }), /allowWrite|writable/);
    assert.throws(() => validateMaintenanceScope({ maintenance: { steps: [{ ...maintenance.steps[0]!, networkAccess: true }] }, workspaceMode, allowWrite: true }), /network grant/);
  }
  for (const workspaceMode of ["snapshot", "local"] as const) {
    assert.throws(() => validateMaintenanceScope({ maintenance: { ...maintenance, activation: { serverName: "fixture", command: "node", args: [] } }, workspaceMode, allowWrite: true }), /activation requires git-worktree/);
    assert.throws(() => validateMaintenanceScope({ maintenance: { steps: [{ ...maintenance.steps[0]!, protectedPaths: [".agents/skills"] }] }, workspaceMode, allowWrite: true }), /Protected maintenance paths require git-worktree/);
  }
  assert.throws(() => validateMaintenanceScope({ maintenance, workspaceMode: "other" as WorkspaceMode, allowWrite: true }), /Unsupported/);
});

test("local operation executes exact declared argv in the original project without invoking a model", async t => {
  const f = await fixture(t);
  const maintenance = plan('require("node:fs").writeFileSync("source.txt","changed by operation\\n"); process.stdout.write("done\\n");');
  const preview = await f.engine.preview({ projectPath: f.project, script: script('return await operation("run");'), maintenance, workspaceMode: "local", allowWrite: true, approvalMode: "auto-review" });
  assert.equal(preview.localGitWrite, true);
  await f.engine.start({ id: preview.id, revision: preview.revision });
  const done = await f.engine.wait(preview.id);
  assert.equal(done.execution, "completed", done.error);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "changed by operation\n");
  assert.equal(await readFile(path.join(f.project, "unrelated.txt"), "utf8"), "user content\n");
  assert.deepEqual(f.calls[0]?.command, maintenance.steps[0]?.command);
  assert.equal(f.calls[0]?.cwd, f.project);
  assert.equal(Object.hasOwn(f.calls[0]!, "approvalMode"), false);
  assert.equal(f.calls[0]?.retries, 0);
  assert.equal(done.tasks[0]?.attempts[0]?.outcome, "confirmed");
  await assert.rejects(f.engine.update({ id: done.id, revision: done.revision, script: done.script, args: done.args, maintenance: plan("1") }), /scope requires a new preview/);
  assert.deepEqual((await f.engine.get(done.id)).maintenance, maintenance);
});

test("snapshot operations write only the owned isolated snapshot", async t => {
  const f = await fixture(t);
  const preview = await f.engine.preview({ projectPath: f.project, script: script('return await operation("run");'), maintenance: plan('require("node:fs").writeFileSync("source.txt","isolated change\\n");'), workspaceMode: "snapshot", allowWrite: true });
  await f.engine.start({ id: preview.id, revision: preview.revision });
  const done = await f.engine.wait(preview.id);
  assert.equal(done.execution, "completed", done.error);
  assert.notEqual(f.calls[0]?.cwd, f.project);
  assert.equal(f.calls[0]?.cwd, done.workspacePath);
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "original\n");
  assert.equal(await readFile(path.join(done.workspacePath!, "source.txt"), "utf8"), "isolated change\n");
  assert.deepEqual(done.diff?.files.map(file => file.path), ["source.txt"]);
});

test("failed local operations retain confirmed stdout and stderr through finally cleanup", async t => {
  for (const stream of ["stderr", "stdout"] as const) await t.test(stream, async child => {
    const f = await fixture(child);
    const maintenance: MaintenancePlan = { steps: [
      { id: "fail", command: command(`require("node:fs").writeFileSync("owned-temporary.txt","scratch"); process.${stream}.write("fixture dependency failed\\n"); process.exit(17);`) },
      { id: "cleanup", command: command('require("node:fs").rmSync("owned-temporary.txt"); process.stdout.write("cleaned\\n");') },
    ] };
    const preview = await f.engine.preview({ projectPath: f.project, script: script('try { phase("Build"); await operation("fail"); } finally { phase("Cleanup"); await operation("cleanup"); }'), maintenance, workspaceMode: "local", allowWrite: true });
    await f.engine.start({ id: preview.id, revision: preview.revision });
    const failed = await f.engine.wait(preview.id);
    assert.equal(failed.execution, "failed");
    assert.match(failed.error!, /fixture dependency failed/);
    assert.equal(failed.tasks[0]?.status, "failed");
    assert.equal(failed.tasks[1]?.status, "completed");
    assert.equal(failed.tasks[0]?.attempts[0]?.outcome, "confirmed");
    assert.match((failed.tasks[0]?.attempts[0]?.output as CommandResult)[stream], /fixture dependency failed/);
    const stored = await f.store.load(failed.id);
    assert.deepEqual(stored.tasks[0]?.output, stored.tasks[0]?.attempts[0]?.output);
    assert.match((stored.tasks[0]?.output as CommandResult)[stream], /fixture dependency failed/);
    await assert.rejects(readFile(path.join(f.project, "owned-temporary.txt")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(f.project, "unrelated.txt"), "utf8"), "user content\n");
  });
});

test("local operations with unknown non-idempotent outcomes cannot replay an existing side effect", async t => {
  let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const f = await fixture(t, async (request, signal) => {
    await writeFile(path.join(request.cwd, "effect.txt"), "one effect\n");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Fixture acknowledgment lost after effect")), { once: true });
      begun();
    });
    return { exitCode: 0, stdout: "", stderr: "", attempts: 1 };
  });
  const preview = await f.engine.preview({ projectPath: f.project, script: script('return await operation("run");'), maintenance: plan("0"), workspaceMode: "local", allowWrite: true });
  await f.engine.start({ id: preview.id, revision: preview.revision });
  await started;
  const stopped = await f.engine.stop(preview.id);
  assert.equal(stopped.tasks[0]?.attempts[0]?.outcome, "unknown");
  await f.engine.start({ id: stopped.id, revision: stopped.revision }, true);
  const refused = await f.engine.wait(preview.id);
  assert.equal(refused.execution, "failed");
  assert.match(refused.error!, /will not be repeated/);
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(path.join(f.project, "effect.txt"), "utf8"), "one effect\n");
});

test("legacy local previews cannot acquire command Git scope through update or preparing", async t => {
  const f = await fixture(t);
  const preview = await f.engine.preview({ projectPath: f.project, script: script('return "legacy";'), workspaceMode: "local", allowWrite: true });
  const legacy = await f.store.load(preview.id);
  delete legacy.localGitWrite;
  await f.store.save(legacy);
  await assert.rejects(f.engine.update({ id: legacy.id, revision: legacy.revision, script: script('return await operation("run");'), args: {}, maintenance: plan("0") }), /legacy write scope cannot be expanded/);
  assert.equal((await f.store.load(legacy.id)).maintenance, undefined);
  legacy.maintenance = plan("0");
  legacy.script = script('return await operation("run");');
  await f.store.save(legacy);
  await f.engine.start({ id: legacy.id, revision: legacy.revision });
  const refused = await f.engine.wait(legacy.id);
  assert.equal(refused.execution, "failed");
  assert.match(refused.error!, /legacy write scope cannot be expanded/);
  assert.equal(f.calls.length, 0);
});

test("snapshot operation preparing rejects a workspace redirected to the original project", async t => {
  const f = await fixture(t);
  const preview = await f.engine.preview({ projectPath: f.project, script: script('return await operation("run");'), maintenance: plan("0"), allowWrite: true });
  await f.engine.start({ id: preview.id, revision: preview.revision });
  const done = await f.engine.wait(preview.id);
  assert.equal(done.execution, "completed", done.error);
  done.workspace!.root = f.project;
  done.workspacePath = f.project;
  done.execution = "failed";
  await f.store.save(done);
  await f.engine.start({ id: done.id, revision: done.revision }, true);
  const refused = await f.engine.wait(done.id);
  assert.equal(refused.execution, "failed");
  assert.match(refused.error!, /owned isolated workspace/);
  assert.equal(f.calls.length, 1);
});

test("template scope validation applies on saving and reading portable command definitions", async t => {
  const f = await fixture(t);
  const templates = new TemplateStore(f.store);
  const source = script('return await operation("run");');
  const maintenance = plan("0");
  const saved = await templates.save({ script: source, maintenance, workspaceMode: "local", allowWrite: true });
  assert.deepEqual((await templates.get(saved.id))?.maintenance, maintenance);
  const activation = { serverName: "fixture", command: "node", args: [] };
  await assert.rejects(templates.save({ script: source, revision: saved.revision, maintenance: { ...maintenance, activation }, workspaceMode: "local", allowWrite: true }), /activation requires git-worktree/);
  const malformed = { ...saved, maintenance: { ...maintenance, activation } };
  await writeFile(templates.filename(saved.id), JSON.stringify(malformed));
  await assert.rejects(templates.get(saved.id), /activation requires git-worktree/);
});

test("preview, update and retained preparing reject command activation and protected paths outside Git isolation", async t => {
  const f = await fixture(t);
  const source = script('return await operation("run");');
  const maintenance = plan("0");
  const activation = { serverName: "fixture", command: "node", args: [] };
  await assert.rejects(f.engine.preview({ projectPath: f.project, script: source, maintenance: { ...maintenance, activation }, workspaceMode: "local", allowWrite: true }), /activation requires git-worktree/);
  await assert.rejects(f.engine.preview({ projectPath: f.project, script: source, maintenance: { steps: [{ ...maintenance.steps[0]!, protectedPaths: [".codex"] }] }, allowWrite: true }), /Protected maintenance paths require git-worktree/);
  const draft = await f.engine.preview({ projectPath: f.project, script: source, maintenance, workspaceMode: "local", allowWrite: true });
  await assert.rejects(f.engine.update({ id: draft.id, revision: draft.revision, script: source, args: {}, maintenance: { steps: [{ ...maintenance.steps[0]!, protectedPaths: [".agents"] }] } }), /Protected maintenance paths require git-worktree/);
  assert.deepEqual((await f.store.load(draft.id)).maintenance, maintenance);
  const tampered = await f.store.load(draft.id);
  tampered.maintenance!.activation = activation;
  await f.store.save(tampered);
  await f.engine.start({ id: tampered.id, revision: tampered.revision });
  const refused = await f.engine.wait(draft.id);
  assert.equal(refused.execution, "failed");
  assert.match(refused.error!, /activation requires git-worktree/);
  assert.equal(f.calls.length, 0);
});
