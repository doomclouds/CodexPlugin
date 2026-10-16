import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkflowEngine } from "../src/engine.ts";
import { createServer } from "../src/server.ts";
import type { WorkflowDefinition } from "../src/definition.ts";
import type { StructuredRun, StructuredDefinitionRecord } from "../src/structured-types.ts";

const definition: WorkflowDefinition = { schemaVersion: 1, name: "protocol-fixture", description: "In-memory MCP transport fixture; no native workers", steps: [{ id: "value", type: "transform", value: 7 }] };
async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflows-v010-mcp-"));
    const engine = new WorkflowEngine({ root, driver: { execute: async () => true, captureCheckpoint: async () => "a".repeat(64) } });
    const server = createServer(engine, { projects: { getProjects: async () => ({ available: true, currentProjectId: "fixture", projects: [{ projectId: "fixture", label: "Protocol fixture", path: root, hostId: "local" }], contextSource: "thread" }) } });
    const client = new Client({ name: "workflow-protocol-tests", version: "0.10.0" }, { capabilities: {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
    const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const data = async (name: string, args: Record<string, unknown> = {}) => { const response = await call(name, args); assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent as Record<string, unknown>; };
    return { root, engine, server, client, call, data };
}

test("MCP catalogue advertises only the structured protocol and fullscreen project panel", async t => {
    const f = await fixture(t), catalogue = await f.client.listTools(), names = catalogue.tools.map(tool => tool.name);
    assert.equal(catalogue.tools.find(tool => tool.name === "workflow_delete")?.annotations?.destructiveHint, true);
    assert.ok(names.includes("workflow_pause")); assert.ok(names.includes("workflow_retry_node")); assert.ok(names.includes("workflow_resolve_wait")); assert.ok(names.includes("workflow_resolve_unknown"));
    assert.ok(!names.includes("workflow_update")); assert.ok(!names.includes("workflow_panel_lease"));
    const capabilities = await f.data("workflow_get_capabilities"); assert.equal(capabilities.version, "0.10.0");
    const panel = await f.client.readResource({ uri: "ui://workflows/panel.html" });
    assert.deepEqual(panel.contents[0]?._meta?.["openai/ui"], { availableDisplayModes: ["fullscreen"] });
    const text = "text" in panel.contents[0]! ? panel.contents[0].text : "";
    assert.match(String(text), /wf-instance-select/); assert.match(String(text), /wf-parameters-dialog/);
    assert.match(String(text), /0\.10\.0/);
});
test("strict tool schemas reject JavaScript and old execution arguments", async t => {
    const f = await fixture(t);
    for (const args of [{ projectPath: f.root, script: "return 1", args: {} }, { projectPath: f.root, definition, script: "return 1" }, { projectPath: f.root, definition, allowWrite: true }, { projectPath: f.root, definition, grants: { allowWrite: true, leaseId: "legacy" } }]) {
        assert.equal((await f.call("workflow_preview", args)).isError, true);
    }
    const draft = (await f.data("workflow_preview", { projectPath: f.root, definition })).run as StructuredRun;
    assert.equal((await f.call("workflow_start", { id: draft.id, revision: draft.revision, leaseId: "legacy" })).isError, true);
    assert.equal(f.engine.get(draft.id).status, "draft");
});
test("preview and execution mutations return one matched run/projection revision", async t => {
    const f = await fixture(t);
    const draft = await f.data("workflow_preview", { projectPath: f.root, definition });
    const run = draft.run as StructuredRun, projected = draft.projection as { revision: number; definitionHash: string };
    assert.equal(projected.revision, run.revision); assert.equal(projected.definitionHash, run.definitionHash);
    const started = await f.data("workflow_start", { id: run.id, revision: run.revision });
    assert.equal((started.projection as { revision: number }).revision, (started.run as StructuredRun).revision);
    await f.engine.wait(run.id);
    const final = await f.data("workflow_get_run", { id: run.id });
    assert.equal((final.run as StructuredRun).status, "completed"); assert.equal((final.projection as { revision: number }).revision, (final.run as StructuredRun).revision);
});
test("wait resolution and checkpoint resume retain committed instances across MCP", async t => {
    const f = await fixture(t), waitingDefinition: WorkflowDefinition = { ...definition, name: "wait-fixture", steps: [{ id: "decision", type: "wait", message: "Confirm test result", schema: { type: "boolean" } }, { id: "after", type: "transform", value: { ref: "steps.decision.output" } }] };
    const draft = (await f.data("workflow_preview", { projectPath: f.root, definition: waitingDefinition })).run as StructuredRun;
    await f.data("workflow_start", { id: draft.id, revision: draft.revision }); const waiting = await f.engine.wait(draft.id), instance = waiting.instances.find(instance => instance.nodeId === "decision")!;
    assert.equal(waiting.status, "waiting");
    assert.equal((await f.call("workflow_resolve_wait", { id: waiting.id, revision: waiting.revision, instanceId: instance.id, value: "yes" })).isError, true);
    const resolved = await f.data("workflow_resolve_wait", { id: waiting.id, revision: waiting.revision, instanceId: instance.id, value: true });
    const paused = resolved.run as StructuredRun; assert.equal(paused.status, "paused"); assert.equal((resolved.projection as { revision: number }).revision, paused.revision);
    const preview = await f.data("workflow_preview_recovery", { id: paused.id, revision: paused.revision }); assert.equal(preview.canResume, true);
    await f.data("workflow_resume", { id: paused.id, revision: paused.revision, recoveryFingerprint: preview.fingerprint });
    const completed = await f.engine.wait(paused.id); assert.equal(completed.status, "completed"); assert.equal(completed.instances.find(value => value.id === instance.id)?.output, true);
});
test("definition updates require id and CAS revision while old revisions remain frozen", async t => {
    const f = await fixture(t), first = (await f.data("workflow_save_template", { definition })).template as StructuredDefinitionRecord;
    assert.equal((await f.call("workflow_save_template", { revision: first.revision, definition: { ...definition, description: "changed" } })).isError, true);
    const updated = (await f.data("workflow_save_template", { id: first.id, revision: first.revision, definition: { ...definition, description: "changed" } })).template as StructuredDefinitionRecord;
    assert.equal(updated.id, first.id); assert.equal(updated.revision, first.revision + 1);
    assert.equal((await f.call("workflow_save_template", { id: first.id, revision: first.revision, definition })).isError, true);
    const previous = (await f.data("workflow_get_template", { id: first.id, revision: first.revision })).template as StructuredDefinitionRecord;
    assert.equal(previous.definition.description, definition.description);
});
test("settings clearing uses explicit current project and null means inherit", async t => {
    const f = await fixture(t), updates: unknown[] = [];
    f.engine.updateSettings = async (input, project) => { updates.push({ input, project }); return { ...input, revision: input.revision + 1 }; };
    const cleared = await f.data("workflow_update_execution_settings", { projectPath: f.root, revision: 0, model: null, reasoningEffort: null });
    assert.deepEqual(updates, [{ input: { revision: 0 }, project: f.root }]); assert.equal((cleared.settings as { revision: number }).revision, 1);
    assert.equal((await f.call("workflow_update_execution_settings", { revision: 1, model: null })).isError, true);
});
test("historical attempt process never borrows current output or unrelated logs", async t => {
    const f = await fixture(t), draft = await f.engine.preview({ projectPath: f.root, definition });
    f.engine.store.update(draft.id, run => { run.instances.push({ id: "historical-instance", nodeId: "value", label: "history fixture", type: "agent", path: "history", status: "completed", output: "new output", attempts: [{ id: "old", status: "failed", startedAt: draft.createdAt, error: "old failure", activities: [], logs: [{ at: draft.createdAt, message: "old log" }] }, { id: "new", status: "completed", startedAt: draft.createdAt, output: "new output", activities: [], logs: [{ at: draft.createdAt, message: "new log" }] }] }); });
    const old = (await f.data("workflow_get_node_process", { id: draft.id, instanceId: "historical-instance", attemptId: "old", detail: "developer" })).process as Record<string, unknown>;
    assert.equal(old.selectedAttemptId, "old"); assert.equal(old.error, "old failure"); assert.equal(old.output, undefined); assert.match(JSON.stringify(old.logs), /old log/); assert.doesNotMatch(JSON.stringify(old.logs), /new log/);
    const brief = (await f.data("workflow_get_node_process", { id: draft.id, instanceId: "historical-instance", attemptId: "new" })).process as Record<string, unknown>;
    assert.equal(brief.logs, undefined); assert.equal(brief.output, "new output"); assert.equal(brief.error, undefined);
});
test("run and attempt histories expose bounded continuation offsets", async t => {
    const f = await fixture(t);
    const runs = await Promise.all([1, 2, 3].map(() => f.engine.preview({ projectPath: f.root, definition })));
    const first = await f.data("workflow_list_runs", { projectPath: runs[0]!.projectPath, limit: 2 });
    assert.equal((first.runs as unknown[]).length, 2); assert.equal(first.nextOffset, 2);
    const last = await f.data("workflow_list_runs", { projectPath: runs[0]!.projectPath, offset: first.nextOffset, limit: 2 });
    assert.equal((last.runs as unknown[]).length, 1); assert.equal(last.nextOffset, undefined);
    f.engine.store.update(runs[0]!.id, run => { run.instances.push({ id: "paged-attempts", nodeId: "value", type: "agent", label: "paged", path: "paged", status: "completed", attempts: ["old", "new"].map(id => ({ id, status: "completed", startedAt: run.createdAt, activities: [], logs: [] })) }); });
    const recent = (await f.data("workflow_get_node_process", { id: runs[0]!.id, instanceId: "paged-attempts", attemptLimit: 1 })).process as { attempts: Array<{id:string}>; nextAttemptOffset?:number; attemptTotal:number };
    assert.equal(recent.attemptTotal, 2); assert.equal(recent.attempts[0]!.id, "new"); assert.equal(recent.nextAttemptOffset, 1);
    const older = (await f.data("workflow_get_node_process", { id: runs[0]!.id, instanceId: "paged-attempts", attemptLimit: 1, attemptOffset: recent.nextAttemptOffset })).process as { attempts:Array<{id:string}>;nextAttemptOffset?:number };
    assert.equal(older.attempts[0]!.id, "old"); assert.equal(older.nextAttemptOffset, undefined);
});
test("pause and stop forward execution identity once while other controls remain strict", async t => {
    const f = await fixture(t), draft = await f.engine.preview({ projectPath: f.root, definition }), calls: Array<{ action:string; input:unknown }> = [];
    f.engine.pause = async input => { calls.push({ action: "pause", input }); return f.engine.get(input.id); };
    f.engine.stop = async input => { calls.push({ action: "stop", input }); return f.engine.get(input.id); };
    for (const action of ["pause", "stop"] as const) await f.data(`workflow_${action}`, { id: draft.id, revision: draft.revision, expectedOwnerToken: "displayed-owner" });
    assert.deepEqual(calls.map(call => call.input), [{ id: draft.id, revision: draft.revision, expectedOwnerToken: "displayed-owner" }, { id: draft.id, revision: draft.revision, expectedOwnerToken: "displayed-owner" }]);
    assert.equal(calls.length, 2);
    assert.equal((await f.call("workflow_start", { id: draft.id, revision: draft.revision, expectedOwnerToken: "displayed-owner" })).isError, true);
    assert.equal((await f.call("workflow_resume", { id: draft.id, revision: draft.revision, expectedOwnerToken: "displayed-owner", recoveryFingerprint: "f".repeat(64) })).isError, true);
});
