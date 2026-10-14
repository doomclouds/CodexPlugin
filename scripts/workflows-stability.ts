import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAdapter } from "../plugins/workflows/src/adapter.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult, CommandRequest } from "../plugins/workflows/src/adapter.ts";
import { WorkflowEngine } from "../plugins/workflows/src/engine.ts";
import { RunStore } from "../plugins/workflows/src/store.ts";
import { TemplateStore } from "../plugins/workflows/src/templates.ts";
import type { WorkflowRun } from "../plugins/workflows/src/types.ts";

const execute = promisify(execFile);
const model = "gpt-6-luna";
const effort = "max";
const settings = { model, reasoningEffort: effort };
const workerOptions = JSON.stringify(settings);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/https?:\/\/\S+/g, "[url]")
  .replace(/((?:token|secret|password|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]")
  .slice(0, 200);
const markerSchema = { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false };
const valueSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const meta = (name: string) => `export const meta = { name: ${JSON.stringify(name)}, description: "Opt-in real stability matrix", phases: [{title:"运行"}] }; phase("运行");`;
const readPrompt = "Use your native shell command tool to read marker.txt from the current project. Return its exact trimmed content as marker. Do not modify files, spawn other agents, install software, or use external services.";

class ObservedRealAdapter implements WorkerAdapter {
  calls = 0;
  commands = 0;
  readonly requests: Array<{ id: string; model?: string; effort?: string; status: string; ms?: number; error?: string; usage?: WorkerResult["usage"]; tools?: string[]; settings?: WorkerResult["executionSettings"]; data?: unknown }> = [];
  readonly real = new CodexAdapter({ command: process.env.WORKFLOWS_STABILITY_CODEX ?? "codex" });
  private onProcess?: (pid: number) => void;
  constructor(onProcess?: (pid: number) => void) { this.onProcess = onProcess; }
  executionEnvironment(cwd: string, signal: AbortSignal) { return this.real.executionEnvironment(cwd, signal); }
  async run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void) {
    assert.equal(request.model, model, "Every real worker must request the authorized model.");
    assert.equal(request.reasoningEffort, effort, "Every real worker must request max reasoning.");
    this.calls++;
    const record = { id: request.id, model: request.model, effort: request.reasoningEffort, status: "running" } as ObservedRealAdapter["requests"][number];
    this.requests.push(record);
    const started = Date.now();
    try {
      const result = await this.real.run(request, signal, event => {
        if (event.type === "process" && event.state === "started") this.onProcess?.(event.pid);
        if (event.type === "usage") record.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
        if (event.type === "execution-settings") record.settings = event.settings;
        onEvent(event);
      });
      assert.equal(result.executionSettings?.model, model);
      assert.equal(result.executionSettings?.reasoningEffort, effort);
      assert.equal(result.executionSettings?.provenance, "configured", "CLI must confirm configuration; a request alone is insufficient.");
      Object.assign(record, { status: "completed", ms: Date.now() - started, usage: result.usage, tools: result.toolsUsed, settings: result.executionSettings, ...(result.data === undefined ? {} : { data: result.data }) });
      console.log(JSON.stringify({ event: "worker", ...record }));
      return result;
    } catch (error) {
      Object.assign(record, { status: "failed", ms: Date.now() - started, error: safeError(error) });
      console.log(JSON.stringify({ event: "worker", ...record }));
      throw error;
    }
  }
  command(request: CommandRequest, signal: AbortSignal, onEvent?: (event: WorkerEvent) => void) {
    this.commands++;
    return this.real.command(request, signal, event => {
      if (event.type === "process" && event.state === "started") this.onProcess?.(event.pid);
      onEvent?.(event);
    });
  }
  close() { return this.real.close(); }
}

interface CaseResult { name: string; status: "passed" | "failed"; model: string; effort: string; calls: number; commands: number; ms: number; error?: string; evidence?: Record<string, unknown>; inputTokens: number; outputTokens: number; totalTokens: number }
const summaries: CaseResult[] = [];

async function initializeProject(project: string, marker: string) {
  await mkdir(project, { recursive: true });
  await execute("git", ["init", "--quiet", "-b", "main"], { cwd: project });
  await writeFile(path.join(project, "marker.txt"), `${marker}\n`);
  await writeFile(path.join(project, "sum.mjs"), "export const add = (a, b) => a - b;\n");
  await writeFile(path.join(project, "sum.test.mjs"), "import assert from 'node:assert/strict';import {add} from './sum.mjs';assert.equal(add(2,3),5);assert.equal(add(-2,3),1);console.log('PASS');\n");
  await execute("git", ["add", "-A"], { cwd: project });
  await execute("git", ["-c", "user.name=Workflow Stability", "-c", "user.email=workflow-stability@example.invalid", "commit", "--quiet", "-m", "Create disposable stability fixture"], { cwd: project });
}

async function crashChild(root: string) {
  const adapter = new ObservedRealAdapter();
  const engine = new WorkflowEngine({ store: new RunStore(path.join(root, "crash-state")), adapter });
  const script = `${meta("crash-recovery")} await operation("identity"); await operation("wait"); return "recovered";`;
  const draft = await engine.preview({ projectPath: path.join(root, "project-c"), script, allowWrite: true, workspaceMode: "git-worktree", maintenance: { steps: [
    { id: "identity", command: ["git", "rev-parse", "HEAD"], idempotent: true },
    { id: "wait", command: [process.execPath, "-e", "setTimeout(()=>console.log('done'),4000)"], idempotent: true },
  ] }, limits: { maxCalls: 3, timeoutMs: 60000 } });
  await writeFile(path.join(root, "crash-id.txt"), draft.id);
  await engine.start({ id: draft.id, revision: draft.revision });
  await engine.wait(draft.id);
  await engine.close();
}

async function main() {
  if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers to authorize real gpt-6-luna/max calls in disposable fixtures.");
  const root = await mkdtemp(path.join(tmpdir(), "workflows-stability-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const markerA = `A-${randomBytes(12).toString("hex")}`;
  const markerB = `B-${randomBytes(12).toString("hex")}`;
  let adapter = new ObservedRealAdapter();
  let engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  let child: ReturnType<typeof spawn> | undefined;
  const reportPath = process.env.WORKFLOWS_STABILITY_REPORT ?? path.join(root, "report.json");
  const selectedCases = process.env.WORKFLOWS_STABILITY_CASES?.split(",").filter(Boolean);
  const run = async (name: string, script: string, input: Partial<Parameters<WorkflowEngine["preview"]>[0]> = {}) => {
    const draft = await engine.preview({ projectPath: projectA, script, limits: { maxCalls: 12, maxReadWorkers: 2, timeoutMs: 360000 }, ...input });
    await engine.start({ id: draft.id, revision: draft.revision });
    const complete = await engine.wait(draft.id);
    assert.equal(complete.execution, "completed", `${name}: ${complete.error}`);
    for (const task of complete.tasks.filter(task => !task.options.operation && task.status === "completed")) {
      assert.equal(task.executionSettings?.model, model);
      assert.equal(task.executionSettings?.reasoningEffort, effort);
      assert.equal(task.executionSettings?.provenance, "configured");
    }
    return complete;
  };
  const checkpoint = async () => {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ date: "2026-10-15", model, effort, root, cases: summaries, requests: adapter.requests }, null, 2), { mode: 0o600 });
  };
  const test = async (name: string, action: () => Promise<Record<string, unknown>>) => {
    if (selectedCases && !selectedCases.includes(name)) return true;
    const begin = Date.now();
    const previous = adapter.calls;
    const commands = adapter.commands;
    const requestIndex = adapter.requests.length;
    console.log(JSON.stringify({ event: "case-start", name, model, effort }));
    let summary: CaseResult;
    try { summary = { name, status: "passed", model, effort, calls: adapter.calls - previous, commands: adapter.commands - commands, ms: Date.now() - begin, evidence: await action(), inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
    catch (error) { summary = { name, status: "failed", model, effort, calls: 0, commands: 0, ms: 0, error: safeError(error), inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
    summary.calls = adapter.calls - previous; summary.commands = adapter.commands - commands; summary.ms = Date.now() - begin;
    for (const record of adapter.requests.slice(requestIndex)) { summary.inputTokens += record.usage?.inputTokens ?? 0; summary.outputTokens += record.usage?.outputTokens ?? 0; summary.totalTokens += record.usage?.totalTokens ?? 0; }
    summaries.push(summary);
    console.log(JSON.stringify({ event: "case", ...summary }));
    await checkpoint();
    return summary.status === "passed";
  };
  try {
    await initializeProject(projectA, markerA); await initializeProject(projectB, markerB);
    await initializeProject(path.join(root, "project-c"), "Crash-recovery fixture");
    const defaults = await engine.getExecutionSettings(projectA);
    await engine.updateExecutionSettings({ revision: defaults.settings.revision, projectPath: projectA, ...settings });
    console.log(JSON.stringify({ event: "catalogue", model: defaults.models.find(entry => entry.id === model), fixtureRoot: root }));
    if (!await test("native-structured-probe", async () => {
      const complete = await run("probe", `${meta("native-structured-probe")} return await agent(args.prompt,{...args.settings,schema:args.schema});`, { args: { prompt: readPrompt, settings, schema: markerSchema } });
      assert.deepEqual(complete.result, { marker: markerA });
      assert.ok(complete.tasks[0].attempts.at(-1)?.toolsUsed?.length);
      return { execution: complete.execution, CLIConfigured: complete.tasks[0].executionSettings, nativeTools: complete.tasks[0].attempts.at(-1)?.toolsUsed, progressSequence: complete.progressSequence };
    })) return;

    for (const branch of ["left", "right"]) await test(`branch-loop-parallel-pipeline-${branch}`, async () => {
      const script = `${meta(`matrix-${branch}`)}
const decision=await agent("Return the branch token " + args.branch + " exactly as marker, without tools.",{...args.settings,schema:args.markerSchema});
const selected=decision.marker==="left" ? "L" : "R";
const values=[]; for(let i=0;i<2;i++){const value=await agent("Return integer " + (i+1) + " as value, without tools.",{...args.settings,schema:args.valueSchema});values.push(value.value);}
const parallelResult=await parallel([0,1].map(i=>()=>agent(args.readPrompt,{...args.settings,label:"Parallel " + i,schema:args.markerSchema})));
const pipelineResult=await pipeline([1,2], value=>agent("Return integer " + (value*2) + " as value, without tools.",{...args.settings,schema:args.valueSchema}), value=>value.value===2?null:value.value);
return {selected,values,parallelResult,pipelineResult};`;
      const complete = await run(branch, script, { args: { branch, settings, markerSchema, valueSchema, readPrompt }, limits: { maxCalls: 7, maxReadWorkers: 2, timeoutMs: 360000 } });
      const result = complete.result as any;
      assert.equal(result.selected, branch === "left" ? "L" : "R");
      assert.deepEqual(result.values, [1, 2]);
      assert.deepEqual(result.parallelResult, [{ marker: markerA }, { marker: markerA }]);
      assert.deepEqual(result.pipelineResult, [null, 4]);
      assert.equal(complete.tasks.length, 7);
      const parallelTasks = complete.tasks.filter(task => task.label?.startsWith("Parallel"));
      const intervals = parallelTasks.map(task => task.attempts.at(-1)!);
      assert.ok(Date.parse(intervals[0].startedAt!) < Date.parse(intervals[1].endedAt!) && Date.parse(intervals[1].startedAt!) < Date.parse(intervals[0].endedAt!), "Parallel workers must actually overlap.");
      return { branch: result.selected, loopIterations: result.values.length, parallelOverlap: true, pipelineStopsNullItem: true, tasks: complete.tasks.length, execution: complete.execution };
    });

    await test("failure-capture-and-call-budget", async () => {
      const script = `${meta("failure-capture")}
const first=await agent(args.prompt,{...args.settings,schema:args.schema});
let caught="";try{await agent("This must never dispatch",args.settings);}catch(error){caught=error.message;}
if(!caught)throw new Error("Call budget did not reject");return {first,caught};`;
      const complete = await run("failure-capture", script, { args: { prompt: readPrompt, settings, schema: markerSchema }, limits: { maxCalls: 1, maxReadWorkers: 1, timeoutMs: 120000 } });
      const result = complete.result as any;
      assert.deepEqual(result.first, { marker: markerA }); assert.match(result.caught, /limit|calls/i);
      return { caught: safeError(result.caught), realWorkers: complete.tasks.length, execution: complete.execution };
    });

    await test("cancel-worker-parallel-failure-isolation", async () => {
      const script = `${meta("cancel-worker")} return await parallel([()=>agent(args.slow,{...args.settings,schema:args.schema,label:"cancel-target"}),()=>agent(args.prompt,{...args.settings,schema:args.schema,label:"survivor"})]);`;
      const draft = await engine.preview({ projectPath: projectA, script, args: { settings, schema: markerSchema, prompt: readPrompt, slow: "Use your native shell command tool to run sleep 8 followed by cat marker.txt. Return its exact trimmed content as marker. Do not modify files, spawn agents, install anything, or use external services." }, limits: { maxCalls: 2, maxReadWorkers: 2, timeoutMs: 120000 } });
      await engine.start({ id: draft.id, revision: draft.revision });
      const deadline = Date.now() + 90000;
      let current: WorkflowRun | undefined;
      while (Date.now() < deadline) {
        current = await engine.get(draft.id);
        if (current.tasks[0]?.currentActivity?.kind === "command" && current.tasks[0].currentActivity.status === "running") break;
        if (["completed", "failed"].includes(current.execution)) throw new Error("Cancellation target finished before the active native command was observed.");
        await delay(100);
      }
      assert.equal(current?.tasks[0]?.currentActivity?.kind, "command");
      await engine.cancelTask(draft.id, current!.tasks[0].id);
      const completed = await engine.wait(draft.id);
      assert.equal(completed.execution, "completed", completed.error);
      assert.deepEqual(completed.result, [null, { marker: markerA }]);
      assert.equal(completed.tasks[0].status, "failed"); assert.equal(completed.tasks[1].status, "completed");
      return { realNativeCommandInterrupted: true, parallelFailedItemNull: true, survivingWorkerCompleted: true, failedNodeVisible: true };
    });

    let writeRun: WorkflowRun | undefined;
    await test("isolated-write-review-and-apply", async () => {
      const original = await readFile(path.join(projectA, "sum.mjs"), "utf8");
      const testOriginal = await readFile(path.join(projectA, "sum.test.mjs"), "utf8");
      const schema = { type: "object", properties: { testPassed: { type: "boolean" } }, required: ["testPassed"], additionalProperties: false };
      writeRun = await run("isolated-write", `${meta("isolated-write")} return await agent(args.prompt,{...args.settings,mode:"write",schema:args.schema});`, { allowWrite: true, args: { settings, schema, prompt: "Fix only sum.mjs so add is correct. Read the file, edit only sum.mjs, then run node sum.test.mjs using native command/file tools. Return actual testPassed. Do not edit tests, commit, install software, spawn agents, or use external services." } });
      assert.deepEqual(writeRun.result, { testPassed: true });
      assert.equal(await readFile(path.join(projectA, "sum.mjs"), "utf8"), original);
      assert.equal(await readFile(path.join(projectA, "sum.test.mjs"), "utf8"), testOriginal);
      assert.deepEqual(writeRun.diff?.files, [{ path: "sum.mjs", status: "modified" }]);
      await execute(process.execPath, ["sum.test.mjs"], { cwd: writeRun.workspacePath });
      const applied = await engine.apply(writeRun.id, writeRun.revision);
      assert.equal(applied.application, "applied");
      await execute(process.execPath, ["sum.test.mjs"], { cwd: projectA });
      return { originalUnchangedBeforeApply: true, reviewedFiles: writeRun.diff?.files, independentTestsPassed: true, application: applied.application };
    });

    await test("apply-conflict-retains-project-edit", async () => {
      const schema = { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false };
      const complete = await run("apply-conflict", `${meta("apply-conflict")} return await agent(args.prompt,{...args.settings,mode:"write",schema:args.schema});`, { allowWrite: true, args: { settings, schema, prompt: "Using native file tools, create conflict.txt with exactly WORKFLOW followed by a newline. Do not modify any other files, commit, install software, spawn agents or use external services. Return changed:true after reading back the actual file." } });
      await writeFile(path.join(projectA, "conflict.txt"), "USER EDIT\n");
      const applied = await engine.apply(complete.id, complete.revision);
      assert.equal(applied.application, "conflict");
      assert.equal(await readFile(path.join(projectA, "conflict.txt"), "utf8"), "USER EDIT\n");
      return { application: applied.application, conflicts: applied.diff?.conflicts, userEditRetained: true };
    });

    await test("stop-resume-disk-and-cached-worker", async () => {
      const script = `${meta("stop-resume")} const report=await agent(args.prompt,{...args.settings,schema:args.schema});await operation("wait");return report;`;
      const draft = await engine.preview({ projectPath: projectB, script, allowWrite: true, workspaceMode: "git-worktree", args: { settings, prompt: readPrompt, schema: markerSchema }, limits: { maxCalls: 3, timeoutMs: 120000 }, maintenance: { steps: [{ id: "wait", command: [process.execPath, "-e", "setTimeout(()=>console.log('done'),4000)"], idempotent: true }] } });
      await engine.start({ id: draft.id, revision: draft.revision });
      const deadline = Date.now() + 120000;
      let running: WorkflowRun | undefined;
      while (Date.now() < deadline) { running = await engine.get(draft.id); if (running.tasks[1]?.status === "running") break; if (running.execution === "failed") throw new Error(running.error); await delay(100); }
      assert.equal(running?.tasks[1]?.status, "running");
      const stopped = await engine.stop(draft.id);
      assert.equal(stopped.execution, "stopped"); assert.equal(stopped.tasks[0].status, "completed"); assert.equal(stopped.tasks[1].status, "interrupted");
      const originalAdapter = adapter;
      await engine.close();
      adapter = new ObservedRealAdapter();
      engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
      try {
        const retained = await engine.get(draft.id);
        assert.equal(retained.execution, "stopped"); assert.equal(adapter.calls, 0);
        await engine.start({ id: retained.id, revision: retained.revision }, true);
        const resumed = await engine.wait(retained.id);
        assert.equal(resumed.execution, "completed", resumed.error); assert.equal(resumed.tasks[0].cached, true);
        assert.equal(adapter.calls, 0); assert.equal(resumed.tasks[1].attempts.length, 2); assert.deepEqual(resumed.result, { marker: markerB });
        return { stoppedAfterWorkerExit: true, diskRetained: true, cachedWorker: true, resumedOperationAttempts: 2, automaticWorkersAfterReopen: 0 };
      } finally {
        // Retain real call accounting after replacing the closed adapter, including failures.
        adapter.calls += originalAdapter.calls; adapter.commands += originalAdapter.commands; adapter.requests.unshift(...originalAdapter.requests);
      }
    });

    await test("definition-reuse-independent-projects", async () => {
      const templateStore = new TemplateStore(engine.store);
      const script = `${meta("reusable-marker")} return await agent(args.prompt,{...args.settings,schema:args.schema});`;
      const template = await templateStore.save({ script, args: { prompt: readPrompt, settings, schema: markerSchema }, limits: { maxCalls: 1, timeoutMs: 120000 } });
      assert.equal((await templateStore.list()).length, 1); assert.ok(!Object.hasOwn(template, "projectPath"));
      const runs = [];
      for (const projectPath of [projectA, projectB]) runs.push(await run("reuse", template.script, { projectPath, args: template.args, sourceDefinition: { id: template.id, revision: template.revision }, limits: template.limits }));
      assert.deepEqual(runs.map(value => value.result), [{ marker: markerA }, { marker: markerB }]);
      assert.notEqual(runs[0].id, runs[1].id); assert.notEqual(runs[0].projectPath, runs[1].projectPath);
      return { definitionHasNoProject: true, independentRuns: true, actualProjectMarkers: true, definitionSourceRetained: runs.every(value => value.sourceDefinition?.id === template.id) };
    });

    await test("actual-process-crash-recovery", async () => {
      child = spawn(process.execPath, ["--experimental-strip-types", import.meta.filename, "--crash-child", root], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      // Do not copy child diagnostics or fixture contents into the report.
      child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
      const deadline = Date.now() + 45000;
      let id = ""; let current: WorkflowRun | undefined;
      while (Date.now() < deadline) {
        try { id = (await readFile(path.join(root, "crash-id.txt"), "utf8")).trim(); current = JSON.parse(await readFile(path.join(root, "crash-state", id, "run.json"), "utf8")); } catch {}
        if (current?.tasks[1]?.status === "running" && current.tasks[1].currentActivity?.kind === "command") break;
        if (child.exitCode !== null) throw new Error(`Crash child exited before the active checkpoint: ${child.exitCode}`);
        await delay(100);
      }
      assert.equal(current?.tasks[0]?.status, "completed"); assert.equal(current?.tasks[1]?.status, "running");
      assert.equal(current?.tasks[1]?.currentActivity?.kind, "command");
      adapter.commands += current!.tasks.filter(task => task.options.operation).reduce((count, task) => count + task.attempts.length, 0);
      const processTree = (await execute("ps", ["-Ao", "pid=,ppid=,pgid="])).stdout.split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isInteger));
      const owned = new Set([child.pid!]);
      for (let changed = true; changed;) { changed = false; for (const [pid, ppid] of processTree) if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true; } }
      const descendants = processTree.filter(([pid]) => pid !== child!.pid && owned.has(pid));
      assert.ok(descendants.length, "The real command app-server must be present before crash injection.");
      child.kill("SIGKILL");
      for (const [pid, , pgid] of descendants) { try { process.kill(pid === pgid ? -pgid : pid, "SIGKILL"); } catch {} }
      await delay(6500); // Let the dead owner's existing lock become stale.
      const restoredAdapter = new ObservedRealAdapter();
      const restored = new WorkflowEngine({ store: new RunStore(path.join(root, "crash-state")), adapter: restoredAdapter });
      try {
        const recovered = await restored.get(id); assert.equal(recovered.execution, "stopped"); assert.equal(restoredAdapter.calls, 0); assert.equal(restoredAdapter.commands, 0);
        assert.equal(recovered.tasks[1].status, "interrupted");
        await restored.start({ id, revision: recovered.revision }, true);
        const completed = await restored.wait(id); assert.equal(completed.execution, "completed", completed.error); assert.equal(completed.result, "recovered"); assert.equal(completed.tasks[0].cached, true); assert.equal(completed.tasks[1].attempts.length, 2);
        adapter.commands += restoredAdapter.commands;
        return { actualSIGKILL: true, recoveredStopped: true, noAutomaticExecution: true, cachedCompletedOperation: true, interruptedAttempts: 2, resumed: true };
      } finally { await restored.close(); }
    });
  } finally {
    await engine.close().catch(error => console.error(JSON.stringify({ event: "close-error", error: safeError(error) })));
    child?.kill("SIGKILL");
    await checkpoint();
    const report = { event: "matrix-final", model, effort, passed: summaries.filter(value => value.status === "passed").length, failed: summaries.filter(value => value.status === "failed").length, realWorkerCalls: adapter.calls, realCommands: adapter.commands, reportPath, fixtureRoot: root };
    console.log(JSON.stringify(report));
    if (summaries.some(value => value.status === "failed")) process.exitCode = 1;
    if (process.argv.includes("--cleanup") && !reportPath.startsWith(`${root}${path.sep}`)) await rm(root, { recursive: true, force: true });
  }
}

const crashIndex = process.argv.indexOf("--crash-child");
if (crashIndex !== -1) await crashChild(process.argv[crashIndex + 1]);
else main().catch(error => { console.error(JSON.stringify({ event: "fatal", model, effort, error: safeError(error) })); process.exitCode = 1; });
