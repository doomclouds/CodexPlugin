import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { DesignError, designDocumentSchema, idSchema, validateDocument } from "./model.ts";
import type { DesignDocument } from "./model.ts";
import { applyPatches } from "./operations.ts";
import type { DesignPatch } from "./operations.ts";
import { createTemplate } from "./templates.ts";
import type { TemplateName } from "./templates.ts";

export interface DesignSummary { id: string; name: string; revision: number; updatedAt: string; artboardCount: number }
export interface RevisionEntry { revision: number; createdAt: string; operation: "create" | "apply" | "replace" | "undo" | "redo" | "restore"; restoredFrom?: number | undefined }
interface StoreRecord { schemaVersion: 1; current: DesignDocument; snapshots: DesignDocument[]; undo: number[]; redo: number[]; history: RevisionEntry[] }

const historySchema: z.ZodType<RevisionEntry> = z.object({ revision: z.number().int().positive().safe(), createdAt: z.string().datetime({ offset: true }), operation: z.enum(["create", "apply", "replace", "undo", "redo", "restore"]), restoredFrom: z.number().int().positive().safe().optional() }).strict();
const recordSchema: z.ZodType<StoreRecord> = z.object({ schemaVersion: z.literal(1), current: designDocumentSchema, snapshots: z.array(designDocumentSchema).min(1).max(50), undo: z.array(z.number().int().positive().safe()).max(50), redo: z.array(z.number().int().positive().safe()).max(50), history: z.array(historySchema).min(1).max(50) }).strict();
const MAX_STORE_BYTES = 96 * 1024 * 1024;

export class DesignStore {
  readonly dataDir: string;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? process.env.DESIGN_DATA_DIR;
    if (dataDir && !isAbsolute(dataDir)) throw new DesignError("VALIDATION", "The design data directory must be an absolute path");
    this.dataDir = dataDir ? resolve(dataDir) : join(homedir(), ".codex-design", "projects");
  }

  async list(): Promise<DesignSummary[]> {
    await this.prepare();
    const names = await readdir(this.dataDir);
    const result = await Promise.all(names.filter((name) => name.endsWith(".json") && idSchema.safeParse(name.slice(0, -5)).success).map(async (name) => {
      const record = await this.read(name.slice(0, -5));
      return { id: record.current.id, name: record.current.name, revision: record.current.revision, updatedAt: record.current.updatedAt, artboardCount: record.current.artboards.length };
    }));
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(input: { name: string; template?: TemplateName }): Promise<DesignDocument> {
    const document = createTemplate(input.name, input.template);
    return this.lock(document.id, async () => {
      try { await stat(this.filename(document.id)); throw new DesignError("REVISION_CONFLICT", "A design with this ID already exists"); }
      catch (error) { if (!isMissing(error)) throw error; }
      const record: StoreRecord = { schemaVersion: 1, current: document, snapshots: [document], undo: [], redo: [], history: [{ revision: 1, createdAt: document.createdAt, operation: "create" }] };
      await this.write(record);
      return structuredClone(document);
    });
  }

  async get(id: string): Promise<DesignDocument> { return structuredClone((await this.read(id)).current); }

  async apply(id: string, expectedRevision: number, patches: DesignPatch[]): Promise<DesignDocument> {
    return this.change(id, expectedRevision, "apply", (record) => applyPatches(record.current, patches));
  }

  async replace(id: string, expectedRevision: number, input: unknown): Promise<DesignDocument> {
    return this.change(id, expectedRevision, "replace", (record) => {
      const document = validateDocument(input);
      if (document.id !== id || document.createdAt !== record.current.createdAt || document.revision !== expectedRevision || document.updatedAt !== record.current.updatedAt) throw new DesignError("VALIDATION", "Replacing a document must preserve its ID and metadata");
      return document;
    });
  }

  async undo(id: string, expectedRevision: number): Promise<DesignDocument> {
    return this.change(id, expectedRevision, "undo", (record) => {
      const revision = record.undo.pop();
      if (revision === undefined) throw new DesignError("VALIDATION", "No earlier change is available to undo");
      record.redo.push(record.current.revision);
      return this.snapshot(record, revision);
    }, false);
  }

  async redo(id: string, expectedRevision: number): Promise<DesignDocument> {
    return this.change(id, expectedRevision, "redo", (record) => {
      const revision = record.redo.pop();
      if (revision === undefined) throw new DesignError("VALIDATION", "No undone change is available to redo");
      record.undo.push(record.current.revision);
      return this.snapshot(record, revision);
    }, false);
  }

  async history(id: string): Promise<RevisionEntry[]> { return structuredClone((await this.read(id)).history); }

  async restore(id: string, expectedRevision: number, revision: number): Promise<DesignDocument> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new DesignError("VALIDATION", "Revision must be a positive safe integer");
    return this.change(id, expectedRevision, "restore", (record) => this.snapshot(record, revision), true, revision);
  }

  private async change(id: string, expectedRevision: number, operation: RevisionEntry["operation"], build: (record: StoreRecord) => DesignDocument, addUndo = true, restoredFrom?: number): Promise<DesignDocument> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new DesignError("VALIDATION", "Expected revision must be a positive safe integer");
    return this.lock(id, async () => {
      const record = await this.read(id);
      if (record.current.revision !== expectedRevision) throw new DesignError("REVISION_CONFLICT", `Design revision changed: expected ${expectedRevision}, current ${record.current.revision}. Read the design and reapply the change.`);
      const next = build(record);
      if (addUndo) { record.undo.push(record.current.revision); record.redo = []; }
      const updatedAt = new Date().toISOString();
      record.current = validateDocument({ ...next, id, createdAt: record.current.createdAt, updatedAt, revision: expectedRevision + 1 });
      record.snapshots.push(record.current);
      record.history.push({ revision: record.current.revision, createdAt: updatedAt, operation, ...(restoredFrom === undefined ? {} : { restoredFrom }) });
      this.trimHistory(record);
      await this.write(record);
      return structuredClone(record.current);
    });
  }

  private snapshot(record: StoreRecord, revision: number): DesignDocument {
    const snapshot = record.snapshots.find((document) => document.revision === revision);
    if (!snapshot) throw new DesignError("NOT_FOUND", `Revision ${revision} is unavailable or has expired from the retained history`);
    return structuredClone(snapshot);
  }

  private trimHistory(record: StoreRecord): void {
    record.snapshots = record.snapshots.slice(-50);
    while (record.snapshots.length > 1 && Buffer.byteLength(JSON.stringify(record)) > MAX_STORE_BYTES) record.snapshots.shift();
    const retained = new Set(record.snapshots.map((document) => document.revision));
    record.undo = record.undo.filter((revision) => retained.has(revision)).slice(-50);
    record.redo = record.redo.filter((revision) => retained.has(revision)).slice(-50);
    record.history = record.history.filter((entry) => retained.has(entry.revision)).slice(-50);
  }

  private filename(id: string): string {
    if (!idSchema.safeParse(id).success) throw new DesignError("VALIDATION", "Invalid design ID");
    return join(this.dataDir, `${id}.json`);
  }

  private async prepare(): Promise<void> { await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); }

  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const filename = this.filename(id);
    await this.prepare();
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filename, { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.2 }, onCompromised: (error) => { compromised = error; } });
      if (compromised) throw new DesignError("LOCKED", "The design lock was lost");
      const result = await action();
      if (compromised) throw new DesignError("LOCKED", "The design lock was lost during the operation; read the current revision before retrying");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new DesignError("LOCKED", "This design is being updated by another process. Retry with its current revision.");
      throw error;
    } finally { if (release) await release(); }
  }

  private async read(id: string): Promise<StoreRecord> {
    const filename = this.filename(id);
    try {
      const info = await stat(filename);
      if (info.size > MAX_STORE_BYTES) throw new DesignError("VALIDATION", "Stored design exceeds its size budget");
      const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
      const result = recordSchema.safeParse(parsed);
      if (!result.success) throw new DesignError("VALIDATION", `Stored design is invalid: ${result.error.issues.slice(0, 4).map((issue) => issue.message).join("; ")}`);
      const record = result.data;
      const revisions = new Set(record.snapshots.map((document) => document.revision));
      if (record.current.id !== id || record.snapshots.some((document) => document.id !== id || document.createdAt !== record.current.createdAt) || revisions.size !== record.snapshots.length || !revisions.has(record.current.revision) || [...record.undo, ...record.redo, ...record.history.map((entry) => entry.revision)].some((revision) => !revisions.has(revision))) throw new DesignError("VALIDATION", "Stored revision history is inconsistent");
      return record;
    } catch (error) {
      if (isMissing(error)) throw new DesignError("NOT_FOUND", `Design not found: ${id}`);
      if (error instanceof SyntaxError) throw new DesignError("VALIDATION", "Stored design is not valid JSON");
      throw error;
    }
  }

  private async write(record: StoreRecord): Promise<void> {
    const filename = this.filename(record.current.id);
    const temporary = join(this.dataDir, `.${record.current.id}.${randomUUID()}.tmp`);
    const contents = JSON.stringify(record);
    if (Buffer.byteLength(contents) > MAX_STORE_BYTES) throw new DesignError("VALIDATION", "Stored design exceeds its size budget");
    const file = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
      await file.close();
      closed = true;
      await rename(temporary, filename);
      const directory = await open(this.dataDir, "r");
      try { await directory.sync(); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      finally { await directory.close(); }
    } finally {
      if (!closed) await file.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

function isMissing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
