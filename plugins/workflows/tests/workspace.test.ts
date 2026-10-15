import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { applyWorkspace, createWorkspace, workspaceDiff } from "../src/workspace.ts";
import { requireFileSymlinks } from "./fixtures/symlink.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-workspace-test-"));
  const project = path.join(root, "project");
  const data = path.join(root, "private");
  await mkdir(project);
  await mkdir(path.join(project, "folder"));
  await exec("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "tracked.txt"), "original\n");
  await writeFile(path.join(project, "delete.txt"), "delete me\n");
  await writeFile(path.join(project, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(project, "folder", "nested.txt"), "nested original\n");
  await writeFile(path.join(project, ".gitignore"), "generated/\nobj/\nnode_modules/\n*.log\n");
  await exec("git", ["add", "--", ".gitignore", "tracked.txt", "delete.txt", "binary.dat", "folder/nested.txt"], { cwd: project });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, project, data };
}

test("the snapshot retains dirty tracked and untracked files without source Git metadata", async t => {
  const { project, data } = await fixture(t);
  await writeFile(path.join(project, "tracked.txt"), "dirty current contents\n");
  await writeFile(path.join(project, "untracked.txt"), "untracked current contents\n");
  await rm(path.join(project, "delete.txt"));
  await exec("git", ["config", "remote.origin.url", "https://example.invalid/private-fixture.git"], { cwd: project });
  const workspace = await createWorkspace(project, data);
  assert.equal(await readFile(path.join(workspace.root, "tracked.txt"), "utf8"), "dirty current contents\n");
  assert.equal(await readFile(path.join(workspace.root, "untracked.txt"), "utf8"), "untracked current contents\n");
  assert.equal(workspace.baseline["delete.txt"], undefined);
  await assert.rejects(exec("git", ["config", "--get", "remote.origin.url"], { cwd: workspace.root }));
  assert.deepEqual((await workspaceDiff(workspace)).files, []);
});

test("POSIX backslashes remain literal filenames throughout snapshot and application", { skip: process.platform === "win32" }, async t => {
  const { project, data } = await fixture(t);
  const name = "literal\\name.txt";
  await writeFile(path.join(project, name), "literal baseline\n");
  const workspace = await createWorkspace(project, data);
  assert.equal(await readFile(path.join(workspace.root, name), "utf8"), "literal baseline\n");
  await assert.rejects(access(path.join(workspace.root, "literal")), { code: "ENOENT" });
  await writeFile(path.join(workspace.root, name), "literal update\n");
  const reviewed = await workspaceDiff(workspace);
  assert.deepEqual(reviewed.files, [{ path: name, status: "modified" }]);
  assert.equal((await applyWorkspace(workspace, reviewed)).applied, true);
  assert.equal(await readFile(path.join(project, name), "utf8"), "literal update\n");
  await assert.rejects(access(path.join(project, "literal")), { code: "ENOENT" });
});

test("binary changes, deletion and newly added files are reviewed and applied exactly", async t => {
  const { project, data } = await fixture(t);
  await writeFile(path.join(project, "untracked.txt"), "retained untracked\n");
  const workspace = await createWorkspace(project, data);
  const binary = Buffer.from([0, 4, 5, 255, 128, 0]);
  const added = Buffer.from([0, 65, 0, 66]);
  await writeFile(path.join(workspace.root, "binary.dat"), binary);
  await rm(path.join(workspace.root, "delete.txt"));
  await writeFile(path.join(workspace.root, "new.bin"), added);
  await writeFile(path.join(workspace.root, "untracked.txt"), "updated untracked\n");
  const reviewed = await workspaceDiff(workspace);
  assert.deepEqual(reviewed.files, [
    { path: "binary.dat", status: "modified" }, { path: "delete.txt", status: "deleted" },
    { path: "new.bin", status: "added" }, { path: "untracked.txt", status: "modified" },
  ]);
  assert.match(reviewed.text, /GIT binary patch/);
  const result = await applyWorkspace(workspace, reviewed);
  assert.equal(result.applied, true);
  assert.deepEqual(await readFile(path.join(project, "binary.dat")), binary);
  assert.deepEqual(await readFile(path.join(project, "new.bin")), added);
  await assert.rejects(access(path.join(project, "delete.txt")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(project, "untracked.txt"), "utf8"), "updated untracked\n");
});

test("a project conflict applies no reviewed files and creates no directories", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createWorkspace(project, data);
  await writeFile(path.join(workspace.root, "tracked.txt"), "worker change\n");
  await mkdir(path.join(workspace.root, "new-directory"));
  await writeFile(path.join(workspace.root, "new-directory", "new.txt"), "new worker file\n");
  const reviewed = await workspaceDiff(workspace);
  await writeFile(path.join(project, "tracked.txt"), "user change after snapshot\n");
  const result = await applyWorkspace(workspace, reviewed);
  assert.deepEqual(result, { applied: false, conflicts: ["tracked.txt"] });
  assert.equal(await readFile(path.join(project, "tracked.txt"), "utf8"), "user change after snapshot\n");
  await assert.rejects(access(path.join(project, "new-directory")), { code: "ENOENT" });
});

test("a workspace changed after review cannot be applied with the old fingerprint", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createWorkspace(project, data);
  await writeFile(path.join(workspace.root, "tracked.txt"), "reviewed contents\n");
  const reviewed = await workspaceDiff(workspace);
  await writeFile(path.join(workspace.root, "tracked.txt"), "unreviewed contents\n");
  await assert.rejects(applyWorkspace(workspace, reviewed), /changed since final review/);
  assert.equal(await readFile(path.join(project, "tracked.txt"), "utf8"), "original\n");
});

test("ignored test and dependency output is excluded while tracked ignored files remain reviewable", async t => {
  const { project, data } = await fixture(t);
  await writeFile(path.join(project, "tracked.log"), "tracked log baseline\n");
  await exec("git", ["add", "--force", "--", "tracked.log"], { cwd: project });
  const workspace = await createWorkspace(project, data);
  for (const directory of ["generated", "obj", "node_modules"]) {
    await mkdir(path.join(workspace.root, directory));
    await writeFile(path.join(workspace.root, directory, "result.txt"), "ignored build product\n");
  }
  await writeFile(path.join(workspace.root, "tracked.log"), "modified tracked log\n");
  const reviewed = await workspaceDiff(workspace);
  assert.deepEqual(reviewed.files, [{ path: "tracked.log", status: "modified" }]);
  assert.equal((await applyWorkspace(workspace, reviewed)).applied, true);
  assert.equal(await readFile(path.join(project, "tracked.log"), "utf8"), "modified tracked log\n");
  await assert.rejects(access(path.join(project, "node_modules")), { code: "ENOENT" });
});

test("internal symbolic links are copied and applied as links", async t => {
  const { root, project, data } = await fixture(t);
  if (!(await requireFileSymlinks(t, root))) return;
  await symlink("tracked.txt", path.join(project, "internal-link"));
  const workspace = await createWorkspace(project, data);
  assert.equal((await lstat(path.join(workspace.root, "internal-link"))).isSymbolicLink(), true);
  assert.equal(await readlink(path.join(workspace.root, "internal-link")), "tracked.txt");
  await rm(path.join(workspace.root, "internal-link"));
  await symlink("binary.dat", path.join(workspace.root, "internal-link"));
  const reviewed = await workspaceDiff(workspace);
  assert.deepEqual(reviewed.files, [{ path: "internal-link", status: "modified" }]);
  assert.equal((await applyWorkspace(workspace, reviewed)).applied, true);
  assert.equal(await readlink(path.join(project, "internal-link")), "binary.dat");
});

test("external symbolic links are rejected before source contents can enter the snapshot", async t => {
  const { root, project, data } = await fixture(t);
  if (!(await requireFileSymlinks(t, root))) return;
  await writeFile(path.join(root, "outside.txt"), "outside fixture data\n");
  await symlink("../outside.txt", path.join(project, "external-link"));
  await assert.rejects(createWorkspace(project, data), /symbolic link|unsafe.*parent/i);
});

test("a tracked source path under an external symlinked parent is never copied", async t => {
  const { root, project, data } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "nested.txt"), "outside fixture data\n");
  // Hide the symlink leaf from git's untracked list while the nested tracked path remains.
  await writeFile(path.join(project, ".gitignore"), "folder\n");
  await rm(path.join(project, "folder"), { recursive: true });
  await symlink(outside, path.join(project, "folder"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createWorkspace(project, data), /symbolic link|unsafe.*parent/i);
});

test("application never follows a project parent replaced by an external symbolic link", async t => {
  const { root, project, data } = await fixture(t);
  const workspace = await createWorkspace(project, data);
  await writeFile(path.join(workspace.root, "folder", "nested.txt"), "worker changed nested file\n");
  const reviewed = await workspaceDiff(workspace);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "nested.txt"), "outside untouched\n");
  await rm(path.join(project, "folder"), { recursive: true });
  await symlink(outside, path.join(project, "folder"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(applyWorkspace(workspace, reviewed), /unsafe.*parent|symbolic link/i);
  assert.equal(await readFile(path.join(outside, "nested.txt"), "utf8"), "outside untouched\n");
});

test("stored paths cannot escape the workspace or address Git metadata", async t => {
  const { project, data } = await fixture(t);
  for (const unsafe of ["../outside.txt", ".git/config", path.join(project, "tracked.txt")]) {
    const workspace = await createWorkspace(project, data);
    workspace.baseline[unsafe] = workspace.baseline["tracked.txt"]!;
    await assert.rejects(workspaceDiff(workspace), /unsafe.*path|escapes root/i);
  }
});

test("snapshot mode refuses a real Git submodule before creating an incomplete workspace", async t => {
  const {root,project,data}=await fixture(t);
  const child=path.join(root,"child-source");await mkdir(child);
  await exec("git",["init","--quiet"],{cwd:child});
  await writeFile(path.join(child,"component.txt"),"real child source\n");
  await exec("git",["add","-A"],{cwd:child});
  await exec("git",["-c","user.name=Workflow Test","-c","user.email=workflow-test@example.invalid","commit","--quiet","-m","Add child fixture"],{cwd:child});
  await exec("git",["-c","core.autocrlf=false","-c","core.eol=lf","-c","protocol.file.allow=always","submodule","add","--quiet",child,"third_party/component"],{cwd:project});
  await assert.rejects(createWorkspace(project,data),/Snapshot writing.*submodules.*git-worktree/);
  await assert.rejects(access(path.join(data,"workspace")),{code:"ENOENT"});
  assert.equal(await readFile(path.join(project,"third_party/component/component.txt"),"utf8"),"real child source\n");
});
