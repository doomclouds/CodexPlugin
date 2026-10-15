import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
await mkdir(path.join(isolatedRoot, "assets"));
await cp(path.join(pluginRoot, "assets", "workflows-sidebar-icon.png"), path.join(isolatedRoot, "assets", "workflows-sidebar-icon.png"));
const iconBytes = await readFile(path.join(isolatedRoot, "assets", "workflows-sidebar-icon.png"));
const expectedIcons = [{ src: `data:image/png;base64,${iconBytes.toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] }];
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
  assert.deepEqual(client.getServerVersion()?.icons, expectedIcons);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "workflow_get_capabilities", "workflow_get_template", "workflow_list_templates", "workflow_open_panel",
    "workflow_get_execution_settings", "workflow_update_execution_settings",
    "workflow_get_projects",
    "workflow_get_node_process", "workflow_preview_recovery", "workflow_get_checkpoints", "workflow_get_task_history", "workflow_preview_deletion", "workflow_delete",
    "workflow_save_template", "workflow_preview", "workflow_update", "workflow_list_runs", "workflow_get_run", "workflow_stop", "workflow_panel_lease", "workflow_start", "workflow_resume", "workflow_cancel_task", "workflow_apply",
  ].sort());
  const panelTool = tools.find(tool => tool.name === "workflow_open_panel");
  const projectTool = tools.find(tool => tool.name === "workflow_get_projects");
  assert.deepEqual(projectTool._meta.ui.visibility, ["model", "app"]);
  assert.equal(projectTool.annotations.readOnlyHint, true);
  const noProjectContext = await client.callTool({ name: "workflow_get_projects", arguments: {} });
  assert.equal(noProjectContext.structuredContent.available, false);
  assert.deepEqual(noProjectContext.structuredContent.projects, []);
  assert.match(noProjectContext.structuredContent.reason, /real thread identity/);
  assert.equal(panelTool._meta.ui.resourceUri, "ui://workflows/panel.html");
  assert.equal(panelTool._meta["ui/resourceUri"], "ui://workflows/panel.html");
  assert.deepEqual(panelTool._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
  assert.deepEqual(panelTool.icons, expectedIcons);
  const panelResult = await client.callTool({ name: "workflow_open_panel", arguments: {} });
  assert.equal(panelResult.structuredContent.version, manifest.version);
  assert.equal(panelResult.structuredContent.prototype, false);
  assert.equal(panelResult.structuredContent.executionAvailable, true);
  // Plugin upgrades may remove the old checkout after its MCP process starts.
  await rm(path.join(isolatedRoot, "runtime", "panel.html"));
  await rm(path.join(isolatedRoot, "runtime", "script-worker.js"));
  await rm(path.join(isolatedRoot, "workflows", "review-changes.workflow.js"));
  await rm(path.join(isolatedRoot, "assets", "workflows-sidebar-icon.png"));
  const panelResource = await client.readResource({ uri: panelTool._meta.ui.resourceUri });
  assert.equal(panelResource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(panelResource.contents[0].text, /workflow-panel/);
  const aliases = ["ui://workflows/prototype/0.1.4.html", "ui://workflows/panel/0.2.0.html", "ui://workflows/panel/0.2.1.html"];
  const { resources } = await client.listResources();
  assert.deepEqual((await client.listTools()).tools.find(tool => tool.name === "workflow_open_panel").icons, expectedIcons);
  for (const uri of [panelTool._meta.ui.resourceUri, ...aliases]) {
    assert.ok(resources.some(resource => resource.uri === uri), `Missing panel resource: ${uri}`);
    assert.deepEqual(resources.find(resource => resource.uri === uri).icons, expectedIcons);
    const resource = await client.readResource({ uri });
    assert.equal(resource.contents[0].uri, uri);
    assert.equal(resource.contents[0].mimeType, panelResource.contents[0].mimeType);
    assert.equal(resource.contents[0].text, panelResource.contents[0].text, `Panel alias has different HTML: ${uri}`);
    assert.deepEqual(resource.contents[0]._meta, panelResource.contents[0]._meta);
  }
  for (const name of ["workflow_start", "workflow_resume", "workflow_apply", "workflow_cancel_task"]) assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ["model", "app"]);
  assert.deepEqual(tools.find(tool => tool.name === "workflow_panel_lease")._meta.ui.visibility, ["app"]);

  const capabilities = await client.callTool({ name: "workflow_get_capabilities", arguments: {} });
  assert.equal(capabilities.isError, undefined);
  assert.equal(capabilities.structuredContent.version, manifest.version);
  assert.equal(capabilities.structuredContent.execution.available, true);
  const preview = await client.callTool({ name: "workflow_preview", arguments: { projectPath: tmpdir(), script: 'export const meta = { name: "smoke", description: "Standalone runtime check" }; return args.value + 1;', args: { value: 6 } } });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.run.execution, "draft");
  const lease = await client.callTool({ name: "workflow_panel_lease", arguments: {} });
  const runId = preview.structuredContent.run.id;
  const started = await client.callTool({ name: "workflow_start", arguments: { id: runId, revision: preview.structuredContent.run.revision } });
  assert.equal(started.isError, undefined);
  let finished;
  for (let index = 0; index < 100; index++) {
    const current = await client.callTool({ name: "workflow_get_run", arguments: { id: runId } });
    finished = current.structuredContent.run;
    if (!["preparing", "running", "stopping"].includes(finished.execution)) break;
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
  console.log("Workflows MCP smoke passed: discovery, versions, stable panel resource and cached aliases after file removal, capabilities, catalog, script read, unknown ID, independent cwd, standalone bundle.");
} finally {
  await client.close();
  await transport.close();
  await rm(isolatedRoot, { recursive: true, force: true });
}
