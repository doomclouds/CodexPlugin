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
const entry = config.mcpServers.workflows;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: entry.args.map(argument => argument.replaceAll("${PLUGIN_ROOT}", isolatedRoot)),
  cwd: tmpdir(),
  stderr: "pipe",
});
const client = new Client({ name: "workflows-smoke", version: "0.1.0" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "workflow_get_capabilities", "workflow_get_template", "workflow_list_templates",
  ]);

  const capabilities = await client.callTool({ name: "workflow_get_capabilities", arguments: {} });
  assert.equal(capabilities.isError, undefined);
  assert.equal(capabilities.structuredContent.execution.available, false);

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
