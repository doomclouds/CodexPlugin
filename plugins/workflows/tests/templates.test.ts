import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "../src/adapter.ts";

const execute = promisify(execFile);
const script = (name: string, body = "return args;", description = "Saved definition test") => `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} };\n${body}`;

// Test-only adapter. It counts execution requests and does not invoke Codex or a model.
class CountingTestAdapter implements WorkerAdapter {
  calls: Array<{ id: string; cwd: string; prompt: string }> = [];
  async run(request: WorkerRequest, _signal: AbortSignal, _onEvent: (event: WorkerEvent) => void): Promise<WorkerResult> {
    this.calls.push({ id: request.id, cwd: request.cwd, prompt: request.prompt });
    return { output: `fresh:${path.basename(request.cwd)}:${this.calls.length}`, threadId: `test-${this.calls.length}`, turnId: `turn-${this.calls.length}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  }
  async close() {}
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-template-test-"));
  const store = new RunStore(path.join(root, "state"));
  const templates = new TemplateStore(store);
  const engines: WorkflowEngine[] = [];
  t.after(async () => { for (const engine of engines) await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, templates, engines };
}

test("saved definitions require the current revision before overwriting", async t => {
  const { templates } = await fixture(t);
  const initial = await templates.save({ script: script("reusable"), args: [null, "initial"], allowWrite: true });
  assert.equal(initial.id, "saved:reusable");
  assert.equal(initial.revision, 1);
  await assert.rejects(templates.save({ script: script("reusable", "return 2;") }), /already exists or changed/);
  await assert.rejects(templates.save({ script: script("reusable", "return 2;"), revision: 0 }), /already exists or changed/);
  assert.deepEqual(await templates.get(initial.id), initial);

  const updated = await templates.save({ script: script("reusable", "return args;", "Updated saved definition"), args: { version: 2 }, allowWrite: false, revision: initial.revision, limits: { maxReadWorkers: 2 } });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.args, { version: 2 });
  assert.equal(updated.allowWrite, false);
  assert.deepEqual(updated.limits, { maxReadWorkers: 2 });
  await assert.rejects(templates.save({ script: initial.script, revision: initial.revision }), /already exists or changed/);
  assert.deepEqual(await templates.get(initial.id), updated);
  assert.deepEqual(await templates.list(), [updated]);
  await assert.rejects(templates.save({ script: script("missing"), revision: 1 }), /no longer exists/);
});

test("concurrent saved-definition updates cannot both overwrite one revision", async t => {
  const { templates } = await fixture(t);
  const initial = await templates.save({ script: script("concurrent"), args: { value: 0 } });
  const results = await Promise.allSettled([
    templates.save({ script: initial.script, revision: initial.revision, args: { value: 1 } }),
    templates.save({ script: initial.script, revision: initial.revision, args: { value: 2 } }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const retained = await templates.get(initial.id);
  assert.equal(retained?.revision, 2);
  assert.ok([1, 2].includes((retained?.args as { value: number }).value));
});

test("saved definition IDs and metadata reject paths outside the template directory", async t => {
  const { root, templates } = await fixture(t);
  await writeFile(path.join(root, "outside.json"), "retained sentinel\n");
  for (const id of ["saved:../outside", "saved:/absolute", "saved:hello/../../outside", "saved:hello\\outside", "saved:hello\0outside", "builtin:hello", "saved:UPPERCASE", "saved:.git"]) {
    await assert.rejects(templates.get(id), /Invalid saved workflow ID/);
  }
  for (const name of ["../outside", "/absolute", "hello/world", "hello\\world"]) {
    await assert.rejects(templates.save({ script: script(name) }), /meta.name/);
  }
  assert.equal(await templates.get("saved:does-not-exist"), undefined);
  assert.equal(await readFile(path.join(root, "outside.json"), "utf8"), "retained sentinel\n");
});

test("saved definitions and previews preserve every JSON input shape", async t => {
  const { root, store, templates, engines } = await fixture(t);
  const project = path.join(root, "project");
  await mkdir(project);
  const adapter = new CountingTestAdapter();
  const engine = new WorkflowEngine({ store, adapter });
  engines.push(engine);
  const inputs = [null, true, false, 0, -7, 0.125, "literal input", [null, false, { nested: [1, "two"] }], { value: null, values: [0, true, { leaf: "kept" }] }];
  for (const [index, args] of inputs.entries()) {
    const saved = await templates.save({ script: script(`json-input-${index}`), args });
    assert.deepEqual((await templates.get(saved.id))?.args, args);
    const preview = await engine.preview({ projectPath: project, script: saved.script, args: saved.args });
    assert.deepEqual(preview.args, args);
    assert.deepEqual((await engine.get(preview.id)).args, args);
    await engine.start({ id: preview.id, revision: preview.revision });
    const complete = await engine.wait(preview.id);
    assert.equal(complete.execution, "completed", complete.error);
    assert.deepEqual(complete.result, args);
  }
  assert.equal(adapter.calls.length, 0);
});

test("one saved definition previews independent project runs without sharing caches", async t => {
  const { root, store, templates, engines } = await fixture(t);
  const adapter = new CountingTestAdapter();
  const engine = new WorkflowEngine({ store, adapter });
  engines.push(engine);
  const projects = [path.join(root, "project-one"), path.join(root, "project-two")];
  for (const [index, project] of projects.entries()) {
    await mkdir(project);
    await execute("git", ["init", "--quiet"], { cwd: project });
    await writeFile(path.join(project, "source.txt"), `project fixture ${index}\n`);
    await execute("git", ["add", "--", "source.txt"], { cwd: project });
  }
  const definition = await templates.save({ script: script("cross-project", "return await agent(args.prompt);"), args: { prompt: "Inspect the same definition in this project" } });
  const runs = [];
  for (const projectPath of projects) {
    const saved = (await templates.get(definition.id))!;
    const run = await engine.preview({ projectPath, script: saved.script, args: saved.args, allowWrite: saved.allowWrite });
    assert.equal(run.script, definition.script);
    assert.equal(run.execution, "draft");
    assert.deepEqual(run.tasks, []);
    await engine.start({ id: run.id, revision: run.revision });
    runs.push(await engine.wait(run.id));
  }
  const [first, second] = runs;
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.equal(first.scriptDigest, second.scriptDigest);
  assert.notEqual(first.projectPath, second.projectPath);
  assert.notEqual(first.contextDigest, second.contextDigest);
  assert.equal(first.execution, "completed", first.error);
  assert.equal(second.execution, "completed", second.error);
  assert.equal(first.tasks[0]?.cached, false);
  assert.equal(second.tasks[0]?.cached, false);
  assert.notEqual(first.result, second.result);
  assert.equal(adapter.calls.length, 2);
  assert.equal((await engine.list(projects[0])).length, 1);
  assert.equal((await engine.list(projects[1])).length, 1);

  const updated = await engine.update({ id: first.id, revision: first.revision, script: first.script, args: first.args });
  await engine.start({ id: first.id, revision: updated.revision });
  const replayed = await engine.wait(first.id);
  assert.equal(replayed.tasks[0]?.cached, true);
  assert.equal(replayed.result, first.result);
  assert.equal(adapter.calls.length, 2);
  assert.deepEqual(await templates.get(definition.id), definition);
});
