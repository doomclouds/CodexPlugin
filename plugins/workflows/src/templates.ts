import { mkdir, readFile, readdir, rename, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { validateScript } from "./script.ts";
import type { WorkflowMeta } from "./script.ts";
import { RunStore } from "./store.ts";
import type { Limits, MaintenancePlan, WorkspaceMode } from "./types.ts";
import { validateMaintenance } from "./maintenance.ts";
import { validateNodeSettings } from "./execution-settings.ts";
import type { NodeSettings } from "./execution-settings.ts";

export interface SavedTemplate {
  id: string; name: string; description: string; script: string; args: unknown; allowWrite: boolean;
  meta: WorkflowMeta;
  nodeSettings?: NodeSettings;
  source: "saved"; revision: number; updatedAt: string; limits?: Partial<Limits>;
  networkAccess?: boolean; workspaceMode?: WorkspaceMode; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; maintenance?: MaintenancePlan;
}
export class TemplateStore {
  private store: RunStore;
  constructor(store: RunStore) { this.store = store; }
  filename(id: string) {
    if (!/^saved:[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid saved workflow ID");
    return path.join(this.store.root, "templates", `${id.slice(6)}.json`);
  }
  async get(id: string) {
    const filename = this.filename(id);
    try {
      await this.store.ownedDirectory("templates");
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("Saved workflow definition must be an owned regular file");
      const template = JSON.parse(await readFile(filename, "utf8")) as Omit<SavedTemplate, "meta">;
      const { meta } = validateScript(template.script);
      if (template.id !== id || template.name !== meta.name || `saved:${meta.name}` !== id || template.source !== "saved" || !Number.isSafeInteger(template.revision) || template.revision < 1) throw new Error("Invalid saved workflow definition identity");
      return { ...template, ...(template.nodeSettings !== undefined ? { nodeSettings: validateNodeSettings(template.nodeSettings, meta) } : {}), meta };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async list() {
    const directory = path.join(this.store.root, "templates");
    await this.store.ownedDirectory("templates", true);
    const files = (await readdir(directory)).filter(file => /^[a-z][a-z0-9-]{0,63}\.json$/.test(file));
    const templates = await Promise.all(files.map(file => this.get(`saved:${file.slice(0, -5)}`)));
    return templates.filter((template): template is SavedTemplate => Boolean(template));
  }
  async deletedRevision(id: string): Promise<number | undefined> {
    this.filename(id);
    try {
      await this.store.ownedDirectory(path.join(".deletions", "templates"));
      const filename = path.join(this.store.root, ".deletions", "templates", `${id.slice(6)}.json`);
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid workflow definition deletion marker");
      const marker = JSON.parse(await readFile(filename, "utf8")) as { revision: number };
      if (!Number.isInteger(marker.revision) || marker.revision < 1) throw new Error("Invalid workflow definition deletion revision");
      return marker.revision;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async markDeleted(id: string, revision: number, deletionId: string) {
    this.filename(id);
    await this.store.writePrivateJson(path.join(".deletions", "templates", `${id.slice(6)}.json`), { schemaVersion: 1, id, revision, deletionId });
  }
  async removeOwned(id: string) {
    const filename = this.filename(id);
    try {
      await this.store.ownedDirectory("templates");
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Saved workflow definition must be an owned regular file");
      await rm(filename);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async save(input: { script: string; args?: unknown; allowWrite?: boolean; networkAccess?: boolean; workspaceMode?: WorkspaceMode; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; maintenance?: MaintenancePlan; revision?: number; limits?: Partial<Limits>; nodeSettings?: NodeSettings }) {
    const { meta } = validateScript(input.script);
    const nodeSettings = validateNodeSettings(input.nodeSettings, meta);
    if (input.allowedMcpServers?.some(name => !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || /workflows/i.test(name))) throw new Error("Invalid or recursive MCP server grant");
    if (input.workspaceMode === "local" && input.allowWrite !== true) throw new Error("Local project mode requires allowWrite: true");
    if (input.maintenance && (!input.allowWrite || input.workspaceMode !== "git-worktree")) throw new Error("Maintenance operations require git-worktree isolation and allowWrite");
    if (input.maintenance) input.maintenance = validateMaintenance(input.maintenance, input.networkAccess ?? false);
    const id = `saved:${meta.name}`;
    const release = await this.store.acquireNamed(`template_${meta.name}`);
    try { return await this.store.withMutation(async () => {
      const previous = await this.get(id);
      if (previous && input.revision !== previous.revision) throw new Error("Saved workflow already exists or changed. Load it before saving an update.");
      if (!previous && input.revision !== undefined) throw new Error("Saved workflow no longer exists");
      const deletedRevision = await this.deletedRevision(id);
      if (deletedRevision !== undefined) throw new Error("Saved workflow deletion is pending; finish cleanup before creating a new definition");
      if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new Error("Invalid saved workflow revision");
      if (previous && previous.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Saved workflow revision exceeds its safe range");
      const template: Omit<SavedTemplate, "meta"> = { id, name: meta.name, description: meta.description, script: input.script, args: input.args === undefined ? {} : input.args, allowWrite: input.allowWrite ?? false, source: "saved", revision: previous ? previous.revision + 1 : randomBytes(6).readUIntBE(0, 6) + 1, updatedAt: new Date().toISOString(), ...(input.limits ? { limits: input.limits } : {}) };
      template.networkAccess = input.networkAccess ?? false;
      template.workspaceMode = input.workspaceMode ?? "snapshot";
      template.allowedMcpServers = input.allowedMcpServers ?? [];
      template.allowedMcpTools = input.allowedMcpTools ?? {};
      if (input.nodeSettings !== undefined) template.nodeSettings = nodeSettings;
      if (input.maintenance) template.maintenance = input.maintenance;
      const json = JSON.stringify(template);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error("Saved workflow exceeds 2 MiB");
      const filename = this.filename(id);
      await this.store.ownedDirectory("templates", true);
      const temporary = `${filename}.${process.pid}.tmp`;
      try { await writeFile(temporary, json, { mode: 0o600, flag: "wx" }); await rename(temporary, filename); }
      finally { await rm(temporary, { force: true }); }
      return { ...template, meta };
    }); } finally { await release(); }
  }
}
