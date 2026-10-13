import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const isolatedRoot = await mkdtemp(path.join(tmpdir(), "codex-workflows-smoke-"));
assert.equal(path.dirname(isolatedRoot), path.resolve(tmpdir()));
await cp(path.join(pluginRoot, "runtime"), path.join(isolatedRoot, "runtime"), { recursive: true });
await cp(path.join(pluginRoot, "workflows"), path.join(isolatedRoot, "workflows"), { recursive: true });
await cp(path.join(pluginRoot, "package.json"), path.join(isolatedRoot, "package.json"));
const config = JSON.parse(await readFile(new URL("../mcp.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const entry = config.mcpServers.workflows;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: entry.args.map(argument => argument.replaceAll("${PLUGIN_ROOT}", isolatedRoot)),
  cwd: tmpdir(),
  env: { ...process.env, WORKFLOWS_DATA_DIR: path.join(isolatedRoot, "data") },
  stderr: "pipe",
});
const client = new Client({ name: "workflows-smoke", version: "0.1.0" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, manifest.version);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "workflow_get_capabilities", "workflow_get_template", "workflow_list_templates", "workflow_open_panel",
    "workflow_save_template", "workflow_preview", "workflow_update", "workflow_list_runs", "workflow_get_run", "workflow_stop", "workflow_panel_lease", "workflow_start", "workflow_resume", "workflow_cancel_task", "workflow_apply",
  ].sort());
  const panelTool = tools.find(tool => tool.name === "workflow_open_panel");
  assert.deepEqual(panelTool._meta["openai/ui"].entrypoints, [{ type: "thread" }, { type: "global" }]);
  const panelResult = await client.callTool({ name: "workflow_open_panel", arguments: {} });
  assert.equal(panelResult.structuredContent.prototype, false);
  assert.equal(panelResult.structuredContent.executionAvailable, true);
  const panelResource = await client.readResource({ uri: panelTool._meta.ui.resourceUri });
  assert.equal(panelResource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(panelResource.contents[0].text, /workflow-panel/);
  for (const name of ["workflow_start", "workflow_resume", "workflow_apply", "workflow_cancel_task"]) assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ["app"]);

  const capabilities = await client.callTool({ name: "workflow_get_capabilities", arguments: {} });
  assert.equal(capabilities.isError, undefined);
  assert.equal(capabilities.structuredContent.execution.available, true);
  const preview = await client.callTool({ name: "workflow_preview", arguments: { projectPath: tmpdir(), script: 'export const meta = { name: "smoke", description: "Standalone runtime check" }; return args.value + 1;', args: { value: 6 } } });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.run.execution, "draft");
  const lease = await client.callTool({ name: "workflow_panel_lease", arguments: {} });
  const runId = preview.structuredContent.run.id;
  const started = await client.callTool({ name: "workflow_start", arguments: { id: runId, revision: preview.structuredContent.run.revision, leaseId: lease.structuredContent.leaseId } });
  assert.equal(started.isError, undefined);
  let finished;
  for (let index = 0; index < 100; index++) {
    const current = await client.callTool({ name: "workflow_get_run", arguments: { id: runId } });
    finished = current.structuredContent.run;
    if (finished.execution !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(finished.execution, "completed", finished.error);
  assert.equal(finished.result, 7);
  await client.callTool({ name: "workflow_panel_lease", arguments: { leaseId: lease.structuredContent.leaseId, release: true } });

  const catalog = await client.callTool({ name: "workflow_list_templates", arguments: {} });
  const templateId = catalog.structuredContent.templates[0].id;
  const template = await client.callTool({ name: "workflow_get_template", arguments: { id: templateId } });
  assert.equal(template.isError, undefined);
  assert.equal(template.structuredContent.id, templateId);
  assert.match(template.structuredContent.script, /export const meta/);

  const missing = await client.callTool({ name: "workflow_get_template", arguments: { id: "../package.json" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Unknown workflow template/);
  assert.equal(stderr, "");
  console.log("Workflows MCP smoke passed: discovery, capabilities, catalog, script read, unknown ID, independent cwd, standalone bundle.");
} finally {
  await client.close();
  await transport.close();
  await rm(isolatedRoot, { recursive: true, force: true });
}
