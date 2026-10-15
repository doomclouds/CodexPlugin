import { randomBytes, createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "./adapter.ts";
import type { WorkerAdapter } from "./adapter.ts";
import { executeScript, validateScript, validateWorkflowArgs } from "./script.ts";
import { RunStore } from "./store.ts";
import { listGitlinks, gitAwareContextDigest, readOnlyGitContextDigest } from "./submodules.ts";
import { snapshotFingerprint } from "./snapshot-checkpoint.ts";
import { createLocalWorkspace, validateLocalWorkspace, localWorkspaceDiff, captureLocalWorkspaceCheckpoints } from "./local-workspace.ts";
import { stopSummary } from "./stop-context.ts";
import { nodeProcess } from "./node-process.ts";
import type { WorkflowStopReason } from "./stop-context.ts";
import { applyWorkspace, contextDigest, createWorkspace, workspaceDiff } from "./workspace.ts";
import { createGitWorkspace, validateMaintenance, reviewMaintenance, applyMaintenance, maintenanceFingerprint, validateGitWorkspace } from "./maintenance.ts";
import type { Activity, ApprovalMode, Attempt, Limits, Task, WorkflowRun, MaintenancePlan, Preparation, DefinitionSource, WorkspaceMode } from "./types.ts";
import { resolveApprovalMode } from "./approval-mode.ts";
import { ExecutionSettingsStore, modelSettingsSchema, resolveExecutionSettings, validateExplicitModelSettings, validateNodeSettings } from "./execution-settings.ts";
import type { EffectiveExecutionSettings, ExecutionEnvironment, ModelSettings, NodeSettings, StoredExecutionSettings } from "./execution-settings.ts";
import { buildWorkerPrompt } from "./worker-prompt.ts";

const now = () => new Date().toISOString();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaults: Limits = { maxReadWorkers: 4, maxCalls: 1000, timeoutMs: 60 * 60 * 1000, maxTokens: 0 };
const taskFingerprint = (prompt: string, options: Record<string, unknown>, settings?: EffectiveExecutionSettings) => digest({ prompt, options, ...(settings?.model || settings?.reasoningEffort ? { executionSettings: { model: settings.model, reasoningEffort: settings.reasoningEffort } } : {}) });
interface Active { controller: AbortController; done: Promise<void>; tasks: Map<string, AbortController>; environment?: ExecutionEnvironment; environmentPromise?: Promise<ExecutionEnvironment> }

class LocalReplayError extends Error {
  readonly recovery = "new-preview";
}

class Pool {
  private running = 0;
  private waiting: Array<() => void> = [];
  private capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  async use<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error("Workflow interrupted");
    if (this.running >= this.capacity) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiting = this.waiting.filter(item => item !== ready); reject(new Error("Workflow interrupted")); };
        this.waiting.push(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.running++;
    try { if (signal.aborted) throw new Error("Workflow interrupted"); return await operation(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  }
}

export class WorkflowEngine {
  readonly store: RunStore;
  private adapter: WorkerAdapter;
  private runs = new Map<string, WorkflowRun>();
  private active = new Map<string, Active>();
  private writePool = new Pool(1);
  private leases = new Map<string, number>();
  private watchdog: NodeJS.Timeout;
  private initialization: Promise<void>;
  private processingControls = false;
  private readonly settings: ExecutionSettingsStore;
  private readonly configAbort = new AbortController();
  private readonly configurations = new Set<Promise<unknown>>();
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;
  constructor(options: { store?: RunStore; adapter?: WorkerAdapter } = {}) {
    this.store = options.store ?? new RunStore();
    this.adapter = options.adapter ?? new CodexAdapter();
    this.settings = new ExecutionSettingsStore(this.store);
    this.initialization = this.initialize();
    this.watchdog = setInterval(() => {
      void this.processControls().catch(error => console.error("Workflow control failed:", message(error)));
      for (const [id] of this.active) {
        const run = this.runs.get(id)!;
        if (run.leaseId && (this.leases.get(run.leaseId) ?? 0) < Date.now()) void this.stop(id, "lease-expired").catch(error => console.error("Workflow lease stop failed:", message(error)));
      }
    }, 1000);
    this.watchdog.unref();
  }
  private async processControls() {
    if (this.processingControls) return;
    this.processingControls = true;
    try {
      for (const [id] of this.active) {
        const controlId = this.runs.get(id)?.controlId;
        if (controlId) await this.store.consumeControls(id, controlId, async (action, taskId) => {
          if (action === "stop") await this.stop(id);
          else await this.cancelTask(id, taskId!);
        });
      }
    } finally { this.processingControls = false; }
  }
  private async initialize() {
    for (const run of await this.store.list()) {
      try {
        if (!run.deletionPending && (["preparing", "running", "stopping"].includes(run.execution) || run.application === "applying") && !await this.store.isLocked(run.id)) await this.recover(run.id);
        this.runs.set(run.id, await this.store.load(run.id));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  private async recover(id: string) {
    const current = await this.store.load(id);
    if (current.deletionPending) { this.runs.set(id, current); return; }
    let release: (() => Promise<void>);
    try { release = await this.store.acquire(id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
      // A deletion can freeze or remove this record between inspection and
      // acquisition. Preserve its cleanup view rather than resurrecting it.
      try { const latest = await this.store.load(id); if (latest.deletionPending) { this.runs.set(id, latest); return; } }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") return; throw readError; }
      throw error;
    }
    try {
      const run = await this.store.load(id);
      if (run.deletionPending) { this.runs.set(id, run); return; }
      if (["preparing", "running", "stopping"].includes(run.execution)) {
        run.execution = "stopped";
        run.stopReason ??= "owner-exited"; delete run.error; delete run.failureContext;
        this.finishPreparation(run, "interrupted");
        run.endedAt = now();
        for (const task of run.tasks) if (["running", "queued", "stopping"].includes(task.status)) {
          task.status = "interrupted";
          const attempt = task.attempts.at(-1);
          if (attempt && ["running", "queued", "stopping"].includes(attempt.status)) { attempt.status = "interrupted"; attempt.endedAt = now(); }
          for (const activity of attempt?.activities ?? []) if (activity.status === "running") { activity.status = "interrupted"; activity.endedAt = now(); }
          if (task.currentActivity?.status === "running") { task.currentActivity.status = "interrupted"; task.currentActivity.endedAt = now(); }
        }
        this.log(run, "Previous process ended. Progress retained; resume must be started manually.");
        await this.persist(run);
      }
      if (run.application === "applying") {
        run.application = "failed";
        run.error = "Application was interrupted. Review and retry; files matching the reviewed result are retained and other changes require conflict resolution.";
        await this.persist(run);
      }
      this.runs.set(run.id, run);
    } finally { await release(); }
  }
  private clearProgress(id: string) { const timer = this.progressTimers.get(id); if (timer) clearTimeout(timer); this.progressTimers.delete(id); }
  private async persist(run: WorkflowRun) { this.clearProgress(run.id); run.updatedAt = now(); run.revision++; await this.store.save(run); }
  private async persistProgress(run: WorkflowRun) { this.clearProgress(run.id); run.updatedAt = now(); run.progressSequence = (run.progressSequence ?? 0) + 1; await this.store.save(run); }
  private scheduleProgress(run: WorkflowRun) {
    if (!this.active.has(run.id) || this.progressTimers.has(run.id)) return;
    const timer = setTimeout(() => { void this.persistProgress(run).catch(error => { const active = this.active.get(run.id); run.error = `Could not save workflow progress: ${message(error)}`; active?.controller.abort(); }); }, 250);
    timer.unref(); this.progressTimers.set(run.id, timer);
  }
  private log(run: WorkflowRun, text: string, taskId?: string, level: "info" | "error" = "info") {
    if (run.logs.length >= 5000) run.logs.shift();
    run.logs.push({ at: now(), level, message: text.slice(0, 16000), ...(taskId ? { taskId } : {}) });
    this.scheduleProgress(run);
  }
  private async load(id: string) {
    await this.initialization;
    let run = this.active.has(id) ? this.runs.get(id)! : await this.store.load(id);
    if (!run.deletionPending && !this.active.has(id) && (["preparing", "running", "stopping"].includes(run.execution) || run.application === "applying") && !await this.store.isLocked(id)) { await this.recover(id); run = await this.store.load(id); }
    this.runs.set(id, run);
    return run;
  }
  async get(id: string) {
    let run = await this.load(id);
    const active = this.active.get(id);
    // A terminal script result is not ready until review, checkpoint and lock cleanup finish.
    if (active && !["preparing", "running", "stopping"].includes(run.execution)) { await active.done; run = await this.load(id); }
    return structuredClone(run);
  }
  async getNodeProcess(id: string, input: Parameters<typeof nodeProcess>[1]) {
    // Diagnostics remain readable while terminal checkpoint and lock cleanup
    // finish; this bounded projection never supplies an actionable run scope.
    return nodeProcess(await this.load(id), input);
  }
  async list(projectPath?: string) {
    await this.initialization;
    const project = projectPath ? await realpath(projectPath) : undefined;
    const runs = await this.store.list();
    return runs.filter(run => !project || run.projectPath === project);
  }
  private configuration<T>(operation: () => Promise<T>): Promise<T> {
    if (this.configAbort.signal.aborted) return Promise.reject(new Error("Workflow engine is closed."));
    const pending = Promise.resolve().then(operation);
    this.configurations.add(pending);
    return pending.finally(() => { this.configurations.delete(pending); });
  }
  private async executionEnvironment(projectPath?: string, signal = this.configAbort.signal) {
    if (!this.adapter.executionEnvironment) throw new Error("This worker adapter cannot provide the Codex model catalogue.");
    const cwd = await realpath(projectPath ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("projectPath must be a directory");
    return this.adapter.executionEnvironment(cwd, signal);
  }
  private async agentEnvironment(run: WorkflowRun, active: Active): Promise<ExecutionEnvironment | undefined> {
    if (active.environment || !this.adapter.executionEnvironment) return active.environment;
    active.environmentPromise ??= this.executionEnvironment(run.projectPath, AbortSignal.any([this.configAbort.signal, active.controller.signal])).then(async environment => {
      if (active.controller.signal.aborted) throw new Error("Workflow interrupted before model selection.");
      const effective = resolveExecutionSettings(environment, [{ settings: run.executionSettings ?? {}, source: run.executionSettings?.source ?? "codex-config" }]);
      for (const settings of Object.values(run.nodeSettings ?? {})) validateExplicitModelSettings(settings, environment);
      run.executionSettings = { ...effective, provenance: "requested" };
      active.environment = environment;
      await this.persist(run);
      return environment;
    });
    return active.environmentPromise;
  }
  private settingsView(settings: StoredExecutionSettings, environment: ExecutionEnvironment) {
    const source = settings.model !== undefined || settings.reasoningEffort !== undefined ? "workflow-settings" as const : "codex-config" as const;
    const base = { settings, models: environment.models, codexDefaults: environment.defaults, source, mainAgentContextAvailable: false as const };
    try {
      const effectiveDefaults = resolveExecutionSettings(environment, [{ settings, source }]);
      return { ...base, effectiveDefaults, defaultsStatus: { available: true } };
    } catch (error) { return { ...base, defaultsStatus: { available: false, reason: message(error) } }; }
  }
  private workerSettings(run: WorkflowRun, options: Record<string, unknown>, index: number, phase: string | undefined, environment?: ExecutionEnvironment): EffectiveExecutionSettings | undefined {
    const script: ModelSettings = { ...(typeof options.model === "string" ? { model: options.model } : {}), ...(typeof options.reasoningEffort === "string" ? { reasoningEffort: options.reasoningEffort } : {}) };
    if (!environment) return script.model || script.reasoningEffort ? { ...script, source: "script", provenance: "requested" } : undefined;
    return { ...resolveExecutionSettings(environment, [
      { settings: run.executionSettings ?? {}, source: run.executionSettings?.source ?? "workflow-settings" },
      { settings: script, source: "script" },
      { ...(phase ? { settings: run.nodeSettings?.[`phase:${phase}`] } : {}), source: "phase" },
      { ...(run.nodeSettings?.[`task:${index}`] ? { settings: run.nodeSettings[`task:${index}`] } : {}), source: "task" },
    ]), provenance: "requested" };
  }
  getExecutionSettings(projectPath?: string) {
    return this.configuration(async () => this.settingsView(await this.settings.get(), await this.executionEnvironment(projectPath)));
  }
  updateExecutionSettings(input: StoredExecutionSettings & { projectPath?: string }) {
    return this.configuration(async () => {
      const settings = { revision: input.revision, ...modelSettingsSchema.parse({ ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) }) };
      const environment = await this.executionEnvironment(input.projectPath);
      validateExplicitModelSettings(settings, environment);
      if (settings.model !== undefined || settings.reasoningEffort !== undefined) resolveExecutionSettings(environment, [{ settings, source: "workflow-settings" }]);
      return this.settingsView(await this.settings.update(settings), environment);
    });
  }
  async preview(input: { projectPath: string; script: string; args?: unknown; allowWrite?: boolean; networkAccess?: boolean; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; workspaceMode?: WorkspaceMode; approvalMode?: ApprovalMode; maintenance?: MaintenancePlan; limits?: Partial<Limits>; nodeSettings?: NodeSettings; sourceDefinition?: DefinitionSource }) {
    await this.initialization;
    const { meta } = validateScript(input.script);
    validateWorkflowArgs(meta, input.args === undefined ? {} : input.args);
    const nodeSettings = validateNodeSettings(input.nodeSettings, meta);
    const approvalMode = resolveApprovalMode(input.approvalMode, "auto-review");
    const projectPath = await realpath(input.projectPath);
    if (!(await stat(projectPath)).isDirectory()) throw new Error("projectPath must be a directory");
    if (input.workspaceMode === "local" && !input.allowWrite) throw new Error("Local project mode requires explicit allowWrite permission");
    if (input.workspaceMode === "git-worktree" && !input.allowWrite) throw new Error("Git maintenance requires an isolated writable workspace");
    if (input.maintenance && (!input.allowWrite || input.workspaceMode !== "git-worktree")) throw new Error("Maintenance operations require git-worktree isolation and allowWrite");
    if (input.allowedMcpServers?.some(name => !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || /workflows/i.test(name))) throw new Error("Invalid or recursive MCP server grant");
    if (input.maintenance) input.maintenance = validateMaintenance(input.maintenance, input.networkAccess ?? false);
    this.validateMcpTools(input.allowedMcpServers ?? [], input.allowedMcpTools);
    const limits = { ...defaults, ...input.limits };
    if (!Number.isInteger(limits.maxReadWorkers) || limits.maxReadWorkers < 1 || limits.maxReadWorkers > 16 || !Number.isInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 1000 || limits.timeoutMs < 100 || limits.timeoutMs > 24 * 60 * 60 * 1000 || limits.maxTokens < 0) throw new Error("Invalid workflow limits");
    const run: WorkflowRun = {
      id: `wf_${randomBytes(12).toString("hex")}`, revision: 0, createdAt: now(), updatedAt: now(),
      meta, script: input.script, scriptDigest: digest(input.script), args: input.args === undefined ? {} : input.args, projectPath,
      approvalMode,
      allowWrite: input.allowWrite ?? false, networkAccess: input.networkAccess ?? false, allowedMcpServers: input.allowedMcpServers ?? [], allowedMcpTools: input.allowedMcpTools ?? {}, workspaceMode: input.workspaceMode ?? "snapshot", ...(input.maintenance ? { maintenance: input.maintenance } : {}), ...(input.nodeSettings !== undefined ? { nodeSettings } : {}), limits, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [],
      ...(input.workspaceMode === "local" && input.allowWrite ? { localGitWrite: true as const } : {}),
      ...(input.sourceDefinition ? { sourceDefinition: { ...input.sourceDefinition } } : {}),
    };
    this.log(run, "Plan saved for preview. No worker has started.");
    run.updatedAt = now(); run.revision++;
    await this.store.create(run);
    return structuredClone(run);
  }
  async update(input: { id: string; revision: number; script: string; args: unknown; allowWrite?: boolean; networkAccess?: boolean; allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>; workspaceMode?: WorkspaceMode; approvalMode?: ApprovalMode; maintenance?: MaintenancePlan; nodeSettings?: NodeSettings }) {
    let run = await this.load(input.id);
    this.assertActionAvailable(run);
    if (this.active.has(run.id)) throw new Error("This workflow is running");
    const release = await this.store.acquire(run.id);
    try {
    run = await this.store.load(input.id);
    this.assertActionAvailable(run);
    this.assertRevision(run, input.revision);
    if (this.active.has(run.id) || ["preparing", "running", "stopping"].includes(run.execution) || run.application !== "none") throw new Error("This workflow cannot be edited while running or after application");
    const { meta } = validateScript(input.script);
    validateWorkflowArgs(meta, input.args);
    const nodeSettings = validateNodeSettings(input.nodeSettings ?? run.nodeSettings, meta);
    const approvalMode = resolveApprovalMode(input.approvalMode, resolveApprovalMode(run.approvalMode));
    if (input.allowWrite !== undefined && input.allowWrite !== run.allowWrite && run.workspace) throw new Error("Changing write scope requires a new preview and workspace");
    if (run.meta.description !== meta.description) {
      for (const task of run.tasks) task.status = "interrupted";
      this.log(run, "Overall delegated task changed; saved task results will not be reused.");
    }
    if (run.script !== input.script) delete run.sourceDefinition;
    run.script = input.script; run.scriptDigest = digest(input.script); run.meta = meta; run.args = input.args;
    if (input.nodeSettings !== undefined || run.nodeSettings !== undefined) run.nodeSettings = nodeSettings;
    const scopes = {
      allowWrite: input.allowWrite ?? run.allowWrite,
      networkAccess: input.networkAccess ?? run.networkAccess ?? false,
      allowedMcpServers: input.allowedMcpServers ?? run.allowedMcpServers ?? [],
      allowedMcpTools: input.allowedMcpTools ?? run.allowedMcpTools ?? {},
      workspaceMode: input.workspaceMode ?? run.workspaceMode ?? "snapshot",
      maintenance: input.maintenance ?? run.maintenance,
    };
    if (scopes.maintenance) scopes.maintenance = validateMaintenance(scopes.maintenance, scopes.networkAccess);
    if (run.workspace && digest(scopes) !== digest({ allowWrite: run.allowWrite, networkAccess: run.networkAccess ?? false, allowedMcpServers: run.allowedMcpServers ?? [], allowedMcpTools: run.allowedMcpTools ?? {}, workspaceMode: run.workspaceMode ?? "snapshot", maintenance: run.maintenance })) throw new Error("Changing execution scope requires a new preview and workspace");
    if (scopes.allowedMcpServers.some(name => !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || /workflows/i.test(name))) throw new Error("Invalid or recursive MCP server grant");
    this.validateMcpTools(scopes.allowedMcpServers, scopes.allowedMcpTools);
    if (scopes.workspaceMode === "local" && !scopes.allowWrite) throw new Error("Local project mode requires explicit allowWrite permission");
    if (scopes.maintenance && (!scopes.allowWrite || scopes.workspaceMode !== "git-worktree")) throw new Error("Maintenance operations require git-worktree isolation and allowWrite");
    const previousScope = { allowWrite: run.allowWrite, networkAccess: run.networkAccess ?? false, allowedMcpServers: run.allowedMcpServers ?? [], allowedMcpTools: run.allowedMcpTools ?? {}, workspaceMode: run.workspaceMode ?? "snapshot", maintenance: run.maintenance };
    const localWriteScopeChanged = scopes.workspaceMode !== previousScope.workspaceMode || scopes.allowWrite !== previousScope.allowWrite;
    if (!run.workspace && localWriteScopeChanged) {
      if (scopes.workspaceMode === "local" && scopes.allowWrite) {
        if (run.tasks.some(task => task.attempts.length > 0)) throw new Error("Enabling local Git write scope after a worker attempt requires a new preview");
        run.localGitWrite = true;
      } else delete run.localGitWrite;
    }
    if (digest(scopes) !== digest(previousScope)) {
      for (const task of run.tasks) task.status = "interrupted";
      this.log(run, "Execution permissions changed; saved task results will not be reused.");
    }
    Object.assign(run, scopes);
    if (input.approvalMode !== undefined) {
      if (approvalMode !== resolveApprovalMode(run.approvalMode)) this.log(run, `Worker approval mode changed to ${approvalMode}; file, network and MCP tool scope remain unchanged.`);
      run.approvalMode = approvalMode;
    }
    run.execution = "draft"; run.review = "unavailable";
    delete run.result; delete run.diff; delete run.error; delete run.failureContext; delete run.stopReason;
    delete run.preparation; delete run.startedAt; delete run.endedAt;
    this.log(run, "Plan changed. Start again from the updated preview; replay validates each cached task.");
    await this.persist(run);
    return structuredClone(run);
    } finally { await release(); }
  }
  private validateMcpTools(servers: string[], tools?: Record<string, string[]>) {
    if (tools && Object.entries(tools).some(([server, names]) => !servers.includes(server) || !Array.isArray(names) || names.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(name)))) throw new Error("MCP tool grants must name tools on explicitly granted servers");
  }
  private assertRevision(run: WorkflowRun, expected: number) { if (run.revision !== expected) throw new Error("Workflow changed; refresh the preview before this action"); }
  private assertActionAvailable(run: WorkflowRun) { if (run.deletionPending) throw new Error("工作流清理尚未完成，请先继续删除。"); }
  lease(input: { leaseId?: string; release?: boolean }) {
    const id = input.leaseId ?? randomBytes(16).toString("hex");
    if (input.leaseId && !this.leases.has(id)) throw new Error("Panel lease is unknown or expired; reconnect the panel");
    if (input.release) {
      this.leases.delete(id);
      for (const [runId] of this.active) if (this.runs.get(runId)?.leaseId === id) void this.stop(runId, "panel-closed").catch(error => console.error("Panel release failed:", message(error)));
      return { leaseId: id, expiresAt: 0 };
    }
    const expiresAt = Date.now() + 90000;
    this.leases.set(id, expiresAt);
    return { leaseId: id, expiresAt };
  }
  private retryBoundary(run: WorkflowRun, taskId: string | undefined, resume: boolean): number | undefined {
    if (taskId === undefined) return undefined;
    if (!resume) throw new Error("Retrying a task requires workflow_resume");
    const task = run.tasks.find(item => item.id === taskId);
    if (!task || !Number.isSafeInteger(task.index) || task.index < 0 || task.id !== `task_${task.index + 1}`) throw new Error("Unknown workflow retry task");
    for (const later of run.tasks.filter(item => item.index >= task.index)) {
      const operation = later.options.operation as { id?: string } | undefined;
      if (operation && later.attempts.some(attempt => attempt.startedAt) && run.maintenance?.steps.find(step => step.id === operation.id)?.idempotent !== true) {
        throw new Error(`Operation ${operation.id} already started and is not declared idempotent. Inspect its actual effects and create a revised preview before retrying this task or its following steps.`);
      }
    }
    return task.index;
  }
  async start(input: { id: string; revision: number; leaseId?: string; retryFromTaskId?: string; approvalMode?: ApprovalMode }, resume = false) {
    if (this.closing) throw new Error("Workflow execution service is closing");
    if (!resume && input.approvalMode !== undefined) throw new Error("Choose worker approval mode in the preview before workflow_start");
    if (input.approvalMode !== undefined) resolveApprovalMode(input.approvalMode);
    let run = await this.load(input.id);
    this.assertActionAvailable(run);
    this.assertRevision(run, input.revision);
    if (this.active.has(run.id) || await this.store.isLocked(run.id)) throw new Error("Old workers have not exited; workflow cannot be relaunched");
    if (resume ? !["stopped", "failed"].includes(run.execution) : run.execution !== "draft") throw new Error("Workflow state does not permit this action");
    this.retryBoundary(run, input.retryFromTaskId, resume);
    if (input.leaseId && (this.leases.get(input.leaseId) ?? 0) < Date.now()) throw new Error("Panel lease expired");
    const release = await this.store.acquire(run.id);
    let active: Active | undefined;
    let launch: (() => void) | undefined;
    try {
      run = await this.store.load(input.id);
      if (this.closing) throw new Error("Workflow execution service is closing");
      this.assertActionAvailable(run);
      this.runs.set(run.id, run);
      this.assertRevision(run, input.revision);
      if (resume ? !["stopped", "failed"].includes(run.execution) : run.execution !== "draft") throw new Error("Workflow state changed before start");
      const retryFrom = this.retryBoundary(run, input.retryFromTaskId, resume);
      const approvalMode = resolveApprovalMode(input.approvalMode, resolveApprovalMode(run.approvalMode));
      const { meta, mayUseAgent } = validateScript(run.script);
      validateWorkflowArgs(meta, run.args);
      run.meta = meta;
      run.nodeSettings = validateNodeSettings(run.nodeSettings, meta);
      const settings = await this.settings.get();
      if (this.closing) throw new Error("Workflow execution service is closing");
      const explicitSettings = settings.model || settings.reasoningEffort || run.executionSettings?.model || run.executionSettings?.reasoningEffort || Object.values(run.nodeSettings).some(settings => settings.model || settings.reasoningEffort);
      if (!this.adapter.executionEnvironment && explicitSettings) throw new Error("This worker adapter cannot validate configured model settings.");
      if (input.approvalMode !== undefined) {
        if (approvalMode !== resolveApprovalMode(run.approvalMode)) this.log(run, `Manual resume selected worker approval mode ${approvalMode}; file, network and MCP tool scope remain unchanged.`);
        run.approvalMode = approvalMode;
      }
      if (retryFrom !== undefined) {
        for (const task of run.tasks) if (task.index >= retryFrom) task.cacheInvalidated = true;
        this.log(run, `Explicit retry from ${input.retryFromTaskId}: preserving earlier results and invalidating this task and its following results.`);
      }
      run.controlId = randomBytes(16).toString("hex");
      run.execution = "preparing"; run.review = "unavailable"; run.application = "none";
      run.startedAt = now(); run.preparation = { startedAt: run.startedAt, stages: [] }; delete run.endedAt;
      delete run.error; delete run.diff; delete run.result; delete run.failureContext; delete run.stopReason;
      if (input.leaseId) run.leaseId = input.leaseId; else delete run.leaseId;
      const gate = new Promise<void>(resolve => { launch = resolve; });
      active = { controller: new AbortController(), tasks: new Map(), done: Promise.resolve() };
      this.active.set(run.id, active);
      const owned = active;
      owned.done = gate.then(() => this.prepare(run, owned, settings, Boolean(mayUseAgent || explicitSettings), resume)).finally(async () => { this.clearProgress(run.id); try { await release(); } finally { this.active.delete(run.id); } });
      void owned.done.catch(error => console.error("Workflow cleanup failed:", message(error)));
      this.log(run, resume ? "Manual resume requested; preparing execution and validating saved results." : "Start requested; preparing execution before launching workers.");
      await this.persist(run);
      const accepted = structuredClone(run);
      launch!();
      return accepted;
    } catch (error) {
      if (active) { active.controller.abort(); launch?.(); await active.done.catch(() => {}); }
      else await release();
      throw error;
    }
  }
  private finishPreparation(run: WorkflowRun, status: "failed" | "interrupted") {
    if (!run.preparation || run.preparation.endedAt) return;
    const endedAt = now();
    for (const stage of run.preparation.stages) if (stage.status === "running") { stage.status = status; stage.endedAt = endedAt; }
    run.preparation.endedAt = endedAt;
  }
  private preparationGuard(run: WorkflowRun, active: Active) {
    if (active.controller.signal.aborted) throw new Error("Workflow interrupted while preparing execution.");
    if (run.leaseId && (this.leases.get(run.leaseId) ?? 0) < Date.now()) { run.stopReason ??= "lease-expired"; active.controller.abort(); throw new Error("Panel closed while preparing the workspace; workers were not started"); }
  }
  private async preparationStage<T>(run: WorkflowRun, active: Active, id: Preparation["stages"][number]["id"], label: string, operation: () => Promise<T>): Promise<T> {
    this.preparationGuard(run, active);
    const stage: Preparation["stages"][number] = { id, label, status: "running", startedAt: now() };
    run.preparation!.stages.push(stage);
    await this.persistProgress(run);
    this.preparationGuard(run, active);
    // Non-cancelable local hashing/copying is still owned until its promise settles.
    const result = await operation();
    this.preparationGuard(run, active);
    stage.status = "completed"; stage.endedAt = now();
    await this.persistProgress(run);
    return result;
  }
  private async prepare(run: WorkflowRun, active: Active, settings: StoredExecutionSettings, needsEnvironment: boolean, resume: boolean) {
    let releaseProject: (() => Promise<void>) | undefined;
    try {
      if (run.workspaceMode === "local" && (!run.allowWrite || run.maintenance) || run.workspace?.kind === "local" && run.workspaceMode !== "local") throw new Error("Local mode requires an explicitly writable local project plan without isolated maintenance operations");
      await this.preparationStage(run, active, "settings", "读取执行设置并核对模型", async () => {
        const environment = this.adapter.executionEnvironment && needsEnvironment ? await this.executionEnvironment(run.projectPath, AbortSignal.any([this.configAbort.signal, active.controller.signal])) : undefined;
        if (!run.executionSettings) run.executionSettings = environment ? { ...resolveExecutionSettings(environment, [{ settings, source: settings.model || settings.reasoningEffort ? "workflow-settings" : "codex-config" }]), provenance: "requested" } : {};
        if (environment) {
          resolveExecutionSettings(environment, [{ settings: run.executionSettings, source: run.executionSettings.source ?? "workflow-settings" }]);
          for (const choice of Object.values(run.nodeSettings ?? {})) validateExplicitModelSettings(choice, environment);
          active.environment = environment;
        }
      });
      await this.preparationStage(run, active, "project", run.workspaceMode === "local" ? "等待项目空闲并核对目录" : "核对项目基线与已有改动", async () => {
        if (run.workspaceMode === "local") {
          const waiting = AbortSignal.any([active.controller.signal, AbortSignal.timeout(run.limits.timeoutMs)]);
          try { releaseProject = await this.store.acquireNamed(`apply_${digest(run.projectPath)}`, waiting); }
          catch (error) { if (waiting.aborted && !active.controller.signal.aborted) throw new Error("Timed out waiting for another workflow to finish editing this local project"); throw error; }
          this.preparationGuard(run, active);
          return;
        }
        let context: string;
        try {
          const gitlinks = await listGitlinks(run.projectPath);
          if (gitlinks.length && run.allowWrite && run.workspaceMode !== "git-worktree") throw new Error("Snapshot writing does not copy Git submodules. Create a new preview with workspaceMode: git-worktree to retain their commit and initialization state.");
          context = gitlinks.length ? await gitAwareContextDigest(run.projectPath) : await contextDigest(run.projectPath);
          if (!run.allowWrite) context = digest({ files: context, git: await readOnlyGitContextDigest(run.projectPath) });
        } catch (error) { if (run.allowWrite) throw error; context = randomBytes(16).toString("hex"); }
        if (run.contextDigest && run.contextDigest !== context) {
          if (run.workspace) throw new Error("Project changed since the workspace snapshot. Create a new preview to preserve those changes.");
          for (const task of run.tasks) task.status = "interrupted";
          this.log(run, "Project changed; saved task results will not be reused.");
        }
        run.contextDigest = context;
      });
      if (run.allowWrite) await this.preparationStage(run, active, "workspace", run.workspaceMode === "local" ? run.workspace ? "核对本地项目与已有改动" : "记录本地项目基线" : run.workspace ? "检查并复用隔离工作区" : "准备隔离工作区", async () => {
        if (!run.workspace) { run.workspace = run.workspaceMode === "local" ? await createLocalWorkspace(run.projectPath, this.store.directory(run.id), active.controller.signal) : run.workspaceMode === "git-worktree" ? await createGitWorkspace(run.projectPath, this.store.directory(run.id)) : await createWorkspace(run.projectPath, this.store.directory(run.id)); run.workspacePath = run.workspace.root; }
      });
      await this.preparationStage(run, active, "validation", "验证工作区与执行范围", async () => {
        if (run.workspace && !(await stat(run.workspace.root)).isDirectory()) throw new Error("Saved workspace is missing; cannot resume");
        if (run.workspaceMode === "local") {
          if (!run.workspace || run.workspace.kind !== "local" || run.workspacePath !== run.workspace.root) throw new Error("Local project workspace identity is missing or inconsistent");
          await validateLocalWorkspace(run.workspace, run.projectPath, this.store.directory(run.id));
          if (run.workspaceCheckpoint) {
            const checkpoints = await captureLocalWorkspaceCheckpoints(run.workspace, active.controller.signal);
            const saved = run.workspaceCheckpoint;
            const verified = saved.startsWith("local-v2:") ? saved === checkpoints.current : saved.startsWith("local-v1:") && (saved === checkpoints.legacy || saved === checkpoints.legacyWithoutHostCheckpoints);
            if (!verified) {
              const changed = run.localCheckpointState ? [
                ...(run.localCheckpointState.filesDigest !== checkpoints.filesDigest ? ["项目文件或忽略产物"] : []),
                ...(run.localCheckpointState.gitDigest !== checkpoints.gitDigest ? ["Git 提交、分支、索引或配置"] : []),
              ] : [];
              const detail = changed.length ? `变化范围：${changed.join("、")}。` : "旧检查点无法完整核验。";
              throw new LocalReplayError(`Local project or build artifacts changed since the last checkpoint. ${detail}请点击“重新检查”创建新预览，再从头核对当前项目；原项目已有改动会保留。`);
            }
            if (saved.startsWith("local-v1:")) this.log(run, "Legacy local checkpoint verified exactly; Codex internal turn checkpoints are excluded from future project checkpoints.");
          } else if (run.tasks.some(task => task.status === "completed" || task.attempts.some(attempt => attempt.startedAt))) throw new LocalReplayError("Local project has previously started workers without a reliable checkpoint. 请点击“重新检查”创建新预览，核对已有改动后再启动。");
        } else if (run.workspace?.kind === "git-worktree") {
          await validateGitWorkspace(run.workspace);
          if (run.workspaceCheckpoint && await maintenanceFingerprint(run.workspace) !== run.workspaceCheckpoint) throw new Error("Saved Git checkout or artifacts changed; cached steps cannot safely replay. Create a new preview.");
        } else if (run.workspace) {
          if (run.workspaceCheckpoint) {
            if (!run.workspaceCheckpoint.startsWith("snapshot-v1:")) throw new Error("Saved snapshot checkpoint format is unsupported. Create a new preview before replaying verified results.");
            if (await snapshotFingerprint(run.workspace, active.controller.signal) !== run.workspaceCheckpoint) throw new Error("Saved snapshot workspace or artifacts changed; cached verification cannot safely replay. Create a new preview.");
          } else if (run.tasks.some(task => task.status === "completed" || task.attempts.some(attempt => attempt.startedAt))) throw new Error("Saved snapshot lacks a verified execution checkpoint. Create a new preview before replaying previously started workers or verified results.");
        }
      });
      run.preparation!.endedAt = now(); run.execution = "running";
      if (run.workspaceMode === "local") { delete run.workspaceCheckpoint; delete run.localCheckpointState; }
      this.log(run, resume ? "Manual resume: replaying script and validating saved results in launch order." : "Execution prepared; dispatching workflow tasks.");
      await this.persist(run);
      this.preparationGuard(run, active);
      await this.execute(run, active);
    } catch (error) {
      const interrupted = this.closing || active.controller.signal.aborted && (run.execution === "stopping" || Boolean(run.stopReason));
      this.finishPreparation(run, interrupted ? "interrupted" : "failed");
      run.execution = interrupted ? "stopped" : "failed"; run.endedAt = now();
      if (interrupted) { run.stopReason ??= this.closing ? "service-shutdown" : "requested"; delete run.error; this.log(run, stopSummary(run.stopReason)); }
      else { run.error = message(error); run.failureContext = { kind: "preparation", ...(error instanceof LocalReplayError ? { recovery: error.recovery } : {}) }; this.log(run, run.error, undefined, "error"); }
      await this.persist(run);
    } finally {
      await releaseProject?.();
    }
  }
  private async execute(run: WorkflowRun, active: Active) {
    const readPool = new Pool(run.limits.maxReadWorkers);
    let index = 0;
    let cacheInvalidFrom = Number.POSITIVE_INFINITY;
    let totalTokens = run.tasks.reduce((total, task) => total + task.attempts.reduce((subtotal, attempt) => subtotal + (attempt.usage?.totalTokens ?? 0), 0), 0);
    let phase: string | undefined;
    let reviewing = false;
    const journal = structuredClone(run.tasks);
    // Bind observed-task choices to their producing inputs, independently of
    // launch position or later UI model/effort overrides. Hash shared args once.
    const configurationScope = digest({ projectPath: run.projectPath, goal: run.meta.description, args: run.args });
    const issued = new Set<Promise<unknown>>();
    const dispatch = (prompt: string, rawOptions: Record<string, unknown>, scriptSignal: AbortSignal, operationId?: string) => {
          // Capture the script's phase before model discovery or worker queues yield.
          const taskPhase = typeof rawOptions.phase === "string" ? rawOptions.phase : phase;
          const operation = (async () => {
            const position = index++;
            const previous = journal[position];
            if (previous?.cacheInvalidated) cacheInvalidFrom = Math.min(cacheInvalidFrom, position);
            let options: Record<string, unknown> = rawOptions;
            let executionSettings: EffectiveExecutionSettings | undefined;
            let configurationTarget: string | undefined;
            try {
              if (position >= run.limits.maxCalls) throw new Error("Workflow agent call limit reached");
              if (operationId) {
                const step = run.maintenance?.steps.find(step => step.id === operationId);
                if (!step) throw new Error(`Operation was not approved: ${operationId}`);
                options = { mode: "write", operation: step };
                const choice = run.nodeSettings?.[`task:${position}`];
                if (choice && (choice.model !== undefined || choice.reasoningEffort !== undefined || choice.identity !== undefined)) throw new Error(`Task ${position} now refers to a command operation. Commands do not use model settings; remove this task override and create a new preview before starting.`);
              } else options = this.agentOptions(rawOptions);
              if (run.workspaceMode === "local" && options.isolation === "worktree") throw new Error("Worktree isolation cannot be requested in local project mode. Choose an isolated workflow mode or use a local write task.");
              if (options.mode === "write" && !run.allowWrite) throw new Error("Writing is outside the previewed workflow scope");
              if (!operationId) {
                configurationTarget = digest({ scope: configurationScope, prompt, options, phase: taskPhase });
                const target = run.nodeSettings?.[`task:${position}`]?.identity;
                if (target !== undefined && target !== configurationTarget) throw new Error(`Task ${position} no longer matches the configured target. Inspect the new task and choose its model settings again.`);
                executionSettings = this.workerSettings(run, options, position, taskPhase, await this.agentEnvironment(run, active));
              }
            } catch (error) {
              cacheInvalidFrom = Math.min(cacheInvalidFrom, position);
              const errorText = message(error);
              run.tasks[position] = { id: `task_${position + 1}`, index: position, prompt, options, mode: options.mode === "write" || options.isolation === "worktree" ? "write" : "read", status: "failed", cached: false, attempts: [...(previous?.attempts ?? []), { id: `task_${position + 1}_attempt_${(previous?.attempts.length ?? 0) + 1}`, status: "failed", error: errorText, endedAt: now() }], error: errorText, ...(configurationTarget ? { configurationTarget } : {}) };
              this.log(run, errorText, `task_${position + 1}`, "error");
              await this.persist(run);
              throw error;
            }
            const mode = options.mode === "write" ? "write" : "read";
            const fingerprint = taskFingerprint(prompt, options, executionSettings);
            const task: Task = { id: `task_${position + 1}`, index: position, prompt, options, mode, status: "queued", cached: false, attempts: previous?.attempts ?? [], ...(configurationTarget ? { configurationTarget } : {}), ...(executionSettings ? { executionSettings } : {}), ...(typeof options.label === "string" ? { label: options.label } : {}), ...(taskPhase !== undefined ? { phase: taskPhase } : {}) };
            run.tasks[position] = task;
            if (position < cacheInvalidFrom && previous?.status === "completed" && taskFingerprint(previous.prompt, previous.options, previous.executionSettings) === fingerprint && Object.hasOwn(previous, "output")) {
              task.status = "completed"; task.cached = true; task.output = previous.output;
              if (previous.executionSettings) task.executionSettings = previous.executionSettings;
              this.log(run, "Reused completed task result.", task.id);
              await this.persist(run);
              return task.output;
            }
            const previousOperation = operationId ? journal.find(item => (item.options.operation as { id?: string } | undefined)?.id === operationId && item.attempts.some(attempt => attempt.startedAt)) : undefined;
            if (previousOperation && run.maintenance!.steps.find(step => step.id === operationId)?.idempotent !== true) {
              cacheInvalidFrom = Math.min(cacheInvalidFrom, position);
              task.status = "failed";
              task.error = `Operation ${operationId} already started in a prior attempt. Its result cannot safely be reused here and it will not be repeated automatically. Inspect its actual effects and revise the workflow before continuing.`;
              this.log(run, task.error, task.id, "error");
              await this.persist(run);
              throw new Error(task.error);
            }
            // A whole-run interruption restarts that task without discarding later completed results.
            if (!(previous?.status === "interrupted" && taskFingerprint(previous.prompt, previous.options, previous.executionSettings) === fingerprint)) cacheInvalidFrom = Math.min(cacheInvalidFrom, position);
            const controller = new AbortController();
            const abort = () => controller.abort();
            active.controller.signal.addEventListener("abort", abort, { once: true });
            scriptSignal?.addEventListener("abort", abort, { once: true });
            if (active.controller.signal.aborted || scriptSignal?.aborted) controller.abort();
            active.tasks.set(task.id, controller);
            const attempt: Attempt = { id: `${task.id}_attempt_${task.attempts.length + 1}`, status: "queued", ...(executionSettings ? { executionSettings } : {}) };
            let accountedTokens = 0;
            task.attempts.push(attempt);
            await this.persist(run);
            try {
              return await (mode === "write" ? this.writePool : readPool).use(controller.signal, async () => {
                const releaseWriter = mode === "write" ? await this.store.acquireNamed("writer", controller.signal) : undefined;
                try {
                if (run.limits.maxTokens > 0 && totalTokens >= run.limits.maxTokens) throw new Error("Workflow token budget exhausted before worker dispatch");
                if (run.workspaceMode === "local") {
                  if (!run.workspace || run.workspace.kind !== "local" || run.workspacePath !== run.workspace.root) throw new Error("Local project workspace identity is missing or inconsistent");
                  await validateLocalWorkspace(run.workspace, run.projectPath, this.store.directory(run.id));
                }
                if (operationId) {
                  const step = run.maintenance!.steps.find(step => step.id === operationId)!;
                  if (step.protectedPaths !== undefined) {
                    if (run.workspace?.kind !== "git-worktree") throw new Error("Protected maintenance paths require an independent Git workspace");
                    const owned = path.join(await realpath(await this.store.ownedDirectory(run.id)), "workspace");
                    if (run.workspace.root !== owned || run.workspacePath !== run.workspace.root || run.workspace.root === run.workspace.original || run.workspace.root === await realpath(run.workspace.original)) throw new Error("Protected maintenance paths must remain bound to this run's owned isolated workspace");
                    await validateGitWorkspace(run.workspace);
                  }
                }
                task.status = "running"; attempt.status = "running"; attempt.startedAt = now();
                this.activity(run, task, attempt, { id: `${attempt.id}:dispatch`, kind: "waiting", label: mode === "write" ? "等待执行器开始任务" : "等待代理开始检查", status: "running", startedAt: attempt.startedAt });
                this.log(run, `Worker started (${mode}).`, task.id);
                await this.persist(run);
                if (operationId) {
                  const step = run.maintenance!.steps.find(step => step.id === operationId)!;
                  if (!this.adapter.command) throw new Error("This adapter cannot execute approved operations");
                  const report = await this.adapter.command({ id: attempt.id, command: step.command, cwd: run.workspacePath!, networkAccess: step.networkAccess ?? false, timeoutMs: Math.min(step.timeoutMs ?? run.limits.timeoutMs, run.limits.timeoutMs), retries: step.retries ?? 0, ...(step.protectedPaths !== undefined ? { protectedPaths: step.protectedPaths } : {}) }, controller.signal, event => { if (event.type === "log") this.log(run, event.message, task.id); else if (event.type === "activity") this.activity(run, task, attempt, event.activity); });
                  task.output = report;
                  attempt.outcome = "confirmed";
                  if (report.exitCode !== 0) throw new Error(`Operation ${operationId} failed (exit ${report.exitCode}): ${report.stderr.slice(-1000)}`);
                  task.status = "completed"; attempt.status = "completed"; attempt.output = task.output;
                  this.log(run, `Operation completed (${report.attempts} attempt(s)).`, task.id);
                  return task.output;
                }
                const report = await this.adapter.run({
                  id: attempt.id, prompt: buildWorkerPrompt({ description: run.meta.description, phaseTitles: run.meta.phases?.map(item => item.title) ?? [], ...(task.phase !== undefined ? { phase: task.phase } : {}), mode, ...(run.workspaceMode !== undefined ? { workspaceMode: run.workspaceMode } : {}), prompt }),
                  cwd: run.workspacePath ?? run.projectPath, mode, networkAccess: run.networkAccess ?? false, mcpServers: run.allowedMcpServers ?? [], mcpTools: run.allowedMcpTools ?? {},
                  approvalMode: resolveApprovalMode(run.approvalMode),
                  ...(run.workspaceMode === "local" && run.localGitWrite === true && mode === "write" ? { localGitWrite: true } : {}),
                  ...(executionSettings?.model ? { model: executionSettings.model } : {}),
                  ...(executionSettings?.reasoningEffort ? { reasoningEffort: executionSettings.reasoningEffort } : {}),
                  ...(executionSettings ? { settingsSource: executionSettings.source } : {}),
                  ...(options.schema ? { outputSchema: options.schema as Record<string, unknown> } : {}),
                  timeoutMs: run.limits.timeoutMs,
                }, controller.signal, event => {
                  if (event.type === "identity") { attempt.threadId = event.threadId; if (event.turnId) attempt.turnId = event.turnId; }
                  else if (event.type === "execution-settings") { task.executionSettings = event.settings; attempt.executionSettings = event.settings; }
                  else if (event.type === "log") this.log(run, event.message, task.id);
                  else if (event.type === "activity") this.activity(run, task, attempt, event.activity);
                  else if (event.type === "usage") {
                    attempt.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
                    totalTokens += Math.max(0, event.totalTokens - accountedTokens);
                    accountedTokens = Math.max(accountedTokens, event.totalTokens);
                  }
                });
                task.output = options.schema ? report.data : report.output;
                if (report.executionSettings) { task.executionSettings = report.executionSettings; attempt.executionSettings = report.executionSettings; }
                if (options.schema && report.data === undefined) throw new Error("Worker did not return structured output");
                if (digest(task.output).length && Buffer.byteLength(JSON.stringify(task.output) ?? "null") > 1024 * 1024) throw new Error("Task output exceeds 1 MiB");
                task.status = "completed"; attempt.status = "completed"; attempt.output = task.output; attempt.usage = report.usage;
                attempt.threadId = report.threadId; attempt.turnId = report.turnId;
                if (report.toolsUsed) attempt.toolsUsed = report.toolsUsed;
                totalTokens += Math.max(0, report.usage.totalTokens - accountedTokens);
                this.log(run, "Worker completed.", task.id);
                return task.output;
                } finally { await releaseWriter?.(); }
              });
            } catch (error) {
              if (operationId && attempt.startedAt && attempt.outcome !== "confirmed") attempt.outcome = "unknown";
              task.status = active.controller.signal.aborted || scriptSignal?.aborted ? "interrupted" : "failed";
              attempt.status = task.status; task.error = message(error); attempt.error = task.error;
              this.log(run, task.error, task.id, "error");
              throw error;
            } finally {
              attempt.endedAt = now(); active.tasks.delete(task.id);
              for (const activity of attempt.activities ?? []) if (activity.status === "running") { activity.status = attempt.status === "completed" ? "completed" : attempt.status === "interrupted" ? "interrupted" : "failed"; activity.endedAt = attempt.endedAt; }
              if (task.currentActivity?.status === "running") { task.currentActivity.status = attempt.status === "completed" ? "completed" : attempt.status === "interrupted" ? "interrupted" : "failed"; task.currentActivity.endedAt = attempt.endedAt; }
              active.controller.signal.removeEventListener("abort", abort); scriptSignal?.removeEventListener("abort", abort);
              await this.persist(run);
            }
          })();
          issued.add(operation);
          void operation.finally(() => issued.delete(operation)).catch(() => {});
          return operation;
    };
    try {
      const result = await executeScript(run.script, run.args, {
        phase: title => { phase = title; this.log(run, `Phase: ${title}`); },
        log: text => { this.log(run, text); },
        agent: (prompt, options, signal) => dispatch(prompt, options, signal),
        operation: (id, signal) => dispatch(`Operation: ${id}`, {}, signal, id),
      }, active.controller.signal, { timeoutMs: run.limits.timeoutMs, maxCalls: run.limits.maxCalls, memoryMb: 64 });
      await Promise.allSettled(issued);
      run.tasks.length = index;
      if (active.controller.signal.aborted) throw new Error("Workflow interrupted");
      run.result = result;
      if (run.workspace) {
        reviewing = true;
        delete run.maintenanceReview; delete run.diff;
        if (run.workspace.kind === "local") run.diff = await localWorkspaceDiff(run.workspace);
        else if (run.workspace.kind === "git-worktree") { run.maintenanceReview = await reviewMaintenance(run.workspace, run.maintenance ?? { steps: [] }); run.diff = run.maintenanceReview.diff; }
        else run.diff = await workspaceDiff(run.workspace);
        run.review = "ready";
      }
      run.execution = "completed";
      this.log(run, run.workspaceMode === "local" ? "Execution completed. Changes are already in the original project; review the reports and baseline diff. No apply step is required." : "Execution completed. Review the final reports and diff before applying changes.");
    } catch (error) {
      active.controller.abort();
      await Promise.allSettled(issued);
      run.execution = active.controller.signal.aborted && (run.execution === "stopping" || this.closing) ? "stopped" : "failed";
      if (run.execution === "stopped") { run.stopReason ??= this.closing ? "service-shutdown" : "requested"; delete run.error; }
      else run.error = message(error);
      if (run.execution === "failed") run.failureContext = {
        kind: reviewing ? "review" : "script", ...(phase ? { phase } : {}),
        ...(!reviewing && run.tasks.length && run.tasks.every(task => task.status === "completed") ? { afterTaskId: run.tasks.at(-1)!.id } : {}),
      };
      if (!reviewing && run.workspace && run.workspace.kind !== "git-worktree") { try { run.diff = run.workspace.kind === "local" ? await localWorkspaceDiff(run.workspace) : await workspaceDiff(run.workspace); } catch {} }
      if (run.execution === "stopped") this.log(run, stopSummary(run.stopReason));
      else this.log(run, run.error!, undefined, "error");
    } finally {
      if (run.workspace?.kind === "local") {
        try {
          await validateLocalWorkspace(run.workspace, run.projectPath, this.store.directory(run.id));
          const checkpoint = await captureLocalWorkspaceCheckpoints(run.workspace);
          run.workspaceCheckpoint = checkpoint.current;
          run.localCheckpointState = { filesDigest: checkpoint.filesDigest, gitDigest: checkpoint.gitDigest };
        }
        catch (error) { delete run.workspaceCheckpoint; delete run.localCheckpointState; run.execution = run.execution === "completed" ? "failed" : run.execution; run.error = `Could not checkpoint local project: ${message(error)}`; run.failureContext = { kind: "checkpoint", recovery: "new-preview", ...(phase ? { phase } : {}) }; this.log(run, run.error, undefined, "error"); }
      } else if (run.workspace?.kind === "git-worktree") {
        try { run.workspaceCheckpoint = await maintenanceFingerprint(run.workspace); }
        catch (error) { run.execution = run.execution === "completed" ? "failed" : run.execution; run.error = `Could not checkpoint isolated checkout: ${message(error)}`; run.failureContext = { kind: "checkpoint", ...(phase ? { phase } : {}) }; this.log(run, run.error, undefined, "error"); }
      } else if (run.workspace) {
        try { run.workspaceCheckpoint = await snapshotFingerprint(run.workspace); }
        catch (error) { run.execution = run.execution === "completed" ? "failed" : run.execution; run.error = `Could not checkpoint isolated snapshot: ${message(error)}`; run.failureContext = { kind: "checkpoint", ...(phase ? { phase } : {}) }; this.log(run, run.error, undefined, "error"); }
      }
      run.endedAt = now();
      await this.persist(run);
    }
  }
  private activity(run: WorkflowRun, task: Task, attempt: Attempt, value: Activity) {
    const activities = attempt.activities ??= [];
    const previous = activities.findIndex(activity => activity.id === value.id);
    // Only adapter-produced categorical labels enter this timeline. Diagnostic
    // payloads stay in their separate log channel and are never activity details.
    const activity: Activity = { id: value.id, kind: value.kind, label: value.label.slice(0, 200), status: value.status, startedAt: value.startedAt, ...(value.endedAt ? { endedAt: value.endedAt } : {}) };
    if (previous >= 0) activities[previous] = activity;
    else { if (activities.length >= 200) { const finished = activities.findIndex(item => item.status !== "running"); activities.splice(finished < 0 ? 0 : finished, 1); } activities.push(activity); }
    if (value.status === "running") {
      const waiting = activities.find(item => item.id === `${attempt.id}:dispatch` && item.status === "running");
      if (waiting && waiting.id !== value.id) { waiting.status = "completed"; waiting.endedAt = value.startedAt; }
      task.currentActivity = { ...activity };
    } else if (task.currentActivity?.id === value.id) {
      task.currentActivity = { ...([...activities].reverse().find(item => item.status === "running") ?? activity) };
    }
    this.scheduleProgress(run);
  }
  private agentOptions(options: Record<string, unknown>) {
    const allowed = new Set(["label", "phase", "mode", "model", "reasoningEffort", "schema", "isolation"]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unsupported agent option: ${key}`);
    if (options.mode !== undefined && !["read", "write"].includes(String(options.mode))) throw new Error("mode must be read or write");
    if (options.isolation !== undefined && options.isolation !== "worktree") throw new Error("Only worktree isolation is supported");
    if (options.isolation === "worktree") options = { ...options, mode: "write" };
    for (const key of ["label", "phase", "model", "reasoningEffort"]) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${key} must be a string`);
    modelSettingsSchema.parse({ ...(options.model !== undefined ? { model: options.model } : {}), ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}) });
    if (options.schema !== undefined && (!options.schema || typeof options.schema !== "object" || Array.isArray(options.schema))) throw new Error("schema must be a JSON schema object");
    return options;
  }
  async stop(id: string, reason: WorkflowStopReason = "requested") {
    const run = await this.load(id);
    this.assertActionAvailable(run);
    const active = this.active.get(id);
    if (!active) {
      if (["preparing", "running", "stopping"].includes(run.execution)) {
        if (!run.controlId) throw new Error("Workflow owner does not support remote control; update the owner server");
        await this.store.requestControl(id, run.controlId, "stop");
        return this.get(id);
      }
      return structuredClone(run);
    }
    // Completion can precede final review/checkpoint/lock cleanup. Stopping at
    // that boundary waits for cleanup without reverting a terminal outcome.
    if (!["preparing", "running", "stopping"].includes(run.execution)) { await active.done; return structuredClone(run); }
    if (run.execution !== "stopping") {
      run.stopReason = reason;
      run.execution = "stopping";
      for (const task of run.tasks) if (task.status === "running") { task.status = "stopping"; const attempt = task.attempts.at(-1); if (attempt) attempt.status = "stopping"; }
      this.log(run, "Stopping dispatch and interrupting all active workers; waiting for their exit.");
      active.controller.abort();
      await this.persist(run);
    }
    await active.done;
    return structuredClone(run);
  }
  async cancelTask(id: string, taskId: string) {
    const run = await this.load(id);
    this.assertActionAvailable(run);
    const controller = this.active.get(id)?.tasks.get(taskId);
    if (!controller) {
      if (["preparing", "running", "stopping"].includes(run.execution) && !this.active.has(id) && run.controlId) {
        await this.store.requestControl(id, run.controlId, "cancel", taskId);
        return this.get(id);
      }
      throw new Error("Task is not active");
    }
    controller.abort();
    this.log(run, "User cancelled this task; it will be recorded as a failed task.", taskId);
    await this.persist(run);
    return structuredClone(run);
  }
  async apply(id: string, revision: number) {
    let run = await this.load(id);
    this.assertActionAvailable(run);
    this.assertRevision(run, revision);
    if (run.workspaceMode === "local" || run.workspace?.kind === "local") throw new Error("Local changes are already in the original project; workflow_apply is not available for local mode");
    if (run.execution !== "completed" || !run.workspace || !run.diff || run.application === "applied" || this.active.has(id)) throw new Error("No completed, reviewed changes are available to apply");
    const release = await this.store.acquire(id);
    let releaseProject: (() => Promise<void>) | undefined;
    let applicationStarted = false;
    try {
      run = await this.store.load(id);
      this.assertActionAvailable(run);
      this.assertRevision(run, revision);
      if (run.workspaceMode === "local" || run.workspace?.kind === "local") throw new Error("Local changes are already in the original project; workflow_apply is not available for local mode");
      if (run.execution !== "completed" || !run.workspace || !run.diff || run.application === "applied") throw new Error("Workflow changed before application");
      try { releaseProject = await this.store.acquireNamed(`apply_${digest(run.projectPath)}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Another workflow is modifying this project. Stop it or wait for it to finish before applying changes."); throw error; }
      applicationStarted = true;
      run.application = "applying"; await this.persist(run);
      let result: { applied: boolean; conflicts: string[]; partial?: boolean; error?: string };
      if (run.workspace.kind === "git-worktree") {
        if (!run.maintenanceReview) throw new Error("Maintenance review is missing");
        const maintenance = await applyMaintenance(run.workspace, run.maintenanceReview, run.maintenance ?? { steps: [] });
        if (maintenance.activation) run.activation = maintenance.activation;
        result = maintenance;
      } else result = await applyWorkspace(run.workspace, run.diff);
      run.application = result.partial ? "partial" : result.applied ? run.activation?.status === "failed" ? "partial" : "applied" : "conflict";
      if (result.error) run.error = result.error;
      else if (run.application === "applied") delete run.error;
      if (!result.applied) run.diff.conflicts = result.conflicts;
      else if (run.application === "applied") delete run.diff.conflicts;
      this.log(run, run.application === "partial" ? "Repository partially updated. Review the unfinished submodule or activation stage before retrying application." : result.applied ? run.activation?.status === "pending_restart" ? "Repository and configuration updated. The current desktop connection still requires restart verification." : "Reviewed changes applied to the project." : "Project conflicts detected; changes were not applied.");
    } catch (error) { if (!applicationStarted) throw error; run.application = "failed"; run.error = message(error); this.log(run, run.error, undefined, "error"); }
    finally { try { if (applicationStarted) await this.persist(run); } finally { try { await releaseProject?.(); } finally { await release(); } } }
    return structuredClone(run);
  }
  async wait(id: string) { await this.active.get(id)?.done; return this.get(id); }
  forgetDeletedRuns(ids: string[]) { for (const id of ids) { if (this.active.has(id)) throw new Error("Cannot forget an active workflow; wait for its workers to exit."); this.clearProgress(id); this.runs.delete(id); } }
  async close() {
    this.closing = true;
    clearInterval(this.watchdog);
    this.configAbort.abort();
    await Promise.allSettled([...this.configurations]);
    await this.initialization;
    const stopped = await Promise.allSettled([...this.active.keys()].map(id => this.stop(id, "service-shutdown")));
    try { await this.adapter.close(); } finally { await this.store.flush(); }
    const failure = stopped.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
