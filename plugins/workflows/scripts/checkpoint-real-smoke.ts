import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapter.ts";
import type { CommandRequest, WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "../src/adapter.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";

// Opt-in only: this calls two real logged-in native workers. The stopped second
// dispatch is held before native.run; real process-crash tests are separate.
if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and CODEX_CLI_PATH; it calls real gpt-6-luna/max workers.");

const sha = (value: string | Buffer | undefined) => value === undefined ? null : createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/((?:token|password|secret|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").slice(0, 1200);

interface Audit {
  nativeCalls: Array<{ taskId: string; attemptId: string; mode: string; model: string; effort: string; tools?: string[]; threadId?: string; turnId?: string }>;
  heldDispatches: number;
  processIds: Set<number>;
}

class CheckpointRealAdapter implements WorkerAdapter {
  private readonly real: CodexAdapter;
  private readonly audit: Audit;
  private readonly project: string;
  private readonly reachedPause: () => void;
  private holdSecond: boolean;

  constructor(input: { wrapper: string; project: string; audit: Audit; holdSecond: boolean; reachedPause: () => void }) {
    this.real = new CodexAdapter({ command: process.execPath, args: [input.wrapper, "app-server", "--stdio"], startupTimeoutMs: 45000 });
    this.audit = input.audit;
    this.project = input.project;
    this.holdSecond = input.holdSecond;
    this.reachedPause = input.reachedPause;
  }

  executionEnvironment(cwd: string, signal: AbortSignal) { return this.real.executionEnvironment(cwd, signal); }
  command(request: CommandRequest, signal: AbortSignal, onEvent?: (event: WorkerEvent) => void) { return this.real.command(request, signal, onEvent); }
  close() { return this.real.close(); }

  async run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    assert.equal(request.cwd, this.project);
    assert.equal(request.model, "gpt-6-luna");
    assert.equal(request.reasoningEffort, "max");
    assert.equal(request.networkAccess, false);
    assert.deepEqual(request.mcpServers, []);
    if (request.id === "task_2_attempt_1" && this.holdSecond) {
      this.holdSecond = false;
      this.audit.heldDispatches++;
      this.reachedPause();
      // No native worker, command, or model has started for this held attempt.
      await new Promise<void>(resolve => {
        const interrupted = () => { signal.removeEventListener("abort", interrupted); resolve(); };
        if (signal.aborted) interrupted(); else signal.addEventListener("abort", interrupted, { once: true });
      });
      throw new Error("Fixture stopped its queued verification before native worker dispatch");
    }
    const call = { taskId: request.id.split("_attempt_")[0]!, attemptId: request.id, mode: request.mode, model: request.model!, effort: request.reasoningEffort! } as Audit["nativeCalls"][number];
    this.audit.nativeCalls.push(call);
    const result = await this.real.run(request, signal, event => {
      if (event.type === "process") {
        if (event.state === "started") this.audit.processIds.add(event.pid);
        else this.audit.processIds.delete(event.pid);
      }
      onEvent(event);
    });
    assert.equal(result.executionSettings?.model, "gpt-6-luna");
    assert.equal(result.executionSettings?.reasoningEffort, "max");
    assert.ok(result.toolsUsed?.some(tool => tool.startsWith("native:")), "A model-only statement is not native tool execution evidence");
    assert.ok(result.toolsUsed?.every(tool => tool.startsWith("native:")), "No external MCP tools are authorized");
    call.tools = result.toolsUsed;
    call.threadId = result.threadId;
    call.turnId = result.turnId;
    return result;
  }
}

async function main() {
  const command = process.env.CODEX_CLI_PATH;
  if (!command?.trim()) throw new Error("Set CODEX_CLI_PATH to the native Codex executable before this opt-in smoke.");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-checkpoint-real-")));
  const project = path.join(root, "project"), state = path.join(root, "state"), privateHome = path.join(root, "codex-home");
  const userHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), configPath = path.join(userHome, "config.toml");
  const wrapper = path.join(root, "private-cli.mjs"), markerName = `checkpoint-${randomUUID()}.txt`, marker = `checkpoint-native-${randomUUID()}`;
  const preserved = "Existing user notes must survive stop, close, preview and resume.\n";
  const audit: Audit = { nativeCalls: [], heldDispatches: 0, processIds: new Set() };
  let engine: WorkflowEngine | undefined;
  let adapter: CheckpointRealAdapter | undefined;
  let originalConfig: string | undefined;
  let configRead = false;
  let report: Record<string, unknown> | undefined;
  const deadline = Date.now() + 240000;
  async function readConfig() {
    try { return await readFile(configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  }
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Real checkpoint smoke exceeded its four-minute execution budget")), Math.max(1, deadline - Date.now())); })]); }
    finally { clearTimeout(timer!); }
  }
  try {
    await mkdir(project);
    await writeFile(path.join(project, "notes.txt"), preserved);
    await mkdir(privateHome, { mode: 0o700 });
    originalConfig = await readConfig(); configRead = true;
    await writeFile(path.join(privateHome, "config.toml"), originalConfig ?? "", { mode: 0o600 });
    try {
      await copyFile(path.join(userHome, "auth.json"), path.join(privateHome, "auth.json"));
      await chmod(path.join(privateHome, "auth.json"), 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The existing login/config is copied only into this disposable private
    // home. No global approval, MCP, model, or other user settings are edited.
    await writeFile(wrapper, `import{spawn}from'node:child_process';const child=spawn(${JSON.stringify(command)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,CODEX_HOME:${JSON.stringify(privateHome)}}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));`);
    let reachedPause!: () => void;
    const paused = new Promise<void>(resolve => { reachedPause = resolve; });
    adapter = new CheckpointRealAdapter({ wrapper, project, audit, holdSecond: true, reachedPause });
    const store = new RunStore(state);
    engine = new WorkflowEngine({ store, adapter });
    const schema = { type: "object", properties: { status: { type: "string" }, marker: { type: "string" } }, required: ["status", "marker"], additionalProperties: false };
    const accept = { type: "object", properties: { status: { const: "passed" }, marker: { const: marker } }, required: ["status", "marker"] };
    const writeCode = `const wf_fs=require("node:fs");wf_fs.writeFileSync(${JSON.stringify(markerName)},${JSON.stringify(`${marker}\n`)},{flag:"wx",mode:384});process.stdout.write(wf_fs.readFileSync(${JSON.stringify(markerName)},"utf8"));`;
    const readCode = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(markerName)},"utf8"));`;
    const writeCommand = `${quote(process.execPath)} -e ${quote(writeCode)}`, readCommand = `${quote(process.execPath)} -e ${quote(readCode)}`;
    const script = 'export const meta={name:"real-node-checkpoint",description:"Create one harmless local marker and independently read it after a manual checkpoint recovery",phases:[{title:"写入标记"},{title:"恢复后核验"}]}; phase("写入标记"); const written=await agent(args.write,{mode:"write",model:"gpt-6-luna",reasoningEffort:"max",schema:args.schema,accept:args.accept}); phase("恢复后核验"); const verified=await agent(args.read,{model:"gpt-6-luna",reasoningEffort:"max",schema:args.schema,accept:args.accept}); return {written,verified};';
    const common = "This is an explicitly authorized harmless smoke test in a disposable, non-Git local project. Use only native tools and the exact command below. Preserve notes.txt. No network, external MCP tools, installation, commits, extra files, permission changes or delegation. If code-mode is needed, emit the actual command result, including exit status and output. Return {\"status\":\"passed\",\"marker\":the actual marker read without its trailing newline} only after the command succeeds; do not invent results. ";
    const draft = await engine.preview({
      projectPath: project, script, allowWrite: true, workspaceMode: "local", networkAccess: false, approvalMode: "never",
      args: {
        schema, accept,
        write: `${common}Create exactly the named marker once using exclusive creation, read it back, and return that actual result. Execute exactly once: ${writeCommand}`,
        read: `${common}Read only the named existing marker. Its value is intentionally not in this prompt; obtain it from the real file. Execute: ${readCommand}`,
      },
      limits: { timeoutMs: 220000, maxCalls: 3, maxReadWorkers: 1 },
    });
    console.log(JSON.stringify({ stage: "real-checkpoint-write", model: "gpt-6-luna", effort: "max", id: draft.id, nativeWorkerCrashClaimed: false }));
    await bounded(engine.start({ id: draft.id, revision: draft.revision }));
    await bounded(Promise.race([paused, engine.wait(draft.id).then(run => { throw new Error(`Workflow ended before the controlled pause: ${run.execution}: ${run.error ?? "no error"}`); })]));
    assert.equal(audit.nativeCalls.length, 1);
    const markerBeforeStop = await readFile(path.join(project, markerName), "utf8");
    assert.equal(markerBeforeStop, `${marker}\n`);
    const stopped = await bounded(engine.stop(draft.id));
    assert.equal(stopped.execution, "stopped", stopped.error);
    assert.deepEqual(stopped.tasks.map(task => task.status), ["completed", "interrupted"]);
    assert.equal(stopped.tasks[0]?.attempts.length, 1);
    assert.equal(stopped.tasks[1]?.attempts.length, 1);
    assert.equal(stopped.nodeCheckpoint?.completedTasks, 1);
    assert.equal(stopped.checkpointState?.status, "ready");
    const firstAttempts = structuredClone(stopped.tasks[0]!.attempts);
    const stoppedCheckpoints = await engine.listCheckpoints({ id: stopped.id, limit: 100 });
    assert.ok(stoppedCheckpoints.total >= 2);
    assert.ok(stoppedCheckpoints.checkpoints.some(checkpoint => checkpoint.completedTasks === 1 && checkpoint.reason === "node"));
    await bounded(engine.close()); engine = undefined; adapter = undefined;
    assert.equal(audit.processIds.size, 0, "all first-owner native worker processes must exit before recovery");

    adapter = new CheckpointRealAdapter({ wrapper, project, audit, holdSecond: false, reachedPause: () => {} });
    engine = new WorkflowEngine({ store: new RunStore(state), adapter });
    const reopened = await bounded(engine.get(stopped.id));
    assert.equal(audit.nativeCalls.length, 1, "reopening saved state must not execute a model");
    assert.deepEqual(reopened.tasks[0]?.attempts, firstAttempts);
    const beforePreview = await store.load(reopened.id);
    const preview = await bounded(engine.previewRecovery({ id: reopened.id, revision: reopened.revision }));
    assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
    assert.deepEqual(preview.reusedTaskIds, ["task_1"]);
    assert.deepEqual(preview.rerunTaskIds, ["task_2"]);
    assert.equal(preview.currentFilesPreserved, true);
    assert.equal(preview.externalEffectsReverted, false);
    assert.deepEqual(await store.load(reopened.id), beforePreview, "recovery preview must remain read-only");
    assert.equal(audit.nativeCalls.length, 1);
    console.log(JSON.stringify({ stage: "real-checkpoint-resume", checkpoint: preview.checkpoint, reusedTaskIds: preview.reusedTaskIds, rerunTaskIds: preview.rerunTaskIds, nativeCallsBeforeConfirm: audit.nativeCalls.length }));
    await bounded(engine.start({ id: reopened.id, revision: reopened.revision, recoveryFingerprint: preview.fingerprint }, true));
    const done = await bounded(engine.wait(reopened.id));
    assert.equal(done.execution, "completed", done.error);
    assert.equal(done.tasks[0]?.cached, true);
    assert.deepEqual(done.tasks[0]?.attempts, firstAttempts);
    assert.equal(done.tasks[1]?.cached, false);
    assert.equal(done.tasks[1]?.attempts.length, 2);
    assert.equal(done.tasks[1]?.attempts[0]?.status, "interrupted");
    assert.equal(done.tasks[1]?.attempts[1]?.status, "completed");
    assert.equal(done.application, "none");
    assert.equal(done.nodeCheckpoint?.completedTasks, 2);
    assert.equal(done.checkpointState?.status, "ready");
    assert.deepEqual(done.result, { written: { status: "passed", marker }, verified: { status: "passed", marker } });
    assert.deepEqual(audit.nativeCalls.map(call => call.attemptId), ["task_1_attempt_1", "task_2_attempt_2"]);
    assert.equal(audit.heldDispatches, 1);
    assert.equal(await readFile(path.join(project, markerName), "utf8"), markerBeforeStop);
    assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), preserved);
    assert.deepEqual((await readdir(project)).sort(), [markerName, "notes.txt"].sort());
    assert.ok(done.tasks.every(task => task.executionSettings?.model === "gpt-6-luna" && task.executionSettings.reasoningEffort === "max"));
    const checkpoints = await engine.listCheckpoints({ id: done.id, limit: 100 });
    assert.ok(checkpoints.total > stoppedCheckpoints.total);
    assert.ok(checkpoints.checkpoints.some(checkpoint => checkpoint.reason === "recovery"));
    assert.equal(sha(await readConfig()), sha(originalConfig));
    report = {
      test: "real-node-checkpoint", success: true, model: "gpt-6-luna", effort: "max", realWorkers: audit.nativeCalls.length,
      heldBeforeNativeDispatch: audit.heldDispatches, realNativeCrashClaimed: false, sourceSha256: sha(await readFile(fileURL())),
      nativeCalls: audit.nativeCalls, stoppedAttemptCounts: stopped.tasks.map(task => task.attempts.length), resumedAttemptCounts: done.tasks.map(task => task.attempts.length),
      firstAttemptUnchanged: true, firstTaskReused: done.tasks[0]?.cached, recoveryPreviewReadOnly: true, checkpointCount: checkpoints.total, checkpoints: checkpoints.checkpoints,
      markerSha256: sha(markerBeforeStop), filesPreserved: true, userConfigUnchanged: true, userConfigSha256: sha(originalConfig), durationMs: Date.now() - (deadline - 240000),
    };
  } finally {
    try { if (engine) await engine.close(); else await adapter?.close(); }
    finally {
      try {
        assert.equal(audit.processIds.size, 0, "native worker processes must exit before private credentials are removed");
        if (configRead) assert.equal(sha(await readConfig()), sha(originalConfig), "this smoke must never modify user configuration");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
  console.log(JSON.stringify({ ...report, temporaryDataAndCredentialsRemoved: true }));
}

function fileURL() { return new URL(import.meta.url); }

try { await main(); }
catch (error) { console.error(JSON.stringify({ test: "real-node-checkpoint", success: false, error: safeError(error) })); process.exitCode = 1; }
