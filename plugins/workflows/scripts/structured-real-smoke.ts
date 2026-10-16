import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../src/engine.ts";
import { projectStructuredRun } from "../src/structured-projection.ts";
import type { WorkflowDefinition } from "../src/definition.ts";

if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers to authorize the real model smoke test.");
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-structured-real-")));
const project = path.join(temporary, "project"), state = path.join(temporary, "state");
await mkdir(project);
await writeFile(path.join(project, "facts.txt"), "The independently observable demo value is 42.\n");
let engine: WorkflowEngine | undefined;
const started = Date.now();
try {
  engine = new WorkflowEngine({ root: state });
  const schema = { type: "object", properties: { observed: { type: "integer" } }, required: ["observed"], additionalProperties: false };
  const definition: WorkflowDefinition = { schemaVersion: 1, name: "structured-real-smoke", description: "Real read-only Codex tools through a structured branch and bounded loop", steps: [
    { id: "inspect", type: "agent", label: "读取实际文件", task: "Use native tools to read facts.txt in this project. Return its independently observable integer as observed. Do not modify any files, make network requests, or assume the value without reading the file.", model: "gpt-6-luna", reasoningEffort: "max", schema, accept: { type: "object", properties: { observed: { const: 42 } }, required: ["observed"] } },
    { id: "route", type: "choice", label: "文件是否符合预期", cases: [{ id: "valid", when: { op: "eq", args: [{ ref: "steps.inspect.output.observed" }, 42] }, steps: [
      { id: "parallel", type: "parallel", label: "并行纯计算", policy: "fail-fast", branches: [{ id: "first", steps: [{ id: "firstResult", type: "transform", value: true }] }, { id: "second", steps: [{ id: "secondResult", type: "transform", value: true }] }] },
    ] }], default: [{ id: "unexpected", type: "transform", value: false }] },
    { id: "loop", type: "repeat", label: "真实工具读取两轮", maxIterations: 3, until: { op: "gte", args: [{ ref: "iteration" }, 1] }, steps: [
      { id: "readAgain", type: "agent", label: "独立读取事实", task: "Read facts.txt using native file or shell tools and report the integer written in the file as observed. Do not edit files or use the network. This is a real independent read; do not answer from the workflow goal.", model: "gpt-6-luna", reasoningEffort: "max", schema, accept: { type: "object", properties: { observed: { const: 42 } }, required: ["observed"] } },
    ] },
  ] };
  const preview = await engine.preview({ projectPath: project, definition, grants: { allowWrite: false, networkAccess: false, approvalMode: "never" }, limits: { maxCalls: 5, timeoutMs: 240000, maxTokens: 0 } });
  assert.equal(preview.status, "draft");
  engine.start({ id: preview.id, revision: preview.revision });
  const completed = await engine.wait(preview.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.instances.find(instance => instance.nodeId === "route")?.cursor?.selectedCase, "valid");
  const scopes = completed.instances.filter(instance => instance.type === "scope" && instance.nodeId === "loop");
  assert.deepEqual(scopes.map(instance => instance.iteration), [0, 1]);
  assert.ok(scopes.every(instance => instance.status === "completed"));
  const attempts = completed.instances.flatMap(instance => instance.attempts);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.status === "completed"));
  assert.ok(attempts.every(attempt => attempt.executionSettings?.model === "gpt-6-luna" && attempt.executionSettings.reasoningEffort === "max"));
  const nativeActivities = attempts.flatMap(attempt => attempt.activities).filter(activity => ["command", "files", "search"].includes(activity.kind));
  assert.ok(nativeActivities.length >= 3, "Each real agent must have observable native tool activity");
  assert.equal(await readFile(path.join(project, "facts.txt"), "utf8"), "The independently observable demo value is 42.\n");
  const projection = projectStructuredRun(completed);
  await engine.close();
  engine = new WorkflowEngine({ root: state });
  assert.deepEqual(projectStructuredRun(engine.get(completed.id)), projection);
  console.log(JSON.stringify({ passed: true, model: "gpt-6-luna", reasoningEffort: "max", agentAttempts: attempts.length, nativeToolActivities: nativeActivities.length, loopIterations: scopes.length, branch: "valid", persistedProjectionStable: true, elapsedMs: Date.now() - started }));
} finally {
  await engine?.close();
  await rm(temporary, { recursive: true, force: true });
}
