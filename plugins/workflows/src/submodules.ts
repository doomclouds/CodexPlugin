import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import type { MaintenanceArtifact } from "./types.ts";

const exec = promisify(execFile);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface GitIndexEntry { path: string; mode: string; commit: string; stage: number }
export interface GitSubmodule { path: string; commit: string; initialized: boolean; manifest?: GitManifest }
export interface GitManifest {
  head: string; index: GitIndexEntry[]; status: string; configFingerprint: string;
  files: MaintenanceArtifact[]; ignored: MaintenanceArtifact[]; submodules: GitSubmodule[];
}
export interface ManifestOptions { includeIgnored?: boolean; requireClean?: boolean; enforceOwnedMetadata?: boolean }

// Every host Git operation disables implicit submodule transport. Child initialization is local and explicit.
async function gitInvocation(cwd: string, args: string[], timeoutMs = 120000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete (env as NodeJS.ProcessEnv)[key];
  const disabledFilters: string[] = [];
  {
    // A tracked .gitattributes file can otherwise invoke arbitrary global or source-local filters.
    let names = "";
    try { names = (await exec("git", ["--no-pager", "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout; }
    catch (error) { if (Number((error as { code?: unknown }).code) !== 1) throw error; }
    const drivers = [...new Set(names.split("\n").filter(Boolean).map(key => key.slice(0, key.lastIndexOf("."))))];
    for (const driver of drivers) {
      if (!/^filter\.[^\r\n\0]+$/.test(driver)) throw new Error("Unsupported Git filter configuration");
      for (const field of ["clean", "smudge", "process"]) disabledFilters.push("-c", `${driver}.${field}=`);
      disabledFilters.push("-c", `${driver}.required=false`);
    }
  }
  return { env, args: ["--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...disabledFilters, ...args] };
}
function gitFailure(args: string[], error: unknown): Error {
  const code = (error as { code?: unknown }).code;
  const failure = new Error(`Git ${args[0] ?? "operation"} failed (exit ${String(code ?? "unknown")})`);
  Object.assign(failure, { code }); return failure;
}
export async function gitCommand(cwd: string, args: string[]): Promise<string> {
  try {
    const invocation = await gitInvocation(cwd, args);
    const { stdout } = await exec("git", invocation.args, { cwd, env: invocation.env, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) { throw gitFailure(args, error); }
}

export interface GitCommandPreview { text: string; previewTruncated: boolean; totalBytes: number; contentSha256: string }
export async function gitCommandPreview(cwd: string, args: string[], options: { previewBytes?: number; timeoutMs?: number } = {}): Promise<GitCommandPreview> {
  const limit = options.previewBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid bounded Git preview options");
  try {
    const invocation = await gitInvocation(cwd, args, timeoutMs);
    return await new Promise<GitCommandPreview>((resolve, reject) => {
      const child = spawn("git", invocation.args, { cwd, env: invocation.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      const digest = createHash("sha256"), chunks: Buffer[] = [];
      let totalBytes = 0, retainedBytes = 0, failure: unknown;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const signal = (value: NodeJS.Signals) => {
        if (process.platform === "win32") {
          if (child.pid) void exec("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 1000, maxBuffer: 65536 }).catch(() => {}).finally(() => child.kill(value));
          else child.kill(value);
        } else {
          try { if (child.pid) process.kill(-child.pid, value); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(value); }
        }
      };
      const stop = (error: unknown) => {
        if (failure) return;
        failure = error; signal("SIGTERM");
        forced = setTimeout(() => signal("SIGKILL"), 1000);
      };
      const timeout = setTimeout(() => stop(Object.assign(new Error("Git preview timed out"), { code: "ETIMEDOUT" })), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        totalBytes += chunk.length;
        if (!Number.isSafeInteger(totalBytes)) { stop(Object.assign(new Error("Git output size is not representable"), { code: "ERR_GIT_OUTPUT_SIZE" })); return; }
        digest.update(chunk);
        if (retainedBytes < limit) {
          const prefix = chunk.subarray(0, Math.min(chunk.length, limit - retainedBytes));
          chunks.push(Buffer.from(prefix)); retainedBytes += prefix.length;
        }
      });
      // Drain diagnostics without retaining or forwarding potentially private stderr.
      child.stderr.on("data", () => {});
      child.stdout.once("error", stop); child.stderr.once("error", stop);
      child.once("error", error => { failure ??= error; });
      child.once("close", code => {
        clearTimeout(timeout); if (forced) clearTimeout(forced);
        if (process.platform !== "win32") signal("SIGKILL");
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(Object.assign(new Error("Git command failed"), { code: code ?? "unknown" })); return; }
        const decoder = new StringDecoder("utf8");
        let previewTruncated = totalBytes > retainedBytes;
        // An incomplete code point at the raw preview boundary remains pending;
        // only a complete output may flush the decoder's final bytes.
        let text = decoder.write(Buffer.concat(chunks, retainedBytes)) + (previewTruncated ? "" : decoder.end());
        const encoded = Buffer.from(text, "utf8");
        if (encoded.length > limit) {
          // Invalid source encodings can expand into multi-byte replacement
          // characters. Bound the serialized UTF-8 preview as well as raw input.
          text = new StringDecoder("utf8").write(encoded.subarray(0, limit));
          previewTruncated = true;
        }
        resolve({ text, previewTruncated, totalBytes, contentSha256: digest.digest("hex") });
      });
    });
  } catch (error) {
    if ((error as { killed?: boolean }).killed && !(error as { code?: unknown }).code) Object.assign(error as object, { code: "ETIMEDOUT" });
    throw gitFailure(args, error);
  }
}
function relative(root: string, name: string): string {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === ".." || part === ".git")) throw new Error("Unsafe Git manifest path");
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw new Error("Git manifest path escapes repository");
  return file;
}
async function parents(root: string, name: string): Promise<void> {
  let current = root;
  for (const segment of name.split(/[\\/]/).slice(0, -1)) {
    current = path.join(current, segment); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await realpath(current)).startsWith(root + path.sep)) throw new Error("Git manifest has an unsafe parent directory");
  }
}
export async function readGitIndex(project: string): Promise<GitIndexEntry[]> {
  return (await gitCommand(project, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean).map(record => {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unsupported Git index record");
    relative(path.resolve(project), match[4]!);
    return { mode: match[1]!, commit: match[2]!, stage: Number(match[3]), path: match[4]! };
  });
}
export async function readGitIndexState(project: string): Promise<{ entries: GitIndexEntry[]; flags: Array<{ path: string; tag: string; intentToAdd: boolean }> }> {
  const [entries, tagged, debug] = await Promise.all([
    readGitIndex(project),
    gitCommand(project, ["ls-files", "-v", "-z"]),
    gitCommand(project, ["ls-files", "--debug", "-z"]),
  ]);
  const tags = tagged.split("\0").filter(Boolean).map(record => {
    const match = /^([A-Za-z?]) ([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unsupported Git index flag record");
    return { tag: match[1]!, path: match[2]! };
  });
  const intentions: Array<{ path: string; intentToAdd: boolean }> = [];
  let cursor = 0;
  while (cursor < debug.length) {
    const end = debug.indexOf("\0", cursor);
    if (end < 0) throw new Error("Unsupported Git index debug record");
    const name = debug.slice(cursor, end);
    const record = /^  ctime:[^\n]*\n  mtime:[^\n]*\n  dev:[^\n]*\n  uid:[^\n]*\n  size:[^\n]*flags: ([0-9a-fA-F]{1,8})\r?\n/.exec(debug.slice(end + 1));
    if (!record) throw new Error("Unsupported Git index intent-to-add record");
    // Git's CE_INTENT_TO_ADD is its on-disk bit 29. Stat caches and in-memory
    // flags from --debug are deliberately excluded from the semantic state.
    intentions.push({ path: name, intentToAdd: (Number.parseInt(record[1]!, 16) & 0x20000000) !== 0 });
    cursor = end + 1 + record[0].length;
  }
  if (entries.length !== tags.length || entries.length !== intentions.length || entries.some((entry, index) => entry.path !== tags[index]?.path || entry.path !== intentions[index]?.path)) throw new Error("Git index entries changed while reading semantic flags");
  return { entries, flags: tags.map((entry, index) => ({ ...entry, intentToAdd: intentions[index]!.intentToAdd })) };
}
export async function listGitlinks(project: string): Promise<GitIndexEntry[]> { return (await readGitIndex(project)).filter(entry => entry.mode === "160000"); }
async function initialized(root: string, name: string): Promise<boolean> {
  const child = relative(root, name);
  try { await parents(root, name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  let stat;
  try { stat = await lstat(child); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Git submodule path is not a safe directory: ${name}`);
  try { await lstat(path.join(child, ".git")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await readdir(child)).length) throw new Error(`Uninitialized Git submodule has unmanaged files: ${name}`);
    return false;
  }
  if (await realpath((await gitCommand(child, ["rev-parse", "--show-toplevel"])).trim()) !== await realpath(child)) throw new Error(`Git submodule metadata does not belong to its directory: ${name}`);
  return true;
}
interface Bounds { count: number; bytes: number }
async function files(root: string, names: string[], bounds: Bounds): Promise<MaintenanceArtifact[]> {
  const result: MaintenanceArtifact[] = [];
  for (const name of [...new Set(names)].sort()) {
    if (++bounds.count > 100000) throw new Error("Git manifest exceeds 100000 files");
    const file = relative(root, name); let stat;
    try { await parents(root, name); stat = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) {
      const target = await readlink(file), resolved = path.resolve(path.dirname(file), target);
      if (path.isAbsolute(target) || !resolved.startsWith(root + path.sep)) throw new Error("External Git manifest symlink is unsupported");
      const canonical = await realpath(resolved).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved; throw error; });
      if (!canonical.startsWith(root + path.sep)) throw new Error("External Git manifest symlink chain is unsupported");
      await parents(root, name);
      result.push({ path: name, kind: "link", mode: stat.mode & 0o777, size: stat.size, hash: createHash("sha256").update(target).digest("hex") });
    } else if (stat.isFile()) {
      bounds.bytes += stat.size;
      if (stat.size > 512 * 1024 * 1024 || bounds.bytes > 2 * 1024 * 1024 * 1024) throw new Error("Git manifest exceeds the bounded 2 GiB limit");
      const hash = createHash("sha256"), fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await parents(root, name); const opened = await fd.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile() || !(await realpath(file)).startsWith(root + path.sep)) throw new Error("Git manifest file changed while opening it");
        for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
        await parents(root, name); const after = await fd.stat(), now = await lstat(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || now.dev !== opened.dev || now.ino !== opened.ino || now.isSymbolicLink()) throw new Error("Git manifest file changed during hashing");
      } finally { await fd.close(); }
      result.push({ path: name, kind: "file", mode: stat.mode & 0o777, size: stat.size, hash: hash.digest("hex") });
    } else throw new Error(`Unsupported Git manifest entry: ${name}`);
  }
  return result;
}
export async function inspectGitManifest(project: string, options: ManifestOptions = {}): Promise<GitManifest> {
  const boundary = await realpath(project), bounds: Bounds = { count: 0, bytes: 0 };
  async function inspect(root: string, depth: number): Promise<GitManifest> {
    if (depth > 16) throw new Error("Git submodule nesting exceeds 16 levels");
    if (await realpath((await gitCommand(root, ["rev-parse", "--show-toplevel"])).trim()) !== root) throw new Error("Git manifest requires the repository root");
    if (options.enforceOwnedMetadata) {
      const entry = await lstat(path.join(root, ".git"));
      const absolute = await realpath((await gitCommand(root, ["rev-parse", "--absolute-git-dir"])).trim());
      const common = await realpath(path.resolve(root, (await gitCommand(root, ["rev-parse", "--git-common-dir"])).trim()));
      if (entry.isSymbolicLink() || (depth === 0 ? !entry.isDirectory() : !entry.isDirectory() && !entry.isFile()) || !absolute.startsWith(boundary + path.sep) || !common.startsWith(boundary + path.sep)) throw new Error("Git submodule must have independent owned metadata");
      const alternates = path.join(common, "objects", "info", "alternates");
      try {
        await parents(common, "objects/info/alternates");
        const stat = await lstat(alternates);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (await readFile(alternates, "utf8")).trim()) throw new Error("Git submodule cannot share alternate object storage");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const index = await readGitIndex(root);
    if (index.some(entry => entry.stage !== 0)) throw new Error("Git manifest has unresolved index entries");
    const links = index.filter(entry => entry.mode === "160000"), linkPaths = new Set(links.map(entry => entry.path));
    const presence = new Map<string, boolean>();
    for (const entry of links) presence.set(entry.path, await initialized(root, entry.path));
    const status = await gitCommand(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    if (options.requireClean && status) throw new Error("Git repository or initialized submodule is dirty");
    const names = (await gitCommand(root, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(name => name && !linkPaths.has(name));
    const ignoredNames = options.includeIgnored ? (await gitCommand(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(name => name && !linkPaths.has(name)) : [];
    const submodules: GitSubmodule[] = [];
    for (const entry of links) {
      const present = presence.get(entry.path)!;
      const manifest = present ? await inspect(await realpath(relative(root, entry.path)), depth + 1) : undefined;
      if (options.requireClean && manifest && manifest.head !== entry.commit) throw new Error(`Git submodule HEAD differs from its gitlink: ${entry.path}`);
      submodules.push({ path: entry.path, commit: entry.commit, initialized: present, ...(manifest ? { manifest } : {}) });
    }
    return { head: (await gitCommand(root, ["rev-parse", "--verify", "HEAD"])).trim(), index, status,
      configFingerprint: createHash("sha256").update(await gitCommand(root, ["config", "--local", "--null", "--list"])).digest("hex"),
      files: await files(root, names, bounds), ignored: await files(root, ignoredNames, bounds), submodules };
  }
  return inspect(boundary, 0);
}
export async function gitAwareContextDigest(project: string): Promise<string> { return digest(await inspectGitManifest(project)); }

// File contents alone miss same-tree branch changes, staged blobs and new refs.
// Keep this separate from source baselines so older writable runs can resume
// under their existing workspace validation without an artificial digest drift.
interface ReadOnlyGitContext {
  head: string | null; branch: string | null;
  index: Awaited<ReturnType<typeof readGitIndexState>>;
  refs: string; configFingerprint: string;
  children: Array<[string, ReadOnlyGitContext]>;
}
export interface ReadOnlyGitContextDigests { full: string; withoutHostCheckpoints: string }
export async function readOnlyGitContextDigests(project: string): Promise<ReadOnlyGitContextDigests> {
  const optional = async (root: string, args: string[]) => {
    try { return await gitCommand(root, args); }
    catch (error) { if (Number((error as { code?: unknown }).code) === 1) return null; throw error; }
  };
  const inspect = async (root: string, depth: number): Promise<ReadOnlyGitContext> => {
    if (depth > 16) throw new Error("Git context nesting exceeds 16 levels");
    const [head, branch, index, refs, config] = await Promise.all([
      optional(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
      optional(root, ["symbolic-ref", "--quiet", "HEAD"]),
      readGitIndexState(root),
      gitCommand(root, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)"]),
      gitCommand(root, ["config", "--local", "--null", "--list"]),
    ]);
    const children: Array<[string, ReadOnlyGitContext]> = [];
    for (const entry of index.entries.filter(item => item.mode === "160000")) if (await initialized(root, entry.path)) {
      const child = await realpath(relative(root, entry.path));
      children.push([entry.path, await inspect(child, depth + 1)]);
    }
    return { head, branch, index, refs, configFingerprint: digest(config), children };
  };
  const context = await inspect(await realpath(project), 0);
  const withoutHostCheckpoints = (value: ReadOnlyGitContext): ReadOnlyGitContext => ({
    ...value,
    // Codex may publish its turn-diff bookkeeping refs after its worker exits.
    // These do not alter the checked project, index or business Git references.
    refs: value.refs.split("\n").filter(record => {
      const separator = record.indexOf("\0");
      const name = separator < 0 ? record : record.slice(0, separator);
      return !name.startsWith("refs/codex/turn-diffs/checkpoints/");
    }).join("\n"),
    children: value.children.map(([name, child]) => [name, withoutHostCheckpoints(child)]),
  });
  return { full: digest(context), withoutHostCheckpoints: digest(withoutHostCheckpoints(context)) };
}
export async function readOnlyGitContextDigest(project: string, options: { ignoreHostCheckpoints?: boolean } = {}): Promise<string> {
  const values = await readOnlyGitContextDigests(project);
  return options.ignoreHostCheckpoints ? values.withoutHostCheckpoints : values.full;
}
export function flattenGitArtifacts(manifest: GitManifest): MaintenanceArtifact[] {
  const result: MaintenanceArtifact[] = [];
  const walk = (item: GitManifest, prefix: string) => {
    result.push(...item.ignored.map(file => ({ ...file, path: prefix + file.path })));
    for (const child of item.submodules) if (child.manifest) walk(child.manifest, prefix + child.path + "/");
  };
  walk(manifest, ""); return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function cloneInitializedSubmodules(source: string, destination: string, hooks: string): Promise<void> {
  const manifest = await inspectGitManifest(source, { requireClean: true });
  async function clone(parentSource: string, parentDestination: string, state: GitManifest): Promise<void> {
    for (const child of state.submodules) {
      if (!child.manifest) continue;
      const from = relative(parentSource, child.path), to = relative(parentDestination, child.path);
      await parents(parentDestination, child.path); await mkdir(to, { recursive: true });
      if ((await readdir(to)).length) throw new Error(`Git submodule destination is not empty: ${child.path}`);
      await gitCommand(parentDestination, ["-c", `core.hooksPath=${hooks}`, "clone", `--template=${hooks}`, "--no-local", "--no-hardlinks", "--no-checkout", "--", from, to]);
      await gitCommand(to, ["config", "core.hooksPath", hooks]);
      for (const remote of (await gitCommand(to, ["remote"])).split("\n").filter(Boolean)) await gitCommand(to, ["remote", "remove", remote]);
      for (const remote of (await gitCommand(from, ["remote"])).split("\n").filter(Boolean)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error("Unsupported submodule remote name");
        for (const key of ["url", "pushurl", "fetch"]) {
          let values = ""; try { values = await gitCommand(from, ["config", "--get-all", `remote.${remote}.${key}`]); } catch (error) { if (Number((error as { code?: unknown }).code) !== 1) throw error; }
          for (const value of values.split("\n").filter(Boolean)) await gitCommand(to, ["config", "--add", `remote.${remote}.${key}`, value]);
        }
      }
      const refs = (await gitCommand(from, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"])).split("\n").filter(Boolean);
      for (const ref of refs) { const [name, value] = ref.split(" "); if (name && value) await gitCommand(to, ["update-ref", name, value]); }
      await gitCommand(to, ["checkout", "--detach", child.commit]);
      await clone(from, to, child.manifest);
    }
  }
  await clone(await realpath(source), await realpath(destination), manifest);
  await inspectGitManifest(destination, { requireClean: true, enforceOwnedMetadata: true });
}
