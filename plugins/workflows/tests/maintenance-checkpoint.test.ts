import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { createGitWorkspace, maintenanceFingerprint } from "../src/maintenance.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Checkpoint Fixture", GIT_AUTHOR_EMAIL: "checkpoint@example.invalid", GIT_COMMITTER_NAME: "Checkpoint Fixture", GIT_COMMITTER_EMAIL: "checkpoint@example.invalid", GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-maintenance-checkpoint-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = path.join(root, "project"); await mkdir(project);
  await git(project, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(project, "source.txt"), "base\n"); await git(project, "add", "source.txt"); await git(project, "commit", "--quiet", "-m", "Add fixture source");
  await writeFile(path.join(project, "history.txt"), "history\n"); await git(project, "add", "history.txt"); await git(project, "commit", "--quiet", "-m", "Add fixture history");
  const workspace = await createGitWorkspace(project, path.join(root, "run"));
  return { root, workspace, cwd: workspace.root };
}

test("maintenance checkpoints cover same-commit branch and ordinary ref changes", async t => {
  const f = await fixture(t), baseline = await maintenanceFingerprint(f.workspace);
  await git(f.cwd, "checkout", "--quiet", "-b", "same-tree-branch");
  assert.notEqual(await maintenanceFingerprint(f.workspace), baseline);
  await git(f.cwd, "checkout", "--quiet", "main"); await git(f.cwd, "branch", "-D", "same-tree-branch");
  assert.equal(await maintenanceFingerprint(f.workspace), baseline);
  await git(f.cwd, "update-ref", "refs/remotes/fixture/main", "HEAD");
  assert.notEqual(await maintenanceFingerprint(f.workspace), baseline);
});

test("maintenance checkpoints distinguish staged blobs with identical worktree files and status", async t => {
  const f = await fixture(t), blob = path.join(f.root, "alternate.txt");
  await writeFile(blob, "staged A\n"); const first = await git(f.cwd, "hash-object", "-w", blob);
  await writeFile(blob, "staged B\n"); const second = await git(f.cwd, "hash-object", "-w", blob);
  await writeFile(path.join(f.cwd, "source.txt"), "unstaged constant\n");
  await git(f.cwd, "update-index", "--cacheinfo", `100644,${first},source.txt`);
  const before = await maintenanceFingerprint(f.workspace), status = await git(f.cwd, "status", "--porcelain=v1");
  await git(f.cwd, "update-index", "--cacheinfo", `100644,${second},source.txt`);
  assert.equal(await git(f.cwd, "status", "--porcelain=v1"), status);
  assert.equal(await readFile(path.join(f.cwd, "source.txt"), "utf8"), "unstaged constant\n");
  assert.notEqual(await maintenanceFingerprint(f.workspace), before);
});

for (const flag of ["assume-unchanged", "skip-worktree"]) test(`maintenance checkpoints cover ${flag} without file or status changes`, async t => {
  const f = await fixture(t), before = await maintenanceFingerprint(f.workspace), status = await git(f.cwd, "status", "--porcelain=v1");
  await git(f.cwd, "update-index", `--${flag}`, "source.txt");
  assert.equal(await git(f.cwd, "status", "--porcelain=v1"), status);
  assert.equal(await readFile(path.join(f.cwd, "source.txt"), "utf8"), "base\n");
  assert.notEqual(await maintenanceFingerprint(f.workspace), before);
});

test("maintenance checkpoints ignore only Codex's reserved turn-diff checkpoint refs", async t => {
  const f = await fixture(t), before = await maintenanceFingerprint(f.workspace);
  const reserved = "refs/codex/turn-diffs/checkpoints/fixture";
  await git(f.cwd, "update-ref", reserved, "HEAD"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(f.cwd, "update-ref", reserved, "HEAD~1"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(f.cwd, "update-ref", "-d", reserved); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(f.cwd, "update-ref", "refs/codex/turn-diffs/checkpoints-business/fixture", "HEAD");
  assert.notEqual(await maintenanceFingerprint(f.workspace), before);
});

test("submodule checkpoints include nested branches, refs and index flags while excluding only reserved host refs", async t => {
  const f = await fixture(t), moduleSource = path.join(f.root, "module-source"); await mkdir(moduleSource);
  await git(moduleSource, "init", "--quiet", "--initial-branch=main"); await writeFile(path.join(moduleSource, "module.txt"), "module fixture\n");
  await git(moduleSource, "add", "module.txt"); await git(moduleSource, "commit", "--quiet", "-m", "Add module source");
  await writeFile(path.join(moduleSource, "history.txt"), "module history\n"); await git(moduleSource, "add", "history.txt"); await git(moduleSource, "commit", "--quiet", "-m", "Add module history");
  await git(f.cwd, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", moduleSource, "deps/module");
  const nested = path.join(f.cwd, "deps", "module"), before = await maintenanceFingerprint(f.workspace), parentStatus = await git(f.cwd, "status", "--porcelain=v1");
  await git(nested, "checkout", "--quiet", "-b", "same-tree-module");
  assert.equal(await git(f.cwd, "status", "--porcelain=v1"), parentStatus); assert.notEqual(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "checkout", "--quiet", "main"); await git(nested, "branch", "-D", "same-tree-module"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "update-ref", "refs/remotes/fixture/main", "HEAD"); assert.notEqual(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "update-ref", "-d", "refs/remotes/fixture/main"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    await git(nested, "update-index", `--${flag}`, "module.txt");
    assert.equal(await git(f.cwd, "status", "--porcelain=v1"), parentStatus); assert.notEqual(await maintenanceFingerprint(f.workspace), before);
    await git(nested, "update-index", `--no-${flag}`, "module.txt"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  }
  const reserved = "refs/codex/turn-diffs/checkpoints/fixture";
  await git(nested, "update-ref", reserved, "HEAD"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "update-ref", reserved, "HEAD~1"); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "update-ref", "-d", reserved); assert.equal(await maintenanceFingerprint(f.workspace), before);
  await git(nested, "update-ref", "refs/codex/turn-diffs/checkpoints-business/fixture", "HEAD"); assert.notEqual(await maintenanceFingerprint(f.workspace), before);
});

test("maintenance checkpoint rejects Git state that changes while files are being captured", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), binaries = path.join(f.root, "bin"); await mkdir(binaries);
  const actualGit = (await exec("which", ["git"])).stdout.trim();
  const wrapper = path.join(binaries, "git-wrapper.mjs"), entry = path.join(binaries, "git");
  await writeFile(wrapper, `import {spawnSync} from "node:child_process"; const args=process.argv.slice(2); if(args.includes("status")){const changed=spawnSync(${JSON.stringify(actualGit)},["update-ref","refs/remotes/fixture/during-capture","HEAD"],{stdio:"inherit"}); if(changed.status!==0)process.exit(changed.status??1);} const result=spawnSync(${JSON.stringify(actualGit)},args,{stdio:"inherit"}); process.exit(result.status??1);\n`);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(entry, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} "$@"\n`); await chmod(entry, 0o700);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = binaries + path.delimiter + (previousPath ?? "");
    await assert.rejects(maintenanceFingerprint(f.workspace), /Git state changed during checkpoint hashing/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
  assert.equal(await git(f.cwd, "rev-parse", "refs/remotes/fixture/during-capture"), await git(f.cwd, "rev-parse", "HEAD"));
});
