import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import lockfile from "proper-lockfile";
import type { WorkerAdapter, WorkerEvent } from "./adapter.ts";
import { canonicalJson, cloneJson, evaluateExpression, validateDefinition, walkNodes } from "./definition.ts";
import type { DefinitionNode, JsonValue, WorkflowDefinition } from "./definition.ts";
import type { ActivityDriver, ActivityRequest, StructuredRun } from "./structured-types.ts";
import type { StructuredStore } from "./structured-store.ts";
import { ExecutionSettingsStore, resolveExecutionSettings } from "./execution-settings.ts";
import type { ExecutionEnvironment } from "./execution-settings.ts";
import { createLocalWorkspace, validateLocalWorkspace, localWorkspaceFingerprint, readOnlyProjectCheckpoint } from "./local-workspace.ts";
import { createWorkspace } from "./workspace.ts";
import { createGitWorkspace, maintenanceFingerprint, validateGitWorkspace } from "./maintenance.ts";
import { snapshotFingerprint } from "./snapshot-checkpoint.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const active = new Set(["running", "pausing", "stopping", "unknown"]);
export async function ownedDirectory(root: string, relative = ""): Promise<string> {
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("Owned workflow directory escapes storage.");
  await mkdir(target, { recursive: true, mode: 0o700 });
  let current = path.parse(target).root;
  for (const piece of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workflow storage requires real directories.");
  }
  if (await realpath(target) !== target) throw new Error("Workflow storage directory identity changed.");
  return target;
}
export async function acquireNamed(root: string, name: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Invalid workflow lock name.");
  const directory = await ownedDirectory(root, "locks");
  for (;;) {
    signal?.throwIfAborted();
    try { return await lockfile.lock(path.join(directory, name), { realpath: false, stale: 10000, update: 2000, onCompromised: () => { process.emit("SIGTERM"); } }); }
    catch (error) {
      if (!signal || (error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 100); signal.addEventListener("abort", done, { once: true }); });
    }
  }
}
function commandManifest(node: DefinitionNode): string | undefined {
  if (node.type !== "command") return;
  const { id: _id, label: _label, ...scope } = node;
  return canonicalJson(cloneJson(scope));
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function visitDefinitions(definition: WorkflowDefinition, visitor: (node: DefinitionNode) => void): void {
  walkNodes(definition, node => { visitor(node); if (node.type === "subflow" && node.definition) visitDefinitions(node.definition, visitor); });
}

/** Bridges durable activities to real Codex workers; no user code is evaluated here. */
export class NativeActivityDriver implements ActivityDriver {
  readonly settings: ExecutionSettingsStore;
  readonly #adapter: WorkerAdapter;
  readonly #store: StructuredStore<StructuredRun>;
  readonly #locks = new Map<string, () => Promise<void>>();
  readonly #environments = new Map<string, ExecutionEnvironment>();
  constructor(store: StructuredStore<StructuredRun>, adapter: WorkerAdapter) {
    this.#adapter = adapter; this.#store = store;
    this.settings = new ExecutionSettingsStore({ root: store.directory, acquireNamed: name => acquireNamed(store.directory, name) });
  }
  async environment(project: string, signal = AbortSignal.timeout(30000)): Promise<ExecutionEnvironment> {
    if (!this.#adapter.executionEnvironment) throw new Error("This worker adapter does not expose the real Codex model catalogue.");
    return this.#adapter.executionEnvironment(project, signal);
  }
  async #lock(run: StructuredRun, signal: AbortSignal): Promise<void> {
    if (!run.grants.allowWrite || this.#locks.has(run.id)) return;
    const release = await acquireNamed(this.#store.directory, `project_${digest(run.projectPath)}`, signal);
    try {
      const conflict = this.#store.listProject(run.projectPath).find(other => other.id !== run.id && active.has(other.status));
      if (conflict) throw new Error(`Project is held by workflow ${conflict.id}; stop it or reconcile unknown effects first.`);
      this.#locks.set(run.id, release);
    } catch (error) { await release(); throw error; }
  }
  async prepare(run: StructuredRun, signal: AbortSignal, onProgress: () => void = () => {}): Promise<void> {
    signal.throwIfAborted();
    const project = await realpath(run.projectPath);
    if (project !== run.projectPath || !(await lstat(project)).isDirectory()) throw new Error("The bound project directory changed; create a new preview.");
    const data = this.#store.directory;
    if (project === data || project.startsWith(data + path.sep) || data.startsWith(project + path.sep)) throw new Error("Project and workflow storage must not overlap.");
    run.preparation = [{ id: "project", label: "核对项目与等待写入时隙", status: "running" }]; onProgress();
    await this.#lock(run, signal);
    run.preparation = [{ id: "project", label: "核对项目与执行授权", status: "completed" }, { id: "workspace", label: "准备工作区", status: "running" }];
    onProgress();
    const directory = await ownedDirectory(data, path.join("runs", run.id));
    if (run.grants.allowWrite && !run.workspace) {
      run.workspace = run.grants.workspaceMode === "local" ? await createLocalWorkspace(project, directory, signal)
        : run.grants.workspaceMode === "git-worktree" ? await createGitWorkspace(project, directory) : await createWorkspace(project, directory);
    }
    run.preparation[1]!.status = "completed";
    if (this.#requiresModel(run.definition)) {
      run.preparation.push({ id: "settings", label: "读取模型配置与原生工具目录", status: "running" }); onProgress();
      const environment = await this.environment(run.workspace?.root ?? project, signal);
      this.#environments.set(run.id, environment);
      run.executionSettings = resolveExecutionSettings(environment, [{ settings: run.executionSettings ?? await this.settings.get(), source: "workflow-settings" }]);
      this.#validateModels(run.definition, run, environment);
      run.preparation[2]!.status = "completed";
    }
    run.preparation.push({ id: "checkpoint", label: "核对代码与构建产物检查点", status: "running" }); onProgress();
    run.workspaceFingerprint = await this.captureCheckpoint(run);
    run.preparation.at(-1)!.status = "completed"; onProgress();
    signal.throwIfAborted();
  }
  #requiresModel(definition: WorkflowDefinition): boolean {
    let required = false; walkNodes(definition, node => { if (node.type === "agent" || node.type === "expand" || node.type === "subflow" && node.definition && this.#requiresModel(node.definition)) required = true; }); return required;
  }
  #validateModels(definition: WorkflowDefinition, run: StructuredRun, environment: ExecutionEnvironment): void {
    visitDefinitions(definition, node => {
      if (node.type !== "agent") return;
      resolveExecutionSettings(environment, [{ settings: run.executionSettings, source: "workflow-settings" }, { settings: { ...(node.model ? { model: node.model } : {}), ...(node.reasoningEffort ? { reasoningEffort: node.reasoningEffort } : {}) }, source: "task" }]);
    });
  }
  async captureCheckpoint(run: StructuredRun): Promise<string> {
    const workspace = run.workspace;
    if (!workspace) return readOnlyProjectCheckpoint(run.projectPath);
    if (workspace.kind === "local") { await validateLocalWorkspace(workspace, run.projectPath, path.join(this.#store.directory, "runs", run.id)); return localWorkspaceFingerprint(workspace); }
    if (workspace.kind === "git-worktree") { await validateGitWorkspace(workspace); return maintenanceFingerprint(workspace); }
    return snapshotFingerprint(workspace);
  }
  async validateCheckpoint(run: StructuredRun, fingerprint: string): Promise<void> {
    await this.#lock(run, AbortSignal.timeout(30000));
    try { if (await this.captureCheckpoint(run) !== fingerprint) throw new Error("Project or workspace changed after the checkpoint. Current files are preserved; create a new run to execute against the changed files."); }
    catch (error) { await this.finish(run); throw error; }
  }
  async execute({ run, node, env }: ActivityRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<JsonValue> {
    const cwd = run.workspace?.root ?? run.projectPath;
    if (node.type === "command") {
      if (!this.#adapter.command) throw new Error("Native command execution is unavailable.");
      if (node.effect === "write" && !run.grants.allowWrite) throw new Error("This command requires explicit write authorization.");
      if (node.networkAccess && !run.grants.networkAccess) throw new Error("This command requires explicit network authorization.");
      if (node.effect === "read" && node.protectedPaths?.length) throw new Error("A read-only command cannot request writable protected paths.");
      const command = node.argv.map(value => { const evaluated = evaluateExpression(value, env); if (typeof evaluated !== "string" || evaluated.includes("\0")) throw new Error("Every command argument must evaluate to a string without NUL."); return evaluated; });
      const result = await this.#adapter.command({ id: `${run.id}_${node.id}`, command, cwd, readOnly: node.effect === "read", networkAccess: node.networkAccess === true, timeoutMs: Math.min(node.timeoutMs ?? run.limits.timeoutMs, run.limits.timeoutMs), retries: 0, ...(node.protectedPaths ? { protectedPaths: node.protectedPaths } : {}) }, signal, onEvent);
      if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}: ${result.stderr.slice(-6000) || result.stdout.slice(-6000)}`);
      return cloneJson(result);
    }
    if (node.type !== "agent" && node.type !== "expand") throw new Error("Unsupported native activity.");
    const task = evaluateExpression(node.task, env);
    if (typeof task !== "string" || !task.trim()) throw new Error("Agent task must evaluate to a nonempty string.");
    const mode = node.type === "agent" ? node.mode ?? "read" : "read";
    if (mode === "write" && !run.grants.allowWrite) throw new Error("This agent requires explicit write authorization.");
    const environment = this.#environments.get(run.id) ?? await this.environment(cwd, signal);
    this.#environments.set(run.id, environment);
    const settings = resolveExecutionSettings(environment, [{ settings: run.executionSettings ?? await this.settings.get(), source: "workflow-settings" }, ...(node.type === "agent" ? [{ settings: { ...(node.model ? { model: node.model } : {}), ...(node.reasoningEffort ? { reasoningEffort: node.reasoningEffort } : {}) }, source: "task" as const }] : [])]);
    const expansion = node.type === "expand";
    const prompt = expansion ? `Generate a structured workflow definition as JSON. Never execute it. schemaVersion=1; name lowercase hyphenated; description string; steps array. Allowed node types: transform, choice, parallel, map, repeat, try, wait, agent. Expressions use {ref:"args.name"} or {op:"eq",args:[...]}. No JS, no shell commands, no subflow references, no new permissions. Bounded loops only. Return {definitionJson: <the serialized definition>}. Requested plan:\n${task}`
      : `Workflow: ${run.definition.name}\nGoal: ${run.definition.description}\nNode: ${node.label ?? node.id}\n${task}\n\nWork only in the supplied directory. Respect the supplied sandbox and tool grants. Report the actual result, including failures. Never invent a successful tool result.`;
    const schema = expansion ? { type: "object", properties: { definitionJson: { type: "string" } }, required: ["definitionJson"], additionalProperties: false } : record(node.schema);
    const total = run.instances.flatMap(item => item.attempts).reduce((sum, attempt) => sum + (attempt.usage?.totalTokens ?? 0), 0);
    const output = await this.#adapter.run({ id: `${run.id}_${node.id}`, prompt, cwd, mode, model: settings.model!, reasoningEffort: settings.reasoningEffort!, settingsSource: settings.source,
      ...(schema ? { outputSchema: schema } : {}), ...(!expansion && record(node.accept) ? { accept: record(node.accept)! } : {}),
      maxRecoveryAttempts: expansion ? 1 : node.maxRecoveryAttempts ?? 2,
      ...(run.limits.maxTokens ? { remainingTokenBudget: Math.max(0, run.limits.maxTokens - total) } : {}), timeoutMs: run.limits.timeoutMs,
      networkAccess: !expansion && run.grants.networkAccess, mcpServers: expansion ? [] : run.grants.allowedMcpServers, mcpTools: expansion ? {} : run.grants.allowedMcpTools,
      localGitWrite: mode === "write" && run.grants.workspaceMode === "local", approvalMode: run.grants.approvalMode }, signal, onEvent);
    if (expansion) {
      const response = record(output.data ?? JSON.parse(output.output));
      if (typeof response?.definitionJson !== "string") throw new Error("Planner did not return a serialized structured definition.");
      const definition = validateDefinition(JSON.parse(response.definitionJson));
      this.#validateModels(definition, run, environment);
      const manifests = new Set<string>(); visitDefinitions(run.definition, original => { const manifest = commandManifest(original); if (manifest) manifests.add(manifest); });
      visitDefinitions(definition, generated => {
        if (generated.type === "subflow" && generated.ref) throw new Error("Expanded definitions must contain frozen inline subflows.");
        const manifest = commandManifest(generated); if (manifest && !manifests.has(manifest)) throw new Error("Dynamic expansion cannot introduce a new command authorization; declare the command in the initial definition.");
      });
      return cloneJson(definition);
    }
    return cloneJson(output.data ?? output.output);
  }
  async finish(run: StructuredRun): Promise<void> { this.#environments.delete(run.id); const release = this.#locks.get(run.id); if (release) { this.#locks.delete(run.id); await release(); } }
  async close(): Promise<void> { await this.#adapter.close(); for (const [id, release] of this.#locks) { this.#locks.delete(id); await release(); } }
}
