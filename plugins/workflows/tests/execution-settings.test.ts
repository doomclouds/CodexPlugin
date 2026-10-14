import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { ExecutionSettingsStore, parseExecutionEnvironment } from "../src/execution-settings.ts";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest } from "../src/adapter.ts";

const environment: ExecutionEnvironment = {
  defaults: { model: "model-a", reasoningEffort: "medium" },
  models: [
    { id: "model-a", displayName: "A", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    { id: "model-b", displayName: "B", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" },
    { id: "model-c", displayName: "C", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
  ],
};
// Test boundary only: no Codex/model calls. Catalogue and observed configuration
// are supplied explicitly to test settings ownership and dispatch semantics.
class SettingsAdapter implements WorkerAdapter {
  requests: WorkerRequest[] = [];
  environmentReads = 0;
  environment = structuredClone(environment);
  async executionEnvironment() { this.environmentReads++; return structuredClone(this.environment); }
  async run(request: WorkerRequest, _signal: AbortSignal, onEvent: (event: WorkerEvent) => void) {
    this.requests.push(request);
    const settings = { model: request.model!, reasoningEffort: request.reasoningEffort!, source: request.settingsSource!, provenance: "configured" as const };
    onEvent({ type: "execution-settings", settings });
    return { output: request.prompt, executionSettings: settings, threadId: "fake-thread", turnId: "fake-turn", durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async close() {}
}
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-execution-settings-"));
  const projectPath = path.join(root, "project"); await mkdir(projectPath);
  const store = new RunStore(path.join(root, "data"));
  const adapter = new SettingsAdapter();
  const engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { engine, store, adapter, projectPath };
}
const script = 'export const meta={name:"model-settings",description:"Model settings workflow",phases:[{title:"Review"},{title:"Summary"}]}; phase("Review"); await agent("first",{model:"model-a",reasoningEffort:"medium"}); await agent("second",{model:"model-a",reasoningEffort:"low"}); phase("Summary"); await agent("third",{model:"model-a",reasoningEffort:"low"}); return await agent("fourth");';

test("Workflows defaults use own CAS storage and clearing falls back to Codex config", async t => {
  const { engine, store, adapter, projectPath } = await setup(t);
  const initial = await engine.getExecutionSettings(projectPath);
  assert.deepEqual(initial.settings, { revision: 0 });
  assert.equal(initial.source, "codex-config");
  assert.equal(initial.mainAgentContextAvailable, false);
  assert.deepEqual(initial.effectiveDefaults, { model: "model-a", reasoningEffort: "medium", source: "codex-config" });
  const saved = await engine.updateExecutionSettings({ revision: 0, model: "model-c", reasoningEffort: "low", projectPath });
  assert.equal(saved.source, "workflow-settings");
  assert.equal(saved.settings.revision, 1);
  await assert.rejects(engine.updateExecutionSettings({ revision: 0, model: "model-a", projectPath }), /changed/);
  await assert.rejects(engine.updateExecutionSettings({ revision: 1, model: "model-b", projectPath }), /unsupported/);
  await assert.rejects(engine.updateExecutionSettings({ revision: 1, model: "invented", reasoningEffort: "high", projectPath }), /unavailable/);
  const cleared = await engine.updateExecutionSettings({ revision: 1, projectPath });
  assert.deepEqual(cleared.settings, { revision: 2 });
  assert.equal(cleared.source, "codex-config");
  assert.deepEqual(JSON.parse(await readFile(path.join(store.root, "settings.json"), "utf8")), { revision: 2 });
  assert.equal(adapter.requests.length, 0);
  const stores = [new ExecutionSettingsStore(store), new ExecutionSettingsStore(store)];
  const updates = await Promise.allSettled(stores.map(item => item.update({ revision: 2, model: "model-a" })));
  assert.equal(updates.filter(item => item.status === "fulfilled").length, 1);
});

test("node overrides follow declared precedence and first-start defaults remain stable", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  await engine.updateExecutionSettings({ revision: 0, model: "model-a", reasoningEffort: "medium", projectPath });
  const nodeSettings = { "phase:Review": { model: "model-b", reasoningEffort: "high" }, "task:0": { model: "model-c", reasoningEffort: "low" } };
  const draft = await engine.preview({ projectPath, script, nodeSettings });
  assert.equal(draft.executionSettings, undefined);
  assert.equal(adapter.requests.length, 0);
  await engine.start({ id: draft.id, revision: draft.revision });
  const done = await engine.wait(draft.id);
  assert.equal(done.execution, "completed", done.error);
  assert.deepEqual(adapter.requests.map(request => [request.model, request.reasoningEffort, request.settingsSource]), [["model-c", "low", "task"], ["model-b", "high", "phase"], ["model-a", "low", "script"], ["model-a", "medium", "workflow-settings"]]);
  assert.deepEqual(done.executionSettings, { model: "model-a", reasoningEffort: "medium", source: "workflow-settings", provenance: "requested" });
  assert.equal(done.tasks[0]?.executionSettings?.provenance, "configured");
  assert.deepEqual(done.tasks[0]?.attempts[0]?.executionSettings, done.tasks[0]?.executionSettings);
  await engine.updateExecutionSettings({ revision: 1, model: "model-c", reasoningEffort: "low", projectPath });
  const updated = await engine.update({ id: done.id, revision: done.revision, script: script.replace("Model settings workflow", "Changed workflow goal"), args: {}, nodeSettings });
  await engine.start({ id: done.id, revision: updated.revision });
  const rerun = await engine.wait(done.id);
  assert.deepEqual(rerun.executionSettings, done.executionSettings);
  assert.equal(adapter.requests.at(-1)?.model, "model-a");
  assert.equal(adapter.requests.at(-1)?.reasoningEffort, "medium");
});

test("arithmetic workflows never need a catalogue and aliased agents still validate before execution", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  const arithmetic = await engine.preview({ projectPath, script: 'export const meta={name:"arithmetic-only",description:"No model dependency"}; return args.value + 1;', args: { value: 6 } });
  await engine.start({ id: arithmetic.id, revision: arithmetic.revision });
  assert.equal((await engine.wait(arithmetic.id)).result, 7);
  assert.equal(adapter.environmentReads, 0);
  assert.equal(adapter.requests.length, 0);
  const aliased = await engine.preview({ projectPath, script: 'export const meta={name:"aliased-agent",description:"Owned capability check"}; const inspect=agent; return await inspect("read");' });
  await engine.start({ id: aliased.id, revision: aliased.revision });
  assert.equal((await engine.wait(aliased.id)).execution, "completed");
  assert.equal(adapter.environmentReads, 1);
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0]?.model, "model-a");
});

test("legacy adapters cannot silently ignore node choices added after an empty first-start snapshot", async t => {
  const { store, projectPath } = await setup(t);
  let calls = 0;
  const adapter: WorkerAdapter = { async run() { calls++; throw new Error("No worker should be invoked"); }, async close() {} };
  const engine = new WorkflowEngine({ store, adapter });
  t.after(() => engine.close());
  const source = 'export const meta={name:"legacy-node",description:"Optional node settings",phases:[{title:"Review"}]}; return 1;';
  const draft = await engine.preview({ projectPath, script: source });
  await engine.start({ id: draft.id, revision: draft.revision });
  const done = await engine.wait(draft.id);
  assert.deepEqual(done.executionSettings, {});
  const updated = await engine.update({ id: done.id, revision: done.revision, script: source, args: {}, nodeSettings: { "phase:Review": { model: "model-a" } } });
  await assert.rejects(engine.start({ id: done.id, revision: updated.revision }), /cannot validate configured/);
  assert.equal(calls, 0);
});

test("node key/type errors and incompatible model-only overrides never dispatch workers", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  for (const key of ["phase:Unknown", "task:-1", "task:01", "task:1000", "constructor"]) await assert.rejects(engine.preview({ projectPath, script, nodeSettings: { [key]: { model: "model-a" } } }), /Unknown workflow node/);
  const draft = await engine.preview({ projectPath, script: 'export const meta={name:"invalid-model",description:"Mismatch",phases:[{title:"Review"}]}; return await agent("inspect",{phase:"Review"});', nodeSettings: { "phase:Review": { model: "model-b" } } });
  await engine.start({ id: draft.id, revision: draft.revision });
  const done = await engine.wait(draft.id);
  assert.equal(done.execution, "failed");
  assert.match(done.error ?? "", /unsupported/);
  assert.equal(adapter.requests.length, 0);
});

test("valid catalogue survives invalid CLI defaults so own settings can repair execution", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  const catalogue = environment.models.map(model => ({ ...model, model: model.id, isDefault: model.id === "model-a", supportedReasoningEfforts: model.supportedReasoningEfforts.map(reasoningEffort => ({ reasoningEffort })) }));
  adapter.environment = parseExecutionEnvironment({ model: "removed-model", model_reasoning_effort: "unsupported-global-effort" }, catalogue);
  const unavailable = await engine.getExecutionSettings(projectPath);
  assert.equal(unavailable.models.length, 3);
  assert.equal(unavailable.defaultsStatus.available, false);
  assert.match(unavailable.defaultsStatus.reason ?? "", /unavailable/);
  assert.equal(unavailable.effectiveDefaults, undefined);
  assert.deepEqual(unavailable.codexDefaults, { model: "removed-model", reasoningEffort: "unsupported-global-effort" });
  const saved = await engine.updateExecutionSettings({ revision: 0, model: "model-a", reasoningEffort: "low", projectPath });
  assert.equal(saved.defaultsStatus.available, true);
  assert.deepEqual(saved.effectiveDefaults, { model: "model-a", reasoningEffort: "low", source: "workflow-settings" });
  const draft = await engine.preview({ projectPath, script: 'export const meta={name:"repair-defaults",description:"Own defaults repair"}; return await agent("inspect");' });
  await engine.start({ id: draft.id, revision: draft.revision });
  assert.equal((await engine.wait(draft.id)).execution, "completed");
  assert.equal(adapter.requests[0]?.model, "model-a");
  assert.equal(adapter.requests[0]?.reasoningEffort, "low");
  const cleared = await engine.updateExecutionSettings({ revision: 1, projectPath });
  assert.equal(cleared.defaultsStatus.available, false);
  assert.equal(cleared.settings.revision, 2);
});

test("known invalid node selections fail before any declared operation or workspace allocation", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  let commands = 0;
  (adapter as SettingsAdapter & WorkerAdapter).command = async () => { commands++; return { exitCode: 0, stdout: "changed", stderr: "", attempts: 1 }; };
  const source = 'export const meta={name:"preflight-node",description:"Before side effects",phases:[{title:"Review"}]}; await operation("change"); return await agent("inspect",{phase:"Review"});';
  for (const settings of [{ model: "invented", reasoningEffort: "high" }, { model: "model-b", reasoningEffort: "low" }]) {
    const draft = await engine.preview({ projectPath, script: source, allowWrite: true, workspaceMode: "git-worktree", maintenance: { steps: [{ id: "change", command: ["fixture-change"] }] }, nodeSettings: { "phase:Review": settings } });
    await engine.start({ id: draft.id, revision: draft.revision });
    const failed = await engine.wait(draft.id);
    assert.equal(failed.execution, "failed");
    assert.match(failed.error ?? "", /unavailable|unsupported/);
    assert.equal((await engine.get(draft.id)).workspace, undefined);
  }
  assert.equal(commands, 0);
  assert.equal(adapter.requests.length, 0);
});

test("saved templates retain node choices and changing them invalidates cached tasks", async t => {
  const { engine, adapter, store, projectPath } = await setup(t);
  const templates = new TemplateStore(store);
  const source = 'export const meta={name:"saved-model",description:"Reusable model choice",phases:[{title:"Review"}]}; return await agent("inspect",{phase:"Review"});';
  const definition = await templates.save({ script: source, nodeSettings: { "phase:Review": { model: "model-a", reasoningEffort: "low" } } });
  assert.deepEqual((await templates.get(definition.id))?.nodeSettings, definition.nodeSettings);
  const draft = await engine.preview({ projectPath, script: definition.script, nodeSettings: definition.nodeSettings });
  await engine.start({ id: draft.id, revision: draft.revision });
  const done = await engine.wait(draft.id);
  const updated = await engine.update({ id: done.id, revision: done.revision, script: source, args: {}, nodeSettings: { "phase:Review": { model: "model-a", reasoningEffort: "high" } } });
  await engine.start({ id: done.id, revision: updated.revision });
  const final = await engine.wait(done.id);
  assert.equal(final.execution, "completed", final.error);
  assert.equal(adapter.requests.length, 2);
  assert.equal(final.tasks[0]?.cached, false);
  assert.equal(final.tasks[0]?.executionSettings?.reasoningEffort, "high");
});

test("an unchanged observed target accepts its bound task override across a fresh template preview", async t => {
  const { engine, adapter, store, projectPath } = await setup(t);
  const source = 'export const meta={name:"bound-target",description:"Observed target binding"}; return await agent("Inspect " + args.file,{label:"File review"});';
  const args = { file: "alpha.ts" };
  const initial = await engine.preview({ projectPath, script: source, args });
  await engine.start({ id: initial.id, revision: initial.revision });
  const observed = await engine.wait(initial.id);
  const identity = observed.tasks[0]?.configurationTarget;
  assert.match(identity ?? "", /^[a-f0-9]{64}$/);
  const nodeSettings = { "task:0": { model: "model-c", reasoningEffort: "low", identity } };
  const templates = new TemplateStore(store);
  const saved = await templates.save({ script: source, args, nodeSettings });
  assert.equal((await templates.get(saved.id))?.nodeSettings?.["task:0"]?.identity, identity);
  const draft = await engine.preview({ projectPath, script: saved.script, args: saved.args, nodeSettings: saved.nodeSettings });
  await engine.start({ id: draft.id, revision: draft.revision });
  const result = await engine.wait(draft.id);
  assert.equal(result.execution, "completed", result.error);
  assert.equal(result.tasks[0]?.configurationTarget, identity);
  assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[1]?.model, "model-c");
  assert.equal(adapter.requests[1]?.reasoningEffort, "low");
  assert.equal(result.tasks[0]?.executionSettings?.source, "task");
});

test("reordered input rejects a bound task choice before the different target's worker starts", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  const source = 'export const meta={name:"bound-reorder",description:"Observed target binding"}; for (const file of args.files) await agent("Inspect " + file,{label:"File review"}); return "done";';
  const initial = await engine.preview({ projectPath, script: source, args: { files: ["alpha.ts", "beta.ts"] } });
  await engine.start({ id: initial.id, revision: initial.revision });
  const observed = await engine.wait(initial.id);
  const identity = observed.tasks[1]?.configurationTarget;
  assert.ok(identity);
  const priorCalls = adapter.requests.length;
  const draft = await engine.preview({ projectPath, script: source, args: { files: ["beta.ts", "alpha.ts"] }, nodeSettings: { "task:1": { model: "model-c", reasoningEffort: "low", identity } } });
  await engine.start({ id: draft.id, revision: draft.revision });
  const result = await engine.wait(draft.id);
  assert.equal(result.execution, "failed");
  assert.match(result.error ?? "", /no longer matches the configured target/);
  assert.equal(result.tasks[1]?.status, "failed");
  assert.notEqual(result.tasks[1]?.configurationTarget, identity);
  const newCalls = adapter.requests.slice(priorCalls);
  assert.equal(newCalls.length, 1);
  assert.match(newCalls[0]?.prompt ?? "", /Inspect beta\.ts/);
  assert.equal(newCalls[0]?.model, "model-a");
  assert.equal(newCalls.some(request => request.model === "model-c" || /Inspect alpha\.ts/.test(request.prompt)), false);
});

test("an observed agent position changed to an operation rejects model choices before command execution", async t => {
  const { engine, adapter, projectPath } = await setup(t);
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: projectPath });
  await exec("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Operation position fixture"], { cwd: projectPath });
  const source = 'export const meta={name:"agent-to-operation",description:"Node kind binding",phases:[{title:"Review"}]}; if (args.command) return await operation("step"); return await agent("Inspect",{phase:"Review"});';
  const initial = await engine.preview({ projectPath, script: source, args: { command: false } });
  await engine.start({ id: initial.id, revision: initial.revision });
  const observed = await engine.wait(initial.id);
  const identity = observed.tasks[0]?.configurationTarget;
  assert.ok(identity);
  let commands = 0;
  (adapter as SettingsAdapter & WorkerAdapter).command = async () => { commands++; return { exitCode: 0, stdout: "command confirmed", stderr: "", attempts: 1 }; };
  const input = { projectPath, script: source, args: { command: true }, allowWrite: true, workspaceMode: "git-worktree" as const, maintenance: { steps: [{ id: "step", command: ["fixture-command"] }] } };
  const bound = await engine.preview({ ...input, nodeSettings: { "task:0": { model: "model-c", reasoningEffort: "low", identity } } });
  await engine.start({ id: bound.id, revision: bound.revision });
  const refused = await engine.wait(bound.id);
  assert.equal(refused.execution, "failed");
  assert.match(refused.error ?? "", /now refers to a command operation/);
  assert.equal((refused.tasks[0]?.options.operation as { id: string }).id, "step");
  assert.equal(refused.tasks[0]?.mode, "write");
  assert.equal(commands, 0);
  assert.equal(adapter.requests.length, 1);
  const unconfigured = await engine.preview(input);
  await engine.start({ id: unconfigured.id, revision: unconfigured.revision });
  const completed = await engine.wait(unconfigured.id);
  assert.equal(completed.execution, "completed", completed.error);
  assert.equal(commands, 1);
  assert.equal(adapter.requests.length, 1);
});
