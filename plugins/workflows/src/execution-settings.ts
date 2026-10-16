import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export interface ModelSettings { model?: string | undefined; reasoningEffort?: string | undefined }
export interface StoredExecutionSettings extends ModelSettings { revision: number }
export interface WorkflowModel {
  id: string; displayName: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string;
}
export interface EffectiveExecutionSettings extends ModelSettings {
  source: "task" | "workflow-settings" | "codex-config";
  provenance?: "requested" | "configured" | "runtime";
}
export interface ExecutionEnvironment {
  defaults: ModelSettings; models: WorkflowModel[];
}

const namedValue = z.string().trim().min(1).max(256);
export const modelSettingsSchema = z.strictObject({ model: namedValue.optional(), reasoningEffort: namedValue.optional() });
const storedSchema = modelSettingsSchema.extend({ revision: z.number().int().nonnegative() });

export class ExecutionSettingsStore {
  private readonly filename: string;
  private readonly store: { root: string; acquireNamed(name: string): Promise<() => Promise<void>> };
  constructor(store: { root: string; acquireNamed(name: string): Promise<() => Promise<void>> }) { this.store = store; this.filename = path.join(store.root, "settings.json"); }
  async get(): Promise<StoredExecutionSettings> {
    try { return storedSchema.parse(JSON.parse(await readFile(this.filename, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0 }; throw error; }
  }
  async update(input: StoredExecutionSettings): Promise<StoredExecutionSettings> {
    const parsed = storedSchema.parse(input);
    const release = await this.store.acquireNamed("execution_settings");
    try {
      const previous = await this.get();
      if (previous.revision !== parsed.revision) throw new Error("Execution settings changed; refresh before saving.");
      const settings = { ...parsed, revision: parsed.revision + 1 };
      await mkdir(this.store.root, { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filename);
      return settings;
    } finally { await release(); }
  }
}

export function resolveExecutionSettings(environment: ExecutionEnvironment, layers: Array<{ settings?: ModelSettings | undefined; source: EffectiveExecutionSettings["source"] }>): EffectiveExecutionSettings {
  const result: EffectiveExecutionSettings = { ...environment.defaults, source: "codex-config" };
  for (const layer of layers) {
    if (layer.settings?.model !== undefined) { result.model = layer.settings.model; result.source = layer.source; }
    if (layer.settings?.reasoningEffort !== undefined) { result.reasoningEffort = layer.settings.reasoningEffort; result.source = layer.source; }
  }
  if (!result.model || !result.reasoningEffort) throw new Error("Codex did not expose an effective model and reasoning effort.");
  const model = environment.models.find(model => model.id === result.model);
  if (!model) throw new Error(`Model is unavailable in the Codex catalogue: ${result.model}`);
  if (!model.supportedReasoningEfforts.includes(result.reasoningEffort)) throw new Error(`Reasoning effort ${result.reasoningEffort} is unsupported by model ${result.model}; select a supported effort explicitly.`);
  return result;
}

export function validateExplicitModelSettings(settings: ModelSettings, environment: ExecutionEnvironment): void {
  if (settings.model !== undefined) {
    const model = environment.models.find(model => model.id === settings.model);
    if (!model) throw new Error(`Model is unavailable in the Codex catalogue: ${settings.model}`);
    if (settings.reasoningEffort !== undefined && !model.supportedReasoningEfforts.includes(settings.reasoningEffort)) throw new Error(`Reasoning effort ${settings.reasoningEffort} is unsupported by model ${settings.model}; select a supported effort explicitly.`);
  } else if (settings.reasoningEffort !== undefined && !environment.models.some(model => model.supportedReasoningEfforts.includes(settings.reasoningEffort!))) throw new Error(`Reasoning effort is unavailable in the Codex catalogue: ${settings.reasoningEffort}`);
}

export function parseExecutionEnvironment(configValue: unknown, modelsValue: unknown): ExecutionEnvironment {
  const config = z.object({ model: z.string().nullable().optional(), model_reasoning_effort: z.string().nullable().optional() }).passthrough().parse(configValue);
  const models = z.array(z.object({
    id: namedValue, model: namedValue.optional(), displayName: z.string(), isDefault: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: namedValue }).passthrough()).min(1),
    defaultReasoningEffort: namedValue,
  }).passthrough()).min(1).parse(modelsValue);
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error("Codex model catalogue contains duplicate model IDs.");
  const selected = config.model ? models.find(model => model.model === config.model || model.id === config.model) : models.find(model => model.isDefault);
  const model = selected?.id ?? config.model ?? undefined;
  const reasoningEffort = config.model_reasoning_effort ?? selected?.defaultReasoningEffort;
  const environment: ExecutionEnvironment = {
    defaults: { ...(model !== undefined ? { model } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) },
    models: models.map(model => ({ id: model.id, displayName: model.displayName, supportedReasoningEfforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort), defaultReasoningEffort: model.defaultReasoningEffort })),
  };
  return environment;
}
