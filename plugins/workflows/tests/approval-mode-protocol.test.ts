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
const script = 'export const meta={name:"approval-protocol",description:"Approval routing fixture"}; return 1;';

// Public MCP schemas and persistence are real; execution is a recording fixture.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-approval-protocol-"));
  const store = new RunStore(directory), calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const base: WorkflowRun = { id, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", meta: { name: "approval-protocol", description: "Approval routing fixture" }, projectPath: directory, script, scriptDigest: "fixture", args: {}, allowWrite: false, approvalMode: "never", limits: { maxReadWorkers: 1, maxCalls: 1, maxTokens: 0, timeoutMs: 1000 }, execution: "stopped", review: "unavailable", application: "none", tasks: [], logs: [] };
  const record = (action: string, input: Record<string, unknown>) => { calls.push({ action, input }); return { ...base, ...input } as WorkflowRun; };
  const engine = { store, get: async () => base, preview: async (input: Record<string, unknown>) => record("preview", input), update: async (input: Record<string, unknown>) => record("update", input), start: async (input: Record<string, unknown>, resume: boolean) => record(resume ? "resume" : "start", input) } as unknown as WorkflowEngine;
  const server = createServer(engine, { readDeletionConfig: async () => ({ mcp_servers: {} }) });
  const client = new Client({ name: "workflow-approval-protocol", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, calls, directory };
}

test("public approval schemas expose explicit workflow policy choices", async t => {
  const { client } = await fixture(t), tools = (await client.listTools()).tools;
  for (const name of ["workflow_preview", "workflow_update", "workflow_save_template", "workflow_resume"]) {
    const schema = tools.find(tool => tool.name === name)!.inputSchema;
    assert.deepEqual((schema.properties?.approvalMode as { enum: string[] }).enum, ["auto-review", "never"]);
    assert.ok(!schema.required?.includes("approvalMode"));
  }
  assert.equal(tools.find(tool => tool.name === "workflow_start")!.inputSchema.properties?.approvalMode, undefined);
});

test("approval choices survive save, load, sourced preview, update and explicit resume", async t => {
  const { client, calls, directory } = await fixture(t);
  const savedResponse = await client.callTool({ name: "workflow_save_template", arguments: { script, approvalMode: "auto-review" } });
  assert.equal(savedResponse.isError, undefined, JSON.stringify(savedResponse.content));
  const saved = savedResponse.structuredContent?.template as { id: string; revision: number; approvalMode: string };
  assert.equal(saved.approvalMode, "auto-review");
  const loaded = await client.callTool({ name: "workflow_get_template", arguments: { id: saved.id } });
  assert.equal(loaded.structuredContent?.approvalMode, "auto-review");
  const sourceDefinition = { id: saved.id, revision: saved.revision };
  for (const [name, input] of [
    ["workflow_preview", { script, projectPath: directory, sourceDefinition, approvalMode: "auto-review" }],
    ["workflow_update", { id, revision: 1, script, args: {}, approvalMode: "never" }],
    ["workflow_resume", { id, revision: 1, approvalMode: "auto-review", retryFromTaskId: "task_2" }],
  ] as const) {
    const response = await client.callTool({ name, arguments: input });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    assert.equal((response.structuredContent?.run as WorkflowRun).approvalMode, input.approvalMode);
    assert.equal(calls.at(-1)?.input.approvalMode, input.approvalMode);
  }
  assert.equal(calls.at(-1)?.input.retryFromTaskId, "task_2");
  const legacyResume = await client.callTool({ name: "workflow_resume", arguments: { id, revision: 1 } });
  assert.equal(legacyResume.isError, undefined);
  assert.deepEqual(calls.at(-1), { action: "resume", input: { id, revision: 1 } });
});

test("persistent approve and ambiguous auto modes are rejected before execution routing", async t => {
  const { client, calls, directory } = await fixture(t);
  for (const name of ["workflow_preview", "workflow_update", "workflow_save_template", "workflow_resume"]) for (const approvalMode of ["approve", "auto", "on-request"]) {
    const response = await client.callTool({ name, arguments: { id, revision: 1, script, args: {}, projectPath: directory, approvalMode } });
    assert.equal(response.isError, true, `${name} accepted ${approvalMode}`);
  }
  assert.deepEqual(calls, []);
});
