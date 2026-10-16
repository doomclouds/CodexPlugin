import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readlink, realpath, rm } from "node:fs/promises";
import { CodexAdapter } from "./adapter.ts";
import type { WorkerAdapter } from "./adapter.ts";
import { compileDefinition, validateDefinitionArgs, walkNodes } from "./definition.ts";
import type { WorkflowDefinition, JsonValue } from "./definition.ts";
import { StructuredStore, RevisionConflictError } from "./structured-store.ts";
import { StructuredExecutor } from "./structured-executor.ts";
import { NativeActivityDriver, acquireNamed } from "./structured-driver.ts";
import type { ActivityDriver, StructuredPreview, StructuredRun, RunGrants, RunLimits } from "./structured-types.ts";
import { projectStructuredRun } from "./structured-projection.ts";
import { workspaceDiff, applyWorkspace } from "./workspace.ts";
import { localWorkspaceDiff } from "./local-workspace.ts";
import { reviewMaintenance, applyMaintenance } from "./maintenance.ts";
import type { MaintenanceReview } from "./types.ts";
import { validateExplicitModelSettings } from "./execution-settings.ts";
import type { StoredExecutionSettings } from "./execution-settings.ts";

const active = new Set(["preparing", "running", "pausing", "stopping"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, maximum = 8000) => (typeof value === "string" ? value : JSON.stringify(value))?.slice(0, maximum);
export interface DeleteInput { kind: "run" | "definition"; id: string; revision: number; }
/** Structured execution and projection facade; no script parsing or replay. */
export class WorkflowEngine {
  readonly store: StructuredStore<StructuredRun>; readonly executor: StructuredExecutor; readonly driver: ActivityDriver; readonly native?: NativeActivityDriver;
  constructor(options: { root?: string; store?: StructuredStore<StructuredRun>; adapter?: WorkerAdapter; driver?: ActivityDriver } = {}) {
    this.store = options.store ?? new StructuredStore(options.root ?? process.env.WORKFLOWS_DATA_DIR ?? path.join(os.homedir(), ".local", "state", "codex-workflows"));
    if (options.driver) this.driver = options.driver; else { this.native = new NativeActivityDriver(this.store, options.adapter ?? new CodexAdapter()); this.driver = this.native; }
    this.executor = new StructuredExecutor({ store: this.store, driver: this.driver });
  }
  #freeze(definition: WorkflowDefinition, stack: string[] = []): WorkflowDefinition {
    const copy = compileDefinition(definition).definition;
    walkNodes(copy, node => { if (node.type !== "subflow") return;
      const key = node.ref ? `${node.ref.id}:${node.ref.revision}` : `inline:${node.id}`;
      if ((node.ref && stack.includes(key)) || stack.length >= 16) throw new Error("Recursive or excessively nested subflow reference.");
      if (node.ref) { node.definition = this.#freeze(this.store.getDefinition(node.ref.id, node.ref.revision).definition, [...stack, key]); delete node.ref; }
      else if (node.definition) node.definition = this.#freeze(node.definition, [...stack, key]); });
    return compileDefinition(copy).definition;
  }
  async preview(input: StructuredPreview): Promise<StructuredRun> {
    const projectPath = await realpath(input.projectPath); if (!(await lstat(projectPath)).isDirectory()) throw new Error("Project must be a real directory.");
    const definition = this.#freeze(input.definition);
    if (input.sourceDefinition && compileDefinition(definition).hash !== compileDefinition(this.#freeze(this.store.getDefinition(input.sourceDefinition.id, input.sourceDefinition.revision).definition)).hash) throw new Error("Source definition differs from its immutable revision; save the update first.");
    return this.executor.preview({ ...input, projectPath, definition });
  }
  get(id: string) { return this.executor.get(id); }
  list(options: { projectPath?: string; limit?: number; offset?: number } = {}) { return this.executor.list(options); }
  view(id: string, scopeInstanceId?: string) {
    const stored = this.get(id), projection = projectStructuredRun(stored, scopeInstanceId ? { scopeInstanceId } : {}), run = this.transport(stored);
    const view = { run, projection };
    if (Buffer.byteLength(JSON.stringify(view)) <= 5 * 1024 * 1024) return view;
    // Large histories still expose every instance identity/status. Details remain independently readable.
    run.instances = stored.instances.map(instance => ({ id: instance.id, nodeId: instance.nodeId, type: instance.type, label: instance.label.slice(0, 60), path: "", status: instance.status, attempts: [],
      ...(instance.parentId ? { parentId: instance.parentId } : {}), ...(instance.iteration === undefined ? {} : { iteration: instance.iteration }), ...(instance.itemKey === undefined ? {} : { itemKey: instance.itemKey.slice(0, 80) }),
      ...(instance.branchId ? { branchId: instance.branchId } : {}), ...(instance.type === "wait" && instance.cursor ? { cursor: { ...(instance.cursor.message === undefined ? {} : { message: bounded(instance.cursor.message, 2000)! }), ...(instance.cursor.schema === undefined ? {} : { schema: instance.cursor.schema }) } } : {}) }));
    return { ...view, compact: true };
  }
  transport(run: StructuredRun): StructuredRun {
    // The control plane carries identities and summaries; activity payloads have an independent endpoint.
    const { workspace: _workspace, diff: _diff, result: _result, ...base } = run;
    return { ...base,
      events: run.events.slice(-100).map(({ data: _data, ...event }) => event),
      instances: run.instances.map(instance => {
        const { environment: _env, output: _output, cursor: _cursor, ...summary } = instance;
        const cursor = instance.type === "wait" ? { ...(instance.cursor?.message === undefined ? {} : { message: instance.cursor.message }), ...(instance.cursor?.schema === undefined ? {} : { schema: instance.cursor.schema }) } : undefined;
        return { ...summary, path: instance.path.slice(-240), ...(instance.error ? { error: instance.error.slice(0, 1200) } : {}), ...(cursor ? { cursor } : {}),
          attempts: instance.attempts.slice(-1).map(attempt => ({ id: attempt.id, status: attempt.status, startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
            ...(attempt.error ? { error: attempt.error.slice(0, 1000) } : {}), activities: attempt.activities.slice(-1).map(({ detail: _detail, ...activity }) => activity), logs: [], ...(attempt.executionSettings ? { executionSettings: attempt.executionSettings } : {}) })) };
      }),
      ...(run.result === undefined ? {} : { result: run.result }),
      ...(run.error ? { error: run.error.slice(0, 8000) } : {}),
      ...(run.diff ? { diff: { ...run.diff, text: run.diff.text.slice(0, 120000) } } : {}),
    };
  }
  start(input: { id: string; revision: number }) { const run = this.get(input.id); for (const other of this.store.listProject(run.projectPath)) this.executor.get(other.id); return this.executor.start(input); }
  pause(input: Parameters<StructuredExecutor["pause"]>[0]) { return this.executor.pause(input); }
  stop(input: Parameters<StructuredExecutor["stop"]>[0]) { return this.executor.stop(input); }
  wait(id: string) { return this.executor.wait(id); }
  async recoveryPreview(input: { id: string; revision: number; instanceId?: string }) {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError(); const blockers: string[] = [];
    if (!["paused", "stopped", "failed", "waiting"].includes(run.status)) blockers.push("运行尚未到达可恢复的稳定状态。");
    const unknownInstanceIds = run.instances.filter(instance => instance.status === "unknown").map(instance => instance.id);
    if (unknownInstanceIds.length) blockers.push("存在副作用未知的节点，须先核对实际结果并提交证据。");
    if (run.instances.some(instance => instance.status === "waiting")) blockers.push("请先提供等待节点的输入。");
    const inspectFiles = ["paused", "stopped", "failed", "waiting"].includes(run.status) && !this.store.owner(run.id)?.alive;
    const observed = inspectFiles ? await this.driver.captureCheckpoint?.(run) ?? run.checkpoint?.fingerprint ?? "no-filesystem-driver" : run.checkpoint?.fingerprint ?? "not-inspected-while-active";
    if (this.store.get(run.id).revision !== input.revision) throw new RevisionConflictError();
    if (run.checkpoint && observed !== run.checkpoint.fingerprint) blockers.push("文件与检查点不同；保留当前文件，请基于当前代码创建新运行。");
    if (input.instanceId && !run.instances.some(instance => instance.id === input.instanceId)) throw new Error("Node instance not found.");
    return { fingerprint: hash({ id: run.id, revision: run.revision, definitionHash: run.definitionHash, checkpoint: run.checkpoint?.id, observed, instanceId: input.instanceId }), canResume: !blockers.length, currentFilesPreserved: true, blockers, unknownInstanceIds,
      reusedInstanceIds: run.instances.filter(instance => instance.status === "completed" && instance.id !== input.instanceId).map(instance => instance.id), rerunInstanceIds: run.instances.filter(instance => instance.status !== "completed" || instance.id === input.instanceId).map(instance => instance.id) };
  }
  async resume(input: { id: string; revision: number; recoveryFingerprint: string; instanceId?: string }) {
    const preview = await this.recoveryPreview(input); if (preview.fingerprint !== input.recoveryFingerprint || !preview.canResume) throw new Error(preview.blockers.join(" ") || "Recovery confirmation changed.");
    const run = input.instanceId ? this.executor.retryNode({ id: input.id, revision: input.revision, instanceId: input.instanceId }) : this.get(input.id);
    try { return await this.executor.resume({ id: run.id, revision: run.revision, ...(run.checkpoint ? { fingerprint: run.checkpoint.fingerprint } : {}) }); } catch (error) { await this.driver.finish?.(run); throw error; }
  }
  resolveWait(input: Parameters<StructuredExecutor["resolveWait"]>[0]) { return this.executor.resolveWait(input); }
  async resolveUnknown(input: Parameters<StructuredExecutor["resolveUnknown"]>[0]) {
    const initial = this.get(input.id); if (initial.revision !== input.revision) throw new RevisionConflictError();
    const release = await acquireNamed(this.store.directory, `project_${createHash("sha256").update(initial.projectPath).digest("hex")}`);
    try {
      const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError();
      const instance = run.instances.find(item => item.id === input.instanceId);
      if (!instance || instance.status !== "unknown" || this.store.owner(run.id)?.alive) throw new Error("Unknown activity must have a stopped owner before reconciliation.");
      if (input.fingerprint !== this.executor.unknownFingerprint(run, instance)) throw new Error("Unknown-activity confirmation fingerprint changed.");
      const fingerprint = await this.driver.captureCheckpoint?.(run);
      return this.executor.resolveUnknown(input, fingerprint);
    } finally { await release(); }
  }
  unknownPreview(id: string, instanceId: string) { const run = this.get(id), instance = run.instances.find(item => item.id === instanceId); if (!instance || instance.status !== "unknown") throw new Error("Unknown activity not found."); return { fingerprint: this.executor.unknownFingerprint(run, instance), instanceId, error: instance.error, currentFilesPreserved: true, requiresEvidence: true }; }
  saveDefinition(input: { id?: string; revision?: number; definition: WorkflowDefinition; args?: JsonValue; grants?: Partial<RunGrants>; limits?: Partial<RunLimits> }) {
    const compiled = compileDefinition(this.#freeze(input.definition)); if (input.args !== undefined) validateDefinitionArgs(compiled.definition, input.args);
    if (input.revision && !input.id) throw new Error("Updating a definition requires its id and revision.");
    return this.store.saveDefinition({ ...(input.id ? { id: input.id } : {}), definition: compiled.definition, hash: compiled.hash, ...(input.args === undefined ? {} : { args: input.args }), ...(input.grants ? { grants: input.grants } : {}), ...(input.limits ? { limits: input.limits } : {}) }, input.revision);
  }
  template(id: string, revision?: number) { const template = this.store.getDefinition(id, revision); return { ...template, plan: compileDefinition(template.definition).plan }; }
  nodeProcess(input: { id: string; instanceId: string; attemptId?: string; detail?: "brief" | "developer" }) {
    const run = this.get(input.id), instance = run.instances.find(item => item.id === input.instanceId); if (!instance) throw new Error("Node instance not found.");
    const selected = input.attemptId ? instance.attempts.find(attempt => attempt.id === input.attemptId) : instance.attempts.at(-1); if (input.attemptId && !selected) throw new Error("Node attempt not found.");
    const { environment: _env, attempts: _attempts, output: _output, ...summary } = instance;
    const checkpointManifest = this.store.checkpoints(run.id)[0]?.snapshot as import("./structured-store.ts").CheckpointManifest | undefined;
    return { instance: summary, attempts: instance.attempts.map(({ id, status, startedAt, endedAt }) => ({ id, status, startedAt, endedAt })), selectedAttemptId: selected?.id, activities: selected?.activities.slice(-100) ?? [],
      ...(input.detail === "developer" ? { logs: selected?.logs.slice(-150).map(entry => ({ ...entry, message: entry.message.slice(0, 2000) })) ?? [] } : {}), output: input.detail === "developer" ? (selected ? selected.output : instance.output) : bounded(selected ? selected.output : instance.output, 4000), error: bounded(selected ? selected.error : instance.error, 6000), checkpointCovered: !!run.checkpoint && (selected ? selected.status === "completed" && selected.resultEventSequence !== undefined && selected.resultEventSequence <= (checkpointManifest?.eventSequence ?? -1) : instance.status === "completed") };
  }
  async review(input: { id: string; revision: number }) {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError(); if (active.has(run.status) || run.status === "unknown" || this.store.owner(run.id)?.alive) throw new Error("Stop and reconcile before reviewing changes."); if (!run.workspace) throw new Error("No writable workspace.");
    let maintenance: MaintenanceReview | undefined; const diff = run.workspace.kind === "local" ? await localWorkspaceDiff(run.workspace) : run.workspace.kind === "git-worktree" ? (maintenance = await reviewMaintenance(run.workspace, { steps: [] })).diff : await workspaceDiff(run.workspace);
    return this.store.update(run.id, current => { if (current.revision !== input.revision) throw new RevisionConflictError(); if (this.store.owner(run.id)?.alive) throw new Error("Workflow is held by another operation."); current.diff = diff; current.review = "ready"; if (maintenance) (current as StructuredRun & { maintenanceReview?: MaintenanceReview }).maintenanceReview = maintenance; });
  }
  async apply(input: { id: string; revision: number; fingerprint: string }) {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError(); if (!run.workspace || !run.diff || run.review !== "ready" || input.fingerprint !== run.diff.fingerprint) throw new Error("Review current changes before applying them.");
    if (run.workspace.kind === "local") throw new Error("Local changes are already effective."); if (active.has(run.status) || run.status === "unknown") throw new Error("Workflow is not stable.");
    const release = await acquireNamed(this.store.directory, `project_${createHash("sha256").update(run.projectPath).digest("hex")}`);
    const token = `apply_${randomUUID()}`; let claimed = false;
    try {
      if (this.get(run.id).revision !== input.revision) throw new RevisionConflictError();
      this.store.claim(run.id, token, input.revision); claimed = true;
      const conflict = this.store.listProject(run.projectPath).map(other => this.get(other.id)).find(other => other.id !== run.id && (active.has(other.status) || other.status === "unknown" || this.store.owner(other.id)?.alive));
      if (conflict) throw new Error(`Project is held by workflow ${conflict.id}; stop or reconcile it before applying changes.`);
      const review = (run as StructuredRun & { maintenanceReview?: MaintenanceReview }).maintenanceReview;
      const result = run.workspace.kind === "git-worktree" ? review ? await applyMaintenance(run.workspace, review, { steps: [] }) : (() => { throw new Error("Missing maintenance review."); })() : await applyWorkspace(run.workspace, run.diff);
      return this.store.update(run.id, current => { if (current.revision !== input.revision || this.store.owner(run.id)?.token !== token) throw new RevisionConflictError(); current.application = result.applied ? "applied" : "conflict"; });
    } finally { try { await release(); } finally { if (claimed) this.store.release(run.id, token); } }
  }
  async settings(project: string) { if (!this.native) throw new Error("Native model settings unavailable."); const environment = await this.native.environment(project); return { settings: await this.native.settings.get(), models: environment.models, defaults: environment.defaults }; }
  async updateSettings(input: StoredExecutionSettings, project: string) { if (!this.native) throw new Error("Native model settings unavailable."); validateExplicitModelSettings(input, await this.native.environment(project)); return this.native.settings.update(input); }
  async #inventory(id: string): Promise<unknown[]> {
    if (!/^wf_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid run identity."); const root = path.join(this.store.directory, "runs", id), entries: unknown[] = [];
    const visit = async (filename: string, relative: string, depth: number): Promise<void> => { if (depth > 64 || entries.length > 200000) throw new Error("Deletion inventory exceeds its limit."); const info = await lstat(filename, { bigint: true }); entries.push([relative, info.dev.toString(), info.ino.toString(), info.size.toString(), info.mtimeNs.toString(), info.isSymbolicLink() ? await readlink(filename) : ""]); if (info.isDirectory() && !info.isSymbolicLink()) for (const name of (await readdir(filename)).sort()) await visit(path.join(filename, name), relative ? `${relative}/${name}` : name, depth + 1); };
    try { const parent = path.dirname(root); if (await realpath(parent) !== parent) throw new Error("Deletion parent directory changed."); await visit(root, "", 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return entries;
  }
  async deletionPreview(input: DeleteInput) {
    const definition = input.kind === "definition" ? this.store.getDefinition(input.id) : undefined, runs = definition ? this.store.listForDefinition(definition.id).map(run => this.get(run.id)) : [this.get(input.id)];
    if ((definition?.revision ?? runs[0]?.revision) !== input.revision) throw new RevisionConflictError(); const blockers: string[] = [];
    for (const run of runs) { if (active.has(run.status) || this.store.owner(run.id)?.alive) blockers.push(`${run.id} 仍在运行，请先停止。`); if (run.status === "unknown") blockers.push(`${run.id} 存在未知副作用，请先核对。`); }
    const manifests = await Promise.all(runs.map(async run => [run.id, run.revision, await this.#inventory(run.id)]));
    return { fingerprint: hash({ input, manifests }), canDelete: !blockers.length, blockers, runIds: runs.map(run => run.id), runRevisions: runs.map(run => ({ id: run.id, revision: run.revision })), removes: ["运行、尝试、事件、检查点和插件持有的工作区与日志", ...(definition ? ["库中定义的所有版本与关联运行"] : [])], preserves: ["项目原目录及已生效的本地改动", "其他工作流", "旧版本的独立存储"] };
  }
  async delete(input: DeleteInput & { fingerprint: string }) {
    const release = await acquireNamed(this.store.directory, "deletion");
    try { const { fingerprint, ...identity } = input, preview = await this.deletionPreview(identity); if (!preview.canDelete || fingerprint !== preview.fingerprint) throw new Error(preview.blockers.join(" ") || "Deletion scope changed.");
      const scope = { runs: preview.runRevisions, ...(input.kind === "definition" ? { definition: { id: input.id, revision: input.revision } } : {}) };
      this.store.beginDeletion(scope, fingerprint);
      if ((await this.deletionPreview(identity)).fingerprint !== fingerprint) throw new Error("Owned files changed after deletion was reserved; refresh the deletion preview before retrying.");
      for (const id of preview.runIds) { await this.#inventory(id); await rm(path.join(this.store.directory, "runs", id), { recursive: true, force: true }); }
      this.store.finishDeletion(scope, fingerprint); return { deleted: true, runIds: preview.runIds };
    } finally { await release(); }
  }
  async close() { try { await this.executor.close(); } finally { this.store.close(); } }
}
