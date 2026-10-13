import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "../src/adapter.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";

const execute = promisify(execFile);

// This wrapper delegates every task to a real Codex process; it does not simulate results.
class ObservedRealAdapter implements WorkerAdapter {
  calls = 0;
  private real = new CodexAdapter();
  async run(request: WorkerRequest, signal: AbortSignal, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    this.calls++;
    return this.real.run(request, signal, onEvent);
  }
  async close() { await this.real.close(); }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "[url]").replace(/((?:token|password|secret|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").slice(0, 600);
}

async function realSmoke() {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-real-engine-"));
  const project = path.join(root, "project");
  const state = path.join(root, "state");
  const source = "export const add = (a, b) => a - b;\n";
  const testSource = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './sum.mjs';\ntest('adds positive and negative values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);assert.equal(add(0,0),0);});\n";
  const adapter = new ObservedRealAdapter();
  let engine: WorkflowEngine | undefined;
  let restoredAdapter: ObservedRealAdapter | undefined;
  try {
    await mkdir(project);
    await execute("git", ["init", "--quiet"], { cwd: project });
    await writeFile(path.join(project, "sum.mjs"), source);
    await writeFile(path.join(project, "sum.test.mjs"), testSource);
    await execute("git", ["add", "--", "sum.mjs", "sum.test.mjs"], { cwd: project });
    let baselineFailed = false;
    try { await execute(process.execPath, ["--test", "sum.test.mjs"], { cwd: project }); }
    catch (error) { baselineFailed = (error as { code?: number }).code === 1; }
    assert.ok(baselineFailed, "The fixture must expose a real failing test before the worker starts.");

    engine = new WorkflowEngine({ store: new RunStore(state), adapter });
    const args = {
      phase: "修复加法并运行测试",
      label: "真实隔离写入验证",
      note: "Manual opt-in integration smoke with a real Codex worker.",
      echo: [null, false, 17, "fixture"],
      task: "Fix the incorrect add function in sum.mjs. Change only sum.mjs. Run the existing node --test sum.test.mjs and return the actual test outcome. Do not modify sum.test.mjs, create commits, install anything, or use external services.",
      schema: { type: "object", properties: { changed: { type: "boolean" }, testPassed: { type: "boolean" }, testCommand: { type: "string" } }, required: ["changed", "testPassed", "testCommand"], additionalProperties: false },
    };
    const script = `export const meta = { name: "real-engine-smoke", description: "真实动态脚本、隔离写入、差异与应用验证", phases: [{ title: "修复加法并运行测试" }] };
phase(args.phase);
log(args.note);
const report = await agent(args.task, { mode: "write", label: args.label, schema: args.schema });
if (!report || !report.testPassed) throw new Error("Real worker did not confirm the requested test.");
return { report, echo: args.echo };
`;
    const preview = await engine.preview({ projectPath: project, script, args, allowWrite: true, limits: { maxCalls: 1, maxReadWorkers: 1, timeoutMs: 240_000 } });
    assert.equal(adapter.calls, 0);
    assert.equal(preview.workspace, undefined);
    // Internal engine invocation is explicitly authorized for this temporary smoke fixture.
    // Product starts still go through the preview and panel lease checks.
    await engine.start({ id: preview.id, revision: preview.revision });
    let complete = await engine.wait(preview.id);
    let capacityRetried = false;
    if (complete.execution === "failed" && /(?:model is at capacity|selected model is at capacity)/i.test(complete.error ?? "")) {
      capacityRetried = true;
      console.error("Default model is at capacity; retrying once with the same model.");
      await engine.start({ id: complete.id, revision: complete.revision }, true);
      complete = await engine.wait(preview.id);
    }
    assert.equal(complete.execution, "completed", complete.error);
    assert.equal(complete.tasks.length, 1);
    assert.equal(complete.tasks[0]?.mode, "write");
    assert.equal(complete.tasks[0]?.phase, args.phase);
    assert.equal(complete.tasks[0]?.label, args.label);
    const result = complete.result as { report: { changed: boolean; testPassed: boolean; testCommand: string }; echo: unknown };
    assert.deepEqual(result.echo, args.echo);
    assert.equal(result.report.testPassed, true);
    assert.equal(result.report.testCommand, "node --test sum.test.mjs");
    assert.ok(capacityRetried || result.report.changed);
    assert.ok(complete.logs.some(log => log.message === args.note));
    assert.equal(await readFile(path.join(project, "sum.mjs"), "utf8"), source);
    assert.equal(await readFile(path.join(project, "sum.test.mjs"), "utf8"), testSource);
    assert.deepEqual(complete.diff?.files, [{ path: "sum.mjs", status: "modified" }]);
    assert.ok(complete.diff?.text.includes("a - b"));
    assert.ok(complete.workspacePath && complete.workspacePath !== project);
    await execute(process.execPath, ["--test", "sum.test.mjs"], { cwd: complete.workspacePath });

    await engine.close();
    restoredAdapter = new ObservedRealAdapter();
    engine = new WorkflowEngine({ store: new RunStore(state), adapter: restoredAdapter });
    const retained = await engine.get(complete.id);
    assert.equal(retained.execution, "completed");
    assert.equal(retained.review, "ready");
    assert.deepEqual(retained.result, complete.result);
    assert.deepEqual(retained.args, args);
    assert.equal(restoredAdapter.calls, 0, "Reopening completed state must not automatically start a worker.");
    // Applying to this disposable fixture is explicitly authorized by the smoke invocation.
    const applied = await engine.apply(retained.id, retained.revision);
    assert.equal(applied.application, "applied", applied.error);
    assert.notEqual(await readFile(path.join(project, "sum.mjs"), "utf8"), source);
    assert.equal(await readFile(path.join(project, "sum.test.mjs"), "utf8"), testSource);
    await execute(process.execPath, ["--test", "sum.test.mjs"], { cwd: project });
    assert.equal(restoredAdapter.calls, 0);
    console.log(JSON.stringify({ test: "real-workflow-engine", success: true, workerCalls: adapter.calls, capacityRetried, baselineFailed, originalUnchangedBeforeApply: true, diffFiles: complete.diff?.files, snapshotTestPassed: true, persistenceRetained: true, noAutomaticWorkers: true, application: applied.application, projectTestPassed: true, usage: complete.tasks[0]?.attempts.at(-1)?.usage }));
  } finally {
    try { if (engine) await engine.close(); else await adapter.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

if (!process.argv.includes("--real-workers")) {
  console.error("手工真实验证会调用已登录 Codex 的默认模型。在插件目录运行 npm run smoke:real。");
  process.exitCode = 2;
} else {
  try { await realSmoke(); }
  catch (error) { console.error(JSON.stringify({ test: "real-workflow-engine", success: false, error: safeError(error) })); process.exitCode = 1; }
}
