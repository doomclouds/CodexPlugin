import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import type { WorkerAdapter, WorkerRequest } from "../src/adapter.ts";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";
import type { WorkflowRun } from "../src/types.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(settle => { resolve = settle; }); return { promise, resolve }; }
const promptOf = (request: WorkerRequest) => request.prompt.slice(request.prompt.lastIndexOf("\n\nTask:\n") + 8);
const executionTimeoutMs = 20000;
// Two executions plus recovery validation and durable checkpoint cleanup.
const testTimeoutMs = executionTimeoutMs * 3;

async function pausedWriter(t: TestContext, operation: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-cache-")));
  const project = path.join(root, "project"); await mkdir(project); await writeFile(path.join(project, "source.txt"), "initial");
  const partial = deferred(); let writerCalls = 0, readerCalls = 0;
  const write = async (signal: AbortSignal) => {
    await writeFile(path.join(project, "source.txt"), ++writerCalls === 1 ? "partial" : "final");
    if (writerCalls === 1) {
      partial.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("Fixture writer stopped after its partial edit"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    }
    return "write completed";
  };
  const adapter: WorkerAdapter = {
    run: async (request, signal) => {
      let output: string;
      if (promptOf(request) === "writer") output = await write(signal);
      else { readerCalls++; await partial.promise; output = await readFile(path.join(project, "source.txt"), "utf8"); }
      return { output, threadId: "checkpoint-fixture", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    },
    command: async (_request, signal) => ({ exitCode: 0, stdout: await write(signal), stderr: "", attempts: 1 }),
    close: async () => {},
  };
  const readerCompleted = deferred();
  class ReaderObservedStore extends RunStore {
    override async save(run: WorkflowRun, durable = false) {
      const observed = run.tasks[0]?.status === "running" && run.tasks[1]?.status === "completed";
      await super.save(run, durable);
      if (observed) readerCompleted.resolve();
    }
  }
  const engine = new WorkflowEngine({ store: new ReaderObservedStore(path.join(root, "state")), adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const run = await engine.preview({
    projectPath: project, allowWrite: true, workspaceMode: "local",
    limits: { timeoutMs: executionTimeoutMs },
    ...(operation ? { maintenance: { steps: [{ id: "writer", command: ["node", "fixture.mjs"], idempotent: true }] } } : {}),
    script: `export const meta={name:"checkpoint-cache",description:"Modify only this temporary fixture"}; return await parallel([()=>${operation ? 'operation("writer")' : 'agent("writer",{mode:"write"})'},()=>agent("reader")]);`,
  });
  await engine.start({ id: run.id, revision: run.revision });
  // Stop only after the real persistence boundary records the partial read.
  // Startup and checkpoint I/O do not consume a separate five-second poll race.
  await Promise.race([readerCompleted.promise, engine.wait(run.id).then(finished => {
    throw new Error(`Fixture finished before saving the partial read: ${finished.execution}: ${finished.error ?? "no error"}`);
  })]);
  const stopped = await engine.stop(run.id);
  assert.deepEqual(stopped.tasks.map(task => task.status), ["interrupted", "completed"]);
  assert.equal(stopped.tasks[1]?.output, "partial");
  return { engine, stopped, project, calls: () => ({ writerCalls, readerCalls }) };
}

for (const operation of [false, true]) test(`resuming an interrupted ${operation ? "idempotent operation" : "write worker"} invalidates later completed readers`, { timeout: testTimeoutMs }, async t => {
  const f = await pausedWriter(t, operation);
  await f.engine.start({ id: f.stopped.id, revision: f.stopped.revision }, true);
  const result = await f.engine.wait(f.stopped.id);
  assert.equal(result.execution, "completed", result.error);
  assert.deepEqual(result.tasks.map(task => task.cached), [false, false]);
  assert.deepEqual(result.tasks.map(task => task.attempts.length), [2, 2]);
  assert.deepEqual(f.calls(), { writerCalls: 2, readerCalls: 2 });
  assert.equal(await readFile(path.join(f.project, "source.txt"), "utf8"), "final");
});

test("interrupted-write invalidation precedes a later reader's faster environment discovery", { timeout: testTimeoutMs }, async t => {
  const f = await pausedWriter(t, false);
  const scheduling = f.engine as unknown as { agentEnvironment(...args: unknown[]): Promise<ExecutionEnvironment | undefined> };
  const original = scheduling.agentEnvironment.bind(f.engine), writerDiscovery = deferred(); let arrivals = 0;
  scheduling.agentEnvironment = async (...args) => {
    if (++arrivals === 1) await writerDiscovery.promise;
    else setImmediate(writerDiscovery.resolve);
    return original(...args);
  };
  await f.engine.start({ id: f.stopped.id, revision: f.stopped.revision }, true);
  const result = await f.engine.wait(f.stopped.id);
  assert.equal(result.execution, "completed", result.error);
  assert.equal(arrivals, 2);
  assert.equal(result.tasks[1]?.cached, false);
  assert.equal(result.tasks[1]?.attempts.length, 2);
  assert.deepEqual(f.calls(), { writerCalls: 2, readerCalls: 2 });
});
