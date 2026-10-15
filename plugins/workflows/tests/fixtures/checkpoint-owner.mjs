import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowEngine } from "../../src/engine.ts";
import { RunStore } from "../../src/store.ts";

// A real, disposable workflow owner. The test parent kills only this process.
// No Codex CLI, model, external service, or user project is used by this fixture.
const [root, scenario] = process.argv.slice(2);
if (!root || !["entered", "partial-write", "uncommitted-manifest", "uncommitted-no-change"].includes(scenario)) throw new Error("Invalid checkpoint owner fixture arguments");
const project = path.join(root, "project");
const store = new RunStore(path.join(root, "state"));
let runId;
const send = value => new Promise((resolve, reject) => {
  if (!process.send) { reject(new Error("Checkpoint fixture requires an IPC parent")); return; }
  process.send(value, error => error ? reject(error) : resolve());
});
const forever = () => new Promise(() => {});

if (scenario === "uncommitted-manifest" || scenario === "uncommitted-no-change") {
  const save = store.save.bind(store);
  store.save = async (run, durable = false) => {
    if (durable && run.nodeCheckpoint?.reason === "node" && run.nodeCheckpoint.completedTasks === 1) {
      const saved = await store.load(run.id);
      await send({ event: "uncommitted-manifest", id: run.id, pending: run.nodeCheckpoint, committed: saved.nodeCheckpoint });
      // The immutable manifest is real. Stop before the real run.json rename.
      await forever();
    }
    return save(run, durable);
  };
}

const adapter = {
  run: async request => {
    const taskId = request.id.split("_attempt_")[0];
    if (taskId === "task_1") {
      // This variation records dispatch outside the project so an unchanged
      // workspace cannot accidentally mask an uncommitted-result reuse bug.
      await appendFile(path.join(scenario === "uncommitted-no-change" ? root : project, "first-writes.txt"), "first write\n");
    } else if (taskId === "task_2") {
      if (scenario === "partial-write") await writeFile(path.join(project, "source.txt"), "partial write before owner crash\n");
      const saved = await store.load(runId);
      await send({ event: "second-entered", id: runId, checkpoint: saved.nodeCheckpoint, tasks: saved.tasks });
      await forever();
    } else throw new Error(`Unexpected fixture task: ${taskId}`);
    return { output: "first completed", threadId: "fixture-owner", turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
  },
  close: async () => {},
};

const engine = new WorkflowEngine({ store, adapter });
try {
  const run = await engine.preview({
    projectPath: project, allowWrite: true, workspaceMode: "local",
    limits: { timeoutMs: 60000 },
    script: 'export const meta={name:"checkpoint-process-fixture",description:"Exercise only disposable local fixture files"}; await agent("first",{mode:"write"}); return await agent("second",{mode:"write"});',
  });
  runId = run.id;
  await send({ event: "created", id: runId });
  await engine.start({ id: run.id, revision: run.revision });
  const result = await engine.wait(run.id);
  throw new Error(`Fixture unexpectedly finished with ${result.execution}: ${result.error ?? "no error"}`);
} catch (error) {
  await send({ event: "fatal", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
  process.exit(1);
}
