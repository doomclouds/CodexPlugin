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

test("fresh catalogues are empty and removed builtin sources cannot create or dispatch runs", async t => {
  const { project, calls, open } = await fixture(t);
  const first = await open();
  assert.deepEqual((await call(first.client, "workflow_list_templates")).templates, []);
  for (const id of ["review-changes", "builtin:review-changes"]) {
    const lookup = await first.client.callTool({ name: "workflow_get_template", arguments: { id } });
    assert.equal(lookup.isError, true);
    assert.match(JSON.stringify(lookup.content), /Unknown workflow template/);
    const preview = await first.client.callTool({ name: "workflow_preview", arguments: { projectPath: project, script: fixtureScript, sourceDefinition: { id, revision: 0 } } });
    assert.equal(preview.isError, true);
    assert.match(JSON.stringify(preview.content), /Workflow definition changed or does not match/);
  }
  assert.deepEqual((await call(first.client, "workflow_list_runs")).runs, []);
  assert.equal(calls.length, 0, "Removed catalogue entries cannot dispatch a worker or create a fallback plan.");
});

test("saved definition lookup, preview, execution, restart and complete deletion preserve provenance", async t => {
  const { project, calls, open } = await fixture(t);
  const first = await open();
  assert.deepEqual((await call(first.client, "workflow_list_templates")).templates, []);
  const saved = (await call(first.client, "workflow_save_template", { script: fixtureScript })).template as { id: string; revision: number; script: string; source: string };
  assert.equal(saved.id, "saved:builtin-provenance-fixture");
  assert.equal(saved.source, "saved");
  assert.deepEqual(((await call(first.client, "workflow_list_templates")).templates as Array<{ id: string }>).map(item => item.id), [saved.id]);
  const template = await call(first.client, "workflow_get_template", { id: saved.id });
  assert.equal(template.script, fixtureScript);
  assert.equal(template.revision, saved.revision);
  const sourceDefinition = { id: saved.id, revision: saved.revision };
  const preview = await call(first.client, "workflow_preview", { projectPath: project, script: template.script, sourceDefinition });
  let run = preview.run as WorkflowRun;
  assert.deepEqual(run.sourceDefinition, sourceDefinition);
  run = (await call(first.client, "workflow_update", { id: run.id, revision: run.revision, script: run.script, args: run.args })).run as WorkflowRun;
  assert.deepEqual(run.sourceDefinition, sourceDefinition, "Editing the stored plan preserves its source.");
  assert.equal((await call(first.client, "workflow_get_run", { id: run.id })).run !== undefined, true);
  assert.equal(((await call(first.client, "workflow_list_runs")).runs as WorkflowRun[]).length, 1);
  await call(first.client, "workflow_start", { id: run.id, revision: run.revision });
  const completed = await first.engine.wait(run.id);
  assert.equal(completed.execution, "completed", completed.error);
  assert.equal(calls.length, 1, "The saved script executes through the actual sandbox and fixture adapter.");
  await first.close();
  await first.engine.close();

  const reopened = await open();
  const retained = (await call(reopened.client, "workflow_get_run", { id: run.id })).run as WorkflowRun;
  assert.equal(retained.execution, "completed");
  assert.deepEqual(retained.sourceDefinition, sourceDefinition);
  assert.equal((await call(reopened.client, "workflow_get_template", { id: saved.id })).script, fixtureScript);
  assert.deepEqual(((await call(reopened.client, "workflow_list_templates")).templates as Array<{ id: string }>).map(item => item.id), [saved.id]);
  assert.equal(calls.length, 1, "Restart must only read history, not execute the saved definition again.");
  const target = { kind: "definition", id: saved.id, revision: saved.revision };
  const deletionPreview = (await call(reopened.client, "workflow_preview_deletion", target)).preview as { canDelete: boolean; fingerprint: string };
  assert.equal(deletionPreview.canDelete, true);
  const deletion = (await call(reopened.client, "workflow_delete", { ...target, fingerprint: deletionPreview.fingerprint })).deletion as { deleted: boolean };
  assert.equal(deletion.deleted, true);
  assert.deepEqual((await call(reopened.client, "workflow_list_runs")).runs, []);
  assert.deepEqual((await call(reopened.client, "workflow_list_templates")).templates, []);
  assert.equal((await reopened.client.callTool({ name: "workflow_get_template", arguments: { id: saved.id } })).isError, true);
  assert.equal((await reopened.client.callTool({ name: "workflow_get_run", arguments: { id: retained.id } })).isError, true);
});

test("legacy builtin zero-revision records migrate on read and do not block engine initialization", async t => {
  const { project, calls, open } = await fixture(t);
  const first = await open();
  const run = await first.engine.preview({ projectPath: project, script: fixtureScript });
  // Seed the pre-removal storage shape; the public API rejects this source for new runs.
  await first.engine.store.save({ ...run, sourceDefinition: { id: "review-changes", revision: 0 } });
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

test("canonical historical builtin IDs remain readable and executable after their catalogue entry is removed", async t => {
  const { project, calls, open } = await fixture(t);
  const { engine, client } = await open();
  const run = await engine.preview({ projectPath: project, script: fixtureScript });
  await engine.store.save({ ...run, sourceDefinition: { id: "builtin:review-changes", revision: 0 } });
  const retained = (await call(client, "workflow_get_run", { id: run.id })).run as WorkflowRun;
  assert.deepEqual(retained.sourceDefinition, { id: "builtin:review-changes", revision: 0 });
  assert.equal((await client.callTool({ name: "workflow_get_template", arguments: { id: "builtin:review-changes" } })).isError, true, "Historical source identities cannot fabricate current catalogue entries.");
  await call(client, "workflow_start", { id: retained.id, revision: retained.revision });
  const complete = await engine.wait(retained.id);
  assert.equal(complete.execution, "completed", complete.error);
  assert.deepEqual(complete.sourceDefinition, retained.sourceDefinition);
  assert.equal(calls.length, 1);
  const target = { kind: "run", id: complete.id, revision: complete.revision };
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
