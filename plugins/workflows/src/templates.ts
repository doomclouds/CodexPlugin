import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateScript } from "./script.ts";
import type { WorkflowMeta } from "./script.ts";
import { RunStore } from "./store.ts";
import type { Limits, MaintenancePlan } from "./types.ts";
import { validateMaintenance } from "./maintenance.ts";
import { validateNodeSettings } from "./execution-settings.ts";
import type { NodeSettings } from "./execution-settings.ts";

export interface SavedTemplate {
  id: string; name: string; description: string; script: string; args: unknown; allowWrite: boolean;
  meta: WorkflowMeta;
  nodeSettings?: NodeSettings;
  source: "saved"; revision: number; updatedAt: string; limits?: Partial<Limits>;
  networkAccess?: boolean; workspaceMode?: "snapshot" | "git-worktree"; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; maintenance?: MaintenancePlan;
}
export class TemplateStore {
  private store: RunStore;
  constructor(store: RunStore) { this.store = store; }
  private filename(id: string) {
    if (!/^saved:[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid saved workflow ID");
    return path.join(this.store.root, "templates", `${id.slice(6)}.json`);
  }
  async get(id: string) {
    try {
      const template = JSON.parse(await readFile(this.filename(id), "utf8")) as Omit<SavedTemplate, "meta">;
      const { meta } = validateScript(template.script);
      return { ...template, ...(template.nodeSettings !== undefined ? { nodeSettings: validateNodeSettings(template.nodeSettings, meta) } : {}), meta };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async list() {
    const directory = path.join(this.store.root, "templates");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(directory)).filter(file => /^[a-z][a-z0-9-]{0,63}\.json$/.test(file));
    const templates = await Promise.all(files.map(file => this.get(`saved:${file.slice(0, -5)}`)));
    return templates.filter((template): template is SavedTemplate => Boolean(template));
  }
  async save(input: { script: string; args?: unknown; allowWrite?: boolean; networkAccess?: boolean; workspaceMode?: "snapshot" | "git-worktree"; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; maintenance?: MaintenancePlan; revision?: number; limits?: Partial<Limits>; nodeSettings?: NodeSettings }) {
    const { meta } = validateScript(input.script);
    const nodeSettings = validateNodeSettings(input.nodeSettings, meta);
    if (input.allowedMcpServers?.some(name => !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || /workflows/i.test(name))) throw new Error("Invalid or recursive MCP server grant");
    if (input.maintenance && (!input.allowWrite || input.workspaceMode !== "git-worktree")) throw new Error("Maintenance operations require git-worktree isolation and allowWrite");
    if (input.maintenance) input.maintenance = validateMaintenance(input.maintenance, input.networkAccess ?? false);
    const id = `saved:${meta.name}`;
    const release = await this.store.acquireNamed(`template_${meta.name}`);
    try {
      const previous = await this.get(id);
      if (previous && input.revision !== previous.revision) throw new Error("Saved workflow already exists or changed. Load it before saving an update.");
      if (!previous && input.revision !== undefined) throw new Error("Saved workflow no longer exists");
      const template: Omit<SavedTemplate, "meta"> = { id, name: meta.name, description: meta.description, script: input.script, args: input.args === undefined ? {} : input.args, allowWrite: input.allowWrite ?? false, source: "saved", revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), ...(input.limits ? { limits: input.limits } : {}) };
      template.networkAccess = input.networkAccess ?? false;
      template.workspaceMode = input.workspaceMode ?? "snapshot";
      template.allowedMcpServers = input.allowedMcpServers ?? [];
      template.allowedMcpTools = input.allowedMcpTools ?? {};
      if (input.nodeSettings !== undefined) template.nodeSettings = nodeSettings;
      if (input.maintenance) template.maintenance = input.maintenance;
      const json = JSON.stringify(template);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error("Saved workflow exceeds 2 MiB");
      const filename = this.filename(id);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${process.pid}.tmp`;
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, filename);
      return { ...template, meta };
    } finally { await release(); }
  }
}
