import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const isolated = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-structured-package-")));
const project = path.join(isolated, "project"), data = path.join(isolated, "data");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
await cp(path.join(pluginRoot, "runtime"), path.join(isolated, "runtime"), { recursive: true });
await cp(path.join(pluginRoot, "package.json"), path.join(isolated, "package.json"));
await mkdir(path.join(isolated, "assets"));
await cp(path.join(pluginRoot, "assets", "workflows-sidebar-icon.png"), path.join(isolated, "assets", "workflows-sidebar-icon.png"));
await mkdir(project);
await writeFile(path.join(project, "input.txt"), "Unchanged package fixture\n");
let client, transport;
let stderr = "";
async function connect() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && name !== "CODEX_APP_TOOLS_PIPE_PATH"));
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(isolated, "runtime", "index.js")], cwd: tmpdir(), env: { ...environment, WORKFLOWS_DATA_DIR: data }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
  client = new Client({ name: "structured-package-smoke", version: "1" });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}
async function settle(id) {
  for (let index = 0; index < 300; index++) {
    const view = await call("workflow_get_run", { id });
    if (["completed", "waiting", "paused", "stopped", "failed", "unknown"].includes(view.run.status) && !view.run.ownerToken) return view;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("The isolated pure workflow did not settle");
}
try {
  await connect();
  assert.equal(client.getServerVersion().version, manifest.version);
  const tools = (await client.listTools()).tools;
  const names = tools.map(tool => tool.name);
  assert.equal(names.length, 27);
  for (const name of ["workflow_preview", "workflow_retry_node", "workflow_pause", "workflow_resolve_wait", "workflow_resolve_unknown", "workflow_get_events", "workflow_review"]) assert.ok(names.includes(name));
  for (const name of ["workflow_update", "workflow_panel_lease", "workflow_get_task_history", "workflow_cancel_task"]) assert.equal(names.includes(name), false);
  const entry = tools.find(tool => tool.name === "workflow_open_panel");
  assert.deepEqual(entry._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
  assert.ok(entry.icons[0].src.startsWith("data:image/png;base64,"));
  assert.equal((await call("workflow_get_capabilities")).version, manifest.version);
  assert.deepEqual((await call("workflow_list_templates")).templates, []);
  const panel = await client.readResource({ uri: entry._meta.ui.resourceUri });
  assert.deepEqual(panel.contents[0]._meta["openai/ui"].availableDisplayModes, ["fullscreen"]);
  assert.match(panel.contents[0].text, /workflow-panel/);
  const invalid = await client.callTool({ name: "workflow_preview", arguments: { projectPath: project, script: "return 1" } });
  assert.equal(invalid.isError, true, "Legacy script input must not execute or migrate");
  const definition = { schemaVersion: 1, name: "package-smoke", description: "Standalone structured runtime and durable input", parameters: [{ name: "value", type: "integer", default: 6 }], steps: [
    { id: "first", type: "transform", value: { op: "add", args: [{ ref: "args.value" }, 1] } },
    { id: "route", type: "choice", cases: [{ id: "valid", when: { op: "eq", args: [{ ref: "steps.first.output" }, 7] }, steps: [
      { id: "together", type: "parallel", policy: "all-settled", branches: [{ id: "a", steps: [{ id: "aValue", type: "transform", value: true }] }, { id: "b", steps: [{ id: "bValue", type: "transform", value: true }] }] },
    ] }], default: [] },
    { id: "loop", type: "repeat", maxIterations: 3, until: { op: "gte", args: [{ ref: "iteration" }, 1] }, steps: [{ id: "round", type: "transform", value: { ref: "iteration" } }] },
    { id: "confirm", type: "wait", message: "Provide explicit fixture confirmation", schema: { type: "boolean" } },
    { id: "done", type: "transform", value: { ref: "steps.confirm.output" } },
  ] };
  const template = (await call("workflow_save_template", { definition })).template;
  const draft = (await call("workflow_preview", { projectPath: project, definition: template.definition, sourceDefinition: { id: template.id, revision: template.revision } })).run;
  assert.equal(draft.status, "draft");
  await call("workflow_start", { id: draft.id, revision: draft.revision });
  let view = await settle(draft.id);
  assert.equal(view.run.status, "waiting", view.run.error);
  const first = view.run.instances.find(instance => instance.nodeId === "first");
  const firstProcess = (await call("workflow_get_node_process", { id: draft.id, instanceId: first.id, detail: "developer" })).process;
  assert.equal(firstProcess.output, 7);
  assert.equal(view.run.instances.filter(instance => instance.type === "scope" && instance.nodeId === "loop").length, 2);
  const waiting = view.run.instances.find(instance => instance.nodeId === "confirm");
  await call("workflow_resolve_wait", { id: draft.id, revision: view.run.revision, instanceId: waiting.id, value: true });
  view = await call("workflow_get_run", { id: draft.id });
  const recovery = await call("workflow_preview_recovery", { id: draft.id, revision: view.run.revision });
  assert.equal(recovery.canResume, true, JSON.stringify(recovery.blockers));
  await call("workflow_resume", { id: draft.id, revision: view.run.revision, recoveryFingerprint: recovery.fingerprint });
  view = await settle(draft.id);
  assert.equal(view.run.status, "completed", view.run.error);
  assert.equal(view.run.result.done, true);
  assert.equal(view.run.instances.reduce((count, instance) => count + instance.attempts.length, 0), 0, "Package smoke never sends a model or native command");
  const round = view.run.instances.find(instance => instance.type === "scope" && instance.nodeId === "loop");
  const scoped = await call("workflow_get_run", { id: draft.id, scopeInstanceId: round.id });
  assert.equal(scoped.projection.scopeInstanceId, round.id);
  assert.ok((await call("workflow_get_checkpoints", { id: draft.id })).checkpoints.length > 0);
  assert.ok((await call("workflow_get_events", { id: draft.id })).events.length > 0);
  const frozenHash = view.run.definitionHash;
  await call("workflow_save_template", { id: template.id, revision: template.revision, definition: { ...definition, description: "New immutable definition revision" } });
  assert.equal((await call("workflow_get_run", { id: draft.id })).run.definitionHash, frozenHash);
  const expectedProjection = view.projection;
  await client.close();
  await connect();
  assert.deepEqual((await call("workflow_get_run", { id: draft.id })).projection, expectedProjection);
  assert.equal(await readFile(path.join(project, "input.txt"), "utf8"), "Unchanged package fixture\n");
  const latest = (await call("workflow_get_run", { id: draft.id })).run;
  const deletion = await call("workflow_preview_deletion", { kind: "run", id: draft.id, revision: latest.revision });
  await call("workflow_delete", { kind: "run", id: draft.id, revision: latest.revision, fingerprint: deletion.fingerprint });
  assert.deepEqual((await call("workflow_list_runs", { projectPath: project })).runs, []);
  assert.equal(await readFile(path.join(project, "input.txt"), "utf8"), "Unchanged package fixture\n");
  console.log(JSON.stringify({ passed: true, version: manifest.version, tools: names.length, isolatedPackage: true, modelTurns: 0, legacyScriptRejected: true, branchParallelLoopWait: true, restartProjectionStable: true, deletionPreservesProject: true }));
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  await client?.close();
  await rm(isolated, { recursive: true, force: true });
}
