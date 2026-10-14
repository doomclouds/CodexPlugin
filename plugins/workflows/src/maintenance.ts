import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProtocolSession } from "./adapter.ts";
import { cloneInitializedSubmodules, flattenGitArtifacts, gitCommand, inspectGitManifest, listGitlinks, type GitManifest } from "./submodules.ts";
import type { ActivationResult, Diff, MaintenanceArtifact, MaintenancePlan, MaintenanceReview, Workspace } from "./types.ts";
import { normalizeProtectedPaths } from "./protected-paths.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
const maxFiles = 100000;
const maxArtifactBytes = 2 * 1024 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > maximum) throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`);
  return value;
}
export function validateMaintenance(plan: MaintenancePlan, networkGrant: boolean): MaintenancePlan {
  const input = object(plan);
  for (const key of Object.keys(input)) if (!["steps", "activation"].includes(key)) throw new Error(`Unsupported maintenance property: ${key}`);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 64) throw new Error("Maintenance requires 1 to 64 declared steps");
  const ids = new Set<string>();
  const result: MaintenancePlan = { steps: input.steps.map(value => {
    const step = object(value);
    for (const key of Object.keys(step)) if (!["id", "command", "networkAccess", "timeoutMs", "retries", "idempotent", "protectedPaths"].includes(key)) throw new Error(`Unsupported maintenance step property: ${key}`);
    const id = string(step.id, "step.id", 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error("Maintenance step IDs must be unique lowercase identifiers");
    ids.add(id);
    if (!Array.isArray(step.command) || step.command.length < 1 || step.command.length > 128) throw new Error("Maintenance command must be an argument array");
    const command = step.command.map(value => string(value, "command argument", 16384));
    if (step.networkAccess !== undefined && typeof step.networkAccess !== "boolean") throw new Error("networkAccess must be a boolean");
    if (step.networkAccess && !networkGrant) throw new Error("Maintenance step requires the previewed network grant");
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || Number(step.timeoutMs) < 100 || Number(step.timeoutMs) > 86400000)) throw new Error("Invalid maintenance timeout");
    if (step.retries !== undefined && (!Number.isSafeInteger(step.retries) || Number(step.retries) < 0 || Number(step.retries) > 2)) throw new Error("Maintenance retries must be between 0 and 2");
    if (step.idempotent !== undefined && typeof step.idempotent !== "boolean") throw new Error("idempotent must be a boolean");
    if (Number(step.retries ?? 0) > 0 && step.idempotent !== true) throw new Error("Automatic retries require an explicitly idempotent operation");
    return { id, command, ...(step.networkAccess !== undefined ? { networkAccess: step.networkAccess as boolean } : {}), ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs as number } : {}), ...(step.retries !== undefined ? { retries: step.retries as number } : {}), ...(step.idempotent !== undefined ? { idempotent: step.idempotent as boolean } : {}), ...(step.protectedPaths !== undefined ? { protectedPaths: normalizeProtectedPaths(step.protectedPaths) } : {}) };
  }) };
  if (input.activation !== undefined) {
    const activation = object(input.activation);
    for (const key of Object.keys(activation)) if (!["serverName", "command", "args"].includes(key)) throw new Error(`Unsupported activation property: ${key}`);
    const serverName = string(activation.serverName, "serverName", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(serverName)) throw new Error("MCP serverName must be a simple configuration key");
    if (!Array.isArray(activation.args) || activation.args.length > 128) throw new Error("Activation args must be an array");
    result.activation = { serverName, command: string(activation.command, "activation command"), args: activation.args.map(value => {
      if (typeof value !== "string" || value.includes("\0") || value.length > 16384) throw new Error("Invalid activation argument");
      return value;
    }) };
  }
  return result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return gitCommand(cwd, args);
}
async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
  try { return (await git(cwd, args)).trim() || undefined; }
  catch (error) { if ([1, 128].includes(Number((error as { code?: unknown }).code))) return undefined; throw error; }
}
async function clean(cwd: string): Promise<boolean> { return !(await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])); }
async function head(cwd: string): Promise<string> { return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim(); }
async function emptyHooks(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(directory)).length) throw new Error("Maintenance hooks directory must be an empty owned directory");
  return directory;
}
async function branch(cwd: string): Promise<string> {
  const result = await optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!result) throw new Error("Maintenance requires an attached source branch");
  return result;
}
async function ownGit(workspace: Workspace): Promise<void> {
  if (workspace.kind !== "git-worktree" || !workspace.git) throw new Error("Maintenance requires an independent Git checkout");
  const root = await realpath(workspace.root);
  const directory = await lstat(workspace.root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || root !== path.resolve(workspace.root)) throw new Error("Maintenance checkout path must remain its owned directory");
  const metadata = await lstat(path.join(root, ".git"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Maintenance Git metadata must be inside its independent checkout");
  const common = await realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim()));
  if (!common.startsWith(root + path.sep)) throw new Error("Maintenance checkout cannot share source Git metadata");
  if (await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== root) throw new Error("Maintenance checkout has a redirected working tree");
}
export async function validateGitWorkspace(workspace: Workspace): Promise<void> {
  await ownGit(workspace);
  if (await realpath(workspace.original) !== path.resolve(workspace.original)) throw new Error("Original repository path changed; create a new preview");
  if (!await clean(workspace.original)) throw new Error("Original repository is dirty; create a new preview after resolving it");
  if (await head(workspace.original) !== workspace.git!.base || await branch(workspace.original) !== workspace.git!.branch) throw new Error("Original repository HEAD or branch changed; create a new preview");
  await validateSourceSubmodules(workspace);
}
export async function createGitWorkspace(projectPath: string, runDirectory: string): Promise<Workspace> {
  const original = await realpath(projectPath);
  if (await realpath((await git(original, ["rev-parse", "--show-toplevel"])).trim()) !== original) throw new Error("Maintenance project must be the Git repository root");
  if (!await clean(original)) throw new Error("Original repository must be clean before maintenance");
  const sourceManifest = await inspectGitManifest(original, { requireClean: true });
  const base = await head(original), sourceBranch = await branch(original);
  const upstream = await optionalGit(original, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(runDirectory);
  const root = path.join(directory, "workspace");
  const hooks = await emptyHooks(path.join(directory, "disabled-hooks"));
  await rm(root, { recursive: true, force: true });
  try {
    // The local transport copies objects instead of sharing a linked worktree's metadata or alternates.
    await git(directory, ["-c", `core.hooksPath=${hooks}`, "clone", `--template=${hooks}`, "--no-local", "--no-hardlinks", "--no-checkout", "--", original, root]);
    await git(root, ["config", "core.hooksPath", hooks]);
    await git(root, ["fetch", "--no-tags", original, "+refs/remotes/*:refs/remotes/*"]);
    const remotes = (await git(original, ["remote"])).split("\n").filter(Boolean);
    for (const remote of (await git(root, ["remote"])).split("\n").filter(Boolean)) await git(root, ["remote", "remove", remote]);
    for (const remote of remotes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error("Unsupported repository remote name");
      for (const key of ["url", "pushurl", "fetch"]) {
        const values = await optionalGit(original, ["config", "--get-all", `remote.${remote}.${key}`]);
        for (const value of values?.split("\n") ?? []) await git(root, ["config", "--add", `remote.${remote}.${key}`, value]);
      }
    }
    // Recreate original remote-tracking refs after removing clone's temporary origin.
    const remoteRefs = (await git(original, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"])).split("\n").filter(Boolean);
    for (const ref of remoteRefs) { const [name, value] = ref.split(" "); if (name && value) await git(root, ["update-ref", name, value]); }
    await git(root, ["checkout", "-B", sourceBranch, base]);
    for (const key of ["remote", "merge"]) {
      const value = await optionalGit(original, ["config", "--get", `branch.${sourceBranch}.${key}`]);
      if (value) await git(root, ["config", `branch.${sourceBranch}.${key}`, value]);
    }
    await cloneInitializedSubmodules(original, root, hooks);
    const workspace: Workspace = { root, original, baseline: {}, kind: "git-worktree", git: { base, branch: sourceBranch, ...(upstream ? { upstream } : {}) } };
    await savePrivateJson(path.join(directory, "submodule-baseline.json"), submoduleStates(sourceManifest));
    await validateGitWorkspace(workspace);
    return workspace;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

function relativeFile(root: string, name: string): string {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error("Unsafe maintenance artifact path");
  const result = path.resolve(root, name);
  if (!result.startsWith(root + path.sep)) throw new Error("Maintenance artifact escapes checkout");
  return result;
}
async function safeArtifactParents(root: string, name: string): Promise<void> {
  let parent = root;
  for (const segment of name.split(/[\\/]/).slice(0, -1)) {
    parent = path.join(parent, segment);
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Maintenance artifact has an unsafe parent directory");
    const canonical = await realpath(parent);
    if (!canonical.startsWith(root + path.sep)) throw new Error("Maintenance artifact parent escapes checkout");
  }
}
async function records(workspace: Workspace, args: string[]): Promise<MaintenanceArtifact[]> {
  const names = [...new Set((await git(workspace.root, args)).split("\0").filter(Boolean))].sort();
  if (names.length > maxFiles) throw new Error("Maintenance checkout exceeds 100000 files");
  const result: MaintenanceArtifact[] = [];
  let bytes = 0;
  for (const name of names) {
    const file = relativeFile(workspace.root, name);
    let stat;
    try { await safeArtifactParents(workspace.root, name); stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = path.resolve(path.dirname(file), target);
      if (path.isAbsolute(target) || !resolved.startsWith(workspace.root + path.sep)) throw new Error("External maintenance artifact symlink is unsupported");
      const canonical = await realpath(resolved).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved; throw error; });
      if (!canonical.startsWith(workspace.root + path.sep)) throw new Error("Maintenance artifact symlink chain escapes checkout");
      await safeArtifactParents(workspace.root, name);
      result.push({ path: name, kind: "link", mode: stat.mode & 0o777, size: stat.size, hash: hash(target) });
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 512 * 1024 * 1024 || bytes > maxArtifactBytes) throw new Error("Maintenance artifacts exceed the bounded 2 GiB limit");
      const digest = createHash("sha256");
      const descriptor = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await safeArtifactParents(workspace.root, name);
        const opened = await descriptor.stat();
        const canonical = await realpath(file);
        const current = await lstat(canonical);
        if (!canonical.startsWith(workspace.root + path.sep) || opened.dev !== stat.dev || opened.ino !== stat.ino || current.dev !== opened.dev || current.ino !== opened.ino || !opened.isFile()) throw new Error("Maintenance artifact changed while opening it");
        for await (const chunk of descriptor.createReadStream({ autoClose: false })) digest.update(chunk as Buffer);
        await safeArtifactParents(workspace.root, name);
        const after = await descriptor.stat(), pathAfter = await lstat(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.isSymbolicLink()) throw new Error("Maintenance artifact changed during hashing");
      } finally { await descriptor.close(); }
      result.push({ path: name, kind: "file", mode: stat.mode & 0o777, size: stat.size, hash: digest.digest("hex") });
    } else throw new Error("Unsupported maintenance artifact entry");
  }
  return result;
}
async function ignoredArtifacts(workspace: Workspace) {
  if ((await listGitlinks(workspace.root)).length) return flattenGitArtifacts(await inspectGitManifest(workspace.root, { includeIgnored: true, enforceOwnedMetadata: true }));
  return records(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
}
export async function maintenanceFingerprint(workspace: Workspace): Promise<string> {
  await ownGit(workspace);
  if ((await listGitlinks(workspace.root)).length) return fingerprint(await inspectGitManifest(workspace.root, { includeIgnored: true, enforceOwnedMetadata: true }));
  const source = await records(workspace, ["ls-files", "-co", "--exclude-standard", "-z"]);
  const artifacts = await ignoredArtifacts(workspace);
  // Hash local settings without publishing remote URLs or other configuration values.
  const config = await git(workspace.root, ["config", "--local", "--null", "--list"]);
  return fingerprint({ head: await head(workspace.root), status: await git(workspace.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), source, artifacts, config });
}
export async function reviewMaintenance(workspace: Workspace, plan: MaintenancePlan): Promise<MaintenanceReview> {
  await ownGit(workspace);
  const target = await head(workspace.root);
  const preparedClean = await clean(workspace.root);
  const text = await git(workspace.root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", workspace.git!.base, target, "--"]);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Maintenance review diff exceeds 4 MiB");
  const names = (await git(workspace.root, ["diff", "--name-status", "--no-renames", "-z", workspace.git!.base, target, "--"])).split("\0").filter(Boolean);
  const files: Diff["files"] = [];
  for (let index = 0; index < names.length; index += 2) {
    const status = names[index], name = names[index + 1];
    if (name) files.push({ path: name, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  const artifacts = await ignoredArtifacts(workspace);
  const artifactFingerprint = fingerprint(artifacts);
  const state = await maintenanceFingerprint(workspace);
  const diff: Diff = { text, files, fingerprint: fingerprint({ base: workspace.git!.base, target, state }) };
  const submodules = submoduleStates(await inspectGitManifest(workspace.root, { enforceOwnedMetadata: true }));
  return { base: workspace.git!.base, target, branch: workspace.git!.branch, ...(workspace.git!.upstream ? { upstream: workspace.git!.upstream } : {}), diff, artifacts, artifactFingerprint, preparedClean, fingerprint: fingerprint({ state, plan }), ...(submodules.length ? { submodules } : {}) };
}

interface SubmoduleState { path: string; commit: string; initialized: boolean; head?: string }
function submoduleStates(manifest: GitManifest, prefix = ""): SubmoduleState[] {
  return manifest.submodules.flatMap(child => [{ path: prefix + child.path, commit: child.commit, initialized: child.initialized, ...(child.manifest ? { head: child.manifest.head } : {}) }, ...(child.manifest ? submoduleStates(child.manifest, prefix + child.path + "/") : [])]);
}
async function savePrivateJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, filename); await chmod(filename, 0o600);
}
async function sourceSubmoduleBaseline(workspace: Workspace): Promise<SubmoduleState[]> {
  try { return JSON.parse(await readFile(path.join(path.dirname(workspace.root), "submodule-baseline.json"), "utf8")) as SubmoduleState[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await listGitlinks(workspace.original)).length) throw new Error("This run lacks its Git submodule baseline; create a new preview");
    return [];
  }
}
async function validateSourceSubmodules(workspace: Workspace): Promise<void> {
  const expected = await sourceSubmoduleBaseline(workspace);
  const actual = submoduleStates(await inspectGitManifest(workspace.original, { requireClean: true }));
  if (fingerprint(expected) !== fingerprint(actual)) throw new Error("Original Git submodule state changed; create a new preview");
}

interface SubmoduleApplyEntry { path: string; beforeHead: string; beforeSignature: string; configFingerprint: string; targetHead: string; afterSignature?: string }
interface SubmoduleApplyJournal { schemaVersion: 1; reviewFingerprint: string; base: string; target: string; entries: SubmoduleApplyEntry[]; initializedPaths: string[] }
function manifestRepositories(manifest: GitManifest, prefix = ""): Map<string, GitManifest> {
  const result = new Map<string, GitManifest>();
  for (const child of manifest.submodules) if (child.manifest) {
    const name = prefix + child.path; result.set(name, child.manifest);
    for (const [key, value] of manifestRepositories(child.manifest, name + "/")) result.set(key, value);
  }
  return result;
}
async function childRepository(root: string, name: string): Promise<string> {
  const child = relativeFile(root, name); await safeArtifactParents(root, name);
  const stat = await lstat(child);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(await realpath(child)).startsWith(root + path.sep)) throw new Error("Submodule application path is unsafe");
  if (await realpath((await git(child, ["rev-parse", "--show-toplevel"])).trim()) !== child) throw new Error("Submodule application metadata changed");
  return child;
}
async function ownSourceSignature(directory: string, state?: GitManifest): Promise<string> {
  const manifest = state ?? await inspectGitManifest(directory);
  const status = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (status) throw new Error("Initialized submodule has local changes");
  return fingerprint({ head: manifest.head, index: manifest.index, files: manifest.files, config: manifest.configFingerprint, branch: await optionalGit(directory, ["symbolic-ref", "--quiet", "HEAD"]) ?? null });
}
async function prepareSubmoduleApply(workspace: Workspace, review: MaintenanceReview, originalHead: string): Promise<{ journal: SubmoduleApplyJournal; filename: string }> {
  const filename = path.join(path.dirname(workspace.root), "submodule-apply-journal.json");
  const prepared = await inspectGitManifest(workspace.root, { requireClean: true, enforceOwnedMetadata: true });
  const targets = manifestRepositories(prepared);
  let journal: SubmoduleApplyJournal | undefined;
  try { journal = JSON.parse(await readFile(filename, "utf8")) as SubmoduleApplyJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (journal) {
    if (journal.schemaVersion !== 1 || journal.reviewFingerprint !== review.fingerprint || journal.base !== review.base || journal.target !== review.target) throw new Error("Submodule application journal does not match this review");
    for (const entry of journal.entries) if (targets.get(entry.path)?.head !== entry.targetHead) throw new Error("Prepared submodule target changed since application");
    return { journal, filename };
  }
  if (originalHead === review.base) await validateSourceSubmodules(workspace);
  const original = await inspectGitManifest(workspace.original, { requireClean: true });
  const sources = manifestRepositories(original), entries: SubmoduleApplyEntry[] = [];
  for (const [name, state] of sources) {
    const target = targets.get(name);
    if (!target) throw new Error(`Initialized submodule is missing from the prepared target: ${name}`);
    const source = await childRepository(workspace.original, name);
    entries.push({ path: name, beforeHead: state.head, beforeSignature: await ownSourceSignature(source, state), configFingerprint: state.configFingerprint, targetHead: target.head });
  }
  journal = { schemaVersion: 1, reviewFingerprint: review.fingerprint, base: review.base, target: review.target, entries, initializedPaths: [...sources.keys()].sort() };
  await savePrivateJson(filename, journal);
  return { journal, filename };
}
async function validateSubmoduleApply(workspace: Workspace, journal: SubmoduleApplyJournal): Promise<void> {
  const original = await inspectGitManifest(workspace.original);
  const sources = manifestRepositories(original);
  if (fingerprint([...sources.keys()].sort()) !== fingerprint(journal.initializedPaths)) throw new Error("Original submodule initialization changed during application");
  for (const entry of journal.entries) {
    const state = sources.get(entry.path)!;
    if (state.configFingerprint !== entry.configFingerprint) throw new Error(`Original submodule configuration changed: ${entry.path}`);
    const source = await childRepository(workspace.original, entry.path);
    const signature = await ownSourceSignature(source, state);
    if (entry.afterSignature) {
      if (signature !== entry.afterSignature) throw new Error(`Applied submodule changed after application: ${entry.path}`);
    } else if (state.head === entry.beforeHead) {
      if (signature !== entry.beforeSignature) throw new Error(`Original submodule changed before application: ${entry.path}`);
    } else if (state.head !== entry.targetHead) throw new Error(`Original submodule HEAD changed: ${entry.path}`);
  }
}
async function fetchSubmoduleTargets(workspace: Workspace, journal: SubmoduleApplyJournal, hooks: string): Promise<void> {
  await validateSubmoduleApply(workspace, journal);
  for (const entry of journal.entries) {
    const source = await childRepository(workspace.original, entry.path), prepared = await childRepository(workspace.root, entry.path);
    // Transfer only the reviewed object from the independent checkout, never a configured remote.
    await git(source, ["-c", `core.hooksPath=${hooks}`, "fetch", "--no-tags", prepared, entry.targetHead]);
    await git(source, ["cat-file", "-e", `${entry.targetHead}^{commit}`]);
  }
  await validateSubmoduleApply(workspace, journal);
}
async function syncSubmoduleTargets(workspace: Workspace, journal: SubmoduleApplyJournal, filename: string, hooks: string): Promise<void> {
  await validateSubmoduleApply(workspace, journal);
  for (const entry of journal.entries) {
    const source = await childRepository(workspace.original, entry.path);
    if (await head(source) !== entry.targetHead) {
      await validateSubmoduleApply(workspace, journal);
      await git(source, ["-c", `core.hooksPath=${hooks}`, "checkout", "--no-overwrite-ignore", "--detach", entry.targetHead]);
    }
    entry.afterSignature = await ownSourceSignature(source);
    await savePrivateJson(filename, journal);
  }
  await inspectGitManifest(workspace.original, { requireClean: true });
}

export interface ActivationSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}
export type ActivationSessionFactory = (cwd: string) => ActivationSession;
interface ConfigLayer { name: { type: string; file?: string; profile?: string | null }; version: string; config: unknown }
interface ActivationJournal {
  schemaVersion: 1; serverName: string; configPath: string; backupPath: string;
  before: Record<string, unknown>; desired: { command: string; args: string[] };
  beforeVersion: string; writtenVersion?: string; state: "prepared" | "written" | "verified" | "rollback_pending" | "rolled_back" | "failed";
}
async function userConfig(session: ActivationSession): Promise<ConfigLayer> {
  const response = object(await session.request("config/read", { includeLayers: true }));
  const layers = Array.isArray(response.layers) ? response.layers as ConfigLayer[] : [];
  const layer = layers.find(item => item.name?.type === "user" && !item.name.profile);
  if (!layer?.name.file || !layer.version) throw new Error("Codex did not expose a versioned user config layer");
  return layer;
}
const defaultSession: ActivationSessionFactory = cwd => new ProtocolSession(process.env.WORKFLOWS_CODEX_COMMAND ?? "codex", ["app-server"], cwd, 15000, 5000, () => {});
async function saveActivationJournal(filename: string, journal: ActivationJournal): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Activation journal directory cannot be a symbolic link");
  await chmod(directory, 0o700);
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" }); await rename(temporary, filename); await chmod(filename, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
async function retainConfigBackup(filename: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || !bytes.equals(await readFile(filename))) throw new Error("An orphaned activation backup does not match the current config; inspect it before retrying");
    await chmod(filename, 0o600);
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await rename(temporary, filename); await chmod(filename, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
function preservedServer(server: Record<string, unknown>) {
  const result = { ...server }; delete result.command; delete result.args; return result;
}
function desiredServer(server: Record<string, unknown>, journal: ActivationJournal): boolean {
  return server.command === journal.desired.command && fingerprint(server.args) === fingerprint(journal.desired.args) && fingerprint(preservedServer(server)) === fingerprint(preservedServer(journal.before));
}
export async function activateMcpServer(workspace: Workspace, activation: NonNullable<MaintenancePlan["activation"]>, sessionFactory: ActivationSessionFactory = defaultSession): Promise<ActivationResult> {
  const command = activation.command.replaceAll("${WORKSPACE}", workspace.root);
  const args = activation.args.map(value => value.replaceAll("${WORKSPACE}", workspace.root));
  const result: ActivationResult = { status: "pending_restart", serverName: activation.serverName, command, args };
  const session = sessionFactory(workspace.root);
  const journalPath = path.join(path.dirname(workspace.root), "activation-journal.json");
  let journal: ActivationJournal | undefined;
  let didWrite = false;
  try {
    await session.request("initialize", { clientInfo: { name: "workflows_activation", title: "Workflows activation", version: "0.3.0" }, capabilities: { experimentalApi: true } });
    session.send({ method: "initialized", params: {} });
    const layer = await userConfig(session);
    result.configPath = layer.name.file!;
    const server = object(object(object(layer.config).mcp_servers)[activation.serverName]);
    if (typeof server.command !== "string" || server.url !== undefined) throw new Error("Activation requires an existing user-configured stdio MCP server");
    try {
      const stat = await lstat(journalPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid activation journal file");
      journal = JSON.parse(await readFile(journalPath, "utf8")) as ActivationJournal;
      if (journal.schemaVersion !== 1 || journal.serverName !== activation.serverName || journal.configPath !== layer.name.file || fingerprint(journal.desired) !== fingerprint({ command, args }) || typeof journal.before.command !== "string") throw new Error("Activation journal does not match this reviewed plan");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const backup = path.join(path.dirname(workspace.root), "activation-config.backup.toml");
      await retainConfigBackup(backup, await readFile(layer.name.file!));
      journal = { schemaVersion: 1, serverName: activation.serverName, configPath: layer.name.file!, backupPath: backup, before: server, desired: { command, args }, beforeVersion: layer.version, state: "prepared" };
      await saveActivationJournal(journalPath, journal);
    }
    result.backupPath = journal.backupPath;
    // A previous write can have committed before its response or journal update was durable.
    if (desiredServer(server, journal)) { journal.state = "verified"; journal.writtenVersion = layer.version; await saveActivationJournal(journalPath, journal); return result; }
    if (fingerprint(server) !== fingerprint(journal.before)) throw new Error("MCP server changed since the saved activation preimage");
    const write = object(await session.request("config/batchWrite", { filePath: layer.name.file, expectedVersion: layer.version, edits: [
      { keyPath: `mcp_servers.${activation.serverName}.command`, value: command, mergeStrategy: "replace" },
      { keyPath: `mcp_servers.${activation.serverName}.args`, value: args, mergeStrategy: "replace" },
    ], reloadUserConfig: false }));
    if (typeof write.version !== "string") throw new Error("Codex did not return the configuration write version");
    didWrite = true; journal.writtenVersion = write.version; journal.state = "written";
    await saveActivationJournal(journalPath, journal);
    const updated = await userConfig(session);
    const actual = object(object(object(updated.config).mcp_servers)[activation.serverName]);
    if (write.status !== "ok" || !desiredServer(actual, journal)) throw new Error("Activation configuration was overridden or did not preserve the reviewed server settings");
    journal.state = "verified";
    await saveActivationJournal(journalPath, journal);
    return result;
  } catch {
    result.status = "failed";
    result.error = "MCP activation failed; the saved config backup is retained. No desktop connection was reloaded.";
    if (didWrite && journal?.writtenVersion) {
      try {
        const current = await userConfig(session);
        if (current.version !== journal.writtenVersion) throw new Error("Config changed after activation");
        journal.state = "rollback_pending"; await saveActivationJournal(journalPath, journal);
        await session.request("config/batchWrite", { filePath: current.name.file, expectedVersion: current.version, edits: [{ keyPath: `mcp_servers.${activation.serverName}`, value: journal.before, mergeStrategy: "replace" }], reloadUserConfig: false });
        const restored = await userConfig(session);
        if (fingerprint(object(object(restored.config).mcp_servers)[activation.serverName]) !== fingerprint(journal.before)) throw new Error("Config rollback verification failed");
        journal.state = "rolled_back"; await saveActivationJournal(journalPath, journal);
        result.error = "MCP activation failed; the original server settings were restored and verified. No desktop connection was reloaded.";
      } catch { result.error = "MCP activation failed; concurrent configuration changes prevented safe rollback. Inspect the retained backup and journal."; }
    }
    return result;
  } finally { await session.close(); }
}
export async function applyMaintenance(workspace: Workspace, review: MaintenanceReview, plan: MaintenancePlan, activationSessionFactory: ActivationSessionFactory = defaultSession): Promise<{ applied: boolean; conflicts: string[]; activation?: ActivationResult; partial?: boolean; error?: string }> {
  await ownGit(workspace);
  if (await realpath(workspace.original) !== path.resolve(workspace.original)) return { applied: false, conflicts: ["repository-path"] };
  const current = await reviewMaintenance(workspace, plan);
  if (current.fingerprint !== review.fingerprint || current.target !== review.target) throw new Error("Maintenance checkout or artifacts changed since review");
  if (!current.preparedClean) throw new Error("Maintenance checkout has uncommitted source changes; no automatic commit is allowed");
  const originalHead = await head(workspace.original);
  const hasSubmodules = (await sourceSubmoduleBaseline(workspace)).length > 0 || (await listGitlinks(workspace.root)).length > 0;
  if (await branch(workspace.original) !== review.branch || ![review.base, review.target].includes(originalHead)) return { applied: false, conflicts: ["repository-baseline"] };
  if (!hasSubmodules && !await clean(workspace.original)) return { applied: false, conflicts: ["repository-baseline"] };
  try { await git(workspace.root, ["merge-base", "--is-ancestor", review.base, review.target]); }
  catch { return { applied: false, conflicts: ["non-fast-forward-target"] }; }
  const hooks = await emptyHooks(path.join(path.dirname(workspace.root), "disabled-hooks"));
  let submoduleApplication: Awaited<ReturnType<typeof prepareSubmoduleApply>> | undefined;
  if (hasSubmodules) {
    try {
      if (await git(workspace.original, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])) throw new Error("Original repository has local changes");
      submoduleApplication = await prepareSubmoduleApply(workspace, review, originalHead);
      await fetchSubmoduleTargets(workspace, submoduleApplication.journal, hooks);
    } catch (error) {
      return { applied: originalHead === review.target && originalHead !== review.base, conflicts: ["submodule-baseline"], ...(originalHead === review.target && originalHead !== review.base ? { partial: true } : {}), error: (error as Error).message };
    }
  }
  if (originalHead !== review.target) {
    // Copy the verified commit without consulting the mutable remote again.
    await git(workspace.original, ["fetch", "--no-tags", workspace.root, review.target]);
    if (!await clean(workspace.original) || await head(workspace.original) !== review.base || await branch(workspace.original) !== review.branch) return { applied: false, conflicts: ["repository-changed-during-apply"] };
    if (submoduleApplication) await validateSubmoduleApply(workspace, submoduleApplication.journal);
    await git(workspace.original, ["-c", `core.hooksPath=${hooks}`, "merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", review.target]);
  }
  if (await head(workspace.original) !== review.target) throw new Error("Original repository did not reach the reviewed target");
  if (submoduleApplication) {
    try { await syncSubmoduleTargets(workspace, submoduleApplication.journal, submoduleApplication.filename, hooks); }
    catch (error) { return { applied: true, conflicts: ["submodule-application"], partial: true, error: (error as Error).message }; }
  }
  const activation = plan.activation ? await activateMcpServer(workspace, plan.activation, activationSessionFactory) : undefined;
  return { applied: true, conflicts: [], ...(activation ? { activation } : {}) };
}
