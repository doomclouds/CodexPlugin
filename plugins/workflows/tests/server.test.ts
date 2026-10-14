import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { RunStore } from "../src/store.ts";
import type { WorkflowEngine } from "../src/engine.ts";
import type { ProjectsProvider } from "../src/projects.ts";
import type { WorkflowRun } from "../src/types.ts";

// This protocol test records routing only; it never launches a worker or executes maintenance.
async function fixture(projects?: ProjectsProvider) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-server-contract-"));
  const calls: Array<{ action: string; input: unknown }> = [];
  const record = (action: string, input: unknown) => { calls.push({ action, input }); return { id: "wf_0123456789abcdef01234567", revision: 1 }; };
  const engine = {
    store: new RunStore(directory),
    get: async (id: string) => engine.store.load(id),
    forgetDeletedRuns: (ids: string[]) => { record("forget-deleted", ids); },
    preview: async (input: unknown) => record("preview", input),
    getExecutionSettings: async (projectPath: unknown) => record("get-settings", { projectPath }),
    updateExecutionSettings: async (input: unknown) => record("update-settings", input),
    update: async (input: unknown) => record("update", input),
    start: async (input: unknown, resume: boolean) => record(resume ? "resume" : "start", input),
    cancelTask: async (id: string, taskId: string) => record("cancel", { id, taskId }),
    apply: async (id: string, revision: number) => record("apply", { id, revision }),
  } as unknown as WorkflowEngine;
  const server = createServer(engine, { ...(projects ? { projects } : {}), readDeletionConfig: async () => ({ mcp_servers: {} }) });
  const client = new Client({ name: "workflow-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, store: engine.store, close: async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); } };
}

const id = "wf_0123456789abcdef01234567";

test("MCP node process and complete deletion route real owned records with explicit confirmation", async () => {
  const { client, store, calls, close } = await fixture();
  try {
    const run = { id, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), meta: { name: "protocol-cleanup", description: "Protocol cleanup fixture" }, script: 'export const meta={name:"protocol-cleanup",description:"Protocol cleanup fixture"}; return 1;', scriptDigest: "fixture", args: {}, projectPath: store.root, allowWrite: false, limits: { maxReadWorkers: 1, maxCalls: 1, maxTokens: 0, timeoutMs: 1000 }, execution: "completed", application: "none", review: "ready", tasks: [{ id: "task_1", index: 0, label: "检查", prompt: "PRIVATE PROMPT", options: {}, mode: "read", status: "completed", cached: false, attempts: [] }], logs: [{ at: new Date().toISOString(), level: "info", taskId: "task_1", message: "token=private-token" }] } as WorkflowRun;
    await store.create(run);
    const tools = (await client.listTools()).tools;
    for (const name of ["workflow_get_node_process", "workflow_preview_deletion", "workflow_delete"]) assert.deepEqual(tools.find(tool => tool.name === name)?._meta?.ui, { visibility: ["model", "app"] });
    assert.equal(tools.find(tool => tool.name === "workflow_preview_deletion")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "workflow_delete")?.annotations?.destructiveHint, true);
    const process = await client.callTool({ name: "workflow_get_node_process", arguments: { id, taskId: "task_1" } });
    assert.equal(process.isError, undefined);
    assert.ok(!JSON.stringify(process.structuredContent).includes("PRIVATE PROMPT"));
    assert.ok(!JSON.stringify(process.structuredContent).includes("private-token"));
    const preview = await client.callTool({ name: "workflow_preview_deletion", arguments: { kind: "run", id, revision: 1 } });
    assert.equal(preview.isError, undefined);
    const value = preview.structuredContent?.preview as { canDelete: boolean; fingerprint: string };
    assert.equal(value.canDelete, true);
    assert.equal((await client.callTool({ name: "workflow_delete", arguments: { kind: "run", id, revision: 1 } })).isError, true);
    assert.equal((await store.list()).length, 1);
    const deleted = await client.callTool({ name: "workflow_delete", arguments: { kind: "run", id, revision: 1, fingerprint: value.fingerprint } });
    assert.equal(deleted.isError, undefined);
    assert.equal((deleted.structuredContent?.deletion as { deleted: boolean }).deleted, true);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(calls.at(-1), { action: "forget-deleted", input: [id] });
  } finally { await close(); }
});

test("MCP preview verifies a real definition revision and script before recording provenance", async () => {
  const { client, calls, close } = await fixture();
  try {
    const script = 'export const meta={name:"definition-source",description:"Definition source"}; return args;';
    const saved = await client.callTool({ name: "workflow_save_template", arguments: { script } });
    const definition = saved.structuredContent?.template as { id: string; revision: number };
    const args = { script, projectPath: tmpdir(), sourceDefinition: { id: definition.id, revision: definition.revision } };
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: args })).isError, undefined);
    assert.deepEqual((calls.at(-1)?.input as { sourceDefinition: unknown }).sourceDefinition, args.sourceDefinition);
    const count = calls.length;
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: { ...args, sourceDefinition: { ...args.sourceDefinition, revision: definition.revision + 1 } } })).isError, true);
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: { ...args, script: script.replace("return args", "return 1") } })).isError, true);
    assert.equal(calls.length, count);
  } finally { await close(); }
});

test("MCP server and panel resource advertise the compact packaged brand icon", async () => {
  const { client, calls, close } = await fixture();
  try {
    const bytes = await readFile(new URL("../assets/workflows-sidebar-icon.png", import.meta.url));
    assert.equal(bytes.readUInt32BE(16), 128);
    assert.equal(bytes.readUInt32BE(20), 128);
    const expected = [{ src: `data:image/png;base64,${bytes.toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] }];
    assert.deepEqual(client.getServerVersion()?.icons, expected);
    assert.ok(bytes.length < 16 * 1024, "MCP descriptors should use the compact sidebar PNG");
    const resources = (await client.listResources()).resources;
    assert.ok(resources.length > 0);
    for (const resource of resources) assert.deepEqual(resource.icons, expected);
    const tools = (await client.listTools()).tools;
    const panelTool = tools.find(tool => tool.name === "workflow_open_panel");
    assert.deepEqual(panelTool?.icons, expected);
    assert.deepEqual(panelTool?.inputSchema, { type: "object", properties: {}, "$schema": "http://json-schema.org/draft-07/schema#" });
    assert.ok(tools.filter(tool => tool.name !== "workflow_open_panel").every(tool => tool.icons === undefined));
    assert.deepEqual((panelTool?._meta?.["openai/ui"] as Record<string, unknown>).entrypoints, [{ type: "thread" }, { type: "global" }]);
    const opened = await client.callTool({ name: "workflow_open_panel", arguments: {} });
    assert.equal(opened.structuredContent?.executionAvailable, true);
    assert.equal((await client.callTool({ name: "workflow_start", arguments: { id, revision: 1 } })).isError, undefined);
    assert.deepEqual(calls, [{ action: "start", input: { id, revision: 1 } }]);
    assert.deepEqual((await client.listTools()).tools.find(tool => tool.name === "workflow_open_panel")?.icons, expected);
  } finally { await close(); }
});

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

test("project tool forwards fresh request metadata and cancellation to its read-only provider", async () => {
  const observed: Array<{ meta?: unknown; signal: AbortSignal }> = [];
  const projects: ProjectsProvider = { async getProjects(context) { observed.push(context); return { available: true, projects: [{ projectId: "local-a", label: "Project A", path: path.join(tmpdir(), "not-required-to-exist"), hostId: "local" }], currentProjectId: "local-a", contextSource: "thread" }; } };
  const { client, calls, close } = await fixture(projects);
  try {
    const tool = (await client.listTools()).tools.find(tool => tool.name === "workflow_get_projects");
    assert.equal(tool?.annotations?.readOnlyHint, true);
    assert.deepEqual(tool?._meta?.ui, { visibility: ["model", "app"] });
    const meta = { threadId: "fresh-current", thread_id: "fresh-current", "openai/threadId": "older" };
    const response = await client.callTool({ name: "workflow_get_projects", arguments: {}, _meta: meta });
    assert.equal(response.structuredContent?.available, true);
    assert.equal(response.structuredContent?.currentProjectId, "local-a");
    assert.deepEqual(observed[0]?.meta, meta);
    assert.ok(observed[0]?.signal instanceof AbortSignal);
    assert.deepEqual(calls, []);
  } finally { await close(); }
});

test("template tools expose authoritative phase and parameter metadata without planning or starting", async () => {
  const { client, calls, close } = await fixture();
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name === "workflow_plan"), false);
    const builtin = await client.callTool({ name: "workflow_get_template", arguments: { id: "review-changes" } });
    const meta = builtin.structuredContent?.meta as Record<string, unknown>;
    assert.deepEqual(meta.phases, [{ title: "审查" }, { title: "核实" }, { title: "汇总" }]);
    assert.equal((meta.parameters as Array<Record<string, unknown>>)[0]?.name, "files");
    const script = 'export const meta={name:"bug-args",description:"Variable workflow input",phases:[{title:"读取 Bug"}],parameters:[{name:"bug",label:"Bug 编号或 URL",type:"string",required:true}]}; return await agent(args.bug);';
    const saved = await client.callTool({ name: "workflow_save_template", arguments: { script, args: { bug: "123" } } });
    const definition = saved.structuredContent?.template as Record<string, unknown>;
    const loaded = await client.callTool({ name: "workflow_get_template", arguments: { id: definition.id } });
    assert.deepEqual(loaded.structuredContent?.meta, definition.meta);
    const listed = await client.callTool({ name: "workflow_list_templates", arguments: {} });
    const summaries = listed.structuredContent?.templates as Array<Record<string, unknown>>;
    assert.deepEqual(summaries.find(template => template.id === "saved:bug-args")?.meta, definition.meta);
    assert.deepEqual(calls, []);
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

test("settings tools route explicit defaults and node choices without inference or execution", async () => {
  const { client, calls, close } = await fixture();
  try {
    const projectPath = tmpdir();
    assert.equal((await client.callTool({ name: "workflow_get_execution_settings", arguments: { projectPath } })).isError, undefined);
    assert.equal((await client.callTool({ name: "workflow_update_execution_settings", arguments: { revision: 3, model: "model-a", reasoningEffort: "high", projectPath } })).isError, undefined);
    assert.equal((await client.callTool({ name: "workflow_update_execution_settings", arguments: { revision: 4, projectPath } })).isError, undefined);
    const script = 'export const meta={name:"node-contract",description:"Node configuration",phases:[{title:"Review"}]}; return await agent("inspect");';
    const nodeSettings = { "phase:Review": { model: "model-a", reasoningEffort: "low" }, "task:0": { reasoningEffort: "high", identity: "a".repeat(64) } };
    assert.equal((await client.callTool({ name: "workflow_preview", arguments: { projectPath, script, nodeSettings } })).isError, undefined);
    assert.deepEqual(calls, [
      { action: "get-settings", input: { projectPath } },
      { action: "update-settings", input: { revision: 3, model: "model-a", reasoningEffort: "high", projectPath } },
      { action: "update-settings", input: { revision: 4, projectPath } },
      { action: "preview", input: { projectPath, script, nodeSettings, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "snapshot" } },
    ]);
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
