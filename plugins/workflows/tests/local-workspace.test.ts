import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createLocalWorkspace, localWorkspaceDiff, localWorkspaceFingerprint, validateLocalWorkspace } from "../src/local-workspace.ts";
const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-test-")));
  const project = path.join(root, "project"), run = path.join(root, "state", "run");
  await mkdir(project); await mkdir(run, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, run };
}
async function git(project: string, args: string[]) { return (await exec("git", args, { cwd: project, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout; }
async function commit(project: string) { await git(project, ["add", "--all"]); await git(project, ["-c", "user.name=Workflow Fixture", "-c", "user.email=workflow@example.invalid", "commit", "--quiet", "-m", "Add fixture"]); }

test("local non-Git baseline uses current contents and reports actual original-project writes", async t => {
  const { project, run } = await fixture(t);
  await writeFile(path.join(project, "keep.txt"), "existing user edits\n");
  await writeFile(path.join(project, "change.txt"), "dirty baseline\n");
  await writeFile(path.join(project, "remove.txt"), "original\n");
  const workspace = await createLocalWorkspace(project, run);
  assert.equal(workspace.root, project); assert.equal(workspace.original, project);
  assert.equal(workspace.baselineRoot, path.join(run, "local-baseline"));
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, []);
  await writeFile(path.join(project, "change.txt"), "changed by worker\n");
  await writeFile(path.join(project, "add.txt"), "new file\n"); await rm(path.join(project, "remove.txt"));
  const diff = await localWorkspaceDiff(workspace);
  assert.deepEqual(diff.files, [{ path: "add.txt", status: "added" }, { path: "change.txt", status: "modified" }, { path: "remove.txt", status: "deleted" }]);
  assert.match(diff.text, /dirty baseline/); assert.match(diff.text, /changed by worker/); assert.equal(diff.previewTruncated, false);
  assert.equal(await readFile(path.join(project, "keep.txt"), "utf8"), "existing user edits\n");
  assert.equal((await readdir(project)).includes(".git"), false);
});

test("unborn Git preserves staged and dirty state while ignored output changes invalidate checkpoints", async t => {
  const { project, run } = await fixture(t);
  await git(project, ["init", "--quiet"]);
  await writeFile(path.join(project, ".gitignore"), "build/\n");
  await writeFile(path.join(project, "staged.txt"), "staged contents\n"); await git(project, ["add", "--all"]);
  await writeFile(path.join(project, "staged.txt"), "dirty user contents\n");
  await mkdir(path.join(project, "build")); await writeFile(path.join(project, "build", "artifact.txt"), "old artifact\n");
  const beforeIndex = await readFile(path.join(project, ".git", "index"));
  const beforeConfig = await readFile(path.join(project, ".git", "config"));
  const workspace = await createLocalWorkspace(project, run);
  assert.equal(workspace.baseline["build/artifact.txt"], undefined);
  assert.equal(await readFile(path.join(workspace.baselineRoot!, "staged.txt"), "utf8"), "dirty user contents\n");
  const first = await localWorkspaceFingerprint(workspace);
  await writeFile(path.join(project, "build", "artifact.txt"), "new artifact\n");
  assert.notEqual(first, await localWorkspaceFingerprint(workspace));
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, []);
  assert.deepEqual(await readFile(path.join(project, ".git", "index")), beforeIndex);
  assert.deepEqual(await readFile(path.join(project, ".git", "config")), beforeConfig);
});

test("linked Git worktrees retain their existing external metadata and expose code changes", async t => {
  const { root, project, run } = await fixture(t);
  await git(project, ["init", "--quiet"]); await writeFile(path.join(project, "code.txt"), "base\n"); await commit(project);
  const linked = path.join(root, "linked"); await git(project, ["worktree", "add", "--quiet", "-b", "local-fixture", linked]);
  const metadata = await readFile(path.join(linked, ".git"));
  const workspace = await createLocalWorkspace(linked, run); await localWorkspaceFingerprint(workspace);
  await writeFile(path.join(linked, "code.txt"), "local change\n");
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, [{ path: "code.txt", status: "modified" }]);
  assert.deepEqual(await readFile(path.join(linked, ".git")), metadata);
});

test("initialized and uninitialized Git submodules retain state and track nested source modifications", async t => {
  const { root, project, run } = await fixture(t), child = path.join(root, "child");
  await mkdir(child); await git(child, ["init", "--quiet"]); await writeFile(path.join(child, "child.txt"), "child base\n"); await commit(child);
  await git(project, ["init", "--quiet"]);
  await git(project, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "modules/child"]); await commit(project);
  await git(project, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "modules/lazy"]); await commit(project);
  await git(project, ["submodule", "deinit", "--force", "--", "modules/lazy"]);
  const workspace = await createLocalWorkspace(project, run);
  assert.ok(workspace.baseline["modules/child/child.txt"]); assert.equal(workspace.baseline["modules/lazy/child.txt"], undefined);
  const before = await localWorkspaceFingerprint(workspace);
  await writeFile(path.join(project, "modules", "child", "child.txt"), "nested changed\n");
  assert.notEqual(before, await localWorkspaceFingerprint(workspace));
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, [{ path: "modules/child/child.txt", status: "modified" }]);
  assert.deepEqual(await readdir(path.join(project, "modules", "lazy")), []);
});

test("local workspace validates project identity, owned baseline paths, and disjoint storage", async t => {
  const { root, project, run } = await fixture(t);
  await writeFile(path.join(project, "code.txt"), "base"); const workspace = await createLocalWorkspace(project, run);
  await assert.rejects(validateLocalWorkspace({ ...workspace, baselineRoot: project }, project, run), /paths do not match/);
  await assert.rejects(validateLocalWorkspace({ ...workspace, rootIdentity: { dev: -1, ino: -1 } }, project, run), /identity changed/);
  const nested = path.join(project, "state", "run"); await mkdir(nested, { recursive: true });
  await assert.rejects(createLocalWorkspace(project, nested), /must not overlap/);
  await rename(project, path.join(root, "old-project")); await mkdir(project);
  await assert.rejects(validateLocalWorkspace(workspace, project, run), /identity changed/);
});

test("external symlinks and tampered baseline contents fail closed without reading or replacing the target", async t => {
  const { root, project, run } = await fixture(t);
  await writeFile(path.join(project, "code.txt"), "base"); const workspace = await createLocalWorkspace(project, run);
  await writeFile(path.join(workspace.baselineRoot!, "code.txt"), "tampered");
  await assert.rejects(localWorkspaceFingerprint(workspace), /baseline contents changed/);
  await writeFile(path.join(root, "outside.txt"), "private marker"); await symlink("../outside.txt", path.join(project, "external"));
  const otherRun = path.join(root, "state", "other"); await mkdir(otherRun);
  await assert.rejects(createLocalWorkspace(project, otherRun), /symbolic link/);
  assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "private marker");
});

test("large local diffs retain a bounded text preview and complete changed-file manifest", async t => {
  const { project, run } = await fixture(t);
  await writeFile(path.join(project, "large.txt"), "base\n"); const workspace = await createLocalWorkspace(project, run);
  await writeFile(path.join(project, "large.txt"), "a".repeat(5 * 1024 * 1024) + "\n");
  await writeFile(path.join(project, "z-final.txt"), "complete manifest\n");
  const diff = await localWorkspaceDiff(workspace);
  assert.equal(diff.previewTruncated, true); assert.ok(Buffer.byteLength(diff.text) <= 4 * 1024 * 1024);
  assert.ok(diff.totalBytes! > 5 * 1024 * 1024); assert.match(diff.contentSha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(diff.files.map(file => file.path), ["large.txt", "z-final.txt"]);
});

test("dirty Git baselines accept deleted tracked files whose parent directories were also removed", async t => {
  const { project, run } = await fixture(t);
  await git(project, ["init", "--quiet"]); await mkdir(path.join(project, "removed"));
  await writeFile(path.join(project, "removed", "tracked.txt"), "tracked\n"); await commit(project);
  await rm(path.join(project, "removed"), { recursive: true });
  const workspace = await createLocalWorkspace(project, run);
  assert.equal(workspace.baseline["removed/tracked.txt"], undefined);
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, []);
  await localWorkspaceFingerprint(workspace);
});

test("changing ignore rules cannot hide existing baseline files or manufacture their deletion", async t => {
  const { project, run } = await fixture(t);
  await git(project, ["init", "--quiet"]); await writeFile(path.join(project, ".gitignore"), "build/\n");
  await git(project, ["add", ".gitignore"]); await writeFile(path.join(project, "untracked.txt"), "initial user file\n");
  const workspace = await createLocalWorkspace(project, run);
  await writeFile(path.join(project, ".gitignore"), "build/\nuntracked.txt\n");
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, [{ path: ".gitignore", status: "modified" }]);
  await writeFile(path.join(project, "untracked.txt"), "modified despite new ignore rule\n");
  await mkdir(path.join(project, "build")); await writeFile(path.join(project, "build", "new.txt"), "new ignored output\n");
  const diff = await localWorkspaceDiff(workspace);
  assert.deepEqual(diff.files, [{ path: ".gitignore", status: "modified" }, { path: "untracked.txt", status: "modified" }]);
  assert.match(diff.text, /modified despite new ignore rule/);
  const before = await localWorkspaceFingerprint(workspace);
  await writeFile(path.join(project, "build", "new.txt"), "changed ignored output\n");
  assert.notEqual(before, await localWorkspaceFingerprint(workspace));
});

test("local checkpoints notice Git branch, staged-content, and submodule commit changes even without source diffs", async t => {
  const { root, project, run } = await fixture(t), child = path.join(root, "child");
  await mkdir(child); await git(child, ["init", "--quiet"]); await writeFile(path.join(child, "child.txt"), "source\n"); await commit(child);
  await git(project, ["init", "--quiet"]); await writeFile(path.join(project, "code.txt"), "source\n");
  await git(project, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "child"]); await commit(project);
  const workspace = await createLocalWorkspace(project, run);
  const initial = await localWorkspaceFingerprint(workspace);
  await git(project, ["checkout", "--quiet", "-b", "new-branch"]);
  const branched = await localWorkspaceFingerprint(workspace); assert.notEqual(initial, branched);
  await git(path.join(project, "child"), ["-c", "user.name=Workflow Fixture", "-c", "user.email=workflow@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Same tree new commit"]);
  const advanced = await localWorkspaceFingerprint(workspace); assert.notEqual(branched, advanced);
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, []);
  await writeFile(path.join(project, "code.txt"), "staged new content\n"); await git(project, ["add", "code.txt"]);
  await writeFile(path.join(project, "code.txt"), "source\n");
  assert.notEqual(advanced, await localWorkspaceFingerprint(workspace));
  assert.deepEqual((await localWorkspaceDiff(workspace)).files, []);
});

test("local creation refuses external worktrees whose Git metadata belongs to workflow storage", async t => {
  const { root, project, run } = await fixture(t), ownedRepository = path.join(root, "state", "owned-repository");
  await mkdir(ownedRepository); await git(ownedRepository, ["init", "--quiet"]);
  await writeFile(path.join(ownedRepository, "code.txt"), "owned checkout source\n"); await commit(ownedRepository);
  await rm(project, { recursive: true });
  await git(ownedRepository, ["worktree", "add", "--quiet", "-b", "external-local", project]);
  const projectMetadata = await readFile(path.join(project, ".git"));
  const ownedHead = await readFile(path.join(ownedRepository, ".git", "HEAD"));
  await assert.rejects(createLocalWorkspace(project, run), /Git metadata depends on workflow-owned data/);
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "owned checkout source\n");
  assert.deepEqual(await readFile(path.join(project, ".git")), projectMetadata);
  assert.deepEqual(await readFile(path.join(ownedRepository, ".git", "HEAD")), ownedHead);
  assert.deepEqual(await readdir(run), []);
});

test("runtime validation refuses Git metadata redirected into workflow storage after baseline creation", async t => {
  const { root, project, run } = await fixture(t);
  await git(project, ["init", "--quiet"]); await writeFile(path.join(project, "code.txt"), "independent source\n"); await commit(project);
  const workspace = await createLocalWorkspace(project, run);
  const movedMetadata = path.join(root, "state", "retained-git"); await rename(path.join(project, ".git"), movedMetadata);
  await writeFile(path.join(project, ".git"), `gitdir: ${movedMetadata}\n`);
  await assert.rejects(validateLocalWorkspace(workspace, project, run), /Git metadata depends on workflow-owned data/);
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "independent source\n");
});

test("non-Git projects cannot silently exclude nested repository metadata from recovery checkpoints", async t => {
  const { project, run } = await fixture(t);
  await writeFile(path.join(project, "code.txt"), "existing source\n");
  const workspace = await createLocalWorkspace(project, run), nested = path.join(project, "nested");
  await mkdir(nested); await git(nested, ["init", "--quiet"]);
  const head = await readFile(path.join(nested, ".git", "HEAD"));
  await assert.rejects(localWorkspaceFingerprint(workspace), /Unregistered nested Git repositories/);
  await assert.rejects(createLocalWorkspace(project, run), /Unregistered nested Git repositories/);
  assert.equal(await readFile(path.join(project, "code.txt"), "utf8"), "existing source\n");
  assert.deepEqual(await readFile(path.join(nested, ".git", "HEAD")), head);
});
