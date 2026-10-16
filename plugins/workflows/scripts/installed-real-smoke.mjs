import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers to authorize real Codex model calls.");
const selected = process.argv.indexOf("--plugin-root");
const plugin = await realpath(selected < 0 ? fileURLToPath(new URL("../", import.meta.url)) : process.argv[selected + 1]);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-installed-real-"))), project = path.join(root, "project");
await mkdir(project); await writeFile(path.join(project, "facts.txt"), "The observed integer is 42.\n");
const env = Object.fromEntries(Object.entries({ ...process.env, WORKFLOWS_DATA_DIR: path.join(root, "state") }).filter(([, value]) => typeof value === "string"));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, "runtime", "launcher.mjs")], cwd: plugin, env, stderr: "pipe" });
const client = new Client({ name: "workflows-installed-real-verification", version: "1" });
const started = Date.now();
const call = async (name, args = {}) => { const response = await client.callTool({ name, arguments: args }); assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent; };
try {
  await client.connect(transport);
  assert.equal((await call("workflow_get_capabilities")).version, JSON.parse(await readFile(path.join(plugin, "plugin.json"), "utf8")).version);
  const schema = { type: "object", properties: { observed: { type: "integer" } }, required: ["observed"], additionalProperties: false };
  const reader = id => ({ id, type: "agent", task: "Use a native file or shell tool to read facts.txt in this directory. Report the integer actually observed as observed. Do not modify files, use network, or answer from assumptions.", mode: "read", model: "gpt-6-luna", reasoningEffort: "max", schema, accept: { type: "object", properties: { observed: { const: 42 } }, required: ["observed"] } });
  const definition = { schemaVersion: 1, name: "installed-native-proof", description: "Disposable compiled MCP runtime verification using real workers", steps: [
    reader("inspect"),
    { id: "route", type: "choice", cases: [{ id: "valid", when: { op: "eq", args: [{ ref: "steps.inspect.output.observed" }, 42] }, steps: [{ id: "fork", type: "parallel", policy: "fail-fast", branches: [{ id: "a", steps: [{ id: "one", type: "transform", value: 1 }] }, { id: "b", steps: [{ id: "two", type: "transform", value: 2 }] }] }] }], default: [{ id: "unexpected", type: "transform", value: false }] },
    { id: "loop", type: "repeat", maxIterations: 2, steps: [reader("verify")] },
  ] };
  const draft = (await call("workflow_preview", { projectPath: project, definition, limits: { maxCalls: 4, timeoutMs: 240000 } })).run;
  await call("workflow_start", { id: draft.id, revision: draft.revision });
  let view;
  const deadline = Date.now() + 260000;
  do { view = await call("workflow_get_run", { id: draft.id }); if (!["preparing", "running"].includes(view.run.status)) break; await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < deadline);
  assert.equal(view.run.status, "completed", view.run.error);
  const agents = view.run.instances.filter(instance => instance.type === "agent"); assert.equal(agents.length, 3);
  let nativeActivities = 0;
  for (const instance of agents) {
    assert.equal(instance.attempts.length, 1); assert.equal(instance.attempts[0].executionSettings.model, "gpt-6-luna"); assert.equal(instance.attempts[0].executionSettings.reasoningEffort, "max");
    const process = (await call("workflow_get_node_process", { id: draft.id, instanceId: instance.id, detail: "developer" })).process;
    assert.deepEqual(process.output, { observed: 42 }); nativeActivities += process.activities.filter(activity => ["command", "files", "search"].includes(activity.kind)).length;
    assert.equal(process.checkpointCovered, true);
  }
  assert.ok(nativeActivities >= 3); assert.equal(view.run.instances.filter(instance => instance.type === "scope").length, 2); assert.equal(view.run.instances.some(instance => instance.nodeId === "unexpected"), false);
  assert.equal(await readFile(path.join(project, "facts.txt"), "utf8"), "The observed integer is 42.\n");
  console.log(JSON.stringify({ passed: true, compiledRuntime: true, model: "gpt-6-luna", reasoningEffort: "max", agentAttempts: agents.length, nativeActivities, loopIterations: 2, branch: "valid", elapsedMs: Date.now() - started }));
} finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
