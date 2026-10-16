import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../src/engine.ts";
import type { CommandRequest, WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { WorkflowDefinition } from "../src/definition.ts";

const definition = (name: string, steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({ schemaVersion: 1, name, description: "Independent driver review fixture", steps });
async function context(planner?: WorkflowDefinition) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-driver-review-")));
  const project = path.join(root, "project"); await mkdir(project); await writeFile(path.join(project, "fixture.txt"), "unchanged");
  const commands: CommandRequest[] = [], workers: WorkerRequest[] = [];
  const adapter: WorkerAdapter = {
    async executionEnvironment() { return { defaults: { model: "review-fixture", reasoningEffort: "max" }, models: [{ id: "review-fixture", displayName: "Fixture", defaultReasoningEffort: "max", supportedReasoningEfforts: ["max"] }] }; },
    async command(request) { commands.push(request); return { exitCode: 0, stdout: "fixture", stderr: "", attempts: 1 }; },
    async run(request) { workers.push(request); return { output: "fixture", ...(planner ? { data: { definitionJson: JSON.stringify(planner) } } : {}), threadId: "fixture-thread", turnId: "fixture-turn", durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; },
    async close() {},
  };
  const engine = new WorkflowEngine({ root: path.join(root, "state"), adapter });
  return { engine, project, commands, workers, cleanup: async () => { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}

test("dynamic expansion cannot hide an undeclared command inside an inline subflow", async () => {
  const planner = definition("generated", [{ id: "hidden", type: "subflow", definition: definition("nested", [{ id: "undeclared", type: "command", effect: "read", argv: ["undeclared-tool"] }]) }]);
  const c = await context(planner);
  try {
    const preview = await c.engine.preview({ projectPath: c.project, definition: definition("outer", [{ id: "expand", type: "expand", task: "Generate a small safe plan" }]) });
    c.engine.start(preview);
    const result = await c.engine.wait(preview.id);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /command|authorization|permission|subflow/i);
    assert.equal(c.commands.length, 0, "Undeclared nested commands must be rejected before any native dispatch");
  } finally { await c.cleanup(); }
});

test("nested inline subflow references are frozen before execution and resolve without a legacy resolver", async () => {
  const c = await context();
  try {
    const saved = c.engine.saveDefinition({ definition: definition("saved-child", [{ id: "read", type: "agent", task: "Read the fixture" }]) });
    const preview = await c.engine.preview({ projectPath: c.project, definition: definition("outer", [{ id: "inline", type: "subflow", definition: definition("middle", [{ id: "reference", type: "subflow", ref: { id: saved.id, revision: saved.revision } }]) }]) });
    c.engine.start(preview);
    const result = await c.engine.wait(preview.id);
    assert.equal(result.status, "completed", result.error);
    assert.equal(c.workers.length, 1);
    const outer = preview.definition.steps[0]; assert.equal(outer?.type, "subflow");
    if (outer?.type === "subflow") { const inner = outer.definition?.steps[0]; assert.equal(inner?.type, "subflow"); if (inner?.type === "subflow") { assert.equal(inner.ref, undefined); assert.ok(inner.definition); } }
  } finally { await c.cleanup(); }
});

test("an invalid later model is rejected before an earlier write command can dispatch", async () => {
  const c = await context();
  try {
    const preview = await c.engine.preview({ projectPath: c.project, grants: { allowWrite: true, workspaceMode: "local" }, definition: definition("invalid-model", [
      { id: "write", type: "command", effect: "write", argv: ["would-write-project"] },
      { id: "read", type: "agent", task: "Read fixture", model: "unavailable-model", reasoningEffort: "max" },
    ]) });
    c.engine.start(preview);
    const result = await c.engine.wait(preview.id);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /model|catalogue|unavailable/i);
    assert.equal(c.commands.length, 0, "Known invalid node settings must fail before any project write");
    assert.equal(c.workers.length, 0);
  } finally { await c.cleanup(); }
});
