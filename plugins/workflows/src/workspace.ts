import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { Diff, FileRecord, Workspace } from "./types.ts";
import { listGitlinks } from "./submodules.ts";
import { constants } from "node:fs";
import { trackProjectTemporary } from "./project-temps.ts";

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function resolveFile(root: string, name: string) {
  if (!name || name.includes("\0") || name.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error(`Unsafe workspace path: ${name}`);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error(`Workspace path escapes root: ${name}`);
  return target;
}
async function record(root: string, name: string): Promise<FileRecord | undefined> {
  await safeParents(root, name, false);
  const target = resolveFile(root, name);
  let stat;
  try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) {
    const value = await readlink(target);
    const destination = path.resolve(path.dirname(target), value);
    if (path.isAbsolute(value) || !destination.startsWith(root + path.sep)) throw new Error(`External symbolic link is unsupported: ${name}`);
    return { hash: hash(value), kind: "link", mode: stat.mode & 0o777 };
  }
  if (!stat.isFile()) throw new Error(`Unsupported workspace entry: ${name}`);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`Workspace file exceeds 16 MiB: ${name}`);
  return { hash: hash(await readFile(target)), kind: "file", mode: stat.mode & 0o777 };
}
async function safeParents(root: string, name: string, create = true) {
  const pieces = name.split(process.platform === "win32" ? /[\\/]/ : "/").slice(0, -1);
  let directory = root;
  for (const piece of pieces) {
    directory = path.join(directory, piece);
    try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (create) await mkdir(directory); else return; }
  }
}
async function copyEntry(source: string, destination: string, name: string, entry: FileRecord) {
  await safeParents(source, name, false);
  await safeParents(destination, name);
  const target = resolveFile(destination, name);
  await rm(target, { force: true });
  if (entry.kind === "link") await symlink(await readlink(resolveFile(source, name)), target);
  else { await copyFile(resolveFile(source, name), target); await chmod(target, entry.mode); }
}
async function replaceEntry(source: string, destination: string, name: string, entry: FileRecord, transaction: string) {
  await safeParents(source, name, false);
  await safeParents(destination, name);
  const target = resolveFile(destination, name);
  const temporary = `${target}.wf-${randomBytes(8).toString("hex")}.tmp`;
  const descriptor = { path: path.relative(destination, temporary), target: name, expected: entry };
  await trackProjectTemporary(transaction, destination, descriptor);
  let identity: { dev: number; ino: number } | undefined;
  try {
    if (entry.kind === "link") await symlink(await readlink(resolveFile(source, name)), temporary);
    else { await copyFile(resolveFile(source, name), temporary, constants.COPYFILE_EXCL); await chmod(temporary, entry.mode); }
    const stat = await lstat(temporary); identity = { dev: stat.dev, ino: stat.ino };
    await trackProjectTemporary(transaction, destination, { ...descriptor, ...identity });
    await rename(temporary, target);
  } finally {
    if (identity) { try { const stat = await lstat(temporary); if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("Project temporary ownership changed during application"); await rm(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
export async function projectFiles(project: string) {
  const { stdout } = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return [...new Set(stdout.split("\0").filter(Boolean))].filter(name => !name.startsWith(".workflow-data/")).sort();
}
export async function contextDigest(project: string) {
  const files = await projectFiles(project);
  const records = await Promise.all(files.map(async name => [name, await record(project, name)]));
  return hash(JSON.stringify(records));
}
export async function createWorkspace(project: string, directory: string): Promise<Workspace> {
  const canonical = await realpath(project);
  const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonical });
  if (await realpath(stdout.trim()) !== canonical) throw new Error("Writing workflows require the Git repository root as projectPath");
  const gitlinks = await listGitlinks(canonical);
  if (gitlinks.length) throw new Error("Snapshot writing does not copy Git submodules. Create a new preview with workspaceMode: git-worktree to retain their commit and initialization state.");
  const root = path.join(directory, "workspace");
  const base = path.join(directory, "baseline");
  // This function only creates an unconfirmed snapshot. Retained workspaces are resumed without calling it.
  // A cancelled preparation must never contribute stale files to the next snapshot.
  await rm(root, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseline: Record<string, FileRecord> = {};
  let size = 0;
  for (const name of await projectFiles(canonical)) {
    const entry = await record(canonical, name);
    if (!entry) continue;
    size += (await lstat(resolveFile(canonical, name))).size;
    if (size > 256 * 1024 * 1024) throw new Error("Workspace snapshot exceeds 256 MiB");
    baseline[name] = entry;
    await copyEntry(canonical, base, name, entry);
    await copyEntry(canonical, root, name, entry);
  }
  // The snapshot has its own repository, without copying source Git metadata or creating a commit.
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "--all"], { cwd: root });
  return { root, original: canonical, baseline };
}
function equal(a: FileRecord | undefined, b: FileRecord | undefined) { return JSON.stringify(a) === JSON.stringify(b); }
export async function workspaceDiff(workspace: Workspace): Promise<Diff> {
  const names = [...new Set([...Object.keys(workspace.baseline), ...await projectFiles(workspace.root)])].sort();
  if (names.length > 20000) throw new Error("Workspace exceeds 20000 source files");
  const files: Diff["files"] = [];
  const details: unknown[] = [];
  const parts: string[] = [];
  for (const name of names) {
    const before = workspace.baseline[name];
    const after = await record(workspace.root, name);
    if (equal(before, after)) continue;
    files.push({ path: name, status: !before ? "added" : !after ? "deleted" : "modified" });
    details.push([name, before ?? null, after ?? null]);
    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    const left = before ? resolveFile(path.join(path.dirname(workspace.root), "baseline"), name) : nullFile;
    const right = after ? resolveFile(workspace.root, name) : nullFile;
    if (before?.kind === "link" || after?.kind === "link") { parts.push(`diff -- ${name}\nSymbolic link or file type changed\n`); continue; }
    try { const { stdout } = await exec("git", ["diff", "--no-index", "--binary", "--", left, right], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); parts.push(stdout); }
    catch (error) { const failure = error as Error & { code?: number; stdout?: string }; if (failure.code !== 1) throw error; parts.push(failure.stdout ?? ""); }
  }
  const raw = parts.join("\n");
  if (raw.length > 4 * 1024 * 1024) throw new Error("Review diff exceeds 4 MiB");
  const text = raw.replaceAll(path.join(path.dirname(workspace.root), "baseline") + path.sep, "").replaceAll(workspace.root + path.sep, "");
  return { text, files, fingerprint: hash(JSON.stringify(details)) };
}
export async function applyWorkspace(workspace: Workspace, reviewed: Diff) {
  const current = await workspaceDiff(workspace);
  if (current.fingerprint !== reviewed.fingerprint) throw new Error("Workspace changed since final review; regenerate the diff before applying");
  const conflicts: string[] = [];
  const targets = new Map<string, FileRecord | undefined>();
  for (const file of current.files) {
    const before = await record(workspace.original, file.path);
    const after = await record(workspace.root, file.path);
    if (!equal(workspace.baseline[file.path], before) && !equal(after, before)) conflicts.push(file.path);
    targets.set(file.path, after);
  }
  if (conflicts.length) return { applied: false, conflicts };
  const transaction = path.join(path.dirname(workspace.root), "apply-transaction");
  const staged = path.join(transaction, "staged");
  await mkdir(transaction, { recursive: true, mode: 0o700 });
  await mkdir(staged, { recursive: true, mode: 0o700 });
  for (const file of current.files) { const after = targets.get(file.path); if (after) await copyEntry(workspace.root, staged, file.path, after); }
  await writeFile(path.join(transaction, "journal.json"), JSON.stringify({ files: current.files, fingerprint: current.fingerprint, state: "prepared" }), { mode: 0o600 });
  const changed: string[] = [];
  try {
    for (const file of current.files) {
      // Recheck immediately before each write; retain rollback material until the transaction is complete.
      const before = await record(workspace.original, file.path);
      const after = targets.get(file.path);
      if (equal(before, after)) continue;
      if (!equal(workspace.baseline[file.path], before)) throw new Error(`Project changed during application: ${file.path}`);
      changed.push(file.path);
      if (after) await replaceEntry(staged, workspace.original, file.path, after, transaction);
      else await rm(resolveFile(workspace.original, file.path));
    }
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({ files: current.files, state: "completed" }), { mode: 0o600 });
    return { applied: true, conflicts: [] };
  } catch (error) {
    const base = path.join(path.dirname(workspace.root), "baseline");
    for (const name of changed.reverse()) {
      const before = workspace.baseline[name];
      // Never roll back a file changed by someone else after our write.
      if (!equal(await record(workspace.original, name), targets.get(name))) continue;
      if (before) await replaceEntry(base, workspace.original, name, before, transaction);
      else await rm(resolveFile(workspace.original, name), { force: true });
    }
    throw error;
  }
}
