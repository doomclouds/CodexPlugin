import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { applyMaintenance, createGitWorkspace, maintenanceFingerprint, reviewMaintenance, validateGitWorkspace } from "../src/maintenance.ts";
import { gitAwareContextDigest, inspectGitManifest, listGitlinks, readGitIndex } from "../src/submodules.ts";
import type { MaintenancePlan } from "../src/types.ts";

const exec = promisify(execFile);
const plan: MaintenancePlan = { steps: [{ id: "check", command: ["node", "--version"] }] };
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Workflow Test", GIT_AUTHOR_EMAIL: "workflow-test@example.invalid", GIT_COMMITTER_NAME: "Workflow Test", GIT_COMMITTER_EMAIL: "workflow-test@example.invalid", GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}
async function commit(directory: string, message: string): Promise<string> { await git(directory, "add", "--all"); await git(directory, "commit", "--quiet", "-m", message); return git(directory, "rev-parse", "HEAD"); }
async function repository(directory: string, file: string) {
  await mkdir(directory); await git(directory, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(directory, file), "original\n"); await writeFile(path.join(directory, ".gitignore"), "dist/\n"); await commit(directory, "Create fixture history");
  await writeFile(path.join(directory, file), "version one\n"); return commit(directory, "Advance fixture history");
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-submodules-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const leafRemote = path.join(root, "leaf-remote"), childRemote = path.join(root, "child-remote"), project = path.join(root, "project"), data = path.join(root, "run");
  const leafHead = await repository(leafRemote, "leaf.txt");
  await repository(childRemote, "child.txt"); await git(childRemote, "submodule", "add", "--quiet", leafRemote, "nested/leaf"); await commit(childRemote, "Add nested submodule");
  await repository(project, "main.txt"); await git(project, "submodule", "add", "--quiet", childRemote, "modules/child");
  await git(project, "submodule", "add", "--quiet", leafRemote, "deps/uninitialized"); await commit(project, "Add initialized and uninitialized submodules");
  const child = path.join(project, "modules", "child"), leaf = path.join(child, "nested", "leaf");
  await git(child, "submodule", "update", "--init", "--recursive"); await git(project, "submodule", "deinit", "--force", "--", "deps/uninitialized");
  const base = await git(project, "rev-parse", "HEAD");
  return { root, project, data, child, leaf, leafRemote, childRemote, base, leafHead };
}

test("Git-aware manifest preserves initialized, nested and uninitialized gitlinks without directory hashing", async t => {
  const { project, child, leaf, leafHead } = await fixture(t);
  assert.equal((await readGitIndex(project)).filter(entry => entry.mode === "160000").length, 2);
  assert.equal((await listGitlinks(project)).length, 2);
  const manifest = await inspectGitManifest(project, { requireClean: true });
  const uninitialized = manifest.submodules.find(item => item.path === "deps/uninitialized")!;
  assert.deepEqual(uninitialized, { path: "deps/uninitialized", commit: leafHead, initialized: false });
  const nested = manifest.submodules.find(item => item.path === "modules/child")!.manifest!.submodules[0]!;
  assert.equal(nested.initialized, true); assert.equal(nested.manifest!.head, leafHead);
  assert.equal(manifest.files.some(file => file.path === "modules/child"), false);
  const before = await gitAwareContextDigest(project);
  assert.equal(await gitAwareContextDigest(project), before);
  await writeFile(path.join(leaf, "leaf.txt"), "nested source changed\n");
  assert.notEqual(await gitAwareContextDigest(project), before);
  await git(leaf, "restore", "leaf.txt");
  await writeFile(path.join(child, "untracked.txt"), "new source\n");
  await assert.rejects(inspectGitManifest(project, { requireClean: true }), /dirty/);
});

test("independent checkout clones only initialized nested sources and never shares their metadata or objects", async t => {
  const { project, data, child, leaf, leafRemote, childRemote } = await fixture(t);
  const before = await gitAwareContextDigest(project);
  const refs = await git(project, "show-ref"), childRefs = await git(child, "show-ref"), leafRefs = await git(leaf, "show-ref");
  const workspace = await createGitWorkspace(project, data);
  const copyChild = path.join(workspace.root, "modules/child"), copyLeaf = path.join(copyChild, "nested/leaf");
  for (const directory of [workspace.root, copyChild, copyLeaf]) {
    assert.equal((await lstat(path.join(directory, ".git"))).isDirectory(), true);
    await assert.rejects(lstat(path.join(directory, ".git/objects/info/alternates")), { code: "ENOENT" });
  }
  assert.equal(await git(copyChild, "remote", "get-url", "origin"), childRemote);
  assert.equal(await git(copyLeaf, "remote", "get-url", "origin"), leafRemote);
  assert.equal(await git(copyLeaf, "rev-list", "--count", "HEAD"), "2");
  assert.notEqual(await realpath(path.join(copyChild, ".git")), await realpath(path.resolve(child, await git(child, "rev-parse", "--git-common-dir"))));
  assert.equal(await readFile(path.join(copyLeaf, "leaf.txt"), "utf8"), "version one\n");
  assert.deepEqual(await readdir(path.join(workspace.root, "deps/uninitialized")), []);
  assert.equal(await gitAwareContextDigest(project), before);
  assert.equal(await git(project, "show-ref"), refs); assert.equal(await git(child, "show-ref"), childRefs); assert.equal(await git(leaf, "show-ref"), leafRefs);
  await validateGitWorkspace(workspace);
});

test("dirty nested submodules are rejected even when repository settings hide all submodule changes", async t => {
  const { project, data, child, leaf } = await fixture(t);
  await git(project, "config", "submodule.modules/child.ignore", "all"); await git(child, "config", "submodule.nested/leaf.ignore", "all");
  await writeFile(path.join(leaf, "leaf.txt"), "dirty nested file\n");
  assert.equal(await git(project, "status", "--porcelain=v1"), "");
  await assert.rejects(createGitWorkspace(project, data), /clean|dirty/);
  await git(leaf, "restore", "leaf.txt"); await writeFile(path.join(leaf, "extra.txt"), "untracked\n");
  await assert.rejects(createGitWorkspace(project, data), /clean|dirty/);
});

test("uninitialized paths reject unmanaged data and symlinks instead of silently dropping them", async t => {
  const { project, root } = await fixture(t);
  const missing = path.join(project, "deps/uninitialized");
  await writeFile(path.join(missing, "unexpected.txt"), "unmanaged\n");
  await assert.rejects(gitAwareContextDigest(project), /unmanaged files/);
  await rm(missing, { recursive: true }); await symlink(root, missing);
  await assert.rejects(gitAwareContextDigest(project), /safe directory/);
});

test("review and checkpoint pin ignored artifacts inside nested initialized submodules", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createGitWorkspace(project, data), directory = path.join(workspace.root, "modules/child/nested/leaf/dist");
  await mkdir(directory); await writeFile(path.join(directory, "built.mjs"), "first build\n");
  const review = await reviewMaintenance(workspace, plan), checkpoint = await maintenanceFingerprint(workspace);
  assert.ok(review.artifacts.some(file => file.path === "modules/child/nested/leaf/dist/built.mjs"));
  assert.equal(review.preparedClean, true);
  assert.ok(review.submodules?.some(item => item.path === "deps/uninitialized" && item.initialized === false));
  await writeFile(path.join(directory, "built.mjs"), "changed build\n");
  assert.notEqual(await maintenanceFingerprint(workspace), checkpoint);
  await assert.rejects(applyMaintenance(workspace, review, plan), /changed since review/);
});

test("reviewed parent and nested gitlink commits apply locally while uninitialized modules stay uninitialized", async t => {
  const { project, data, child, leaf } = await fixture(t);
  const workspace = await createGitWorkspace(project, data), copyChild = path.join(workspace.root, "modules/child"), copyLeaf = path.join(copyChild, "nested/leaf");
  await writeFile(path.join(copyLeaf, "leaf.txt"), "reviewed leaf update\n"); const leafTarget = await commit(copyLeaf, "Advance nested submodule");
  const childTarget = await commit(copyChild, "Pin reviewed nested commit"); const target = await commit(workspace.root, "Pin reviewed child commit");
  const review = await reviewMaintenance(workspace, plan);
  assert.equal(review.preparedClean, true);
  const applied = await applyMaintenance(workspace, review, plan);
  assert.deepEqual(applied, { applied: true, conflicts: [] });
  assert.equal(await git(project, "rev-parse", "HEAD"), target); assert.equal(await git(child, "rev-parse", "HEAD"), childTarget); assert.equal(await git(leaf, "rev-parse", "HEAD"), leafTarget);
  assert.equal(await git(project, "status", "--porcelain=v1", "--ignore-submodules=none"), "");
  assert.deepEqual(await readdir(path.join(project, "deps/uninitialized")), []);
  assert.deepEqual(await applyMaintenance(workspace, review, plan), { applied: true, conflicts: [] });
  await writeFile(path.join(leaf, "leaf.txt"), "user edited after apply\n");
  const rejected = await applyMaintenance(workspace, review, plan);
  assert.equal(rejected.partial, true); assert.equal(rejected.applied, true); assert.match(rejected.error!, /local changes/);
  assert.equal(await readFile(path.join(leaf, "leaf.txt"), "utf8"), "user edited after apply\n");
});

test("missing prepared child commits refuse before changing the original parent", async t => {
  const { project, data, base } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  await git(workspace.root, "rm", "--force", "modules/child"); await commit(workspace.root, "Remove initialized child");
  const result = await applyMaintenance(workspace, await reviewMaintenance(workspace, plan), plan);
  assert.equal(result.applied, false); assert.match(result.error!, /missing from the prepared target/);
  assert.equal(await git(project, "rev-parse", "HEAD"), base);
});

test("partial submodule application is durable and refuses to overwrite ignored source data", async t => {
  const { project, data, child } = await fixture(t);
  const workspace = await createGitWorkspace(project, data), copyChild = path.join(workspace.root, "modules/child");
  await mkdir(path.join(copyChild, "dist")); await writeFile(path.join(copyChild, "dist/owned.txt"), "reviewed source\n");
  await git(copyChild, "add", "--force", "dist/owned.txt"); await git(copyChild, "commit", "--quiet", "-m", "Track previously ignored file");
  const target = await commit(workspace.root, "Advance child gitlink");
  await mkdir(path.join(child, "dist")); await writeFile(path.join(child, "dist/owned.txt"), "user ignored output\n");
  const review = await reviewMaintenance(workspace, plan), first = await applyMaintenance(workspace, review, plan);
  assert.equal(first.applied, true); assert.equal(first.partial, true); assert.deepEqual(first.conflicts, ["submodule-application"]);
  assert.equal(await git(project, "rev-parse", "HEAD"), target); assert.equal(await readFile(path.join(child, "dist/owned.txt"), "utf8"), "user ignored output\n");
  assert.equal((await lstat(path.join(data, "submodule-apply-journal.json"))).mode & 0o777, 0o600);
  const second = await applyMaintenance(workspace, review, plan); assert.equal(second.partial, true);
  await rm(path.join(child, "dist/owned.txt"));
  assert.deepEqual(await applyMaintenance(workspace, review, plan), { applied: true, conflicts: [] });
  assert.equal(await readFile(path.join(child, "dist/owned.txt"), "utf8"), "reviewed source\n");
});

test("changing initialization after preparation invalidates the source baseline", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  await git(project, "submodule", "update", "--init", "--", "deps/uninitialized");
  await assert.rejects(validateGitWorkspace(workspace), /submodule state changed/);
});

test("explicit initialization accepts child gitfiles inside the owned checkout and rejects external metadata or alternates", async t => {
  const { project, data, root, leafRemote } = await fixture(t);
  const workspace = await createGitWorkspace(project, data), child = path.join(workspace.root, "deps/uninitialized");
  await git(workspace.root, "submodule", "update", "--init", "--", "deps/uninitialized");
  assert.equal((await lstat(path.join(child, ".git"))).isFile(), true);
  const manifest = await inspectGitManifest(workspace.root, { requireClean: true, enforceOwnedMetadata: true });
  assert.equal(manifest.submodules.find(item => item.path === "deps/uninitialized")!.initialized, true);
  assert.equal((await reviewMaintenance(workspace, plan)).preparedClean, true);
  const externalMetadata = await realpath(path.join(leafRemote, ".git")), gitfile = path.join(child, ".git"), originalGitfile = await readFile(gitfile, "utf8");
  await writeFile(gitfile, `gitdir: ${externalMetadata}\n`);
  await git(leafRemote, "config", "core.worktree", child);
  await assert.rejects(inspectGitManifest(workspace.root, { enforceOwnedMetadata: true }), /owned metadata/);
  await writeFile(gitfile, originalGitfile); await git(leafRemote, "config", "--unset", "core.worktree");
  const common = await realpath(path.resolve(child, await git(child, "rev-parse", "--git-common-dir")));
  await mkdir(path.join(common, "objects/info"), { recursive: true });
  await writeFile(path.join(common, "objects/info/alternates"), path.join(root, "leaf-remote/.git/objects") + "\n");
  await assert.rejects(inspectGitManifest(workspace.root, { enforceOwnedMetadata: true }), /alternate object storage/);
});

test("host preparation and application disable global recursive submodule transport", async t => {
  const { project, root, data } = await fixture(t);
  await git(project, "config", "--file", ".gitmodules", "submodule.deps/uninitialized.url", path.join(root, "missing-remote"));
  await commit(project, "Declare inaccessible uninitialized remote");
  const config = path.join(root, "global-config"); await writeFile(config, "[submodule]\nrecurse = true\n[fetch]\nrecurseSubmodules = true\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    const workspace = await createGitWorkspace(project, data);
    await writeFile(path.join(workspace.root, "main.txt"), "parent update only\n"); await commit(workspace.root, "Advance parent only");
    assert.deepEqual(await applyMaintenance(workspace, await reviewMaintenance(workspace, plan), plan), { applied: true, conflicts: [] });
    assert.deepEqual(await readdir(path.join(project, "deps/uninitialized")), []);
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});

test("host Git preparation and application do not run configured content filters or filesystem monitors", async t => {
  const { project, root, data } = await fixture(t);
  await writeFile(path.join(project, ".gitattributes"), "*.txt filter=unexpected\n"); await commit(project, "Declare content filter");
  const marker = path.join(root, "unexpected-command"), script = path.join(root, "unexpected-filter.mjs");
  await writeFile(script, 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(marker) + ', "unexpected"); process.stdin.pipe(process.stdout);\n');
  const config = path.join(root, "global-config"), previous = process.env.GIT_CONFIG_GLOBAL;
  await writeFile(config, `[filter "unexpected"]\nsmudge = node ${JSON.stringify(script)}\nrequired = true\n[core]\nfsmonitor = node ${JSON.stringify(script)}\n`);
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    const workspace = await createGitWorkspace(project, data);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await writeFile(path.join(workspace.root, "main.txt"), "reviewed filtered source\n");
    // Fixture commands also disable the monitor; the host's helper must suppress it independently.
    await git(workspace.root, "-c", "core.fsmonitor=false", "-c", "filter.unexpected.required=false", "add", "--all");
    await git(workspace.root, "-c", "core.fsmonitor=false", "-c", "filter.unexpected.required=false", "commit", "--quiet", "-m", "Advance filtered source");
    assert.deepEqual(await applyMaintenance(workspace, await reviewMaintenance(workspace, plan), plan), { applied: true, conflicts: [] });
    await assert.rejects(lstat(marker), { code: "ENOENT" });
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});
