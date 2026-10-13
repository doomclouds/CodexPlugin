import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { RunStore } from "../src/store.ts";
import type { WorkflowEngine } from "../src/engine.ts";

// This protocol test records routing only; it never launches a worker or executes maintenance.
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-server-contract-"));
  const calls: Array<{ action: string; input: unknown }> = [];
  const record = (action: string, input: unknown) => { calls.push({ action, input }); return { id: "wf_0123456789abcdef01234567", revision: 1 }; };
  const engine = {
    store: new RunStore(directory),
    preview: async (input: unknown) => record("preview", input),
    update: async (input: unknown) => record("update", input),
    start: async (input: unknown, resume: boolean) => record(resume ? "resume" : "start", input),
    cancelTask: async (id: string, taskId: string) => record("cancel", { id, taskId }),
    apply: async (id: string, revision: number) => record("apply", { id, revision }),
  } as unknown as WorkflowEngine;
  const server = createServer(engine);
  const client = new Client({ name: "workflow-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, close: async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); } };
}

const id = "wf_0123456789abcdef01234567";

test("agent mutations are model-visible and chat starts do not require a UI lease", async () => {
  const { client, calls, close } = await fixture();
  try {
    const { tools } = await client.listTools();
    for (const name of ["workflow_start", "workflow_resume", "workflow_cancel_task", "workflow_apply"]) assert.deepEqual(tools.find(tool => tool.name === name)?._meta?.ui, { visibility: ["model", "app"] });
    assert.deepEqual(tools.find(tool => tool.name === "workflow_panel_lease")?._meta?.ui, { visibility: ["app"] });
    assert.equal((await client.callTool({ name: "workflow_start", arguments: { id, revision: 1 } })).isError, undefined);
    assert.equal((await client.callTool({ name: "workflow_resume", arguments: { id, revision: 1, leaseId: "live-ui-lease" } })).isError, undefined);
    assert.equal((await client.callTool({ name: "workflow_cancel_task", arguments: { id, taskId: "task-1" } })).isError, undefined);
    assert.equal((await client.callTool({ name: "workflow_apply", arguments: { id, revision: 1 } })).isError, undefined);
    assert.deepEqual(calls, [
      { action: "start", input: { id, revision: 1 } },
      { action: "resume", input: { id, revision: 1, leaseId: "live-ui-lease" } },
      { action: "cancel", input: { id, taskId: "task-1" } },
      { action: "apply", input: { id, revision: 1 } },
    ]);
  } finally { await close(); }
});

test("preview forwards the explicit execution scope and preserves a closed default scope", async () => {
  const { client, calls, close } = await fixture();
  try {
    const input = { projectPath: tmpdir(), script: 'export const meta={name:"scope-test",description:"Scope contract"}; return args;', args: { task: "inspect" }, allowWrite: true, networkAccess: true, allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["binary_session"] }, workspaceMode: "git-worktree", maintenance: { steps: [{ id: "build", command: ["npm", "run", "build"], networkAccess: false, timeoutMs: 10000, retries: 1, idempotent: true }], activation: { serverName: "rea", command: "node", args: ["${WORKSPACE}/runtime/index.js"] } } };
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: input })).isError, undefined);
    assert.deepEqual(calls[0]?.input, input);
    const minimal = { projectPath: tmpdir(), script: input.script };
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: minimal })).isError, undefined);
    assert.deepEqual(calls[1]?.input, { ...minimal, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot" });
    const update = { id, revision: 1, script: input.script, args: null, networkAccess: false, allowedMcpServers: [], workspaceMode: "snapshot" };
    assert.equal((await client.callTool({ name: "workflow_update", arguments: update })).isError, undefined);
    assert.deepEqual(calls[2]?.input, update);
  } finally { await close(); }
});

test("invalid scope declarations cannot reach the execution engine", async () => {
  const { client, calls, close } = await fixture();
  try {
    const minimal = { projectPath: tmpdir(), script: 'export const meta={name:"scope-test",description:"Scope contract"}; return args;' };
    for (const invalid of [
      { allowedMcpServers: ["workflows"] },
      { allowedMcpServers: ["plugin_workflows_private"] },
      { workspaceMode: "unisolated" },
      { allowedMcpTools: { rea: "binary_session" } },
      { maintenance: { steps: [{ id: "bad", command: "npm run build" }] } },
      { maintenance: { steps: [{ id: "bad", command: [] }] } },
      { maintenance: { steps: [{ id: "retry-without-proof", command: ["fixture"], retries: 1 }] } },
    ]) assert.equal((await client.callTool({ name: "workflow_preview", arguments: { ...minimal, ...invalid } })).isError, true);
    assert.equal(calls.length, 0);
  } finally { await close(); }
});

test("read-only network access is independently declared without authorizing file writes", async () => {
  const { client, calls, close } = await fixture();
  try {
    const input = { projectPath: tmpdir(), script: 'export const meta={name:"network-research",description:"Authorized read-only research"}; return await agent(args.question);', args: { question: "Read public information" }, allowWrite: false, networkAccess: true };
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: input })).isError, undefined);
    assert.deepEqual(calls[0]?.input, { ...input, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot" });
    const capability = await client.callTool({ name: "workflow_get_capabilities", arguments: {} });
    assert.equal((capability.structuredContent?.execution as Record<string, unknown>).readOnlyNetworkSupported, true);
    assert.equal((capability.structuredContent?.execution as Record<string, unknown>).networkAccessIndependentFromWrite, true);
  } finally { await close(); }
});
