import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "./store.ts";
import type { DeletedRunSummary } from "./store.ts";
import { TemplateStore } from "./templates.ts";
import type { WorkflowRun } from "./types.ts";
import { inspectProjectTemporaryFiles } from "./project-temps.ts";
import { validateLocalWorkspaceForDeletion } from "./local-workspace.ts";

export type DeleteInput = { kind: "run"; id: string; revision: number } | { kind: "definition"; id: string; revision: number; runIds?: string[]; includeAssociatedRuns?: true };
export interface DeletionBlock { code: string; message: string; runId?: string; path?: string; reference?: { source: string; serverName?: string; field?: string } }
export interface DeletionPreview {
  target: DeleteInput; fingerprint: string; canDelete: boolean;
  runs: Array<{ id: string; revision: number; name: string; projectPath: string }>;
  definition?: { id: string; revision: number; name: string };
  objects: Array<{ path: string; kind: "run" | "definition" | "lock" | "project-temp" | "metadata-temp"; files: number; bytes: number }>;
  totalFiles: number; totalBytes: number; blocked: DeletionBlock[];
  retained: string[];
}
export interface DeletionResult {
  deleted: boolean; partial: boolean; alreadyGone?: boolean; deletedRunIds: string[]; deletedDefinitionId?: string;
  remaining: Array<{ path: string; reason: string }>; blocked: DeletionBlock[];
}
export interface DeletionOptions {
  readEffectiveConfig?: (projectPaths: string[]) => Promise<Record<string, unknown>>;
  // This hook is for deterministic failure testing. Production removes only verified owned paths.
  removeOwnedPath?: (filename: string) => Promise<void>;
}
interface Intent { schemaVersion: 1; id: string; input: DeleteInput; runs: Array<DeletedRunSummary>; definition?: { id: string; revision: number }; completed?: boolean }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function canonicalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalConfig(value[key])]));
  return value;
}
function normalizedInput(input: DeleteInput): DeleteInput {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Invalid deletion revision");
  if (input.kind === "run") {
    if (!/^wf_[a-f0-9]{24}$/.test(input.id)) throw new Error("Invalid workflow ID");
    return { kind: "run", id: input.id, revision: input.revision };
  }
  if (input.kind !== "definition" || !/^(saved|builtin):[a-z][a-z0-9-]{0,63}$/.test(input.id)) throw new Error("Invalid workflow definition ID");
  if (input.includeAssociatedRuns !== undefined && input.includeAssociatedRuns !== true) throw new Error("Definition deletion always includes reliably associated runs");
  const runIds = [...new Set(input.runIds ?? [])].sort();
  if (runIds.length > 1000 || runIds.some(id => !/^wf_[a-f0-9]{24}$/.test(id))) throw new Error("Invalid explicit workflow deletion IDs");
  return { kind: "definition", id: input.id, revision: input.revision, includeAssociatedRuns: true, ...(runIds.length ? { runIds } : {}) };
}
function pathReference(value: string, directory: string): boolean {
  // Arguments can be paths or flag=value. Do not match a different directory with the same prefix.
  let at = value.indexOf(directory);
  while (at >= 0) {
    const end = value[at + directory.length];
    if (end === undefined || /[\\/\s'";:),]/.test(end)) return true;
    at = value.indexOf(directory, at + 1);
  }
  return false;
}
function references(value: unknown, directory: string, field = ""): string[] {
  if (typeof value === "string") return pathReference(value, directory) ? [field] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => references(item, directory, `${field}[${index}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => references(item, directory, field ? `${field}.${key}` : key));
  return [];
}
async function serverReferences(server: unknown, directory: string, cwd: string | undefined, cache: Map<string, Promise<string | undefined>>): Promise<string[]> {
  const fields = references(server, directory);
  const base = cwd ? isObject(server) && typeof server.cwd === "string" ? path.resolve(cwd, server.cwd) : cwd : undefined;
  const canonical = (filename: string) => {
    let value = cache.get(filename);
    if (!value) { value = realpath(filename).catch(error => { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }); cache.set(filename, value); }
    return value;
  };
  const visit = async (value: unknown, field: string): Promise<void> => {
    if (typeof value === "string") {
      for (const token of value.split(/[\s'";]+/).filter(Boolean)) {
        const candidate = token.startsWith("--") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
        if (!candidate || candidate.startsWith("-")) continue;
        const pathLike = candidate.startsWith(".") || candidate.includes("/") || candidate.includes("\\") || field.startsWith("args[");
        const filenames: string[] = [];
        if (pathLike && (base || path.isAbsolute(candidate))) filenames.push(path.resolve(base ?? "", candidate));
        if (field === "command" && !candidate.includes("/") && !candidate.includes("\\")) {
          const configuredPath = isObject(server) && isObject(server.env) && typeof server.env.PATH === "string" ? server.env.PATH : process.env.PATH;
          for (const search of (configuredPath ?? "").split(path.delimiter).filter(Boolean)) filenames.push(path.resolve(base ?? process.cwd(), search, candidate));
        }
        for (const filename of filenames) {
          const resolved = await canonical(filename);
          if ((pathReference(filename, directory) || resolved && pathReference(resolved, directory)) && !fields.includes(field)) fields.push(field);
        }
      }
    } else if (Array.isArray(value)) { for (const [index, item] of value.entries()) await visit(item, `${field}[${index}]`); }
    else if (isObject(value)) { for (const [key, item] of Object.entries(value)) await visit(item, field ? `${field}.${key}` : key); }
  };
  await visit(server, ""); return fields;
}
function configScopes(config: Record<string, unknown>): Array<{ cwd?: string; servers: Record<string, unknown> }> {
  if (Array.isArray(config.scopes)) return config.scopes.map(value => {
    if (!isObject(value) || !isObject(value.mcp_servers)) throw new Error("Invalid effective configuration scope");
    return { ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), servers: value.mcp_servers };
  });
  return [{ servers: isObject(config.mcp_servers) ? config.mcp_servers : config }];
}
async function privateJson(filename: string): Promise<unknown> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("删除记录必须是运行目录内的普通文件");
  if (info.size > 32 * 1024 * 1024) throw new Error("删除记录超过安全读取上限");
  return JSON.parse(await readFile(filename, "utf8"));
}
async function inventory(filename: string): Promise<{ files: number; bytes: number; signature: string }> {
  const entries: unknown[] = []; let files = 0; let bytes = 0;
  async function visit(current: string, relative: string, depth: number) {
    if (depth > 128 || entries.length >= 250000) throw new Error("删除范围过大，请先检查运行目录");
    const info = await lstat(current);
    entries.push([relative, info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file", info.size, info.mode, info.ino, info.mtimeMs, info.ctimeMs]);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const child of (await readdir(current)).sort()) await visit(path.join(current, child), path.join(relative, child), depth + 1);
    } else { files++; bytes += info.size; }
  }
  try { await visit(filename, "", 0); } catch (error) { if (!absent(error)) throw error; }
  return { files, bytes, signature: hash(entries) };
}

/** Deletion is fenced and journaled independently of run directories. A tiny ID/revision marker
 * exists only while cleanup is pending; normal writes cannot recreate missing run directories. */
export class DeletionService {
  private readonly options: DeletionOptions;
  readonly store: RunStore;
  readonly templates: TemplateStore;
  constructor(store: RunStore, templates: TemplateStore, options: DeletionOptions = {}) { this.store = store; this.templates = templates; this.options = options; }
  private intentId(input: DeleteInput) { return hash(input); }
  private intentPath(input: DeleteInput) { return path.join(".deletions", "requests", `${this.intentId(input)}.json`); }
  private async intent(input: DeleteInput): Promise<Intent | undefined> {
    try {
      await this.store.ownedDirectory(path.join(".deletions", "requests"));
      const value = await privateJson(path.join(this.store.root, this.intentPath(input))) as Intent;
      if (value.schemaVersion !== 1 || value.id !== this.intentId(input) || hash(value.input) !== hash(input) || !Array.isArray(value.runs)) throw new Error("删除事务记录损坏，不能继续删除");
      if (value.runs.some(run => !Number.isSafeInteger(run.revision) || run.revision < 1)) throw new Error("删除事务的运行版本无效");
      for (const run of value.runs) {
        this.store.directory(run.id);
        if (input.kind === "run" && run.id !== input.id) throw new Error("删除事务包含未授权运行");
      }
      if (value.definition && (input.kind !== "definition" || value.definition.id !== input.id || value.definition.revision !== input.revision)) throw new Error("删除事务定义范围不匹配");
      return value;
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }
  private async temporaryMetadata(input: DeleteInput, runIds: string[]): Promise<string[]> {
    const probes: Array<{ directory: string; basename: string; suffix: RegExp }> = [
      { directory: path.join(".deletions", "requests"), basename: `${this.intentId(input)}.json`, suffix: /^\.[0-9]+\.[a-f0-9]{16}\.tmp$/ },
      ...runIds.map(id => ({ directory: path.join(".deletions", "runs"), basename: `${id}.json`, suffix: /^\.[0-9]+\.[a-f0-9]{16}\.tmp$/ })),
    ];
    if (input.kind === "definition") {
      probes.push({ directory: path.join(".deletions", "templates"), basename: `${input.id.slice(6)}.json`, suffix: /^\.[0-9]+\.[a-f0-9]{16}\.tmp$/ });
      probes.push({ directory: "templates", basename: `${input.id.slice(6)}.json`, suffix: /^\.[0-9]+\.tmp$/ });
    }
    const filenames: string[] = [];
    for (const probe of probes) {
      let directory: string;
      try { directory = await this.store.ownedDirectory(probe.directory); }
      catch (error) { if (absent(error)) continue; throw error; }
      for (const name of await readdir(directory)) if (name.startsWith(probe.basename) && probe.suffix.test(name.slice(probe.basename.length))) {
        const filename = path.join(directory, name), info = await lstat(filename);
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error("删除临时元数据路径不是普通文件，不能自动清理");
        filenames.push(filename);
      }
    }
    return filenames.sort();
  }
  async preview(raw: DeleteInput): Promise<DeletionPreview> {
    const input = normalizedInput(raw);
    return this.store.withMutation(() => this.inspect(input));
  }
  private async inspect(input: DeleteInput): Promise<DeletionPreview> {
    const blocked: DeletionBlock[] = []; const objects: DeletionPreview["objects"] = []; const signatures: unknown[] = [];
    const result: DeletionPreview = { target: input, fingerprint: "", canDelete: false, runs: [], objects, totalBytes: 0, totalFiles: 0, blocked, retained: ["已交付到原项目的文件和提交", "Codex 全局设置与其他工作流数据"] };
    if (input.kind === "definition" && input.id.startsWith("builtin:")) {
      blocked.push({ code: "builtin", message: "内置工作流属于插件安装包，不能删除。可以删除它的运行记录。" });
      result.fingerprint = hash({ input, blocked }); return result;
    }
    const intent = await this.intent(input);
    let all: WorkflowRun[] = [];
    const ids = (await readdir(this.store.root)).filter(id => /^wf_[a-f0-9]{24}$/.test(id));
    for (const id of ids) {
      try { all.push(await this.store.loadForDeletion(id)); }
      catch (error) {
        // An unresolved record can conceal provenance or a runtime reference. Do not guess.
        if (!(intent?.runs.some(run => run.id === id) && absent(error))) blocked.push({ code: "invalid_record", runId: id, message: "有运行记录无法安全读取；先修复记录后再删除，避免遗漏关联数据。", path: this.store.directory(id) });
      }
    }
    let selected: WorkflowRun[] = [];
    if (input.kind === "run") {
      const run = all.find(run => run.id === input.id);
      if (run && run.revision !== input.revision) blocked.push({ code: "revision", runId: input.id, message: "运行记录已变化，请刷新删除预览。" });
      if (run) selected.push(run);

    } else {
      try {
        try {
          await this.store.ownedDirectory(path.join(".deletions", "templates"));
          const marker = await privateJson(path.join(this.store.root, ".deletions", "templates", `${input.id.slice(6)}.json`)) as { deletionId?: string };
          if (marker.deletionId !== this.intentId(input)) blocked.push({ code: "pending_scope", message: "这个定义已有未完成删除事务，请使用原删除范围继续清理。" });
        } catch (error) { if (!absent(error)) throw error; }
        const definition = await this.templates.get(input.id);
        if (definition && definition.revision !== input.revision) blocked.push({ code: "revision", message: "工作流定义已变化，请刷新删除预览。" });
        if (definition) result.definition = { id: definition.id, revision: definition.revision, name: definition.name };
        else result.definition = { id: input.id, revision: intent?.definition?.revision ?? input.revision, name: input.id.slice(6) };
      } catch (error) { blocked.push({ code: "invalid_definition", message: text(error), path: this.templates.filename(input.id) }); }
      selected = all.filter(run => intent ? intent.runs.some(item => item.id === run.id) : run.sourceDefinition?.id === input.id || input.runIds?.includes(run.id));
      // A same-name run without recorded provenance is intentionally not associated.
    }
    const selection = new Map(selected.map(run => [run.id, { id: run.id, revision: run.revision }]));
    if (input.kind === "run" && !selection.has(input.id)) selection.set(input.id, { id: input.id, revision: input.revision });
    if (input.kind === "definition") for (const id of input.runIds ?? []) if (!selection.has(id)) selection.set(id, { id, revision: 1 });
    for (const run of intent?.runs ?? []) if (!selection.has(run.id)) selection.set(run.id, run);
    const canonicalDirectories = new Map<string, string>();
    for (const descriptor of selection.values()) {
      const run = selected.find(item => item.id === descriptor.id);
      const directory = this.store.directory(descriptor.id);
      let canonicalDirectory: string | undefined;
      try {
        canonicalDirectory = await realpath(await this.store.ownedDirectory(descriptor.id));
        canonicalDirectories.set(descriptor.id, canonicalDirectory);
      } catch (error) { if (!absent(error)) blocked.push({ code: "unsafe_path", runId: descriptor.id, path: directory, message: text(error) }); }
      const pending = await this.store.pendingDeletion(descriptor.id);
      if (pending && pending.deletionId !== this.intentId(input)) blocked.push({ code: "pending_scope", runId: descriptor.id, message: "此运行已有未完成删除事务，请使用原删除范围继续清理。" });
      if (run) {
        const recorded = intent?.runs.find(item => item.id === run.id);
        if (recorded && input.kind === "definition" && run.sourceDefinition?.id !== input.id && !input.runIds?.includes(run.id)) blocked.push({ code: "invalid_intent", runId: run.id, message: "删除事务包含不属于该定义的运行，不能继续。" });
        if (recorded && recorded.revision !== run.revision) blocked.push({ code: "revision", runId: run.id, message: "已冻结的运行记录被外部修改，先核对删除事务。" });
        result.runs.push({ id: run.id, revision: run.revision, name: run.meta.name, projectPath: run.projectPath });
        if (["preparing", "running", "stopping"].includes(run.execution) || run.application === "applying") blocked.push({ code: "active", runId: run.id, message: "工作流仍在准备、执行或应用；请先停止并等待后台进程退出，再重新预览删除。" });
        let workspaceOwned = true;
        if (run.workspace?.kind === "local") {
          try {
            if (!canonicalDirectory || !run.allowWrite || run.workspaceMode !== "local" || run.workspacePath !== run.workspace.root) throw new Error("Local workspace record does not match its execution scope");
            await validateLocalWorkspaceForDeletion(run.workspace, run.projectPath, canonicalDirectory);
          } catch { workspaceOwned = false; }
        } else if (run.workspace) {
          // Derive aliases only from the verified owned run directory. Never
          // resolve a record-supplied workspace path to infer ownership.
          const expected = [path.join(directory, "workspace"), ...(canonicalDirectory ? [path.join(canonicalDirectory, "workspace")] : [])];
          workspaceOwned = canonicalDirectory !== undefined && expected.includes(path.resolve(run.workspace.root));
          if (workspaceOwned) {
            try { await this.store.ownedDirectory(path.join(run.id, "workspace")); }
            catch (error) { if (!absent(error)) workspaceOwned = false; }
          }
        }
        if (run.workspace && !workspaceOwned) blocked.push({ code: "workspace_ownership", runId: run.id, path: run.workspace.root, message: "工作区位置不属于该运行，不能自动删除。请先核对工作区所有权。" });
        else if (run.workspace && run.workspace.kind !== "git-worktree" && run.workspace.kind !== "local") {
          try {
            const temporary = await inspectProjectTemporaryFiles(run.workspace);
            for (const item of temporary.owned) {
              if (!objects.some(object => object.path === item.path)) objects.push({ path: item.path, kind: "project-temp", files: 1, bytes: item.bytes });
              signatures.push([item.path, (await inventory(item.path)).signature]);
            }
            for (const item of temporary.blocked) blocked.push({ code: "project_temp", runId: run.id, path: item.path, message: item.message });
          } catch { blocked.push({ code: "project_temp", runId: run.id, message: "无法安全核验原项目临时文件，不能确认彻底清理。" }); }
        }
      } else {
        const summary = intent?.runs.find(item => item.id === descriptor.id);
        result.runs.push({ id: descriptor.id, revision: descriptor.revision, name: summary?.name ?? "", projectPath: summary?.projectPath ?? "" });
      }
      if (await this.store.isLocked(descriptor.id)) blocked.push({ code: "locked", runId: descriptor.id, message: "运行仍被后台进程占用；等待进程停止后才能删除。" });
      try {
        try { await this.store.ownedDirectory(descriptor.id); } catch (error) { if (!absent(error)) throw error; }
        const size = await inventory(directory);
        objects.push({ path: directory, kind: "run", bytes: size.bytes, files: size.files }); signatures.push([descriptor.id, size.signature]);
        const lock = `${directory}.lock`;
        try { const info = await lstat(lock); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("运行锁路径不是自有目录，不能自动清理"); } catch (error) { if (!absent(error)) throw error; }
        const lockSize = await inventory(lock);
        if (lockSize.files || lockSize.signature !== hash([])) objects.push({ path: lock, kind: "lock", bytes: lockSize.bytes, files: lockSize.files });
      } catch (error) { blocked.push({ code: "unsafe_path", runId: descriptor.id, path: directory, message: text(error) }); }
    }
    if (input.kind === "definition") {
      try {
        const filename = this.templates.filename(input.id); const size = await inventory(filename);
        objects.push({ path: filename, kind: "definition", bytes: size.bytes, files: size.files }); signatures.push([input.id, size.signature]);
      } catch (error) { blocked.push({ code: "unsafe_path", message: text(error) }); }
    }
    try {
      for (const filename of await this.temporaryMetadata(input, [...selection.keys()])) {
        const size = await inventory(filename); objects.push({ path: filename, kind: "metadata-temp", files: size.files, bytes: size.bytes }); signatures.push([filename, size.signature]);
      }
    } catch (error) { blocked.push({ code: "metadata_temp", message: text(error) }); }
    const selectedIds = new Set(selection.keys());
    const directories = [...selectedIds].map(id => ({ id, directory: this.store.directory(id) }));
    // Accept both configured and canonical paths without following paths supplied by a record.
    const canonicalRoot = await realpath(await this.store.ownedDirectory());
    const directoryVariants = directories.flatMap(entry => {
      // A partial deletion may already have removed this run directory. Its
      // pending intent must still retain effective references to the owned name.
      const canonical = canonicalDirectories.get(entry.id) ?? path.join(canonicalRoot, entry.id);
      return [{ ...entry }, ...(canonical !== entry.directory ? [{ id: entry.id, directory: canonical }] : [])];
    });
    let activationEvidence = selected.some(run => Boolean(run.activation || run.maintenance?.activation));
    for (const run of all) {
      let journal: unknown;
      try { journal = await privateJson(path.join(this.store.directory(run.id), "activation-journal.json")); activationEvidence = true; }
      catch (error) { if (!absent(error)) blocked.push({ code: "activation_journal", runId: run.id, message: "激活记录无法读取，不能确认运行工作区是否仍被引用。" }); }
      if (selectedIds.has(run.id)) continue;
      for (const entry of directoryVariants) if (references([run.projectPath, run.workspace?.original, run.workspace?.root, run.workspacePath], entry.directory).length) blocked.push({ code: "run_reference", runId: entry.id, message: `运行 ${run.id} 仍把这个目录作为项目或工作区；先解除依赖再删除。`, reference: { source: run.id, field: "workspace/project" } });
      for (const entry of directoryVariants) for (const [source, value] of [["activation journal", journal], ["activation result", run.activation], ["maintenance plan", run.maintenance?.activation]] as const) {
        for (const field of references(value, entry.directory)) blocked.push({ code: "run_reference", runId: entry.id, message: `运行 ${run.id} 的激活记录仍引用这个工作区；先处理该引用再删除。`, reference: { source: run.id, field: `${source}.${field}` } });
      }
    }
    if (this.options.readEffectiveConfig) {
      try {
        const config = await this.options.readEffectiveConfig([...new Set([...all.map(run => run.projectPath), ...(intent?.runs.map(run => run.projectPath).filter(Boolean) ?? [])])]);
        const scopes = configScopes(config);
        const canonicalPaths = new Map<string, Promise<string | undefined>>();
        for (const entry of directoryVariants) for (const scope of scopes) for (const [serverName, server] of Object.entries(scope.servers)) for (const field of await serverReferences(server, entry.directory, scope.cwd, canonicalPaths)) blocked.push({ code: "config_reference", runId: entry.id, message: `MCP 服务 ${serverName} 仍使用该工作区；先把服务迁移到独立位置并核验配置，再删除。`, reference: { source: "effective MCP configuration", serverName, field } });
        // Codex may serialize configuration maps in a different key order on each read.
        // Normalize object keys, preserving argv order and all values; store only a digest.
        signatures.push(["effectiveConfig", hash(canonicalConfig(scopes))]);
      } catch { blocked.push({ code: "config_unavailable", message: "无法读取当前有效 MCP 配置，不能确认删除不会中断服务。" }); }
    } else if (activationEvidence) blocked.push({ code: "config_unavailable", message: "当前连接不能核验有效 MCP 配置，暂时不能删除包含激活记录的工作流。" });
    result.totalBytes = objects.reduce((total, item) => total + item.bytes, 0); result.totalFiles = objects.reduce((total, item) => total + item.files, 0);
    result.runs.sort((left, right) => left.id.localeCompare(right.id));
    result.canDelete = blocked.length === 0;
    result.fingerprint = hash({ input, runs: result.runs.map(run => [run.id, run.revision]), definition: result.definition, signatures, blocked });
    return result;
  }
  async execute(raw: DeleteInput & { fingerprint: string }): Promise<DeletionResult> {
    const input = normalizedInput(raw);
    if (!/^[a-f0-9]{64}$/.test(raw.fingerprint)) throw new Error("Invalid deletion preview fingerprint");
    return this.store.withMutation(async () => {
      const preview = await this.inspect(input);
      const unchanged = preview.fingerprint === raw.fingerprint;
      const result: DeletionResult = { deleted: false, partial: false, deletedRunIds: [], remaining: [], blocked: [...preview.blocked] };
      if (!unchanged) result.blocked.push({ code: "preview_changed", message: "删除范围、运行状态或引用已变化，请重新预览并确认删除。" });
      if (result.blocked.length) return result;
      result.alreadyGone = true;
      for (const object of preview.objects) {
        try { await lstat(object.path); result.alreadyGone = false; break; }
        catch (error) { if (!absent(error)) throw error; }
      }
      const releases: Array<() => Promise<void>> = [];
      try {
        if (input.kind === "definition") releases.push(await this.store.acquireNamed(`template_${input.id.slice(6)}`));
        for (const run of preview.runs) releases.push(await this.store.acquireForDeletion(run.id));
      } catch (error) {
        for (const release of releases.reverse()) await release();
        result.blocked.push({ code: "locked", message: "删除前运行或定义被其他进程占用，请等待并重新预览。" }); return result;
      }
      const intent: Intent = { schemaVersion: 1, id: this.intentId(input), input, runs: await Promise.all(preview.runs.map(async run => {
        let record: WorkflowRun | undefined;
        try { record = await this.store.loadForDeletion(run.id); } catch (error) { if (!absent(error)) throw error; }
        const previous = (await this.intent(input))?.runs.find(item => item.id === run.id);
        return { id: run.id, revision: run.revision, name: record?.meta.name ?? previous?.name ?? run.name,
          projectPath: record?.projectPath ?? previous?.projectPath ?? run.projectPath,
          createdAt: record?.createdAt ?? previous?.createdAt ?? new Date().toISOString(),
          ...(record?.sourceDefinition ?? previous?.sourceDefinition ? { sourceDefinition: record?.sourceDefinition ?? previous?.sourceDefinition } : {}) };
      })), ...(preview.definition ? { definition: { id: preview.definition.id, revision: preview.definition.revision } } : {}) };
      try {
        await this.store.writePrivateJson(this.intentPath(input), intent);
        for (const run of intent.runs) await this.store.markDeleted(run.id, intent.id, run.revision, run, input);
        if (intent.definition) await this.templates.markDeleted(intent.definition.id, intent.definition.revision, intent.id);
        const remove = this.options.removeOwnedPath ?? (filename => rm(filename, { recursive: true, force: true }));
        // Remove definition last. A failure retains a visible definition until cleanup is retried.
        for (const run of intent.runs) {
          const directory = this.store.directory(run.id);
          try {
            try { await this.store.ownedDirectory(run.id); } catch (error) { if (!absent(error)) throw error; }
            let record: WorkflowRun | undefined;
            try { record = await this.store.loadForDeletion(run.id); } catch (error) { if (!absent(error)) throw error; }
            if (record?.workspace && record.workspace.kind !== "git-worktree" && record.workspace.kind !== "local") {
              const temporary = await inspectProjectTemporaryFiles(record.workspace, true);
              if (temporary.blocked.length) {
                for (const item of temporary.blocked) result.remaining.push({ path: item.path, reason: item.message });
                continue;
              }
            }
            await remove(directory);
            try { await lstat(directory); throw new Error("删除后运行目录仍存在"); } catch (error) { if (!absent(error)) throw error; }
            result.deletedRunIds.push(run.id);
          } catch { result.remaining.push({ path: directory, reason: "运行数据清理失败；数据已冻结，重新预览后可以重试。" }); }
        }
        if (intent.definition && !result.remaining.length) {
          try { await this.templates.removeOwned(intent.definition.id); result.deletedDefinitionId = intent.definition.id; }
          catch { result.remaining.push({ path: this.templates.filename(intent.definition.id), reason: "工作流定义清理失败，重新预览后可以重试。" }); }
        }
        result.partial = result.remaining.length > 0;
        result.deleted = !result.partial;
      } finally { for (const release of releases.reverse()) await release(); }
      for (const run of preview.runs) {
        try { await lstat(`${this.store.directory(run.id)}.lock`); result.remaining.push({ path: `${this.store.directory(run.id)}.lock`, reason: "运行锁清理未完成，请检查后台进程。" }); }
        catch (error) { if (!absent(error)) result.remaining.push({ path: `${this.store.directory(run.id)}.lock`, reason: "无法确认运行锁已清理。" }); }
      }
      if (input.kind === "definition") {
        const lock = path.join(this.store.root, "locks", `template_${input.id.slice(6)}.lock`);
        try { await lstat(lock); result.remaining.push({ path: lock, reason: "工作流定义锁清理未完成。" }); }
        catch (error) { if (!absent(error)) result.remaining.push({ path: lock, reason: "无法确认定义锁已清理。" }); }
      }
      if (result.remaining.length) { result.deleted = false; result.partial = true; }
      if (result.deleted) {
        try {
            // Exact plugin-owned temporary names can remain after a crashed atomic metadata write.
            for (const filename of await this.temporaryMetadata(input, intent.runs.map(run => run.id))) {
              await this.store.ownedDirectory(path.relative(this.store.root, path.dirname(filename)));
              await rm(filename, { force: true });
            }
            // The request is removed last: a crash at any earlier point retains a restartable scope.
            if (intent.runs.length) {
              await this.store.ownedDirectory(path.join(".deletions", "runs"));
              for (const run of intent.runs) await rm(this.store.deletionMarker(run.id), { force: true });
            }
            if (intent.definition) {
              await this.store.ownedDirectory(path.join(".deletions", "templates"));
              await rm(path.join(this.store.root, ".deletions", "templates", `${intent.definition.id.slice(6)}.json`), { force: true });
            }
            await this.store.ownedDirectory(path.join(".deletions", "requests"));
            await rm(path.join(this.store.root, this.intentPath(input)), { force: true });
            for (const subdirectory of ["runs", "templates", "requests"]) {
              const directory = path.join(this.store.root, ".deletions", subdirectory);
              try { if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true }); } catch (error) { if (!absent(error)) throw error; }
            }
            const deletions = path.join(this.store.root, ".deletions");
            try { if ((await readdir(deletions)).length === 0) await rm(deletions, { recursive: true }); } catch (error) { if (!absent(error)) throw error; }
        } catch { result.remaining.push({ path: path.join(this.store.root, this.intentPath(input)), reason: "删除事务元数据清理未完成，重新预览后可以重试。" }); result.deleted = false; result.partial = true; }
      }
      return result;
    });
  }
}
