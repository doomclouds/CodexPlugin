import { mkdir, readFile, readdir, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { WorkflowRun } from "./types.ts";
import lockfile from "proper-lockfile";
import { randomBytes } from "node:crypto";

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
  async save(run: WorkflowRun) {
    const directory = this.directory(run.id);
    const content = JSON.stringify(run);
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error("Workflow state exceeds 32 MiB");
    const previous = this.pending.get(run.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `run.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path.join(directory, "run.json"));
    });
    this.pending.set(run.id, next);
    try { await next; } finally { if (this.pending.get(run.id) === next) this.pending.delete(run.id); }
  }
  async load(id: string): Promise<WorkflowRun> {
    await this.pending.get(id);
    const run = JSON.parse(await readFile(path.join(this.directory(id), "run.json"), "utf8")) as WorkflowRun;
    if (run.id !== id || !Array.isArray(run.tasks) || !Array.isArray(run.logs)) throw new Error("Invalid saved workflow state");
    return run;
  }
  async list() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const ids = (await readdir(this.root)).filter(id => /^wf_[a-f0-9]{24}$/.test(id));
    const results = await Promise.all(ids.map(async id => this.load(id)));
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async isLocked(id: string) {
    return lockfile.check(this.directory(id), { realpath: false, stale: 5000 });
  }
  async acquire(id: string) {
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return lockfile.lock(directory, { realpath: false, stale: 5000, update: 1000, onCompromised: () => { process.emit("SIGTERM"); } });
  }
  async acquireNamed(name: string, signal?: AbortSignal) {
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Invalid lock name");
    const directory = path.join(this.root, "locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = randomBytes(16).toString("hex");
    const filename = path.join(directory, `${name}.json`);
    const temporary = `${filename}.tmp`;
    await writeFile(temporary, JSON.stringify({ controlId, action, taskId, expiresAt: Date.now() + 120000 }), { mode: 0o600 });
    await rename(temporary, filename);
    const deadline = Date.now() + 120000;
    let ownerGoneAt: number | undefined;
    try {
      while (Date.now() < deadline) {
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
      await writeFile(temporary, JSON.stringify(errorText ? { error: errorText } : {}), { mode: 0o600 });
      await rename(temporary, `${filename}.result`);
      await rm(filename, { force: true });
    }
  }
}
