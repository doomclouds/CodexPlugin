import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkflowEngine } from "../src/engine.ts";
import { createServer } from "../src/server.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter } from "../src/adapter.ts";
import type { WorkflowRun } from "../src/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

for (const outcome of ["completed", "failed"] as const) {
  test(`node diagnostics remain live during ${outcome} terminal persistence without releasing action locks`, { timeout: 10_000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-node-process-live-")));
    const project = path.join(root, "project");
    await mkdir(project); await writeFile(path.join(project, "source.txt"), "user baseline\n");
    const terminalSave = deferred(), releaseSave = deferred();
    class HeldTerminalStore extends RunStore {
      terminalRevision = 0;
      override async save(run: WorkflowRun) {
        if (run.execution === outcome) { this.terminalRevision = run.revision; terminalSave.resolve(); await releaseSave.promise; }
        await super.save(run);
      }
    }
    let dispatched = 0;
    const adapter: WorkerAdapter = {
      run: async (request, _signal, onEvent) => {
        dispatched++;
        await writeFile(path.join(request.cwd, "source.txt"), "user baseline\nworkflow edit\n");
        onEvent({ type: "log", message: "fixture worker inspected source; token=private-value" });
        if (outcome === "failed") throw new Error("Fixture tool initialization failed");
        return { output: "Checked the edited source", threadId: "fixture-thread", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
      },
      close: async () => {},
    };
    const store = new HeldTerminalStore(path.join(root, "state"));
    const engine = new WorkflowEngine({ store, adapter });
    const server = createServer(engine, { readDeletionConfig: async () => ({ mcp_servers: {} }) });
    const client = new Client({ name: "live-node-process-test", version: "1" });
    t.after(async () => {
      releaseSave.resolve();
      await client.close(); await server.close(); await engine.close();
      await rm(root, { recursive: true, force: true });
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const draft = await engine.preview({ projectPath: project, allowWrite: true, workspaceMode: "local", script: 'export const meta={name:"live-diagnostics",description:"Exercise a held terminal persistence boundary",phases:[{title:"Inspect source"}]}; phase("Inspect source"); return await agent("PRIVATE PROMPT",{mode:"write",label:"Inspect edited source"});' });
    await engine.start({ id: draft.id, revision: draft.revision });
    await terminalSave.promise;

    let getSettled = false, stopSettled = false;
    const full = engine.get(draft.id).then(run => { getSettled = true; return run; });
    const stopped = engine.stop(draft.id).then(run => { stopSettled = true; return run; });
    const pending = Symbol("waiting for terminal cleanup");
    const process = await Promise.race([engine.getNodeProcess(draft.id, { taskId: "task_1", detail: "developer" }), setImmediate(pending)]);
    assert.notEqual(process, pending, "Node diagnostics must resolve before terminal cleanup is released.");
    if (process === pending) throw new Error("Diagnostic read waited for terminal cleanup");
    assert.equal(process.status, outcome);
    assert.ok(process.logs?.some(log => /fixture worker inspected/.test(log.message)));
    assert.ok(!JSON.stringify(process).includes("private-value"));
    assert.ok(!JSON.stringify(process).includes("PRIVATE PROMPT"));
    assert.equal(Object.hasOwn(process, "revision"), false);
    assert.equal(Object.hasOwn(process, "script"), false);
    assert.equal(Object.hasOwn(process, "workspace"), false);
    if (outcome === "failed") assert.match(process.error!, /Fixture tool initialization failed/);
    const phase = await engine.getNodeProcess(draft.id, { phase: "Inspect source" });
    assert.equal(phase.status, outcome);
    await assert.rejects(engine.getNodeProcess(draft.id, { taskId: "missing" }), /Unknown workflow task/);

    const response = await client.callTool({ name: "workflow_get_node_process", arguments: { id: draft.id, scope: "workflow", detail: "developer" } });
    assert.equal(response.isError, undefined);
    assert.equal((response.structuredContent?.process as { status: string }).status, outcome);
    assert.ok(!JSON.stringify(response).includes("private-value"));
    assert.equal(getSettled, false, "Full run reads still wait for the authoritative final scope.");
    assert.equal(stopSettled, false, "Stopping a terminal run still waits for checkpoint and lock cleanup.");
    assert.equal(await store.isLocked(draft.id), true);
    await assert.rejects(engine.start({ id: draft.id, revision: store.terminalRevision }, true), /Old workers have not exited/);
    assert.equal(dispatched, 1);
    assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "user baseline\nworkflow edit\n");

    releaseSave.resolve();
    const [final, stopResult] = await Promise.all([full, stopped]);
    assert.deepEqual(stopResult, final);
    assert.equal(final.execution, outcome);
    assert.equal(final.workspace?.kind, "local");
    assert.match(final.workspaceCheckpoint!, /^local-v2:/);
    assert.equal(final.application, "none");
    assert.equal(await store.isLocked(draft.id), false);
    assert.deepEqual(await engine.get(draft.id), final);
    assert.equal((await engine.getNodeProcess(draft.id, { scope: "workflow" })).status, outcome);
    assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "user baseline\nworkflow edit\n");
  });
}
