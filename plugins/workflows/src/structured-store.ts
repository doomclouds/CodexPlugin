import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, lstatSync, chmodSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowDefinition } from "./definition.ts";
import type { StructuredDefinitionRecord } from "./structured-types.ts";

export interface StoredRun { id: string; revision: number; status: string; projectPath: string; createdAt: string; updatedAt: string; }
export interface StoredDefinition extends StructuredDefinitionRecord {}
export interface StoredEvent { runId: string; sequence: number; type: string; at: string; instanceId?: string; payload?: unknown; }
export type EventInput = Omit<StoredEvent, "runId" | "sequence" | "at"> & { at?: string };
export interface StoredCheckpoint { id: string; runId: string; revision: number; fingerprint: string; createdAt: string; snapshot: unknown; }
export interface CheckpointManifest { format: "structured-checkpoint-v1"; runId: string; revision: number; definitionHash: string | null; eventSequence: number; fingerprint: string; committedAt: string; }
export interface CommitOptions { expectedRevision: number; events?: EventInput[]; checkpoint?: { fingerprint: string; id?: string }; }
export interface ControlRequest { id: string; runId: string; ownerToken: string; action: "pause" | "stop"; status: "pending" | "accepted" | "completed"; createdAt: string; }
export interface DeletionScope { runs: Array<{ id: string; revision: number }>; definition?: { id: string; revision: number }; }
export class RevisionConflictError extends Error { constructor() { super("Workflow revision changed; refresh before retrying."); this.name = "RevisionConflictError"; } }

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
function encode(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error("Structured workflow snapshot exceeds the storage limit.");
  return serialized;
}
function parse<T>(value: unknown): T { if (typeof value !== "string") throw new Error("Invalid structured workflow storage record."); return JSON.parse(value) as T; }
function existsWithoutLink(filename: string): void {
  try { if (lstatSync(filename).isSymbolicLink()) throw new Error("Structured workflow storage refuses symbolic links."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** A separate SQLite namespace: no legacy JSON is read or migrated. */
export class StructuredStore<T extends StoredRun = StoredRun> {
  readonly directory: string;
  readonly filename: string;
  readonly #db: DatabaseSync;
  #closed = false;
  get root(): string { return this.directory; }

  constructor(root: string) {
    const requestedDirectory = path.join(path.resolve(root), "structured-v1");
    existsWithoutLink(requestedDirectory);
    mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(requestedDirectory);
    if (!lstatSync(this.directory).isDirectory()) throw new Error("Structured workflow storage is not a directory.");
    this.filename = path.join(this.directory, "workflows.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) existsWithoutLink(this.filename + suffix);
    this.#db = new DatabaseSync(this.filename);
    if (process.platform !== "win32") { chmodSync(this.directory, 0o700); chmodSync(this.filename, 0o600); }
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS definitions (
        id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY (id, revision)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
        project_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_path, created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
        type TEXT NOT NULL, at TEXT NOT NULL, instance_id TEXT, payload TEXT,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL,
        revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS owners (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        token TEXT NOT NULL, pid INTEGER NOT NULL, claimed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS controls (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_intents (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS definition_deletion_intents (definition_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }

  #transaction<R>(operation: () => R): R {
    if (this.#closed) throw new Error("Structured workflow storage is closed.");
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  get(id: string): T {
    const row = this.#db.prepare("SELECT snapshot FROM runs WHERE id = ?").get(id);
    if (!row) throw new Error("Workflow run not found.");
    return parse<T>(row.snapshot);
  }
  has(id: string): boolean { return !!this.#db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id); }
  list(options: { projectPath?: string; limit?: number; offset?: number } = {}): T[] {
    const limit = options.limit ?? 100, offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid workflow page.");
    const rows = options.projectPath === undefined
      ? this.#db.prepare("SELECT snapshot FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset)
      : this.#db.prepare("SELECT snapshot FROM runs WHERE project_path = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(options.projectPath, limit, offset);
    return rows.map(row => parse<T>(row.snapshot));
  }
  listForDefinition(id: string): T[] { return this.#db.prepare("SELECT snapshot FROM runs WHERE json_extract(snapshot, '$.sourceDefinition.id') = ? ORDER BY created_at, id").all(id).map(row => parse<T>(row.snapshot)); }
  listProject(projectPath: string): T[] { return this.#db.prepare("SELECT snapshot FROM runs WHERE project_path = ? ORDER BY created_at, id").all(projectPath).map(row => parse<T>(row.snapshot)); }
  create(run: T, events: EventInput[] = []): T {
    if (run.revision !== 1) throw new Error("A new workflow must start at revision 1.");
    return this.#transaction(() => {
      const source = (run as T & { sourceDefinition?: { id: string; revision: number } }).sourceDefinition;
      if (source) { if (this.#db.prepare("SELECT 1 FROM definition_deletion_intents WHERE definition_id = ?").get(source.id)) throw new Error("Workflow definition is being deleted."); this.getDefinition(source.id, source.revision); }
      this.#db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(run.id, run.revision, run.status, run.projectPath, run.createdAt, run.updatedAt, encode(run));
      this.#appendEvents(run.id, events);
      return this.get(run.id);
    });
  }
  #save(run: T, options: CommitOptions): T {
    this.#assertNotDeleting(run.id);
    if (run.revision !== options.expectedRevision + 1) throw new Error("Workflow commits must increment revision exactly once.");
    const result = this.#db.prepare("UPDATE runs SET revision = ?, status = ?, project_path = ?, updated_at = ?, snapshot = ? WHERE id = ? AND revision = ?")
      .run(run.revision, run.status, run.projectPath, run.updatedAt, encode(run), run.id, options.expectedRevision);
    if (result.changes !== 1) throw new RevisionConflictError();
    this.#appendEvents(run.id, options.events ?? []);
    if (options.checkpoint) {
      const state = run as T & { definitionHash?: string; events?: Array<{ sequence: number }> };
      const manifest: CheckpointManifest = { format: "structured-checkpoint-v1", runId: run.id, revision: run.revision, definitionHash: state.definitionHash ?? null, eventSequence: state.events?.at(-1)?.sequence ?? 0, fingerprint: options.checkpoint.fingerprint, committedAt: run.updatedAt };
      this.#db.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)")
        .run(run.id, options.checkpoint.id ?? `cp_${randomUUID()}`, run.revision, options.checkpoint.fingerprint, run.updatedAt, encode(manifest));
    }
    return this.get(run.id);
  }
  save(run: T, options: CommitOptions): T { return this.#transaction(() => this.#save(run, options)); }
  update(id: string, mutate: (run: T) => void, events: EventInput[] = [], checkpoint?: { fingerprint: string; id?: string }): T {
    return this.#transaction(() => {
      const run = this.get(id), expectedRevision = run.revision;
      mutate(run); run.revision = expectedRevision + 1; run.updatedAt = new Date().toISOString();
      return this.#save(run, { expectedRevision, events, ...(checkpoint ? { checkpoint } : {}) });
    });
  }
  #appendEvents(runId: string, events: EventInput[]): void {
    const row = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE run_id = ?").get(runId)!;
    let sequence = Number(row.n);
    const insert = this.#db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)");
    for (const event of events) insert.run(runId, ++sequence, event.type, event.at ?? new Date().toISOString(), event.instanceId ?? null, event.payload === undefined ? null : encode(event.payload));
  }
  events(runId: string, options: { after?: number; limit?: number } = {}): StoredEvent[] {
    const after = options.after ?? 0, limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid workflow event page.");
    return this.#db.prepare("SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(runId, after, limit)
      .map(row => ({ runId, sequence: Number(row.sequence), type: String(row.type), at: String(row.at), ...(row.instance_id === null ? {} : { instanceId: String(row.instance_id) }), ...(row.payload === null ? {} : { payload: parse<unknown>(row.payload) }) }));
  }
  checkpoints(runId: string): StoredCheckpoint[] {
    return this.#db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY revision DESC").all(runId)
      .map(row => ({ id: String(row.id), runId, revision: Number(row.revision), fingerprint: String(row.fingerprint), createdAt: String(row.created_at), snapshot: parse<unknown>(row.snapshot) }));
  }
  saveDefinition(input: { id?: string; definition: WorkflowDefinition; hash?: string } & Pick<StoredDefinition, "args" | "grants" | "limits">, expectedRevision?: number): StoredDefinition {
    return this.#transaction(() => {
      const id = input.id ?? `def_${randomUUID()}`, latest = this.#db.prepare("SELECT snapshot FROM definitions WHERE id = ? ORDER BY revision DESC LIMIT 1").get(id);
      if (this.#db.prepare("SELECT 1 FROM definition_deletion_intents WHERE definition_id = ?").get(id)) throw new Error("Workflow definition is being deleted.");
      const previous = latest ? parse<StoredDefinition>(latest.snapshot) : undefined;
      if ((previous?.revision ?? 0) !== (expectedRevision ?? 0)) throw new RevisionConflictError();
      const now = new Date().toISOString(), serialized = encode(input.definition);
      const record: StoredDefinition = { id, revision: (previous?.revision ?? 0) + 1, definition: input.definition, hash: input.hash ?? createHash("sha256").update(serialized).digest("hex"), createdAt: previous?.createdAt ?? now, updatedAt: now, ...(input.args === undefined ? {} : { args: input.args }), ...(input.grants === undefined ? {} : { grants: input.grants }), ...(input.limits === undefined ? {} : { limits: input.limits }) };
      this.#db.prepare("INSERT INTO definitions VALUES (?, ?, ?, ?, ?, ?)").run(id, record.revision, record.hash, record.createdAt, now, encode(record));
      return parse<StoredDefinition>(encode(record));
    });
  }
  getDefinition(id: string, revision?: number): StoredDefinition {
    const row = revision === undefined
      ? this.#db.prepare("SELECT snapshot FROM definitions WHERE id = ? ORDER BY revision DESC LIMIT 1").get(id)
      : this.#db.prepare("SELECT snapshot FROM definitions WHERE id = ? AND revision = ?").get(id, revision);
    if (!row) throw new Error("Workflow definition not found.");
    return parse<StoredDefinition>(row.snapshot);
  }
  listDefinitions(): StoredDefinition[] {
    return this.#db.prepare("SELECT d.snapshot FROM definitions d JOIN (SELECT id, MAX(revision) AS revision FROM definitions GROUP BY id) latest ON latest.id = d.id AND latest.revision = d.revision ORDER BY d.updated_at DESC").all().map(row => parse<StoredDefinition>(row.snapshot));
  }
  deleteDefinition(id: string, expectedRevision: number): void {
    this.#transaction(() => { if (this.getDefinition(id).revision !== expectedRevision) throw new RevisionConflictError(); this.#db.prepare("DELETE FROM definitions WHERE id = ?").run(id); });
  }
  delete(id: string, expectedRevision?: number): void {
    this.#transaction(() => {
      if (expectedRevision !== undefined && this.get(id).revision !== expectedRevision) throw new RevisionConflictError();
      if (this.owner(id)?.alive) throw new Error("Stop the owning workflow executor before deletion.");
      this.#db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    });
  }
  owner(id: string): { token: string; pid: number; alive: boolean } | undefined {
    const row = this.#db.prepare("SELECT token, pid FROM owners WHERE run_id = ?").get(id);
    if (!row) return undefined;
    const pid = Number(row.pid); let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    return { token: String(row.token), pid, alive };
  }
  claim(id: string, token: string, expectedRevision?: number): void {
    this.#transaction(() => {
      if (expectedRevision !== undefined && this.get(id).revision !== expectedRevision) throw new RevisionConflictError(); else this.get(id);
      this.#assertNotDeleting(id);
      const existing = this.owner(id);
      if (existing?.alive && existing.token !== token) throw new Error("Workflow is owned by another active executor.");
      this.#db.prepare("INSERT INTO owners VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET token = excluded.token, pid = excluded.pid, claimed_at = excluded.claimed_at").run(id, token, process.pid, new Date().toISOString());
    });
  }
  release(id: string, token: string): void { this.#db.prepare("DELETE FROM owners WHERE run_id = ? AND token = ?").run(id, token); }
  requestControl(runId: string, expectedRevision: number, action: "pause" | "stop", expectedOwnerToken?: string): ControlRequest {
    return this.#transaction(() => {
      const run = this.get(runId);
      const owner = this.owner(runId); if (!owner?.alive) throw new Error("The workflow no longer has an active executor.");
      if (expectedOwnerToken !== undefined) {
        if (owner.token !== expectedOwnerToken || expectedRevision > run.revision) throw new Error("The workflow execution owner changed; refresh before issuing a control request.");
      } else if (run.revision !== expectedRevision) throw new RevisionConflictError();
      const existing = this.#db.prepare("SELECT * FROM controls WHERE run_id = ? AND owner_token = ? AND action = ? AND status != 'completed' ORDER BY created_at LIMIT 1").get(runId, owner.token, action);
      if (existing) return this.#controlRow(existing);
      const request: ControlRequest = { id: `control_${randomUUID()}`, runId, ownerToken: owner.token, action, status: "pending", createdAt: new Date().toISOString() };
      this.#db.prepare("INSERT INTO controls VALUES (?, ?, ?, ?, ?, ?)").run(request.id, runId, request.ownerToken, action, request.status, request.createdAt);
      return request;
    });
  }
  #controlRow(row: Record<string, unknown>): ControlRequest { return { id: String(row.id), runId: String(row.run_id), ownerToken: String(row.owner_token), action: row.action as ControlRequest["action"], status: row.status as ControlRequest["status"], createdAt: String(row.created_at) }; }
  readControls(runId: string, ownerToken: string): ControlRequest[] { return this.#db.prepare("SELECT * FROM controls WHERE run_id = ? AND owner_token = ? AND status = 'pending' ORDER BY created_at, id").all(runId, ownerToken).map(row => this.#controlRow(row)); }
  acceptControl(id: string, ownerToken: string): void { this.#db.prepare("UPDATE controls SET status = 'accepted' WHERE id = ? AND owner_token = ? AND status = 'pending'").run(id, ownerToken); }
  completeControls(runId: string, ownerToken: string): void { this.#db.prepare("UPDATE controls SET status = 'completed' WHERE run_id = ? AND owner_token = ?").run(runId, ownerToken); }
  getControl(id: string): ControlRequest | undefined { const row = this.#db.prepare("SELECT * FROM controls WHERE id = ?").get(id); return row ? this.#controlRow(row) : undefined; }
  #assertNotDeleting(id: string): void { if (this.#db.prepare("SELECT 1 FROM deletion_intents WHERE run_id = ?").get(id)) throw new Error("Workflow deletion is in progress; complete deletion before modifying or executing it."); }
  deletionPending(id: string): boolean { return !!this.#db.prepare("SELECT 1 FROM deletion_intents WHERE run_id = ?").get(id); }
  beginDeletion(scope: DeletionScope, fingerprint: string): void {
    this.#transaction(() => {
      if (scope.definition) {
        if (this.getDefinition(scope.definition.id).revision !== scope.definition.revision) throw new RevisionConflictError();
        const actual = this.listForDefinition(scope.definition.id).map(run => `${run.id}:${run.revision}`).sort();
        if (JSON.stringify(actual) !== JSON.stringify(scope.runs.map(run => `${run.id}:${run.revision}`).sort())) throw new Error("Associated workflow runs changed; refresh the deletion preview.");
      }
      for (const item of scope.runs) {
        const run = this.get(item.id); if (run.revision !== item.revision) throw new RevisionConflictError();
        if (this.owner(item.id)?.alive || ["preparing", "running", "pausing", "stopping", "unknown"].includes(run.status)) throw new Error("Stop and reconcile workflow execution before deletion.");
      }
      for (const item of scope.runs) this.#db.prepare("INSERT INTO deletion_intents VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET fingerprint = excluded.fingerprint").run(item.id, fingerprint);
      if (scope.definition) this.#db.prepare("INSERT INTO definition_deletion_intents VALUES (?, ?) ON CONFLICT(definition_id) DO UPDATE SET fingerprint = excluded.fingerprint").run(scope.definition.id, fingerprint);
    });
  }
  finishDeletion(scope: DeletionScope, fingerprint: string): void {
    this.#transaction(() => {
      for (const item of scope.runs) {
        const intent = this.#db.prepare("SELECT fingerprint FROM deletion_intents WHERE run_id = ?").get(item.id);
        if (intent?.fingerprint !== fingerprint || this.get(item.id).revision !== item.revision || this.owner(item.id)?.alive) throw new Error("Workflow deletion scope changed.");
      }
      if (scope.definition) {
        const intent = this.#db.prepare("SELECT fingerprint FROM definition_deletion_intents WHERE definition_id = ?").get(scope.definition.id);
        if (intent?.fingerprint !== fingerprint || this.getDefinition(scope.definition.id).revision !== scope.definition.revision) throw new Error("Workflow definition deletion scope changed.");
      }
      for (const item of scope.runs) this.#db.prepare("DELETE FROM runs WHERE id = ?").run(item.id);
      if (scope.definition) { this.#db.prepare("DELETE FROM definitions WHERE id = ?").run(scope.definition.id); this.#db.prepare("DELETE FROM definition_deletion_intents WHERE definition_id = ?").run(scope.definition.id); }
    });
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}
