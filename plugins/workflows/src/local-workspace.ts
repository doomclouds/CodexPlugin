import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Diff, FileRecord, Workspace } from "./types.ts";
import { gitCommand, readGitIndex, readOnlyGitContextDigest, readOnlyGitContextDigests } from "./submodules.ts";

const sourceLimit = 256 * 1024 * 1024;
const checkpointLimit = 2 * 1024 * 1024 * 1024;
const fileLimit = 512 * 1024 * 1024;
const previewLimit = 4 * 1024 * 1024;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function filename(root: string, name: string): string {
  if (!name || path.isAbsolute(name) || name.includes("\0") || name.split(/[\\/]/).some(part => !part || part === "." || part === ".." || part === ".git")) throw new Error("Unsafe local workspace path");
  const target = path.resolve(root, name);
  if (!within(root, target) || target === root) throw new Error("Local workspace path escapes its root");
  return target;
}
async function parents(root: string, name: string): Promise<void> {
  let parent = root;
  for (const segment of name.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, segment);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("Unsafe local workspace parent directory");
  }
}
async function directory(target: string): Promise<string> {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Local workspace requires real owned directories");
  return realpath(target);
}
async function gitRoot(root: string): Promise<boolean> {
  try {
    const metadata = await lstat(path.join(root, ".git"));
    if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile()) throw new Error("Unsupported local Git metadata");
  } catch (error) { if (!absent(error)) throw error; }
  try { return await realpath((await gitCommand(root, ["rev-parse", "--show-toplevel"])).trim()) === root; }
  catch (error) {
    try { await lstat(path.join(root, ".git")); } catch (missing) { if (absent(missing)) return false; throw missing; }
    throw error;
  }
}
async function names(root: string, includeIgnored: boolean, signal?: AbortSignal): Promise<string[]> {
  const result = new Set<string>();
  const walk = async (current: string, prefix: string, depth: number) => {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error("Local workspace exceeds 64 directory levels");
    const entries = (await readdir(current)).sort();
    if (current !== root && entries.includes(".git")) throw new Error("Unregistered nested Git repositories are not supported in local workspace tracking");
    for (const entry of entries) {
      if (entry === ".git") continue;
      const relative = prefix + entry, target = filename(root, relative), info = await lstat(target);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (await realpath(target) !== target) throw new Error("Local workspace directory identity changed");
        await walk(target, relative + path.sep, depth + 1);
      } else result.add(relative);
      if (result.size > 100000) throw new Error("Local workspace exceeds 100000 files");
    }
  };
  const git = async (current: string, prefix: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 16) throw new Error("Local Git submodules exceed 16 levels");
    const index = await readGitIndex(current);
    const links = new Map(index.filter(entry => entry.mode === "160000").map(entry => [entry.path, entry]));
    const tracked = (await gitCommand(current, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const ignored = includeIgnored ? (await gitCommand(current, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean) : [];
    for (const name of [...tracked, ...ignored]) {
      if (links.has(name)) continue;
      const target = filename(root, prefix + name);
      let info;
      try { await parents(root, prefix + name); info = await lstat(target); } catch (error) { if (absent(error)) continue; throw error; }
      if (info.isDirectory()) throw new Error("Unregistered nested Git repositories are not supported in local workspace tracking");
      result.add(prefix + name);
      if (result.size > 100000) throw new Error("Local workspace exceeds 100000 files");
    }
    for (const [name, entry] of links) {
      if (entry.stage !== 0) throw new Error("Local Git submodule has unresolved index entries");
      const relative = prefix + name, target = filename(root, relative);
      let info;
      try { await parents(root, relative); info = await lstat(target); } catch (error) { if (absent(error)) continue; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Local Git submodule is not a real project directory");
      if (await gitRoot(target)) await git(target, relative + path.sep, depth + 1);
      else if ((await readdir(target)).length) throw new Error("Uninitialized local Git submodule contains unmanaged files");
    }
  };
  if (await gitRoot(root)) await git(root, "", 0); else await walk(root, "", 0);
  return [...result].sort();
}
interface Scan { records: Record<string, FileRecord>; bytes: number }
async function scan(root: string, includeIgnored: boolean, limit: number, signal?: AbortSignal, destination?: string, retainedNames: string[] = []): Promise<Scan> {
  const records: Record<string, FileRecord> = Object.create(null);
  const inventory = await names(root, includeIgnored, signal);
  const initial = [...new Set([...inventory, ...retainedNames])].sort();
  const identities: Array<{ target: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }> = [];
  let bytes = 0;
  for (const name of initial) {
    signal?.throwIfAborted();
    const target = filename(root, name);
    let info;
    try { await parents(root, name); info = await lstat(target); } catch (error) { if (absent(error)) continue; throw error; }
    const mode = info.mode & 0o777;
    bytes += info.size;
    if (bytes > limit || info.size > fileLimit) throw new Error(`Local workspace exceeds its ${Math.floor(limit / 1024 / 1024)} MiB bounded content limit`);
    const copy = destination ? filename(destination, name) : undefined;
    if (copy) { await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 }); await parents(destination!, name); }
    if (info.isSymbolicLink()) {
      const value = await readlink(target), resolved = path.resolve(path.dirname(target), value);
      if (path.isAbsolute(value) || !within(root, resolved)) throw new Error("External local workspace symbolic link is unsupported");
      const canonical = await realpath(target).catch(error => { if (absent(error)) return resolved; throw error; });
      if (!within(root, canonical)) throw new Error("Local workspace symbolic link chain escapes its project");
      records[name] = { hash: createHash("sha256").update(value).digest("hex"), kind: "link", mode };
      if (copy) await symlink(value, copy);
    } else if (info.isFile()) {
      const input = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let output;
      try {
        const opened = await input.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || await realpath(target) !== target) throw new Error("Local workspace file changed while opening it");
        if (copy) output = await open(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
        const digest = createHash("sha256");
        for await (const chunk of input.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); digest.update(chunk as Buffer); if (output) await output.writeFile(chunk as Buffer); }
        records[name] = { hash: digest.digest("hex"), kind: "file", mode };
        const after = await input.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Local workspace file changed during hashing");
        if (output) await output.chmod(mode);
      } finally { await output?.close(); await input.close(); }
    } else throw new Error("Local workspace contains an unsupported filesystem entry");
    identities.push({ target, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  if (!equal(inventory, await names(root, includeIgnored, signal))) throw new Error("Local workspace file inventory changed during hashing");
  for (const previous of identities) {
    signal?.throwIfAborted();
    await parents(root, path.relative(root, previous.target));
    const current = await lstat(previous.target);
    if (previous.dev !== current.dev || previous.ino !== current.ino || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || previous.ctimeMs !== current.ctimeMs) throw new Error("Local workspace file changed during hashing");
  }
  return { records, bytes };
}

async function assertIndependentGitMetadata(root: string, data: string, depth = 0): Promise<void> {
  if (depth > 16) throw new Error("Local Git submodules exceed 16 levels");
  if (!await gitRoot(root)) return;
  const [actualName, commonName] = await Promise.all([
    gitCommand(root, ["rev-parse", "--absolute-git-dir"]),
    gitCommand(root, ["rev-parse", "--git-common-dir"]),
  ]);
  const actual = await realpath(actualName.trim()), common = await realpath(path.resolve(root, commonName.trim()));
  // A separately located working tree can still depend on another workflow's
  // owned checkout. Deleting that workflow must never destroy this project's Git.
  if (within(data, actual) || within(data, common)) throw new Error("Local project Git metadata depends on workflow-owned data; use an independent original project outside workflow storage");
  for (const entry of await readGitIndex(root)) {
    if (entry.mode !== "160000") continue;
    const child = filename(root, entry.path);
    let info;
    try { await parents(root, entry.path); info = await lstat(child); } catch (error) { if (absent(error)) continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(child) !== child) throw new Error("Local Git submodule is not a real project directory");
    await assertIndependentGitMetadata(child, data, depth + 1);
  }
}
export async function validateLocalWorkspace(workspace: Workspace, projectPath: string, runDirectory: string): Promise<void> {
  if (workspace.kind !== "local") throw new Error("Expected a local workspace");
  const project = await directory(projectPath), run = await directory(runDirectory);
  const data = await realpath(path.dirname(run));
  if (within(project, data) || within(data, project)) throw new Error("Local project and workflow data directories must not overlap");
  await assertIndependentGitMetadata(project, data);
  if (workspace.root !== project || workspace.original !== project || workspace.baselineRoot !== path.join(run, "local-baseline")) throw new Error("Local workspace paths do not match their project and owned run directory");
  const identity = await lstat(project);
  if (!workspace.rootIdentity || identity.dev !== workspace.rootIdentity.dev || identity.ino !== workspace.rootIdentity.ino) throw new Error("Local project directory identity changed");
  if (await directory(workspace.baselineRoot) !== workspace.baselineRoot) throw new Error("Local baseline directory identity changed");
}
// Cleanup owns the run directory only. It must remain possible after a user
// moves/removes the project or a partial cleanup has already removed the baseline.
export async function validateLocalWorkspaceForDeletion(workspace: Workspace, projectPath: string, runDirectory: string): Promise<void> {
  const run = await directory(runDirectory), data = await realpath(path.dirname(run));
  const project = path.resolve(projectPath);
  if (workspace.kind !== "local" || !path.isAbsolute(projectPath) || projectPath !== project || workspace.root !== project || workspace.original !== project || workspace.baselineRoot !== path.join(run, "local-baseline")) throw new Error("Local workspace paths do not match their project and owned run directory");
  if (within(project, data) || within(data, project)) throw new Error("Local project and workflow data directories must not overlap");
  if (!workspace.rootIdentity || !Number.isSafeInteger(workspace.rootIdentity.dev) || workspace.rootIdentity.dev < 0 || !Number.isSafeInteger(workspace.rootIdentity.ino) || workspace.rootIdentity.ino < 0) throw new Error("Local project directory identity is invalid");
  try { if (await directory(workspace.baselineRoot) !== workspace.baselineRoot) throw new Error("Local baseline directory identity changed"); }
  catch (error) { if (!absent(error)) throw error; }
}
async function validate(workspace: Workspace): Promise<void> {
  if (!workspace.baselineRoot) throw new Error("Local workspace baseline is missing");
  await validateLocalWorkspace(workspace, workspace.original, path.dirname(workspace.baselineRoot));
}
async function baseline(workspace: Workspace): Promise<void> {
  const actual = await scan(workspace.baselineRoot!, false, sourceLimit);
  if (!equal(actual.records, workspace.baseline)) throw new Error("Local baseline contents changed; create a new preview");
}
export async function createLocalWorkspace(projectPath: string, runDirectory: string, signal?: AbortSignal): Promise<Workspace> {
  signal?.throwIfAborted();
  const root = await directory(projectPath), run = await directory(runDirectory), data = await realpath(path.dirname(run));
  if (within(root, data) || within(data, root)) throw new Error("Local project and workflow data directories must not overlap");
  await assertIndependentGitMetadata(root, data);
  const identity = await lstat(root), baselineRoot = path.join(run, "local-baseline");
  try { await directory(baselineRoot); } catch (error) { if (!absent(error)) throw error; }
  await rm(baselineRoot, { recursive: true, force: true });
  await mkdir(baselineRoot, { mode: 0o700 });
  const beforeGit = await gitRoot(root) ? await readOnlyGitContextDigest(root, { ignoreHostCheckpoints: true }) : undefined;
  const captured = await scan(root, false, sourceLimit, signal, baselineRoot);
  const afterGit = await gitRoot(root) ? await readOnlyGitContextDigest(root, { ignoreHostCheckpoints: true }) : undefined;
  if (beforeGit !== afterGit) throw new Error("Local Git state changed while capturing the baseline");
  const workspace: Workspace = { root, original: root, kind: "local", baselineRoot, baseline: captured.records, rootIdentity: { dev: identity.dev, ino: identity.ino } };
  await validateLocalWorkspace(workspace, root, run);
  await baseline(workspace);
  return workspace;
}
export interface LocalWorkspaceCheckpoints {
  current: string; legacy?: string; legacyWithoutHostCheckpoints: string;
  filesDigest: string; gitDigest: string | null;
}
// Read-only workflows need the same bounded file/Git evidence without creating
// a writable workspace or a baseline directory in the user's project.
export async function readOnlyProjectCheckpoint(project: string, signal?: AbortSignal): Promise<string> {
  const root = await directory(await realpath(project)), identity = await lstat(root);
  const isGit = await gitRoot(root);
  const before = isGit ? await readOnlyGitContextDigest(root, { ignoreHostCheckpoints: true }) : null;
  const captured = await scan(root, true, checkpointLimit, signal);
  const after = isGit ? await readOnlyGitContextDigest(root, { ignoreHostCheckpoints: true }) : null;
  const current = await lstat(root);
  if (before !== after || !current.isDirectory() || current.isSymbolicLink() || identity.dev !== current.dev || identity.ino !== current.ino || await realpath(project) !== root) throw new Error("Read-only project changed while capturing its node checkpoint");
  return `readonly-v1:${hash({ rootIdentity: { dev: identity.dev, ino: identity.ino }, files: captured.records, git: after })}`;
}
export async function captureLocalWorkspaceCheckpoints(workspace: Workspace, signal?: AbortSignal): Promise<LocalWorkspaceCheckpoints> {
  signal?.throwIfAborted();
  await validate(workspace); await baseline(workspace);
  const gitBefore = await gitRoot(workspace.root) ? await readOnlyGitContextDigests(workspace.root) : undefined;
  const current = await scan(workspace.root, true, checkpointLimit, signal);
  const gitAfter = await gitRoot(workspace.root) ? await readOnlyGitContextDigests(workspace.root) : undefined;
  if (gitBefore?.withoutHostCheckpoints !== gitAfter?.withoutHostCheckpoints) throw new Error("Local Git state changed during checkpoint hashing");
  await validate(workspace);
  const fingerprint = (git: string | undefined) => hash({ rootIdentity: workspace.rootIdentity, files: current.records, git: git ?? null });
  const filtered = fingerprint(gitAfter?.withoutHostCheckpoints);
  return {
    current: `local-v2:${filtered}`,
    ...(gitBefore?.full === gitAfter?.full ? { legacy: `local-v1:${fingerprint(gitAfter?.full)}` } : {}),
    legacyWithoutHostCheckpoints: `local-v1:${filtered}`,
    filesDigest: hash(current.records),
    gitDigest: gitAfter?.withoutHostCheckpoints ?? null,
  };
}
export async function localWorkspaceFingerprint(workspace: Workspace, signal?: AbortSignal): Promise<string> {
  return (await captureLocalWorkspaceCheckpoints(workspace, signal)).current;
}
async function fileDiff(cwd: string, left: string, right: string, full: ReturnType<typeof createHash>): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"].includes(key)) delete (env as NodeJS.ProcessEnv)[key];
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-index", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", "--binary", "--", left, right], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const retained: Buffer[] = [];
    let bytes = 0, kept = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (chunk: Buffer) => { full.update(chunk); bytes += chunk.length; if (kept < previewLimit) { const next = chunk.subarray(0, previewLimit - kept); retained.push(next); kept += next.length; } });
    child.stderr.on("data", () => {});
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); if (code !== 0 && code !== 1) { reject(new Error("Could not generate local workspace review diff")); return; } const decoder = new StringDecoder("utf8"); resolve({ text: decoder.write(Buffer.concat(retained)) + (bytes <= kept ? decoder.end() : ""), bytes, truncated: bytes > kept }); });
  });
}
export async function localWorkspaceDiff(workspace: Workspace): Promise<Diff> {
  await validate(workspace); await baseline(workspace);
  const retained = Object.keys(workspace.baseline);
  const current = await scan(workspace.root, false, sourceLimit, undefined, undefined, retained);
  const files: Diff["files"] = [], details: unknown[] = [];
  const full = createHash("sha256"); let text = "", totalBytes = 0, previewTruncated = false;
  for (const name of [...new Set([...Object.keys(workspace.baseline), ...Object.keys(current.records)])].sort()) {
    const before = workspace.baseline[name], after = current.records[name];
    if (equal(before, after)) continue;
    files.push({ path: name, status: !before ? "added" : !after ? "deleted" : "modified" });
    details.push([name, before ?? null, after ?? null]);
    const empty = process.platform === "win32" ? "NUL" : "/dev/null";
    const part = before?.kind === "link" || after?.kind === "link" ? { text: `diff -- ${name}\nSymbolic link or file type changed\n`, bytes: 0, truncated: false } : await fileDiff(path.dirname(workspace.baselineRoot!), before ? filename(workspace.baselineRoot!, name) : empty, after ? filename(workspace.root, name) : empty, full);
    if (!part.bytes) { part.bytes = Buffer.byteLength(part.text); full.update(part.text); }
    totalBytes += part.bytes; previewTruncated ||= part.truncated;
    const normalized = part.text.replaceAll(workspace.baselineRoot! + path.sep, "").replaceAll(workspace.root + path.sep, "");
    const remaining = previewLimit - Buffer.byteLength(text);
    if (Buffer.byteLength(normalized) > remaining) previewTruncated = true;
    if (remaining > 0) text += new StringDecoder("utf8").write(Buffer.from(normalized).subarray(0, remaining));
  }
  if (!equal(current.records, (await scan(workspace.root, false, sourceLimit, undefined, undefined, retained)).records)) throw new Error("Local project changed while generating its review diff");
  await validate(workspace);
  return { text, files, fingerprint: hash(details), previewTruncated, totalBytes, contentSha256: full.digest("hex") };
}
