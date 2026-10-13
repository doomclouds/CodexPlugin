import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateScript } from "./script.ts";
import { RunStore } from "./store.ts";
import type { Limits } from "./types.ts";

export interface SavedTemplate {
  id: string; name: string; description: string; script: string; args: unknown; allowWrite: boolean;
  source: "saved"; revision: number; updatedAt: string; limits?: Partial<Limits>;
}
export class TemplateStore {
  private store: RunStore;
  constructor(store: RunStore) { this.store = store; }
  private filename(id: string) {
    if (!/^saved:[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid saved workflow ID");
    return path.join(this.store.root, "templates", `${id.slice(6)}.json`);
  }
  async get(id: string) {
    try { return JSON.parse(await readFile(this.filename(id), "utf8")) as SavedTemplate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async list() {
    const directory = path.join(this.store.root, "templates");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(directory)).filter(file => /^[a-z][a-z0-9-]{0,63}\.json$/.test(file));
    const templates = await Promise.all(files.map(file => this.get(`saved:${file.slice(0, -5)}`)));
    return templates.filter((template): template is SavedTemplate => Boolean(template));
  }
  async save(input: { script: string; args?: unknown; allowWrite?: boolean; revision?: number; limits?: Partial<Limits> }) {
    const { meta } = validateScript(input.script);
    const id = `saved:${meta.name}`;
    const release = await this.store.acquireNamed(`template_${meta.name}`);
    try {
      const previous = await this.get(id);
      if (previous && input.revision !== previous.revision) throw new Error("Saved workflow already exists or changed. Load it before saving an update.");
      if (!previous && input.revision !== undefined) throw new Error("Saved workflow no longer exists");
      const template: SavedTemplate = { id, name: meta.name, description: meta.description, script: input.script, args: input.args === undefined ? {} : input.args, allowWrite: input.allowWrite ?? false, source: "saved", revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), ...(input.limits ? { limits: input.limits } : {}) };
      const json = JSON.stringify(template);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error("Saved workflow exceeds 2 MiB");
      const filename = this.filename(id);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${process.pid}.tmp`;
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, filename);
      return template;
    } finally { await release(); }
  }
}
