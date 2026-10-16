import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { DesignError, idSchema, validateDocument } from "./model.ts";
import type { DesignDocument } from "./model.ts";
import type { DesignStore } from "./store.ts";
import { importHtml, writeProject } from "./export.ts";

type SourceFile = "design.json" | "index.html";
type SourceName = "json" | "html";
const SOURCE_FILES: SourceFile[] = ["design.json", "index.html"];
const limits = { "design.json": 32 * 1024 * 1024, "index.html": 16 * 1024 * 1024, "design-export.json": 16 * 1024 } as const;
const sha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");
const manifestSchema = z.object({
  projectId: idSchema,
  revision: z.number().int().positive().safe(),
  hashes: z.object({ "design.json": z.string().regex(/^[a-f0-9]{64}$/), "index.html": z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

export interface ProjectSyncState {
  projectId: string;
  directory: string;
  revision: number;
  baseRevision: number;
  changedFiles: SourceFile[];
  conflicts: string[];
}

export class ProjectSyncError extends Error {
  readonly code: "SYNC_CONFLICT" | "SYNC_VALIDATION" | "SYNC_PARTIAL" | "LOCKED";
  readonly partial: boolean;
  readonly savedRevision: number | undefined;
  readonly directory: string | undefined;
  constructor(code: ProjectSyncError["code"], message: string, details: { savedRevision?: number; directory?: string } = {}) {
    super(message);
    this.name = "ProjectSyncError";
    this.code = code;
    this.partial = details.savedRevision !== undefined;
    this.savedRevision = details.savedRevision;
    this.directory = details.directory;
  }
}

interface SourceSnapshot {
  manifest: Manifest;
  rawManifest: Buffer;
  contents: Record<SourceFile, Buffer>;
  hashes: Record<SourceFile, string>;
  changedFiles: SourceFile[];
}

async function canonicalDirectory(directory: string, create = false): Promise<string> {
  if (!isAbsolute(directory)) throw new ProjectSyncError("SYNC_VALIDATION", "Choose an absolute project directory");
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectSyncError("SYNC_VALIDATION", "The project directory must be a real directory, not a symlink");
  return realpath(resolve(directory));
}

export async function withProjectDirectoryLock<T>(directory: string, action: (canonical: string) => Promise<T>, create = false): Promise<T> {
  const canonical = await canonicalDirectory(directory, create);
  let compromised: Error | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(join(canonical, ".design-sync"), { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.2 }, onCompromised: (error) => { compromised = error; } });
    if (compromised) throw new ProjectSyncError("LOCKED", "The project synchronization lock was lost");
    const result = await action(canonical);
    if (compromised) throw new ProjectSyncError("LOCKED", "The project synchronization lock was lost; inspect the saved project before retrying");
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ProjectSyncError("LOCKED", "Another process is synchronizing this project directory");
    throw error;
  } finally { if (release) await release(); }
}

async function boundedFile(directory: string, name: keyof typeof limits): Promise<Buffer> {
  const filename = join(directory, name);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits[name]) throw new ProjectSyncError("SYNC_VALIDATION", `${name} must be a regular file within its size budget`);
  if (dirname(await realpath(filename)) !== directory) throw new ProjectSyncError("SYNC_VALIDATION", `${name} must remain inside the project directory`);
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > limits[name] || opened.dev !== info.dev || opened.ino !== info.ino) throw new ProjectSyncError("SYNC_CONFLICT", `${name} changed while it was being opened`);
    const bytes = await file.readFile();
    if (bytes.length > limits[name]) throw new ProjectSyncError("SYNC_VALIDATION", `${name} exceeds its size budget`);
    return bytes;
  } finally { await file.close(); }
}

async function sourceSnapshot(directory: string): Promise<SourceSnapshot> {
  const [rawManifest, json, html] = await Promise.all([boundedFile(directory, "design-export.json"), boundedFile(directory, "design.json"), boundedFile(directory, "index.html")]);
  let manifest: Manifest;
  try { manifest = manifestSchema.parse(JSON.parse(rawManifest.toString("utf8"))); }
  catch { throw new ProjectSyncError("SYNC_VALIDATION", "The project synchronization manifest is invalid"); }
  const contents = { "design.json": json, "index.html": html };
  const hashes = { "design.json": sha256(json), "index.html": sha256(html) };
  return { manifest, rawManifest, contents, hashes, changedFiles: SOURCE_FILES.filter((name) => hashes[name] !== manifest.hashes[name]) };
}

function inspectState(document: DesignDocument, directory: string, snapshot: SourceSnapshot): ProjectSyncState {
  const conflicts: string[] = [];
  if (snapshot.manifest.projectId !== document.id) conflicts.push("The source directory belongs to a different Design project");
  if (snapshot.manifest.revision !== document.revision) conflicts.push(`The canvas has revision ${document.revision}, but source files are based on revision ${snapshot.manifest.revision}`);
  if (snapshot.changedFiles.length > 1) conflicts.push("Both design.json and index.html changed; choose source 'json' or 'html' explicitly");
  return { projectId: document.id, directory, revision: document.revision, baseRevision: snapshot.manifest.revision, changedFiles: snapshot.changedFiles, conflicts };
}

export async function readProject(store: DesignStore, input: { projectId: string; directory: string }): Promise<ProjectSyncState> {
  return withProjectDirectoryLock(input.directory, async (directory) => {
    const [document, snapshot] = await Promise.all([store.get(input.projectId), sourceSnapshot(directory)]);
    return inspectState(document, directory, snapshot);
  });
}

function validateSourceIdentity(document: DesignDocument, current: DesignDocument, manifest: Manifest): void {
  if (document.id !== current.id || document.id !== manifest.projectId || document.revision !== manifest.revision || document.createdAt !== current.createdAt || document.updatedAt !== current.updatedAt) throw new ProjectSyncError("SYNC_CONFLICT", "Source project identity or base revision metadata differs from the current canvas; reconcile it before importing");
}

async function verifyUnchanged(directory: string, snapshot: SourceSnapshot): Promise<void> {
  const latest = await sourceSnapshot(directory);
  if (sha256(latest.rawManifest) !== sha256(snapshot.rawManifest) || SOURCE_FILES.some((name) => latest.hashes[name] !== snapshot.hashes[name])) throw new ProjectSyncError("SYNC_CONFLICT", "Source files changed during synchronization; no unreviewed source file will be overwritten");
}

async function acknowledgeSources(directory: string, snapshot: SourceSnapshot): Promise<void> {
  const temporary = join(directory, `.design-sync-${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify({ ...snapshot.manifest, hashes: snapshot.hashes }, null, 2), "utf8");
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, join(directory, "design-export.json"));
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function importProject(store: DesignStore, input: { projectId: string; expectedRevision: number; directory: string; source?: SourceName }): Promise<{ document: DesignDocument; directory: string }> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new ProjectSyncError("SYNC_VALIDATION", "Expected revision must be a positive safe integer");
  if (input.source !== undefined && input.source !== "json" && input.source !== "html") throw new ProjectSyncError("SYNC_VALIDATION", "Source must be 'json' or 'html'");
  return withProjectDirectoryLock(input.directory, async (directory) => {
    const [current, snapshot] = await Promise.all([store.get(input.projectId), sourceSnapshot(directory)]);
    if (current.revision !== input.expectedRevision) throw new DesignError("REVISION_CONFLICT", `Expected canvas revision ${input.expectedRevision}, current revision ${current.revision}. Read and reconcile the latest canvas before importing.`);
    const state = inspectState(current, directory, snapshot);
    if (snapshot.manifest.projectId !== current.id || snapshot.manifest.revision !== current.revision) throw new ProjectSyncError("SYNC_CONFLICT", state.conflicts.join("; "));
    if (snapshot.changedFiles.length > 1 && input.source === undefined) throw new ProjectSyncError("SYNC_CONFLICT", "Both design.json and index.html changed. Choose source 'json' or 'html' explicitly after reviewing both files.");
    if (snapshot.changedFiles.length === 0) return { document: current, directory };
    const source = input.source ?? (snapshot.changedFiles[0] === "index.html" ? "html" : "json");
    if (!snapshot.changedFiles.includes(source === "json" ? "design.json" : "index.html")) throw new ProjectSyncError("SYNC_CONFLICT", "The selected source file has no changes; select the changed file or reconcile the source directory");
    // Validate both representations before acknowledging either file for replacement.
    let json: DesignDocument;
    let html: DesignDocument;
    try {
      json = validateDocument(JSON.parse(snapshot.contents["design.json"].toString("utf8")));
      html = importHtml(snapshot.contents["index.html"].toString("utf8"), current);
    } catch (error) {
      throw new ProjectSyncError("SYNC_VALIDATION", `Source validation failed: ${error instanceof Error ? error.message : "invalid source"}`);
    }
    validateSourceIdentity(json, current, snapshot.manifest);
    validateSourceIdentity(html, current, snapshot.manifest);
    if (source === "html" && JSON.stringify(html) === JSON.stringify(current)) throw new ProjectSyncError("SYNC_CONFLICT", "The HTML file changed, but its edits do not map to editable Design content. The canvas and source files were preserved. Reconcile unsupported DOM, stylesheet or script edits before importing.");
    await verifyUnchanged(directory, snapshot);
    const saved = await store.replace(current.id, input.expectedRevision, source === "json" ? json : html);
    try {
      await verifyUnchanged(directory, snapshot);
      await acknowledgeSources(directory, snapshot);
      await writeProject(saved, directory);
      const latest = await store.get(saved.id);
      if (latest.revision !== saved.revision) throw new ProjectSyncError("SYNC_CONFLICT", `The canvas advanced to revision ${latest.revision} while source revision ${saved.revision} was being written; export the latest canvas after reconciling the source`);
    } catch (error) {
      throw new ProjectSyncError("SYNC_PARTIAL", `Canvas revision ${saved.revision} was saved, but source synchronization is incomplete: ${error instanceof Error ? error.message : "source update failed"}. Read the saved canvas and reconcile/export the source directory before another import.`, { savedRevision: saved.revision, directory });
    }
    return { document: saved, directory };
  });
}

export async function writeProjectLocked(document: DesignDocument, directory: string): ReturnType<typeof writeProject> {
  return withProjectDirectoryLock(directory, (canonical) => writeProject(document, canonical), true);
}

export class ProjectSync {
  readonly store: DesignStore;
  constructor(store: DesignStore) { this.store = store; }
  read(input: { projectId: string; directory: string }): Promise<ProjectSyncState> { return readProject(this.store, input); }
  import(input: { projectId: string; expectedRevision: number; directory: string; source?: SourceName }): Promise<{ document: DesignDocument; directory: string }> { return importProject(this.store, input); }
}
