import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { RunStore } from "../src/store.ts";
import type { WorkflowEngine } from "../src/engine.ts";
import type { WorkflowRun } from "../src/types.ts";

const id = "wf_0123456789abcdef01234567";
const script = 'export const meta={name:"local-contract",description:"Direct project editing contract"}; return await agent("Modify the authorized file and test it", {mode:"write"});';

// This fixture verifies public routing and persisted definitions, without executing a worker.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-local-contract-"));
  const store = new RunStore(directory);
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const base: WorkflowRun = { id, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", meta: { name: "local-contract", description: "Direct project editing contract" }, projectPath: directory, script, scriptDigest: "fixture", args: {}, allowWrite: true, workspaceMode: "local", limits: { maxReadWorkers: 1, maxCalls: 3, maxTokens: 0, timeoutMs: 1000 }, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [] };
  const record = (action: string, input: Record<string, unknown>) => { calls.push({ action, input }); return { ...base, ...input } as WorkflowRun; };
  const engine = { store, get: async () => base, preview: async (input: Record<string, unknown>) => record("preview", input), update: async (input: Record<string, unknown>) => record("update", input) } as unknown as WorkflowEngine;
  const server = createServer(engine, { readDeletionConfig: async () => ({ mcp_servers: {} }) });
  const client = new Client({ name: "workflow-local-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, calls, directory };
}

test("public local mode scope survives saved definition, sourced preview and update", async t => {
  const { client, calls, directory } = await fixture(t);
  const definition = { script, args: { file: "source.txt" }, allowWrite: true, workspaceMode: "local" };
  const savedResponse = await client.callTool({ name: "workflow_save_template", arguments: definition });
  assert.equal(savedResponse.isError, undefined, JSON.stringify(savedResponse.content));
  const saved = savedResponse.structuredContent?.template as { id: string; revision: number; workspaceMode: string; allowWrite: boolean };
  assert.equal(saved.workspaceMode, "local"); assert.equal(saved.allowWrite, true);
  const loaded = await client.callTool({ name: "workflow_get_template", arguments: { id: saved.id } });
  assert.equal(loaded.isError, undefined);
  assert.equal((loaded.structuredContent as typeof saved).workspaceMode, "local");
  const sourceDefinition = { id: saved.id, revision: saved.revision };
  const preview = await client.callTool({ name: "workflow_preview", arguments: { ...definition, projectPath: directory, sourceDefinition } });
  assert.equal(preview.isError, undefined, JSON.stringify(preview.content));
  assert.equal((preview.structuredContent?.run as WorkflowRun).workspaceMode, "local");
  assert.deepEqual(calls[0], { action: "preview", input: { ...definition, projectPath: directory, sourceDefinition, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {} } });
  const update = { id, revision: 1, script, args: { file: "another.txt" }, allowWrite: true, workspaceMode: "local" };
  const updated = await client.callTool({ name: "workflow_update", arguments: update });
  assert.equal(updated.isError, undefined);
  assert.deepEqual(calls[1], { action: "update", input: update });
});

test("saved local definitions require write authorization and retain declared operation scope", async t => {
  const { client, calls } = await fixture(t);
  for (const allowWrite of [undefined, false]) {
    const response = await client.callTool({ name: "workflow_save_template", arguments: { script, workspaceMode: "local", ...(allowWrite !== undefined ? { allowWrite } : {}) } });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), /Local project mode requires allowWrite/);
  }
  const maintenance = await client.callTool({ name: "workflow_save_template", arguments: { script, workspaceMode: "local", allowWrite: true, maintenance: { steps: [{ id: "build", command: ["npm", "run", "build"] }] } } });
  assert.equal(maintenance.isError, undefined, JSON.stringify(maintenance.content));
  assert.deepEqual((maintenance.structuredContent?.template as WorkflowRun).maintenance, { steps: [{ id: "build", command: ["npm", "run", "build"] }] });
  assert.deepEqual(calls, []);
  const listed = await client.callTool({ name: "workflow_list_templates", arguments: {} });
  assert.ok((listed.structuredContent?.templates as Array<{ source: string }>).some(item => item.source === "saved"));
});

test("advertised local mode exposes immediate writes and no rollback or apply", async t => {
  const { client } = await fixture(t);
  const response = await client.callTool({ name: "workflow_get_capabilities", arguments: {} });
  assert.equal(response.isError, undefined);
  const capabilities = response.structuredContent as unknown as { execution: { defaultWorkspaceMode: string; workspaceModes: string[]; localMode: Record<string, unknown> } };
  assert.equal(capabilities.execution.defaultWorkspaceMode, "snapshot");
  assert.deepEqual(capabilities.execution.workspaceModes, ["snapshot", "git-worktree", "local"]);
  assert.deepEqual(capabilities.execution.localMode, { requiresAllowWrite: true, writesOriginalProject: true, requiresApply: false, automaticRollback: false, deletionOwnsProject: false, maintenanceSupported: true, projectGitMetadataWrite: true, gitMetadataScope: "canonical-project-contained-only", legacyRunsKeepRecordedWriteScope: true, protectedInstructionDirectoriesAutoGranted: false, maxConcurrentProjectWriters: 1, coordinationScope: "shared-workflows-data-directory", externalEditorsSerialized: false });
  const tools = await client.listTools();
  for (const name of ["workflow_preview", "workflow_update", "workflow_save_template"]) {
    const tool = tools.tools.find(item => item.name === name)!;
    assert.deepEqual((tool.inputSchema.properties?.workspaceMode as { enum: string[] }).enum, ["snapshot", "git-worktree", "local"]);
  }
});
