import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Task, WorkflowRun } from "./types.ts";
import { RunStore } from "./store.ts";

export type CheckpointReason = "initial" | "node" | "final" | "recovery";
export interface CheckpointRef { id: string; sequence: number; createdAt: string; digest: string; reason: CheckpointReason; completedTasks: number }
export interface CheckpointNode { taskId: string; index: number; attemptId?: string; fingerprint: string; status: string; outputDigest?: string; label?: string; phase?: string }
export interface CheckpointManifest extends Omit<CheckpointRef, "digest"> {
  schemaVersion: 1; previous?: CheckpointRef; planDigest: string; workspaceFingerprint: string; nodes: CheckpointNode[];
}
export interface TaskHistoryRef { id: string; taskId: string; index: number; status: Task["status"]; attempts: number; createdAt: string; digest: string; reason: string; label?: string; phase?: string }
interface TaskHistoryEnvelope { schemaVersion: 1; history: TaskHistoryRef; task: Task; integrityDigest: string }

const manifestLimit = 1024 * 1024, historyLimit = 32 * 1024 * 1024, maxNodes = 1000, maxChain = 10000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const encode = (value: unknown) => JSON.stringify(canonical(value));
const hash = (value: unknown) => sha(encode(value));
const equal = (left: unknown, right: unknown) => encode(left) === encode(right);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const reason = (value: unknown): value is CheckpointReason => typeof value === "string" && ["initial", "node", "final", "recovery"].includes(value);
function reference(value: unknown): asserts value is CheckpointRef {
  if (!object(value) || typeof value.id !== "string" || !/^cp_[a-f0-9]{24}$/.test(value.id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !instant(value.createdAt) || !hex(value.digest) || !reason(value.reason) || !Number.isSafeInteger(value.completedTasks) || Number(value.completedTasks) < 0 || Number(value.completedTasks) > maxNodes) throw new Error("Invalid node checkpoint reference");
}
function nodes(value: unknown): asserts value is CheckpointNode[] {
  if (!Array.isArray(value) || value.length > maxNodes) throw new Error("Node checkpoint exceeds its 1000-node limit");
  const indexes = new Set<number>();
  for (const node of value) {
    if (!object(node) || !Number.isSafeInteger(node.index) || Number(node.index) < 0 || node.taskId !== `task_${Number(node.index) + 1}` || indexes.has(Number(node.index)) || !hex(node.fingerprint) || !text(node.status, 64) || (node.attemptId !== undefined && !text(node.attemptId, 256)) || (node.outputDigest !== undefined && !hex(node.outputDigest)) || (node.label !== undefined && !text(node.label, 2048)) || (node.phase !== undefined && !text(node.phase, 2048))) throw new Error("Invalid node checkpoint task entry");
    indexes.add(Number(node.index));
  }
}
function manifest(value: unknown, ref: CheckpointRef): asserts value is CheckpointManifest {
  if (!object(value) || value.schemaVersion !== 1 || !equal({ id: value.id, sequence: value.sequence, createdAt: value.createdAt, reason: value.reason, completedTasks: value.completedTasks }, { id: ref.id, sequence: ref.sequence, createdAt: ref.createdAt, reason: ref.reason, completedTasks: ref.completedTasks }) || !hex(value.planDigest) || !text(value.workspaceFingerprint, 4096)) throw new Error("Node checkpoint manifest identity is invalid");
  nodes(value.nodes);
  if (value.nodes.filter(node => node.status === "completed").length !== ref.completedTasks) throw new Error("Node checkpoint completed-task count is invalid");
  if (value.previous !== undefined) {
    reference(value.previous);
    if (value.previous.id === ref.id || value.previous.sequence !== ref.sequence - 1) throw new Error("Node checkpoint previous link is invalid");
  } else if (ref.sequence !== 1) throw new Error("Node checkpoint chain is missing its previous link");
}
function page(input: { offset?: number; limit?: number }) {
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid checkpoint history page; limit must be between 1 and 100");
  return { offset, limit };
}
function taskRecord(value: unknown): asserts value is Task {
  if (!object(value) || !Number.isSafeInteger(value.index) || Number(value.index) < 0 || value.id !== `task_${Number(value.index) + 1}` || typeof value.prompt !== "string" || !object(value.options) || !["read", "write"].includes(String(value.mode)) || !["queued", "running", "completed", "failed", "interrupted", "stopping"].includes(String(value.status)) || !Array.isArray(value.attempts) || typeof value.cached !== "boolean") throw new Error("Invalid archived workflow task");
}

export class CheckpointStore {
  private readonly store: RunStore;
  constructor(store: RunStore) { this.store = store; }
  private async existing(id: string) { await this.store.assertWritable(id); return this.store.loadForDeletion(id); }
  private async directory(id: string, kind: "checkpoints" | "history", create = false) {
    this.store.directory(id); return this.store.ownedDirectory(path.join(id, kind), create);
  }
  private async bytes(id: string, kind: "checkpoints" | "history", name: string, maximum: number) {
    const directory = await this.directory(id, kind), filename = path.join(directory, `${name}.json`);
    const ownedFilename = path.join(await realpath(directory), `${name}.json`);
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum || await realpath(filename) !== ownedFilename) throw new Error("Invalid private checkpoint artifact");
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) throw new Error("Checkpoint artifact ownership changed");
      const chunks: Buffer[] = []; let size = 0;
      while (size <= maximum) {
        const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - size));
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maximum) throw new Error("Checkpoint artifact exceeds its bounded read limit");
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const content = Buffer.concat(chunks, size).toString("utf8"), after = await file.stat(), current = await lstat(filename);
      if (Buffer.byteLength(content) > maximum || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || await realpath(filename) !== ownedFilename) throw new Error("Checkpoint artifact changed while being read");
      await this.directory(id, kind); return content;
    } finally { await file.close(); }
  }
  private async immutable(id: string, kind: "checkpoints" | "history", name: string, content: string) {
    const directory = await this.directory(id, kind, true), target = path.join(directory, `${name}.json`);
    try { await lstat(target); throw new Error("Immutable checkpoint artifact already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = path.join(directory, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await this.directory(id, kind); await this.store.assertWritable(id); await this.store.loadForDeletion(id);
      await rename(temporary, target);
      // Windows flushes the file above; it has no equivalent POSIX parent-fsync guarantee.
      if (process.platform !== "win32") {
        const parent = await open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
        const runDirectory = await open(path.dirname(directory), "r");
        try { await runDirectory.sync(); } finally { await runDirectory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  }
  private async readOne(runId: string, ref: CheckpointRef) {
    reference(ref);
    const content = await this.bytes(runId, "checkpoints", ref.id, manifestLimit);
    if (sha(content) !== ref.digest) throw new Error("Node checkpoint digest does not match its committed reference");
    const value: unknown = JSON.parse(content); manifest(value, ref); return value;
  }
  async write(run: WorkflowRun, input: { reason: CheckpointReason; planDigest: string; workspaceFingerprint: string; nodes: CheckpointNode[] }): Promise<CheckpointRef> {
    if (!reason(input.reason) || !hex(input.planDigest) || !text(input.workspaceFingerprint, 4096)) throw new Error("Invalid node checkpoint input");
    nodes(input.nodes);
    const id = run.id, request = structuredClone(input), previous = run.nodeCheckpoint === undefined ? undefined : structuredClone(run.nodeCheckpoint);
    if (previous !== undefined) reference(previous);
    return this.store.withMutation(async () => {
      const saved = await this.existing(id);
      if (!equal(saved.nodeCheckpoint, previous)) throw new Error("Committed node checkpoint changed before its successor was written");
      if (previous !== undefined) await this.readOne(id, previous);
      const value: CheckpointManifest = { schemaVersion: 1, id: `cp_${randomBytes(12).toString("hex")}`, sequence: (previous?.sequence ?? 0) + 1, createdAt: new Date().toISOString(), reason: request.reason, completedTasks: request.nodes.filter(node => node.status === "completed").length, ...(previous ? { previous } : {}), planDigest: request.planDigest, workspaceFingerprint: request.workspaceFingerprint, nodes: request.nodes };
      if (!Number.isSafeInteger(value.sequence) || value.sequence > maxChain) throw new Error("Node checkpoint exceeds its 10000-checkpoint chain limit");
      const content = encode(value);
      if (Buffer.byteLength(content) > manifestLimit) throw new Error("Node checkpoint manifest exceeds 1 MiB");
      const ref: CheckpointRef = { id: value.id, sequence: value.sequence, createdAt: value.createdAt, reason: value.reason, completedTasks: value.completedTasks, digest: sha(content) };
      await this.immutable(id, "checkpoints", ref.id, content); return ref;
    });
  }
  async read(run: WorkflowRun, requested?: CheckpointRef): Promise<CheckpointManifest> {
    const saved = await this.store.load(run.id); await this.existing(run.id);
    let ref = saved.nodeCheckpoint;
    if (ref === undefined) throw new Error("Workflow has no committed node checkpoint");
    reference(ref);
    if (requested !== undefined) reference(requested);
    const visited = new Set<string>();
    while (ref) {
      if (visited.has(ref.id) || visited.size >= maxChain) throw new Error("Invalid or excessive node checkpoint chain");
      visited.add(ref.id); const value = await this.readOne(run.id, ref);
      if (!requested || equal(ref, requested)) {
        if (value.previous) await this.readOne(run.id, value.previous);
        await this.existing(run.id); return value;
      }
      ref = value.previous;
    }
    throw new Error("Requested checkpoint is not in the committed checkpoint chain");
  }
  async list(run: WorkflowRun, input: { offset?: number; limit?: number } = {}): Promise<{ checkpoints: CheckpointRef[]; total: number; nextOffset?: number }> {
    const { offset, limit } = page(input), saved = await this.store.load(run.id); await this.existing(run.id);
    let ref = saved.nodeCheckpoint; const checkpoints: CheckpointRef[] = [], visited = new Set<string>(); let total = 0;
    if (ref !== undefined) reference(ref);
    while (ref) {
      if (visited.has(ref.id) || visited.size >= maxChain) throw new Error("Invalid or excessive node checkpoint chain");
      visited.add(ref.id); const value = await this.readOne(run.id, ref);
      if (total >= offset && checkpoints.length < limit) checkpoints.push(structuredClone(ref));
      total++; ref = value.previous;
    }
    await this.existing(run.id);
    return { checkpoints, total, ...(offset + checkpoints.length < total ? { nextOffset: offset + checkpoints.length } : {}) };
  }
  private async history(runId: string, id: string): Promise<TaskHistoryEnvelope> {
    if (!/^history_[a-f0-9]{64}$/.test(id)) throw new Error("Invalid task history ID");
    const content = await this.bytes(runId, "history", id, historyLimit), value: unknown = JSON.parse(content);
    if (!object(value) || value.schemaVersion !== 1 || !object(value.history) || !object(value.task) || !hex(value.integrityDigest)) throw new Error("Invalid task history artifact");
    taskRecord(value.task);
    const ref = value.history, digest = hash(value.task);
    if (ref.id !== id || ref.taskId !== value.task.id || ref.index !== value.task.index || ref.status !== value.task.status || ref.attempts !== value.task.attempts.length || !instant(ref.createdAt) || !text(ref.reason, 1024) || (ref.label !== undefined && !text(ref.label, 2048)) || (ref.phase !== undefined && !text(ref.phase, 2048)) || ref.digest !== digest || id !== `history_${digest}` || value.integrityDigest !== hash({ schemaVersion: 1, history: ref, task: value.task })) throw new Error("Task history digest or identity is invalid");
    return value as unknown as TaskHistoryEnvelope;
  }
  async archiveTask(runId: string, task: Task, why: string): Promise<TaskHistoryRef> {
    taskRecord(task); if (!text(why, 1024)) throw new Error("Task history reason must be a non-empty bounded string");
    const snapshot = structuredClone(task), digest = hash(snapshot), id = `history_${digest}`;
    return this.store.withMutation(async () => {
      await this.existing(runId);
      try { return structuredClone((await this.history(runId, id)).history); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try {
        if ((await readdir(await this.directory(runId, "history"))).filter(name => /^history_[a-f0-9]{64}\.json$/.test(name)).length >= maxChain) throw new Error("Task history exceeds its 10000-entry limit");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const ref: TaskHistoryRef = { id, taskId: snapshot.id, index: snapshot.index, status: snapshot.status, attempts: snapshot.attempts.length, createdAt: new Date().toISOString(), digest, reason: why, ...(snapshot.label ? { label: snapshot.label.slice(0, 2048) } : {}), ...(snapshot.phase ? { phase: snapshot.phase.slice(0, 2048) } : {}) };
      const body = { schemaVersion: 1 as const, history: ref, task: snapshot }, value = { ...body, integrityDigest: hash(body) }, content = encode(value);
      if (Buffer.byteLength(content) > historyLimit) throw new Error("Archived task exceeds 32 MiB");
      await this.immutable(runId, "history", id, content); return ref;
    });
  }
  async readTaskHistory(runId: string, historyId: string): Promise<Task> {
    await this.existing(runId); const value = await this.history(runId, historyId); await this.existing(runId); return structuredClone(value.task);
  }
  async listTaskHistory(runId: string, input: { offset?: number; limit?: number; taskId?: string } = {}): Promise<{ history: TaskHistoryRef[]; total: number; nextOffset?: number }> {
    const { offset, limit } = page(input); this.store.directory(runId);
    if (input.taskId !== undefined && !/^task_[1-9]\d*$/.test(input.taskId)) throw new Error("Invalid task history filter");
    await this.existing(runId);
    let names: string[];
    try { names = await readdir(await this.directory(runId, "history")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { history: [], total: 0 }; throw error; }
    const history: TaskHistoryRef[] = [], entries = names.filter(name => /^history_[a-f0-9]{64}\.json$/.test(name));
    if (entries.length > maxChain) throw new Error("Task history exceeds its 10000-entry limit");
    for (const name of entries) {
      const value = await this.history(runId, name.slice(0, -5));
      if (!input.taskId || value.history.taskId === input.taskId) history.push(value.history);
    }
    history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    await this.existing(runId);
    return { history: history.slice(offset, offset + limit), total: history.length, ...(offset + limit < history.length ? { nextOffset: offset + limit } : {}) };
  }
}
