import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkflowEngine } from "../src/engine.ts";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerAdapter, WorkerRequest, CommandRequest } from "../src/adapter.ts";
import type { WorkflowDefinition } from "../src/definition.ts";

async function context(adapter: WorkerAdapter) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-driver-"))), project = path.join(root, "project");
  await mkdir(project); await writeFile(path.join(project, "input.txt"), "fixture");
  const engine = new WorkflowEngine({ root: path.join(root, "state"), adapter });
  return { root, project, engine, cleanup: async () => { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}
const definition = (steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({ schemaVersion: 1, name: "driver-test", description: "Native driver boundary test", steps });
function stub() {
  const commands: CommandRequest[] = [], workers: WorkerRequest[] = [];
  const adapter: WorkerAdapter = {
    async command(request) { commands.push(request); return { exitCode: 0, stdout: "fixture", stderr: "", attempts: 1 }; },
    async run(request) { workers.push(request); return { output: "done", threadId: "thread", turnId: "turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 }; },
    async executionEnvironment() { return { defaults: { model: "fixture", reasoningEffort: "max" }, models: [{ id: "fixture", displayName: "Fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] }; },
    async close() {},
  };
  return { adapter, commands, workers };
}
test("read commands use an actually read-only native sandbox and need no model catalogue", async () => {
  const fake = stub(); delete fake.adapter.executionEnvironment; const c = await context(fake.adapter);
  try { const draft = await c.engine.preview({ projectPath: c.project, definition: definition([{ id: "read", type: "command", effect: "read", argv: ["cat", "input.txt"] }]) }); c.engine.start(draft); const run = await c.engine.wait(draft.id); assert.equal(run.status, "completed", run.error); assert.equal(fake.commands[0]?.readOnly, true); assert.equal(fake.workers.length, 0); assert.equal(run.workspace, undefined); }
  finally { await c.cleanup(); }
});
test("local mode preserves a prepared workspace and frozen model defaults across resume", async () => {
  const fake = stub(), c = await context(fake.adapter);
  try {
    const draft = await c.engine.preview({ projectPath: c.project, grants: { allowWrite: true, workspaceMode: "local" }, definition: definition([{ id: "first", type: "agent", task: "read fixture", mode: "read" }, { id: "wait", type: "wait", message: "Continue?" }, { id: "last", type: "agent", task: "read fixture", mode: "read" }]) });
    c.engine.start(draft); let run = await c.engine.wait(draft.id); assert.equal(run.status, "waiting", run.error); const baseline = run.workspace?.baselineRoot;
    run = c.engine.resolveWait({ id: run.id, revision: run.revision, instanceId: run.instances.find(instance => instance.type === "wait")!.id, value: true });
    const preview = await c.engine.recoveryPreview(run); await c.engine.resume({ ...run, recoveryFingerprint: preview.fingerprint }); run = await c.engine.wait(run.id);
    assert.equal(run.status, "completed", run.error); assert.equal(run.workspace?.baselineRoot, baseline); assert.equal(fake.workers.length, 2); assert.equal(fake.workers[1]?.model, "fixture");
  } finally { await c.cleanup(); }
});
test("inline subflows inherit real native model settings without a legacy resolver", async () => {
  const fake = stub(), c = await context(fake.adapter);
  try { const draft = await c.engine.preview({ projectPath: c.project, definition: definition([{ id: "child", type: "subflow", definition: definition([{ id: "read", type: "agent", task: "read fixture" }]) }]) }); c.engine.start(draft); const run = await c.engine.wait(draft.id); assert.equal(run.status, "completed", run.error); assert.equal(run.executionSettings?.model, "fixture"); assert.equal(fake.workers.length, 1); }
  finally { await c.cleanup(); }
});
test("changed project content blocks checkpoint reuse while preserving current files", async () => {
  const c = await context(stub().adapter);
  try { const draft = await c.engine.preview({ projectPath: c.project, definition: definition([{ id: "wait", type: "wait", message: "Continue?" }]) }); c.engine.start(draft); let run = await c.engine.wait(draft.id); run = c.engine.resolveWait({ ...run, instanceId: run.instances[0]!.id, value: true }); await writeFile(path.join(c.project, "input.txt"), "new user content"); const preview = await c.engine.recoveryPreview(run); assert.equal(preview.canResume, false); assert.equal(await readFile(path.join(c.project, "input.txt"), "utf8"), "new user content"); }
  finally { await c.cleanup(); }
});
test("real native read and protected local write commands execute the structured flow", { skip: process.env.WORKFLOWS_REAL_NATIVE !== "1", timeout: 120000 }, async () => {
  const adapter = new CodexAdapter({ ...(process.env.CODEX_CLI_PATH ? { command: process.env.CODEX_CLI_PATH } : {}), startupTimeoutMs: 30000 }), c = await context(adapter);
  try {
    execFileSync("git", ["init", "-q"], { cwd: c.project }); await mkdir(path.join(c.project, ".agents", "skills"), { recursive: true });
    const draft = await c.engine.preview({ projectPath: c.project, grants: { allowWrite: true, workspaceMode: "local" }, definition: definition([
      { id: "read", type: "command", effect: "read", argv: [process.execPath, "-e", "process.stdout.write(require('fs').readFileSync('input.txt','utf8'))"] },
      { id: "choose", type: "choice", cases: [{ id: "yes", when: { op: "eq", args: [{ ref: "steps.read.output.stdout" }, "fixture"] }, steps: [{ id: "write", type: "command", effect: "write", protectedPaths: [".agents/skills"], argv: [process.execPath, "-e", "require('fs').writeFileSync('.agents/skills/result.txt','native verified')"] }] }], default: [{ id: "bad", type: "transform", value: "wrong branch" }] },
      { id: "loop", type: "repeat", maxIterations: 3, steps: [{ id: "round", type: "transform", value: { ref: "iteration" } }] },
    ]) });
    c.engine.start(draft); const run = await c.engine.wait(draft.id); assert.equal(run.status, "completed", run.error); assert.equal(await readFile(path.join(c.project, ".agents/skills/result.txt"), "utf8"), "native verified"); assert.equal(run.instances.filter(instance => instance.nodeId === "round").length, 3); assert.equal(run.instances.some(instance => instance.nodeId === "bad"), false);
  } finally { await c.cleanup(); }
});
test("real native dynamic expansion commits a reusable structured child plan", { skip: process.env.WORKFLOWS_REAL_NATIVE !== "1", timeout: 180000 }, async () => {
  const c = await context(new CodexAdapter({ ...(process.env.CODEX_CLI_PATH ? { command: process.env.CODEX_CLI_PATH } : {}) }));
  try {
    await c.engine.updateSettings({ revision: 0, model: "gpt-6-luna", reasoningEffort: "max" }, c.project);
    const draft = await c.engine.preview({ projectPath: c.project, limits: { maxCalls: 2, timeoutMs: 120000 }, definition: definition([{ id: "plan", type: "expand", task: "Create a workflow named generated-arithmetic, description Arithmetic proof, with exactly two sequential transform nodes. First node id first value 3. Second node id second value {op:add,args:[{ref:steps.first.output},4]}. No commands, no agents, no subflows, no other nodes. Return the complete definition encoded as a string in definitionJson." }]) });
    c.engine.start(draft); const run = await c.engine.wait(draft.id); assert.equal(run.status, "completed", run.error);
    const second = run.instances.find(instance => instance.nodeId === "second"); assert.equal(second?.output, 7);
    assert.ok(run.instances.find(instance => instance.type === "expand")?.cursor?.expanded);
    assert.equal(run.instances.flatMap(instance => instance.attempts).length, 1);
  } finally { await c.cleanup(); }
});
