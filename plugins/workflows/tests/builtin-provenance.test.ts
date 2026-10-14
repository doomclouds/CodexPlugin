import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { DefinitionSource, WorkflowRun } from "../src/types.ts";

const exec = promisify(execFile);
const fixtureScript = 'export const meta={name:"builtin-provenance-fixture",description:"Explicit scheduling fixture without a model"}; return await agent("inspect");';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-builtin-provenance-"));
  const project = path.join(root, "project");
  const storage = path.join(root, "state");
  await mkdir(project);
  await exec("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "source.txt"), "fixture\n");
  await exec("git", ["add", "--all"], { cwd: project });
  const calls: WorkerRequest[] = [];
  // The engine and MCP protocol are real; this adapter never starts Codex or a model.
  const adapter: WorkerAdapter = {
    async run(request) {
      calls.push(request);
      return { output: "Fixture evidence", threadId: `fixture-${request.id}`, turnId: `turn-${request.id}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    },
    async close() {},
  };
  const engines: WorkflowEngine[] = [];
  const connections: Array<{ client: Client; close(): Promise<void> }> = [];
  const open = async () => {
    const engine = new WorkflowEngine({ store: new RunStore(storage), adapter });
    engines.push(engine);
    const server = createServer(engine, { readDeletionConfig: async () => ({ mcp_servers: {} }) });
    const client = new Client({ name: "builtin-provenance-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const connection = { client, close: async () => { await client.close(); await server.close(); } };
    connections.push(connection);
    return { engine, ...connection };
  };
  t.after(async () => {
    for (const connection of connections) await connection.close();
    for (const engine of engines) await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  return { project, calls, open };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

test("MCP builtin lookup, preview, execution, restart and deletion share canonical provenance", async t => {
  const { project, calls, open } = await fixture(t);
  const first = await open();
  const catalogue = await call(first.client, "workflow_list_templates");
  const builtin = (catalogue.templates as Array<{ id: string; source: string }>).find(item => item.source === "builtin")!;
  assert.ok(builtin);
  const template = await call(first.client, "workflow_get_template", { id: builtin.id });
  const canonical = `builtin:${builtin.id}`;
  assert.equal((await call(first.client, "workflow_get_template", { id: canonical })).script, template.script);
  const preview = await call(first.client, "workflow_preview", { projectPath: project, script: template.script, args: { files: ["source.txt"] }, sourceDefinition: { id: builtin.id, revision: 0 } });
  let run = preview.run as WorkflowRun;
  assert.deepEqual(run.sourceDefinition, { id: canonical, revision: 0 });
  run = (await call(first.client, "workflow_update", { id: run.id, revision: run.revision, script: run.script, args: run.args })).run as WorkflowRun;
  assert.deepEqual(run.sourceDefinition, { id: canonical, revision: 0 }, "Editing the stored plan preserves its canonical source.");
  assert.equal((await call(first.client, "workflow_get_run", { id: run.id })).run !== undefined, true);
  assert.equal(((await call(first.client, "workflow_list_runs")).runs as WorkflowRun[]).length, 1);
  await call(first.client, "workflow_start", { id: run.id, revision: run.revision });
  const completed = await first.engine.wait(run.id);
  assert.equal(completed.execution, "completed", completed.error);
  assert.equal(calls.length, 3, "The builtin runs review, verification and summary through the actual sandbox.");
  await first.close();
  await first.engine.close();

  const reopened = await open();
  const retained = (await call(reopened.client, "workflow_get_run", { id: run.id })).run as WorkflowRun;
  assert.equal(retained.execution, "completed");
  assert.deepEqual(retained.sourceDefinition, { id: canonical, revision: 0 });
  assert.equal(calls.length, 3, "Restart must only read history, not execute the builtin again.");
  const target = { kind: "run", id: retained.id, revision: retained.revision };
  const deletionPreview = (await call(reopened.client, "workflow_preview_deletion", target)).preview as { canDelete: boolean; fingerprint: string };
  assert.equal(deletionPreview.canDelete, true);
  const deletion = (await call(reopened.client, "workflow_delete", { ...target, fingerprint: deletionPreview.fingerprint })).deletion as { deleted: boolean };
  assert.equal(deletion.deleted, true);
  assert.deepEqual((await call(reopened.client, "workflow_list_runs")).runs, []);
  assert.ok(((await call(reopened.client, "workflow_list_templates")).templates as Array<{ id: string }>).some(item => item.id === builtin.id));
});

test("legacy builtin zero-revision records migrate on read and do not block engine initialization", async t => {
  const { project, calls, open } = await fixture(t);
  const first = await open();
  const run = await first.engine.preview({ projectPath: project, script: fixtureScript, sourceDefinition: { id: "review-changes", revision: 0 } });
  await first.close();
  await first.engine.close();
  const reopened = await open();
  const retained = (await call(reopened.client, "workflow_get_run", { id: run.id })).run as WorkflowRun;
  assert.deepEqual(retained.sourceDefinition, { id: "builtin:review-changes", revision: 0 });
  assert.equal(((await call(reopened.client, "workflow_list_runs")).runs as WorkflowRun[]).length, 1);
  await call(reopened.client, "workflow_start", { id: run.id, revision: retained.revision });
  const complete = await reopened.engine.wait(run.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.deepEqual(complete.sourceDefinition, { id: "builtin:review-changes", revision: 0 });
  assert.equal(calls.length, 1);
  const target = { kind: "run", id: complete.id, revision: complete.revision };
  const preview = (await call(reopened.client, "workflow_preview_deletion", target)).preview as { canDelete: boolean; fingerprint: string };
  assert.equal(preview.canDelete, true);
  assert.equal(((await call(reopened.client, "workflow_delete", { ...target, fingerprint: preview.fingerprint })).deletion as { deleted: boolean }).deleted, true);
});

test("canonical historical builtin IDs remain readable after their catalogue entry is removed", async t => {
  const { project, open } = await fixture(t);
  const { engine, client } = await open();
  const run = await engine.preview({ projectPath: project, script: fixtureScript, sourceDefinition: { id: "builtin:retired-builtin", revision: 0 } });
  assert.deepEqual((await engine.get(run.id)).sourceDefinition, { id: "builtin:retired-builtin", revision: 0 });
  assert.equal((await client.callTool({ name: "workflow_get_template", arguments: { id: "builtin:retired-builtin" } })).isError, true, "Historical source identities cannot fabricate current catalogue entries.");
  const target = { kind: "run", id: run.id, revision: run.revision };
  const preview = (await call(client, "workflow_preview_deletion", target)).preview as { canDelete: boolean; fingerprint: string };
  assert.equal(preview.canDelete, true);
  assert.equal(((await call(client, "workflow_delete", { ...target, fingerprint: preview.fingerprint })).deletion as { deleted: boolean }).deleted, true);
});

test("invalid provenance never weakens saved-definition revision or path validation", async t => {
  const { project, open } = await fixture(t);
  const { engine } = await open();
  for (const sourceDefinition of [
    { id: "saved:valid-name", revision: 0 },
    { id: "builtin:../outside", revision: 0 },
    { id: "builtin:valid-name", revision: -1 },
    { id: "builtin:UPPERCASE", revision: 0 },
    { id: "unknown-bare-name", revision: 0 },
    { id: "review-changes", revision: 1 },
    { id: "review-changes", revision: 0.5 },
  ] satisfies DefinitionSource[]) {
    const run = await engine.preview({ projectPath: project, script: fixtureScript });
    await engine.store.save({ ...run, sourceDefinition });
    await assert.rejects(engine.get(run.id), /Invalid saved workflow provenance/);
  }
});
