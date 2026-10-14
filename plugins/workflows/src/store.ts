import { mkdir, readFile, readdir, rename, writeFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { WorkflowRun } from "./types.ts";
import lockfile from "proper-lockfile";
import { randomBytes } from "node:crypto";

export interface PendingDeletionTarget { kind: "run" | "definition"; id: string; revision: number; runIds?: string[]; includeAssociatedRuns?: true }
export interface DeletedRunSummary { id: string; revision: number; name: string; projectPath: string; createdAt: string; sourceDefinition?: WorkflowRun["sourceDefinition"] }
interface PendingRunDeletion { schemaVersion: 1; id: string; deletionId: string; revision: number; summary?: DeletedRunSummary; target?: PendingDeletionTarget }

export class RunStore {
  readonly root: string;
  private pending = new Map<string, Promise<void>>();
  constructor(root = process.env.WORKFLOWS_DATA_DIR ?? path.join(homedir(), ".local", "state", "codex-workflows")) {
    this.root = path.resolve(root);
  }
  directory(id: string) {
    if (!/^wf_[a-f0-9]{24}$/.test(id)) throw new Error("Invalid workflow ID");
    return path.join(this.root, id);
  }
  async ownedDirectory(relative = "", create = false) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === "..")) throw new Error("Invalid owned data path");
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Workflow data root must be an owned directory, not a symbolic link");
    let current = this.root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workflow data path must remain an owned directory, not a symbolic link");
    }
    return current;
  }
  async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ownedDirectory("locks", true);
    const release = await this.acquireNamed("data_mutation", AbortSignal.timeout(120000));
    try { return await operation(); } finally { await release(); }
  }
  deletionMarker(id: string) { this.directory(id); return path.join(this.root, ".deletions", "runs", `${id}.json`); }
  async pendingDeletion(id: string): Promise<PendingRunDeletion | undefined> {
    this.directory(id);
    try {
      await this.ownedDirectory(path.join(".deletions", "runs"));
      const filename = this.deletionMarker(id), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error("Invalid pending deletion marker");
      const marker = JSON.parse(await readFile(filename, "utf8")) as PendingRunDeletion;
      if (marker.schemaVersion !== 1 || marker.id !== id || !Number.isSafeInteger(marker.revision) || marker.revision < 1) throw new Error("Invalid pending deletion marker identity");
      return marker;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async isDeleted(id: string) { return Boolean(await this.pendingDeletion(id)); }
  async assertWritable(id: string) {
    if (await this.isDeleted(id)) throw new Error("Workflow was deleted; late writes are rejected");
  }
  async writePrivateJson(relative: string, value: unknown) {
    const directory = await this.ownedDirectory(path.dirname(relative), true);
    const name = path.basename(relative);
    if (!name || name === "." || name === "..") throw new Error("Invalid owned JSON filename");
    const filename = path.join(directory, name);
    const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }); }
  }
  async markDeleted(id: string, deletionId: string, revision: number, summary?: DeletedRunSummary, target?: PendingDeletionTarget) {
    this.directory(id);
    await this.writePrivateJson(path.join(".deletions", "runs", `${id}.json`), { schemaVersion: 1, id, deletionId, revision, ...(summary ? { summary } : {}), ...(target ? { target } : {}) });
  }
  async create(run: WorkflowRun) { return this.writeRun(run, true); }
  async save(run: WorkflowRun) { return this.writeRun(run, false); }
  private async writeRun(run: WorkflowRun, create: boolean) {
    const directory = this.directory(run.id);
    const content = JSON.stringify(run);
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error("Workflow state exceeds 32 MiB");
    const previous = this.pending.get(run.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.withMutation(async () => {
      await this.assertWritable(run.id);
      if (create) {
        try { await lstat(directory); throw new Error("Workflow ID already exists"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else await this.requireExisting(run.id);
      if (run.sourceDefinition?.id.startsWith("saved:")) {
        const name = run.sourceDefinition.id.slice(6);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("Invalid workflow definition provenance");
        try {
          await this.ownedDirectory(path.join(".deletions", "templates"));
          const marker = path.join(this.root, ".deletions", "templates", `${name}.json`);
          const info = await lstat(marker);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid workflow definition deletion marker");
          const deleted = JSON.parse(await readFile(marker, "utf8")) as { revision: number };
          if (run.sourceDefinition.revision <= deleted.revision) throw new Error("Workflow definition was deleted; late run creation is rejected");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (create && run.sourceDefinition?.id.startsWith("saved:")) {
        await this.ownedDirectory("templates");
        const filename = path.join(this.root, "templates", `${run.sourceDefinition.id.slice(6)}.json`);
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Workflow definition no longer exists");
        const definition = JSON.parse(await readFile(filename, "utf8")) as { revision: number };
        if (definition.revision !== run.sourceDefinition.revision) throw new Error("Workflow definition changed before run creation");
      }
      await this.ownedDirectory(run.id, create);
      const temporary = path.join(directory, `run.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      try { await rename(temporary, path.join(directory, "run.json")); }
      finally { await rm(temporary, { force: true }); }
    }));
    this.pending.set(run.id, next);
    try { await next; } finally { if (this.pending.get(run.id) === next) this.pending.delete(run.id); }
  }
  async load(id: string): Promise<WorkflowRun> {
    await this.pending.get(id);
    let marker = await this.pendingDeletion(id);
    try {
      const run = await this.loadForDeletion(id);
      marker ??= await this.pendingDeletion(id);
      return marker ? { ...run, deletionPending: true, ...(marker.target ? { deletionTarget: marker.target } : {}) } : run;
    } catch (error) {
      marker ??= await this.pendingDeletion(id);
      if (!marker?.summary) throw error;
      // A failed recursive cleanup can remove run.json before it reaches a protected artifact.
      // This is a cleanup-only view, deliberately without prompts, outputs or execution claims.
      return {
        id, revision: marker.revision, createdAt: marker.summary.createdAt, updatedAt: marker.summary.createdAt,
        meta: { name: marker.summary.name, description: "清理未完成；此记录仅用于重试删除，不代表执行成果。" },
        script: "", scriptDigest: "", args: {}, projectPath: marker.summary.projectPath, allowWrite: false,
        limits: { maxReadWorkers: 1, maxCalls: 1, timeoutMs: 1000, maxTokens: 0 },
        execution: "stopped", review: "unavailable", application: "none", tasks: [], logs: [],
        deletionPending: true, ...(marker.target ? { deletionTarget: marker.target } : {}),
        ...(marker.summary.sourceDefinition ? { sourceDefinition: marker.summary.sourceDefinition } : {}),
      };
    }
  }
  private async requireExisting(id: string) {
    try {
      this.directory(id);
      await this.ownedDirectory(id);
      const info = await lstat(path.join(this.directory(id), "run.json"));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid saved workflow state file");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Workflow no longer exists or was deleted; late writes are rejected"); throw error; }
  }
  async loadForDeletion(id: string): Promise<WorkflowRun> {
    this.directory(id);
    await this.ownedDirectory(id);
    const filename = path.join(this.directory(id), "run.json");
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid saved workflow state file");
    const run = JSON.parse(await readFile(filename, "utf8")) as WorkflowRun;
    if (run.id !== id || !Array.isArray(run.tasks) || !Array.isArray(run.logs) || !Number.isSafeInteger(run.revision) || run.revision < 1) throw new Error("Invalid saved workflow state");
    if (run.sourceDefinition && (!/^(saved|builtin):[a-z][a-z0-9-]{0,63}$/.test(run.sourceDefinition.id) || !Number.isSafeInteger(run.sourceDefinition.revision) || run.sourceDefinition.revision < 1)) throw new Error("Invalid saved workflow provenance");
    return run;
  }
  async list() {
    await this.ownedDirectory("", true);
    const ids = new Set((await readdir(this.root)).filter(id => /^wf_[a-f0-9]{24}$/.test(id)));
    try {
      await this.ownedDirectory(path.join(".deletions", "runs"));
      for (const name of await readdir(path.join(this.root, ".deletions", "runs"))) if (/^wf_[a-f0-9]{24}\.json$/.test(name)) ids.add(name.slice(0, -5));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const results = await Promise.all([...ids].map(async id => {
      try { return await this.load(id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return results.filter((run): run is WorkflowRun => Boolean(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async isLocked(id: string) {
    return lockfile.check(this.directory(id), { realpath: false, stale: 5000 });
  }
  async acquire(id: string) {
    return this.withMutation(async () => {
      await this.assertWritable(id);
      await this.requireExisting(id);
      return this.acquireForDeletion(id);
    });
  }
  async acquireForDeletion(id: string) {
    const directory = this.directory(id);
    await this.ownedDirectory("", true);
    return lockfile.lock(directory, { realpath: false, stale: 5000, update: 1000, onCompromised: () => { process.emit("SIGTERM"); } });
  }
  async acquireNamed(name: string, signal?: AbortSignal) {
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Invalid lock name");
    const directory = path.join(this.root, "locks");
    await this.ownedDirectory("locks", true);
    while (!signal?.aborted) {
      try { return await lockfile.lock(path.join(directory, name), { realpath: false, stale: 5000, update: 1000, onCompromised: () => { process.emit("SIGTERM"); } }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || !signal) throw error;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 50);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
    throw new Error("Workflow interrupted while waiting for the write slot");
  }
  async flush() { await Promise.all(this.pending.values()); }
  async requestControl(id: string, controlId: string, action: "stop" | "cancel", taskId?: string) {
    const directory = path.join(this.directory(id), "controls");
    const name = randomBytes(16).toString("hex");
    const filename = path.join(directory, `${name}.json`);
    const temporary = `${filename}.tmp`;
    await this.withMutation(async () => {
      await this.assertWritable(id);
      await this.requireExisting(id);
      await this.ownedDirectory(path.join(id, "controls"), true);
      await writeFile(temporary, JSON.stringify({ controlId, action, taskId, expiresAt: Date.now() + 120000 }), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    });
    const deadline = Date.now() + 120000;
    let ownerGoneAt: number | undefined;
    try {
      while (Date.now() < deadline) {
        await this.assertWritable(id);
        try {
          const response = JSON.parse(await readFile(`${filename}.result`, "utf8")) as { error?: string };
          if (response.error) throw new Error(response.error);
          return;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        // Stop releases the run lock before its control acknowledgment is written.
        // Allow that bounded handoff without mistaking successful cleanup for a crashed owner.
        if (!await this.isLocked(id)) {
          ownerGoneAt ??= Date.now();
          if (Date.now() - ownerGoneAt > 2000) throw new Error("Workflow owner exited before acknowledging control; refresh saved progress");
        } else ownerGoneAt = undefined;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Workflow owner did not acknowledge control; refresh progress before retrying");
    } finally { await rm(filename, { force: true }); await rm(`${filename}.result`, { force: true }); }
  }
  async consumeControls(id: string, controlId: string, execute: (action: "stop" | "cancel", taskId?: string) => Promise<void>) {
    const directory = path.join(this.directory(id), "controls");
    let files: string[];
    try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const file of files.filter(file => /^[a-f0-9]{32}\.json$/.test(file))) {
      const filename = path.join(directory, file);
      let errorText: string | undefined;
      try {
        const input = JSON.parse(await readFile(filename, "utf8")) as { controlId?: string; action?: string; taskId?: string; expiresAt?: number };
        if (input.controlId !== controlId || !input.expiresAt || input.expiresAt < Date.now()) throw new Error("Control request belongs to an expired workflow execution");
        if (input.action !== "stop" && input.action !== "cancel") throw new Error("Unknown workflow control action");
        if (input.action === "cancel" && (typeof input.taskId !== "string" || input.taskId.length > 100)) throw new Error("Invalid task control request");
        await execute(input.action, input.taskId);
      } catch (error) { errorText = error instanceof Error ? error.message : String(error); }
      const temporary = `${filename}.result.tmp`;
      await this.withMutation(async () => {
        await this.assertWritable(id);
        await this.ownedDirectory(path.join(id, "controls"));
        await writeFile(temporary, JSON.stringify(errorText ? { error: errorText } : {}), { mode: 0o600, flag: "wx" });
        await rename(temporary, `${filename}.result`);
        await rm(filename, { force: true });
      });
    }
  }
}
