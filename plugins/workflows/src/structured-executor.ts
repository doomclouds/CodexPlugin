import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { compileDefinition, evaluateExpression, cloneJson, validateDefinitionArgs, walkNodes } from "./definition.ts";
import type { CompiledDefinition, DefinitionNode, ExpressionEnvironment, JsonValue, WorkflowDefinition } from "./definition.ts";
import type { WorkerEvent } from "./adapter.ts";
import type { Activity } from "./types.ts";
import type { ActivityDriver, NodeInstance, RunLimits, StructuredEvent, StructuredPreview, StructuredRun } from "./structured-types.ts";
import { StructuredStore, RevisionConflictError } from "./structured-store.ts";
import type { CheckpointManifest } from "./structured-store.ts";
import { validateTaskOutput } from "./task-output.ts";

type Resolver = (id: string, revision: number) => Promise<WorkflowDefinition | { definition: WorkflowDefinition }> | WorkflowDefinition | { definition: WorkflowDefinition };
interface Control { abort: AbortController; promise: Promise<void>; pause: boolean; stop: boolean; active: number; activeWrites: number; serial: Promise<void>; token: string; wake: Set<() => void>; }
interface Context { env: ExpressionEnvironment; scope: string; parentId?: string; dependencies: string[]; signal: AbortSignal; control: Control; depth: number; cleanup?: boolean; compiled: CompiledDefinition; iteration?: number; itemKey?: string; branchId?: string; }
interface ProgressBatch { runId: string; instanceId: string; logs: string[]; logBytes: number; activities: Map<string, Activity>; identity?: Extract<WorkerEvent, { type: "identity" }>; settings?: Extract<WorkerEvent, { type: "execution-settings" }>; usage?: Extract<WorkerEvent, { type: "usage" }>; timer: ReturnType<typeof setTimeout>; }
export interface ControlInput { id: string; revision: number; expectedOwnerToken?: string; }
class Suspension extends Error { readonly reason: "paused" | "stopped" | "waiting"; constructor(reason: "paused" | "stopped" | "waiting") { super(reason); this.reason = reason; } }
class NodeFailure extends Error { readonly instanceId: string; constructor(instanceId: string, message: string) { super(message); this.instanceId = instanceId; } }
class UnknownActivityError extends NodeFailure {}
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const writable = (node: DefinitionNode): boolean => node.type === "agent" ? node.mode === "write" : node.type === "command" ? node.effect === "write" : false;
const activity = (node: DefinitionNode): boolean => node.type === "agent" || node.type === "command" || node.type === "expand";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaultLimits: RunLimits = { maxReadWorkers: 2, maxCalls: 100, timeoutMs: 600000, maxTokens: 0, maxInstances: 5000 };

/** Interprets the validated tree. Completed instances are durable cursors, never replayed activities. */
export class StructuredExecutor {
  readonly store: StructuredStore<StructuredRun>;
  readonly #driver: ActivityDriver;
  readonly #resolve?: Resolver;
  readonly #controls = new Map<string, Control>();
  readonly #progress = new Map<string, ProgressBatch>();
  readonly #activeAttempts = new Set<string>();
  #closed = false;

  constructor(options: { store: StructuredStore<StructuredRun>; driver: ActivityDriver; resolveDefinition?: Resolver }) {
    this.store = options.store; this.#driver = options.driver;
    if (options.resolveDefinition) this.#resolve = options.resolveDefinition;
  }

  preview(input: StructuredPreview): StructuredRun {
    if (this.#closed) throw new Error("Workflow executor is closed.");
    const compiled = compileDefinition(input.definition), args = validateDefinitionArgs(compiled.definition, input.args ?? {}), timestamp = now();
    const limits = { ...defaultLimits, ...input.limits };
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (key === "maxTokens" ? 0 : 1)) throw new Error(`Invalid workflow limit: ${key}.`);
    if (limits.maxReadWorkers > 32 || limits.maxInstances > 5000 || limits.maxCalls > 10000 || limits.timeoutMs > 86400000) throw new Error("Workflow limits exceed supported bounds.");
    const grants = { allowWrite: false, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot" as const, approvalMode: "never" as const, ...input.grants };
    const run: StructuredRun = { format: "structured-v1", id: `wf_${randomUUID().replaceAll("-", "")}`, revision: 1, createdAt: timestamp, updatedAt: timestamp,
      definition: compiled.definition, definitionHash: compiled.hash, compiled, args, projectPath: path.resolve(input.projectPath), grants, limits, status: "draft", instances: [], events: [], ...(input.sourceDefinition ? { sourceDefinition: input.sourceDefinition } : {}) };
    this.#checkGrants(run, run.definition.steps);
    return this.store.create(run);
  }

  #checkGrants(run: StructuredRun, nodes: DefinitionNode[]): void {
    for (const node of nodes) {
      if (writable(node) && !run.grants.allowWrite) throw new Error(`Node ${node.id} requires explicitly authorized write access.`);
      if (node.type === "command" && node.networkAccess && !run.grants.networkAccess) throw new Error(`Node ${node.id} requires explicitly authorized network access.`);
      if (node.type === "choice") { for (const branch of node.cases) this.#checkGrants(run, branch.steps); this.#checkGrants(run, node.default); }
      else if (node.type === "parallel") for (const branch of node.branches) this.#checkGrants(run, branch.steps);
      else if (node.type === "repeat" || node.type === "map") this.#checkGrants(run, node.steps);
      else if (node.type === "try") { this.#checkGrants(run, node.steps); this.#checkGrants(run, node.catch ?? []); this.#checkGrants(run, node.finally ?? []); }
      else if (node.type === "subflow" && node.definition) this.#checkGrants(run, node.definition.steps);
    }
  }

  get(id: string): StructuredRun { this.#recoverOrphan(id); return this.store.get(id); }
  list(options: { projectPath?: string; limit?: number; offset?: number } = {}): StructuredRun[] { return this.store.list(options).map(run => this.get(run.id)); }
  #recoverOrphan(id: string): void {
    if (this.#controls.has(id)) return;
    const run = this.store.get(id);
    if (!["preparing", "running", "pausing", "stopping"].includes(run.status)) return;
    const owner = this.store.owner(id);
    if (owner?.alive) return;
    const writeIds = new Set<string>();
    const checkpointManifest = this.store.checkpoints(id)[0]?.snapshot as CheckpointManifest | undefined;
    const collect = (nodes: DefinitionNode[]) => { for (const node of nodes) { if (writable(node)) writeIds.add(node.id); if ("steps" in node) collect(node.steps); if (node.type === "choice") { node.cases.forEach(branch => collect(branch.steps)); collect(node.default); } if (node.type === "parallel") node.branches.forEach(branch => collect(branch.steps)); if (node.type === "try") { collect(node.catch ?? []); collect(node.finally ?? []); } } };
    collect(run.definition.steps);
    this.#change(id, current => {
      for (const instance of current.instances) if (instance.status === "running") {
        const committed = instance.attempts.at(-1);
        const isWrite = instance.cursor?.effect === "write" || (instance.cursor?.effect === undefined && writeIds.has(instance.nodeId));
        const covered = checkpointManifest?.format === "structured-checkpoint-v1" && checkpointManifest.definitionHash === current.definitionHash && committed?.resultEventSequence !== undefined && committed.resultEventSequence <= checkpointManifest.eventSequence;
        if (committed?.status === "completed" && instance.type !== "expand" && (!isWrite || covered)) { instance.status = "completed"; instance.output = committed.output ?? null; instance.endedAt = committed.endedAt ?? now(); continue; }
        instance.status = committed && ["running", "completed"].includes(committed.status) && isWrite ? "unknown" : "interrupted";
        instance.error = instance.status === "unknown" ? "The previous owner exited after a write dispatch; inspect its effects before resolving." : "The previous executor exited before committing the activity result.";
        instance.endedAt = now(); const attempt = instance.attempts.at(-1); if (attempt?.status === "running" || (attempt?.status === "completed" && instance.status === "unknown")) { attempt.status = instance.status; attempt.error = instance.error; attempt.endedAt = now(); }
      }
      current.status = current.instances.some(instance => instance.status === "unknown") ? "unknown" : "stopped";
      current.error = "The previous executor exited; committed outputs were preserved."; delete current.ownerToken;
    }, "run.recovered");
    if (owner) { this.store.completeControls(id, owner.token); this.store.release(id, owner.token); }
  }

  start(input: { id: string; revision: number }): StructuredRun {
    const run = this.get(input.id);
    if (run.revision !== input.revision) throw new RevisionConflictError();
    if (run.status !== "draft") throw new Error("Only a draft can be started; resume an existing run.");
    return this.#launch(run, false);
  }
  async resume(input: { id: string; revision: number; fingerprint?: string }): Promise<StructuredRun> {
    const run = this.get(input.id);
    if (run.revision !== input.revision) throw new RevisionConflictError();
    if (!["paused", "stopped", "failed", "waiting"].includes(run.status)) throw new Error("This workflow cannot currently be resumed.");
    if (run.instances.some(instance => instance.status === "unknown")) throw new Error("Resolve activities with unknown side effects before resuming.");
    if (run.checkpoint) {
      if (input.fingerprint !== run.checkpoint.fingerprint) throw new Error("Checkpoint fingerprint changed; inspect the current recovery preview.");
      await this.#driver.validateCheckpoint?.(run, run.checkpoint.fingerprint);
    }
    if (this.store.get(run.id).revision !== input.revision) throw new RevisionConflictError();
    if (run.instances.some(instance => instance.status === "waiting")) throw new Error("Resolve the waiting node before resuming.");
    const ready = this.#change(run.id, current => {
      if (current.revision !== input.revision) throw new RevisionConflictError();
      for (const instance of current.instances) if (instance.status === "interrupted" || instance.status === "cancelled") { instance.status = "ready"; delete instance.error; delete instance.endedAt; }
      delete current.error; delete current.endedAt; current.recoveryEpoch = (current.recoveryEpoch ?? 0) + 1;
    }, "run.resume-requested");
    return this.#launch(ready, true);
  }
  #launch(run: StructuredRun, resumed: boolean): StructuredRun {
    if (this.#closed) throw new Error("Workflow executor is closed.");
    if (this.#controls.has(run.id)) throw new Error("Workflow is already running.");
    const token = randomUUID(); this.store.claim(run.id, token, run.revision);
    const control: Control = { abort: new AbortController(), promise: Promise.resolve(), pause: false, stop: false, active: 0, activeWrites: 0, serial: Promise.resolve(), token, wake: new Set() };
    this.#controls.set(run.id, control);
    try { this.#change(run.id, current => { if (current.revision !== run.revision) throw new RevisionConflictError(); current.status = resumed && current.workspace ? "running" : "preparing"; current.ownerToken = token; current.startedAt ??= now(); delete current.error; delete current.endedAt; }, "run.started"); }
    catch (error) { this.#controls.delete(run.id); this.store.release(run.id, token); throw error; }
    control.promise = this.#execute(run.id, control);
    return this.store.get(run.id);
  }
  async #execute(id: string, control: Control): Promise<void> {
    const timer = setTimeout(() => control.abort.abort(new Error("Workflow execution deadline exceeded.")), this.store.get(id).limits.timeoutMs); timer.unref();
    const polling = setInterval(() => { try { this.#consumeControls(id, control); } catch (error) { control.abort.abort(error); } }, 250); polling.unref();
    try {
      let run = this.store.get(id);
      if (this.#driver.prepare) {
        await this.#driver.prepare(run, control.abort.signal, () => this.#change(id, current => { if (run.preparation) current.preparation = clone(run.preparation); }, "preparation.progress"));
        if (control.abort.signal.aborted) throw control.abort.signal.reason;
        this.#change(id, current => { if (run.workspace) current.workspace = run.workspace; if (run.workspaceFingerprint) current.workspaceFingerprint = run.workspaceFingerprint; if (run.executionSettings) current.executionSettings = run.executionSettings; if (run.preparation) current.preparation = run.preparation; }, "run.prepared");
      }
      this.#change(id, current => { current.status = "running"; }, "run.running");
      await this.#checkpoint(id, control);
      run = this.store.get(id);
      const env: ExpressionEnvironment = { args: clone(run.args), steps: {} };
      const output = await this.#steps(id, run.definition.steps, { env, scope: "/root", dependencies: [], signal: control.abort.signal, control, depth: 0, compiled: run.compiled });
      if (control.stop) throw new Suspension("stopped");
      const uncertain = this.store.get(id).instances.find(instance => instance.status === "unknown"); if (uncertain) throw new UnknownActivityError(uncertain.id, "An activity has unknown effects; reconciliation is required.");
      this.#change(id, current => { current.result = output; current.status = "completed"; current.endedAt = now(); }, "run.completed");
    } catch (error) {
      this.#change(id, current => {
        const hasUnknown = current.instances.some(instance => instance.status === "unknown");
        for (const stage of current.preparation ?? []) if (stage.status === "running") stage.status = "failed";
        current.status = hasUnknown ? "unknown" : error instanceof Suspension ? error.reason : control.stop ? "stopped" : "failed";
        if (!(error instanceof Suspension)) current.error = errorText(error);
        if (current.status !== "waiting" && current.status !== "paused") current.endedAt = now();
      }, error instanceof Suspension ? `run.${error.reason}` : "run.failed");
    } finally {
      clearTimeout(timer); clearInterval(polling);
      try { await this.#checkpoint(id, control); }
      catch (error) { this.#change(id, run => { if (run.status === "completed") run.status = "failed"; run.error = `Checkpoint commit failed: ${errorText(error)}`; }, "checkpoint.failed"); }
      try { await this.#driver.finish?.(this.store.get(id)); }
      catch (error) { this.#change(id, run => { if (run.status === "completed") run.status = "failed"; run.error = `Activity cleanup failed: ${errorText(error)}`; }, "run.cleanup-failed"); }
      try { this.#change(id, run => { delete run.ownerToken; }, "run.released"); }
      finally { this.store.completeControls(id, control.token); this.store.release(id, control.token); this.#controls.delete(id); }
    }
  }

  async wait(id: string): Promise<StructuredRun> { await this.#controls.get(id)?.promise; return this.get(id); }
  #controlRun(input: ControlInput): StructuredRun {
    const run = this.get(input.id);
    if (input.expectedOwnerToken !== undefined) {
      const owner = this.store.owner(run.id);
      if (!owner?.alive || owner.token !== input.expectedOwnerToken || run.ownerToken !== input.expectedOwnerToken || input.revision > run.revision) throw new Error("The workflow execution owner changed; refresh before issuing a control request.");
    } else if (run.revision !== input.revision) throw new RevisionConflictError();
    return run;
  }
  async pause(input: ControlInput): Promise<StructuredRun> {
    const run = this.#controlRun(input);
    const control = this.#controls.get(run.id); if (!control) { if (this.store.owner(run.id)?.alive) return this.#externalControl(run, "pause", input); throw new Error("Workflow is not running."); }
    control.pause = true; for (const wake of control.wake) wake(); this.#change(run.id, current => { current.status = "pausing"; }, "run.pause-requested");
    return this.wait(run.id);
  }
  async stop(input: ControlInput): Promise<StructuredRun> {
    const run = this.#controlRun(input);
    const control = this.#controls.get(run.id);
    if (!control) { if (this.store.owner(run.id)?.alive) return this.#externalControl(run, "stop", input); if (["completed", "failed", "unknown", "stopped"].includes(run.status)) return run; return this.#change(run.id, current => { current.status = "stopped"; current.endedAt = now(); }, "run.stopped"); }
    control.stop = true; this.#change(run.id, current => { current.status = "stopping"; }, "run.stop-requested"); control.abort.abort(new Suspension("stopped"));
    return this.wait(run.id);
  }
  #consumeControls(id: string, control: Control): void {
    for (const request of this.store.readControls(id, control.token)) {
      if (request.action === "stop") { control.stop = true; control.abort.abort(new Suspension("stopped")); }
      else control.pause = true;
      for (const wake of control.wake) wake();
      this.#change(id, run => { run.status = control.stop ? "stopping" : "pausing"; }, `run.${request.action}-requested`, undefined, { requestId: request.id });
      this.store.acceptControl(request.id, control.token);
    }
  }
  async #externalControl(run: StructuredRun, action: "pause" | "stop", input: ControlInput): Promise<StructuredRun> {
    const request = this.store.requestControl(run.id, input.revision, action, input.expectedOwnerToken), deadline = Date.now() + 30000;
    for (;;) {
      const current = this.get(run.id), owner = this.store.owner(run.id);
      if (!owner?.alive || this.store.getControl(request.id)?.status === "completed") return current;
      if (owner.token !== request.ownerToken) throw new Error("The workflow changed executor; refresh before issuing another control request.");
      if (Date.now() >= deadline) throw new Error(`The ${action} request is queued, but the owning executor has not actually settled yet. Refresh the run to inspect its real state.`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  resolveWait(input: { id: string; revision: number; instanceId: string; value: JsonValue }): StructuredRun {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError();
    if (this.#controls.has(run.id)) throw new Error("Wait for the executor to reach a stable waiting point.");
    this.#assertUnowned(run.id);
    const instance = run.instances.find(item => item.id === input.instanceId); if (!instance || instance.status !== "waiting") throw new Error("Waiting node not found.");
    const value = cloneJson(input.value);
    validateTaskOutput(value, instance.cursor?.schema);
    return this.#change(run.id, current => { if (current.revision !== input.revision) throw new RevisionConflictError(); const target = current.instances.find(item => item.id === instance.id)!; target.status = "completed"; target.output = value; target.endedAt = now(); current.status = "paused"; }, "wait.resolved", instance.id, value);
  }
  resolveUnknown(input: { id: string; revision: number; instanceId: string; resolution: "completed" | "retry"; output?: JsonValue; fingerprint: string; evidence: string }, checkpointFingerprint?: string): StructuredRun {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError();
    if (this.#controls.has(run.id)) throw new Error("Workflow is still running.");
    this.#assertUnowned(run.id);
    const target = run.instances.find(instance => instance.id === input.instanceId); if (!target || target.status !== "unknown") throw new Error("Unknown activity not found.");
    if (input.evidence.trim().length < 3) throw new Error("Record the observed side-effect evidence before reconciliation.");
    if (input.fingerprint !== this.unknownFingerprint(run, target)) throw new Error("Unknown-activity confirmation fingerprint changed.");
    const output = cloneJson(input.output === undefined ? target.attempts.at(-1)?.output ?? null : input.output);
    if (input.resolution === "completed") {
      const node = this.#definitionNode(run, target); if (!node) throw new Error("The activity's frozen definition could not be located for reconciliation.");
      if (node.type === "agent") validateTaskOutput(output, node.schema, node.accept);
    }
    const checkpoint = checkpointFingerprint ? { id: `cp_${randomUUID().replaceAll("-", "")}`, sequence: (run.checkpoint?.sequence ?? 0) + 1, at: now(), fingerprint: checkpointFingerprint, definitionHash: run.definitionHash } : undefined;
    return this.#change(run.id, current => {
      if (current.revision !== input.revision) throw new RevisionConflictError();
      const instance = current.instances.find(item => item.id === target.id)!; instance.status = input.resolution === "completed" ? "completed" : "ready"; delete instance.error;
      if (input.resolution === "completed") instance.output = output; else delete instance.output;
      instance.cursor!.reconciliation = { resolution: input.resolution, evidence: input.evidence, at: now() };
      if (checkpoint) { current.checkpoint = checkpoint; current.workspaceFingerprint = checkpoint.fingerprint; }
      if (!current.instances.some(item => item.status === "unknown")) current.status = "stopped";
    }, "activity.reconciled", target.id, { resolution: input.resolution, evidence: input.evidence }, checkpoint ? { id: checkpoint.id, fingerprint: checkpoint.fingerprint } : undefined);
  }
  unknownFingerprint(run: StructuredRun, instance: NodeInstance): string { return createHash("sha256").update(JSON.stringify({ id: run.id, revision: run.revision, instance: instance.id, attempts: instance.attempts, checkpoint: run.checkpoint?.id })).digest("hex"); }
  #definitionNode(run: StructuredRun, instance: NodeInstance): DefinitionNode | undefined {
    const ancestors: NodeInstance[] = []; let parentId = instance.parentId;
    while (parentId) { const parent = run.instances.find(item => item.id === parentId); if (!parent || ancestors.length > 64) throw new Error("Invalid persisted activity scope."); ancestors.push(parent); parentId = parent.parentId; }
    let definition = run.definition;
    for (const parent of ancestors.reverse()) {
      const child = parent.type === "subflow" ? parent.cursor?.definition : parent.type === "expand" ? parent.cursor?.expanded : undefined;
      if (child) definition = compileDefinition(child).definition;
    }
    let found: DefinitionNode | undefined; walkNodes(definition, node => { if (node.id === instance.nodeId) found = node; }); return found;
  }
  retryNode(input: { id: string; revision: number; instanceId: string }): StructuredRun {
    const run = this.get(input.id); if (run.revision !== input.revision) throw new RevisionConflictError();
    if (this.#controls.has(run.id)) throw new Error("Pause or stop the workflow before retrying a node.");
    this.#assertUnowned(run.id);
    const target = run.instances.find(item => item.id === input.instanceId); if (!target) throw new Error("Node instance not found.");
    if (target.status === "unknown") throw new Error("Reconcile unknown effects before retrying this activity.");
    const reset = new Set(run.instances.filter(item => item.path === target.path || item.path.startsWith(`${target.path}/`)).map(item => item.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const instance of run.instances) if (!reset.has(instance.id) && (instance.path.startsWith(`${target.path}/`) || [...reset].some(id => (instance.cursor?.dependencies as JsonValue[] | undefined)?.includes(id)) || [...reset].some(id => run.instances.find(item => item.id === id)?.parentId === instance.id))) { reset.add(instance.id); changed = true; }
    }
    for (const instance of run.instances) if (reset.has(instance.id) && instance.id !== target.id && instance.status === "completed" && instance.cursor?.effect === "write") throw new Error("A dependent write already completed; create a new run instead of replaying its effects.");
    return this.#change(run.id, current => {
      if (current.revision !== input.revision) throw new RevisionConflictError();
      for (const instance of current.instances) if (reset.has(instance.id)) {
        const needsFreshAttempt = ["agent", "command", "expand"].includes(instance.type) && !target.path.startsWith(`${instance.path}/`);
        instance.status = "ready"; delete instance.output; delete instance.error; delete instance.endedAt;
        if (instance.type !== "subflow" && instance.type !== "expand") { const dependencies = instance.cursor?.dependencies, effect = instance.cursor?.effect, role = instance.cursor?.role; instance.cursor = {}; if (dependencies) instance.cursor.dependencies = dependencies; if (effect) instance.cursor.effect = effect; if (role) instance.cursor.role = role; }
        if (instance.cursor) delete instance.cursor.transitions;
        if (needsFreshAttempt) { instance.cursor ??= {}; instance.cursor.forceNewAttempt = true; if (instance.type === "expand") { delete instance.cursor.expanded; delete instance.cursor.expandedHash; } }
      }
      current.status = "paused"; delete current.error; delete current.endedAt; delete current.result;
    }, "node.retry-prepared", target.id);
  }

  #gate(context: Context): void {
    if (context.cleanup) { if (context.signal.aborted) throw context.signal.reason; return; }
    if (context.control.stop) throw new Suspension("stopped");
    if (context.control.pause) throw new Suspension("paused");
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Activity was cancelled.");
  }
  #assertUnowned(id: string): void { if (this.store.owner(id)?.alive) throw new Error("This workflow is active in another executor; control it from its owning connection."); }
  async #steps(id: string, nodes: DefinitionNode[], context: Context): Promise<JsonValue> {
    const outputs: Record<string, JsonValue> = {}, dependencies = [...context.dependencies];
    const parent = context.parentId ? this.store.get(id).instances.find(item => item.id === context.parentId) : undefined;
    let fromNode = parent?.nodeId, fromInstance = parent?.id;
    for (const node of nodes) {
      this.#gate(context);
      if (fromNode && fromInstance) this.#transition(id, context, fromNode, node.id, fromInstance);
      const result = await this.#visit(id, node, { ...context, dependencies: [...dependencies] });
      outputs[node.id] = result;
      context.env.steps[node.id] = { output: clone(result), status: "completed" };
      const instance = this.store.get(id).instances.find(item => item.path === `${context.scope}/${node.id}`)!;
      dependencies.push(instance.id);
      fromNode = ["choice", "parallel", "map", "repeat", "try", "subflow", "expand"].includes(node.type) ? `$join:${node.id}` : node.id; fromInstance = instance.id;
    }
    if (parent && fromNode && fromInstance) {
      const target = parent.type === "repeat" || parent.type === "map" || parent.type === "scope" ? parent.nodeId : `$join:${parent.nodeId}`;
      this.#transition(id, context, fromNode, target, fromInstance, parent.id);
    }
    return outputs;
  }
  #transition(id: string, context: Context, from: string, to: string, instanceId: string, toInstanceId?: string): void {
    const candidates = context.compiled.plan.edges.filter(edge => edge.from === from && edge.to === to);
    const edge = candidates.find(item => item.branchId === context.branchId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!edge) return;
    const key = `${context.compiled.hash}:${edge.id}:${context.scope}`;
    if ((this.store.get(id).instances.find(item => item.id === instanceId)?.cursor?.transitions as JsonValue[] | undefined)?.includes(key)) return;
    this.#change(id, run => { const source = run.instances.find(item => item.id === instanceId); if (source) source.cursor!.transitions = [...((source.cursor!.transitions ?? []) as JsonValue[]), key]; }, "transition", instanceId,
      { edgeId: edge.id, definitionHash: context.compiled.hash, scope: context.scope, ...(context.branchId ? { branchId: context.branchId } : {}), ...(context.iteration === undefined ? {} : { iteration: context.iteration }), ...(toInstanceId ? { toInstanceId } : {}) }, undefined,
      { edgeId: edge.id, fromInstanceId: instanceId, ...(toInstanceId ? { toInstanceId } : {}) });
  }
  async #visit(id: string, node: DefinitionNode, context: Context): Promise<JsonValue> {
    this.#gate(context);
    if (context.depth > 32) throw new Error("Subflow depth exceeds the execution limit.");
    const instancePath = `${context.scope}/${node.id}`;
    let instance = this.store.get(id).instances.find(item => item.path === instancePath);
    if (!instance) {
      this.#change(id, run => {
        if (run.instances.length >= run.limits.maxInstances) throw new Error("Workflow instance budget exhausted.");
        instance = { id: `ni_${randomUUID().replaceAll("-", "")}`, nodeId: node.id, type: node.type, label: node.label ?? node.id, path: instancePath, status: "ready", attempts: [], cursor: { dependencies: context.dependencies, effect: writable(node) ? "write" : "read" }, ...(context.parentId ? { parentId: context.parentId } : {}), ...(context.iteration === undefined ? {} : { iteration: context.iteration }), ...(context.itemKey === undefined ? {} : { itemKey: context.itemKey }), ...(context.branchId ? { branchId: context.branchId } : {}) };
        run.instances.push(instance);
      }, "node.activated");
    }
    const instanceId = instance!.id;
    instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
    if (instance.status === "completed") return clone(instance.output ?? null);
    if (instance.status === "waiting") throw new Suspension("waiting");
    if (instance.status === "unknown") throw new UnknownActivityError(instance.id, "Activity side effects are unknown; reconciliation is required.");
    if (instance.status === "failed") throw new NodeFailure(instance.id, instance.error ?? "Node failed.");
    this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.status = "running"; current.startedAt ??= now(); delete current.error; }, "node.started", instanceId);
    try {
      let output: JsonValue;
      if (activity(node)) {
        const committed = this.store.get(id).instances.find(item => item.id === instanceId)!.attempts.at(-1);
        output = committed?.status === "completed" && !this.store.get(id).instances.find(item => item.id === instanceId)!.cursor?.forceNewAttempt ? clone(committed.output ?? null) : await this.#activity(id, node, instanceId, context);
        if (node.type === "expand") {
          let stored = this.store.get(id).instances.find(item => item.id === instanceId)!.cursor?.expanded;
          if (!stored) {
            const compiled = compileDefinition(output); this.#checkGrants(this.store.get(id), compiled.definition.steps); stored = cloneJson(compiled.definition);
            this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.cursor!.expanded = stored!; current.cursor!.expandedHash = compiled.hash; }, "expand.committed", instanceId);
          }
          const compiled = compileDefinition(stored);
          output = await this.#steps(id, compiled.definition.steps, this.#child(context, instanceId, `${instancePath}/expanded`, { args: clone(context.env.args), steps: {} }, compiled));
        }
      } else if (node.type === "transform") output = evaluateExpression(node.value, context.env);
      else if (node.type === "wait") {
        const message = evaluateExpression(node.message, context.env);
        this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.status = "waiting"; current.cursor!.message = message; if (node.schema) current.cursor!.schema = node.schema; }, "wait.started", instanceId, { message });
        throw new Suspension("waiting");
      } else if (node.type === "choice") {
        instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
        let selected = instance.cursor?.selectedCase;
        if (selected === undefined) {
          selected = "default";
          for (const branch of node.cases) { const value = evaluateExpression(branch.when, context.env); if (typeof value !== "boolean") throw new Error("Choice conditions must evaluate to booleans."); if (value) { selected = branch.id; break; } }
          this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.selectedCase = selected!; }, "choice.selected", instanceId, { branchId: selected });
        }
        const branch = node.cases.find(item => item.id === selected), steps = branch?.steps ?? node.default;
        const child = this.#child(context, instanceId, `${instancePath}/case:${selected}`, clone(context.env)); child.branchId = String(selected);
        output = await this.#steps(id, steps, child);
      } else if (node.type === "repeat") output = await this.#repeat(id, node, instanceId, instancePath, context);
      else if (node.type === "parallel") {
        const branchAbort = new AbortController(), signal = AbortSignal.any([context.signal, branchAbort.signal]);
        let primary: unknown;
        const results = await this.#pool(node.branches, node.concurrency ?? node.branches.length, async branch => {
          const child = this.#child(context, instanceId, `${instancePath}/branch:${branch.id}`, clone(context.env)); child.signal = signal; child.branchId = branch.id;
          try { return await this.#steps(id, branch.steps, child); }
          catch (error) { if (node.policy === "fail-fast" && !(error instanceof Suspension)) { primary ??= error; branchAbort.abort(error); } throw error; }
        });
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        const suspended = rejected.find(result => result.reason instanceof Suspension); if (suspended) throw suspended.reason;
        const unknown = rejected.find(result => result.reason instanceof UnknownActivityError); if (unknown) throw unknown.reason;
        if (node.policy === "fail-fast" && rejected.length) throw primary ?? rejected[0]!.reason;
        output = Object.fromEntries(node.branches.map((branch, index) => { const result = results[index]!; return [branch.id, result.status === "fulfilled" ? node.policy === "all-settled" ? { status: "completed", output: result.value } : result.value : { status: "failed", error: errorText(result.reason) }]; }));
      } else if (node.type === "map") {
        instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
        let items = instance.cursor?.items;
        let keys = instance.cursor?.keys;
        if (items === undefined) {
          items = evaluateExpression(node.items, context.env); if (!Array.isArray(items)) throw new Error("Map items must evaluate to an array.");
          keys = items.map(item => { const value = evaluateExpression(node.itemKey, { ...context.env, item }); if (typeof value !== "string" && typeof value !== "number") throw new Error("Map keys must be strings or finite numbers."); const key = String(value); if (Buffer.byteLength(key) > 256) throw new Error("Map item keys must not exceed 256 bytes."); return key; });
          if (new Set(keys).size !== keys.length) throw new Error("Map item keys must be unique.");
          this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.cursor!.items = items!; current.cursor!.keys = keys!; }, "map.frozen", instanceId, { count: items.length });
        }
        if (!Array.isArray(items) || !Array.isArray(keys)) throw new Error("Stored map state is invalid.");
        let primary: unknown;
        const mapAbort = new AbortController(), results = await this.#pool(items, node.concurrency ?? this.store.get(id).limits.maxReadWorkers, async (item, index) => {
          const key = String((keys as JsonValue[])[index]);
          const child = this.#child(context, instanceId, `${instancePath}/item:${encodeURIComponent(key)}`, { ...clone(context.env), item: clone(item), key }); child.signal = AbortSignal.any([context.signal, mapAbort.signal]); child.itemKey = key;
          try { return await this.#scope(id, node, instanceId, child, "item"); } catch (error) { if (!(error instanceof Suspension)) { primary ??= error; mapAbort.abort(error); } throw error; }
        });
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (failed) throw primary ?? failed.reason;
        output = results.map(result => (result as PromiseFulfilledResult<JsonValue>).value);
      } else if (node.type === "try") output = await this.#try(id, node, instanceId, instancePath, context);
      else if (node.type === "subflow") {
        instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
        let definition = instance.cursor?.definition;
        if (!definition) {
          let resolved: WorkflowDefinition | { definition: WorkflowDefinition };
          if (node.definition) resolved = node.definition;
          else { if (!node.ref || !this.#resolve) throw new Error("The subflow resolver is unavailable."); resolved = await this.#resolve(node.ref.id, node.ref.revision); }
          const compiled = compileDefinition("definition" in resolved ? resolved.definition : resolved); this.#checkGrants(this.store.get(id), compiled.definition.steps); definition = cloneJson(compiled.definition);
          this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.definition = definition!; }, "subflow.frozen", instanceId);
        }
        const compiled = compileDefinition(definition), args = validateDefinitionArgs(compiled.definition, node.args === undefined ? {} : evaluateExpression(node.args, context.env));
        output = await this.#steps(id, compiled.definition.steps, this.#child(context, instanceId, `${instancePath}/subflow`, { args, steps: {} }, compiled));
      } else throw new Error("Unsupported structured node.");
      output = cloneJson(output);
      const bytes = Buffer.byteLength(JSON.stringify(output)); if (bytes > 1024 * 1024) throw new Error("Node output exceeds the 1 MiB persisted output budget; return a concise result and use artifact files for large data.");
      this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.status = "completed"; current.output = output; current.endedAt = now(); const children = run.instances.filter(item => item.parentId === instanceId).map(item => item.id); current.cursor!.dependencies = [...context.dependencies, ...children]; }, "node.completed", instanceId, { outputBytes: bytes, outputCommitted: true });
      if (node.type === "repeat" || node.type === "map" || node.type === "subflow" || node.type === "expand") this.#transition(id, { ...context, scope: instancePath }, node.id, `$join:${node.id}`, instanceId, instanceId);
      if (!activity(node) && node.type !== "transform" && node.type !== "wait") this.#change(id, () => {}, "join", instanceId, { nodeId: node.id });
      await this.#checkpoint(id, context.control);
      return output;
    } catch (error) {
      this.#change(id, run => {
        const current = run.instances.find(item => item.id === instanceId)!;
        if (current.status === "waiting" || current.status === "unknown") return;
        current.status = error instanceof Suspension || error instanceof UnknownActivityError ? "interrupted" : context.signal.aborted ? "cancelled" : "failed";
        current.error = errorText(error); current.endedAt = now();
      }, "node.interrupted", instanceId, { error: errorText(error) });
      throw error instanceof Suspension || error instanceof NodeFailure ? error : new NodeFailure(instanceId, errorText(error));
    }
  }

  #child(context: Context, parentId: string, scope: string, env: ExpressionEnvironment, compiled = context.compiled): Context {
    return { ...context, parentId, scope, env, compiled, depth: context.depth + 1, dependencies: [...context.dependencies] };
  }
  async #repeat(id: string, node: Extract<DefinitionNode, { type: "repeat" }>, instanceId: string, instancePath: string, context: Context): Promise<JsonValue> {
    let instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
    let iteration = Number(instance.cursor?.nextIteration ?? 0), outputs = (instance.cursor?.outputs ?? []) as JsonValue[];
    if (instance.cursor?.done === true) return outputs;
    const loopEnv = clone(context.env);
    const previous = outputs.at(-1); if (previous && typeof previous === "object" && !Array.isArray(previous)) for (const [nodeId, output] of Object.entries(previous)) loopEnv.steps[nodeId] = { status: "completed", output };
    let priorScope = this.store.get(id).instances.find(item => item.parentId === instanceId && item.type === "scope" && item.iteration === iteration - 1)?.id;
    while (iteration < node.maxIterations) {
      this.#gate(context); loopEnv.iteration = iteration; loopEnv.state = outputs.at(-1) ?? null;
      instance = this.store.get(id).instances.find(item => item.id === instanceId)!;
      if (instance.cursor?.activeIteration !== iteration) {
        if (node.while !== undefined) { const value = evaluateExpression(node.while, loopEnv); if (typeof value !== "boolean") throw new Error("Repeat conditions must evaluate to booleans."); if (!value) { this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.done = true; }, "repeat.exited", instanceId, { iteration, reason: "while-false" }); return outputs; } }
        this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.cursor!.activeIteration = iteration; }, "repeat.iteration", instanceId, { iteration });
      }
      const child = this.#child(context, instanceId, `${instancePath}/iteration:${iteration}`, loopEnv); child.iteration = iteration;
      if (priorScope) child.dependencies = [...context.dependencies, priorScope];
      const output = await this.#scope(id, node, instanceId, child, "iteration");
      priorScope = this.store.get(id).instances.find(item => item.path === child.scope)!.id;
      if (output && typeof output === "object" && !Array.isArray(output)) for (const [nodeId, value] of Object.entries(output)) loopEnv.steps[nodeId] = { status: "completed", output: value };
      outputs = [...outputs, output]; iteration++;
      let exit = false;
      if (node.until !== undefined) { loopEnv.state = output; loopEnv.iteration = iteration - 1; const value = evaluateExpression(node.until, loopEnv); if (typeof value !== "boolean") throw new Error("Repeat conditions must evaluate to booleans."); exit = value; }
      this.#change(id, run => { const current = run.instances.find(item => item.id === instanceId)!; current.cursor!.nextIteration = iteration; current.cursor!.outputs = outputs; if (exit) current.cursor!.done = true; delete current.cursor!.activeIteration; }, "repeat.committed", instanceId, { iteration: iteration - 1 });
      if (exit) { this.#change(id, () => {}, "repeat.exited", instanceId, { iteration: iteration - 1, reason: "until-true" }); return outputs; }
    }
    this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.done = true; }, "repeat.exited", instanceId, { iteration, reason: "maximum" });
    return outputs;
  }
  async #scope(id: string, node: Extract<DefinitionNode, { type: "repeat" | "map" }>, ownerId: string, context: Context, role: "iteration" | "item"): Promise<JsonValue> {
    let instance = this.store.get(id).instances.find(item => item.path === context.scope);
    if (!instance) {
      this.#change(id, run => {
        if (run.instances.length >= run.limits.maxInstances) throw new Error("Workflow instance budget exhausted.");
        instance = { id: `scope_${randomUUID().replaceAll("-", "")}`, nodeId: node.id, type: "scope", label: role === "iteration" ? `第 ${(context.iteration ?? 0) + 1} 轮` : `项目 ${context.itemKey ?? ""}`, path: context.scope, parentId: ownerId, status: "ready", attempts: [], cursor: { role, dependencies: context.dependencies }, ...(context.iteration === undefined ? {} : { iteration: context.iteration }), ...(context.itemKey === undefined ? {} : { itemKey: context.itemKey }) };
        run.instances.push(instance);
      }, "scope.activated", ownerId);
    }
    const scopeId = instance!.id;
    instance = this.store.get(id).instances.find(item => item.id === scopeId)!;
    if (instance.status === "completed") return clone(instance.output ?? null);
    this.#change(id, run => { const current = run.instances.find(item => item.id === scopeId)!; current.status = "running"; current.startedAt ??= now(); }, "scope.started", scopeId);
    try {
      const output = await this.#steps(id, node.steps, { ...context, parentId: scopeId });
      this.#change(id, run => { const current = run.instances.find(item => item.id === scopeId)!; current.status = "completed"; current.output = output; current.endedAt = now(); current.cursor!.dependencies = [...context.dependencies, ...run.instances.filter(item => item.parentId === scopeId).map(item => item.id)]; }, "scope.completed", scopeId);
      return output;
    } catch (error) {
      this.#change(id, run => { const current = run.instances.find(item => item.id === scopeId)!; current.status = error instanceof Suspension || error instanceof UnknownActivityError ? "interrupted" : context.signal.aborted ? "cancelled" : "failed"; current.error = errorText(error); current.endedAt = now(); }, "scope.interrupted", scopeId);
      throw error;
    }
  }
  async #try(id: string, node: Extract<DefinitionNode, { type: "try" }>, instanceId: string, instancePath: string, context: Context): Promise<JsonValue> {
    let output: JsonValue = null, primary: unknown, hasPrimary = false;
    try { output = await this.#steps(id, node.steps, this.#child(context, instanceId, `${instancePath}/try`, clone(context.env))); }
    catch (error) {
      if (node.catch && !(error instanceof Suspension) && !(error instanceof UnknownActivityError) && !context.signal.aborted) {
        this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.caught = errorText(error); }, "error.caught", instanceId, { error: errorText(error) });
        try { output = await this.#steps(id, node.catch, this.#child(context, instanceId, `${instancePath}/catch`, { ...clone(context.env), error: { message: errorText(error) } })); }
        catch (caughtError) { primary = caughtError; hasPrimary = true; }
      } else { primary = error; hasPrimary = true; }
    }
    if (node.finally && !(primary instanceof Suspension && primary.reason !== "stopped")) {
      const cleanup = this.#child(context, instanceId, `${instancePath}/finally`, { ...clone(context.env), error: hasPrimary ? { message: errorText(primary) } : null });
      if (context.control.stop || context.signal.aborted) { cleanup.cleanup = true; cleanup.signal = AbortSignal.timeout(10000); }
      try { await this.#steps(id, node.finally, cleanup); }
      catch (error) { this.#change(id, run => { run.instances.find(item => item.id === instanceId)!.cursor!.cleanupError = errorText(error); }, "cleanup.failed", instanceId, { error: errorText(error) }); if (!hasPrimary) { primary = error; hasPrimary = true; } }
    }
    if (hasPrimary) throw primary;
    return output;
  }

  async #pool<T>(items: T[], concurrency: number, execute: (item: T, index: number) => Promise<JsonValue>): Promise<PromiseSettledResult<JsonValue>[]> {
    const results: PromiseSettledResult<JsonValue>[] = new Array(items.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      for (;;) { const index = cursor++; if (index >= items.length) return; try { results[index] = { status: "fulfilled", value: await execute(items[index]!, index) }; } catch (reason) { results[index] = { status: "rejected", reason }; } }
    }));
    return results;
  }
  async #serial<R>(control: Control, work: () => Promise<R> | R): Promise<R> {
    const previous = control.serial; let release!: () => void; control.serial = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await work(); } finally { release(); }
  }
  async #activity(id: string, node: DefinitionNode, instanceId: string, context: Context): Promise<JsonValue> {
    let attemptId = "";
    for (;;) {
      let awaken!: () => void; const wake = new Promise<void>(resolve => { awaken = resolve; });
      const callback = () => { context.control.wake.delete(callback); context.signal.removeEventListener("abort", callback); awaken(); };
      context.control.wake.add(callback); context.signal.addEventListener("abort", callback, { once: true });
      let acquired: boolean;
      try { acquired = await this.#serial(context.control, () => {
      this.#gate(context);
      const run = this.store.get(id), calls = run.instances.reduce((count, instance) => count + instance.attempts.length, 0);
      const unknown = run.instances.find(item => item.status === "unknown");
      if (unknown && (!context.cleanup || writable(node))) throw new UnknownActivityError(unknown.id, "An earlier write has unknown effects; reconcile before dispatching another activity.");
      if (context.control.activeWrites > 0 || (writable(node) ? context.control.active > 0 : context.control.active >= run.limits.maxReadWorkers)) return false;
      if (calls >= run.limits.maxCalls) throw new Error("Workflow activity budget exhausted.");
      const usedTokens = run.instances.reduce((count, instance) => count + instance.attempts.reduce((sum, attempt) => sum + (attempt.usage?.totalTokens ?? 0), 0), 0);
      if (run.limits.maxTokens > 0 && usedTokens >= run.limits.maxTokens) throw new Error("Workflow token budget exhausted.");
      attemptId = `attempt_${randomUUID().replaceAll("-", "")}`;
      this.#change(id, current => { const target = current.instances.find(item => item.id === instanceId)!; target.attempts.push({ id: attemptId, status: "running", startedAt: now(), activities: [], logs: [] }); delete target.cursor!.forceNewAttempt; }, "activity.dispatch-intent", instanceId, { attemptId, effect: writable(node) ? "write" : "read" });
      context.control.active++;
      if (writable(node)) context.control.activeWrites++;
      return true;
      }); } catch (error) { callback(); throw error; }
      if (acquired) { callback(); break; }
      await wake;
    }
    try {
      const run = this.store.get(id), instance = run.instances.find(item => item.id === instanceId)!;
      this.#activeAttempts.add(attemptId);
      const generated = node.type === "expand" ? instance.cursor?.expanded : undefined;
      const result = generated === undefined ? await this.#driver.execute({ run, node, instance, env: clone(context.env) }, context.signal, event => this.#onWorkerEvent(id, instanceId, attemptId, event)) : generated;
      this.#flushProgress(attemptId);
      const output = cloneJson(result);
      const outputBytes = Buffer.byteLength(JSON.stringify(output));
      if (outputBytes > 512 * 1024 || Buffer.byteLength(JSON.stringify(this.store.get(id))) + outputBytes * 4 > 20 * 1024 * 1024) throw new Error("Activity output exceeds the persisted result budget; return a concise summary and save large artifacts in files.");
      if (node.type === "agent") validateTaskOutput(output, node.schema, node.accept);
      if (node.type === "expand") { const compiled = compileDefinition(output); this.#checkGrants(this.store.get(id), compiled.definition.steps); }
      this.#change(id, current => { const attempt = current.instances.find(item => item.id === instanceId)!.attempts.find(item => item.id === attemptId)!; attempt.status = "completed"; attempt.output = output; attempt.endedAt = now(); attempt.resultEventSequence = (current.events.at(-1)?.sequence ?? 0) + 1; }, "activity.result-committed", instanceId, { attemptId });
      return output;
    } catch (error) {
      this.#flushProgress(attemptId);
      this.#change(id, current => {
        const instance = current.instances.find(item => item.id === instanceId)!, attempt = instance.attempts.find(item => item.id === attemptId)!;
        const outcome = (error as { outcome?: unknown } | null)?.outcome;
        const uncertain = writable(node) && outcome !== "not-applied" && outcome !== "confirmed-failed";
        attempt.status = uncertain ? "unknown" : context.signal.aborted ? "interrupted" : "failed"; attempt.error = errorText(error); attempt.endedAt = now();
        if (uncertain) { instance.status = "unknown"; instance.error = "The write did not confirm its final effects; reconcile before continuing."; }
      }, "activity.failed", instanceId, { attemptId, error: errorText(error) });
      if (this.store.get(id).instances.find(item => item.id === instanceId)!.status === "unknown") throw new UnknownActivityError(instanceId, errorText(error));
      throw error;
    } finally {
      this.#activeAttempts.delete(attemptId);
      await this.#serial(context.control, async () => { context.control.active--; if (writable(node)) context.control.activeWrites--; await this.#checkpointUnlocked(id, context.control); for (const wake of context.control.wake) wake(); });
    }
  }
  #onWorkerEvent(id: string, instanceId: string, attemptId: string, event: WorkerEvent): void {
    if (!this.#activeAttempts.has(attemptId) || event.type === "process") return;
    let batch = this.#progress.get(attemptId);
    if (!batch) {
      const timer = setTimeout(() => { try { this.#flushProgress(attemptId); } catch (error) { this.#controls.get(id)?.abort.abort(error); } }, 200); timer.unref();
      batch = { runId: id, instanceId, logs: [], logBytes: 0, activities: new Map(), timer }; this.#progress.set(attemptId, batch);
    }
    if (event.type === "identity") batch.identity = event;
    else if (event.type === "execution-settings") batch.settings = event;
    else if (event.type === "usage") batch.usage = event;
    else if (event.type === "log") {
      const message = event.message.slice(0, 4096); batch.logs.push(message); batch.logBytes += Buffer.byteLength(message);
      while (batch.logs.length > 200 || batch.logBytes > 128 * 1024) batch.logBytes -= Buffer.byteLength(batch.logs.shift()!);
    } else {
      const item = { ...event.activity, id: event.activity.id.slice(0, 160), label: event.activity.label.slice(0, 256), ...(event.activity.detail ? { detail: event.activity.detail.slice(0, 2048) } : {}) };
      batch.activities.set(item.id, item); if (batch.activities.size > 100) batch.activities.delete(batch.activities.keys().next().value!);
    }
  }
  #flushProgress(attemptId: string): void {
    const batch = this.#progress.get(attemptId); if (!batch) return;
    clearTimeout(batch.timer); this.#progress.delete(attemptId);
    this.#change(batch.runId, run => {
      const attempt = run.instances.find(item => item.id === batch.instanceId)?.attempts.find(item => item.id === attemptId); if (!attempt || attempt.status !== "running") return;
      if (batch.identity) { attempt.threadId = batch.identity.threadId; if (batch.identity.turnId) attempt.turnId = batch.identity.turnId; }
      if (batch.settings) attempt.executionSettings = batch.settings.settings;
      if (batch.usage) attempt.usage = { inputTokens: batch.usage.inputTokens, outputTokens: batch.usage.outputTokens, totalTokens: batch.usage.totalTokens };
      attempt.logs.push(...batch.logs.map(message => ({ at: now(), message })));
      while (attempt.logs.length > 200 || attempt.logs.reduce((size, line) => size + Buffer.byteLength(line.message), 0) > 128 * 1024) attempt.logs.shift();
      for (const item of batch.activities.values()) { const index = attempt.activities.findIndex(entry => entry.id === item.id); if (index < 0) attempt.activities.push(item); else attempt.activities[index] = item; }
      if (attempt.activities.length > 100) attempt.activities.splice(0, attempt.activities.length - 100);
    }, "activity.progress", batch.instanceId, { kind: "batch", logs: batch.logs.length, activities: batch.activities.size });
  }
  async #checkpoint(id: string, control: Control): Promise<void> { await this.#serial(control, () => this.#checkpointUnlocked(id, control)); }
  async #checkpointUnlocked(id: string, control: Control): Promise<void> {
    if (control.active !== 0) return;
    const run = this.store.get(id);
    if (run.instances.some(instance => instance.status === "unknown")) return;
    const fingerprint = this.#driver.captureCheckpoint ? await this.#driver.captureCheckpoint(run) : createHash("sha256").update(JSON.stringify({ definition: run.definitionHash, project: run.projectPath })).digest("hex");
    const checkpoint = { id: `cp_${randomUUID().replaceAll("-", "")}`, sequence: (run.checkpoint?.sequence ?? 0) + 1, at: now(), fingerprint, definitionHash: run.definitionHash };
    this.#change(id, current => { current.checkpoint = checkpoint; }, "checkpoint.committed", undefined, { checkpointId: checkpoint.id }, { id: checkpoint.id, fingerprint });
  }
  #change(id: string, mutate: (run: StructuredRun) => void, type: string, instanceId?: string, data?: JsonValue, checkpoint?: { id: string; fingerprint: string }, edgeFields?: Pick<StructuredEvent, "edgeId" | "fromInstanceId" | "toInstanceId">): StructuredRun {
    let event!: StructuredEvent;
    const inputs: import("./structured-store.ts").EventInput[] = [];
    return this.store.update(id, run => {
      mutate(run);
      const instance = instanceId ? run.instances.find(item => item.id === instanceId) : undefined;
      event = { sequence: (run.events.at(-1)?.sequence ?? 0) + 1, at: now(), type, ...(instanceId ? { instanceId } : {}), ...(instance ? { nodeId: instance.nodeId, ...(instance.parentId ? { parentId: instance.parentId } : {}) } : {}), ...(data === undefined ? {} : { data }), ...edgeFields };
      run.events.push(event);
      inputs.push({ type, at: event.at, ...(instanceId ? { instanceId } : {}), payload: event });
      if (run.events.length > 20000) run.events.splice(0, run.events.length - 20000);
    }, inputs, checkpoint);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, control] of this.#controls) { control.stop = true; control.abort.abort(new Suspension("stopped")); this.#change(id, run => { run.status = "stopping"; }, "run.stop-requested"); }
    await Promise.all([...this.#controls.values()].map(control => control.promise));
    await this.#driver.close?.();
  }
}
