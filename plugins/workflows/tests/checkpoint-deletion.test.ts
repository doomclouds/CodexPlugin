import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { DeletionService } from "../src/deletion.ts";
import type { WorkerAdapter } from "../src/adapter.ts";

// Real engine, checkpoint/history persistence and deletion IO; the worker is a deterministic test double.
test("deleting an executed local run removes every checkpoint and retired task history while preserving live project edits", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-checkpoint-delete-"))), project = path.join(root, "project");
  await mkdir(project); await writeFile(path.join(project, "source.txt"), "existing user edit\n"); await writeFile(path.join(project, "notes.txt"), "user notes\n");
  const store = new RunStore(path.join(root, "state")); let choices = 0, writes = 0;
  const adapter: WorkerAdapter = {
    executionEnvironment: async () => ({ defaults: { model: "checkpoint-delete-fixture", reasoningEffort: "max" }, models: [{ id: "checkpoint-delete-fixture", displayName: "Checkpoint deletion test double", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }] }),
    async run(request) {
      if (request.id.startsWith("task_1_")) {
        const data = { longer: ++choices === 1 };
        return { data, output: JSON.stringify(data), threadId: request.id, turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
      }
      writes++; await writeFile(path.join(request.cwd, "source.txt"), "existing user edit\nworkflow change retained\n");
      return { output: "Updated source", threadId: request.id, turnId: request.id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 };
    }, async close() {},
  };
  const engine = new WorkflowEngine({ store, adapter });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const script = 'export const meta={name:"checkpoint-delete",description:"Modify only the disposable local test project"}; const choice=await agent("choose",{schema:{type:"object",properties:{longer:{type:"boolean"}},required:["longer"],additionalProperties:false}}); if(choice.longer){await agent("write",{mode:"write"});throw new Error("Inspect before retrying branch");} return choice;';
  const draft = await engine.preview({ projectPath: project, script, allowWrite: true, workspaceMode: "local" });
  await engine.start({ id: draft.id, revision: draft.revision }); const first = await engine.wait(draft.id);
  assert.equal(first.execution, "failed"); assert.equal(first.tasks.length, 2); assert.equal(writes, 1);
  const recovery = await engine.previewRecovery({ id: draft.id, revision: first.revision, retryFromTaskId: "task_1" });
  assert.equal(recovery.canResume, true, JSON.stringify(recovery.blockers));
  await engine.start({ id: draft.id, revision: first.revision, retryFromTaskId: "task_1", recoveryFingerprint: recovery.fingerprint }, true);
  const done = await engine.wait(draft.id); assert.equal(done.execution, "completed", done.error); assert.equal(done.tasks.length, 1); assert.equal(writes, 1);
  const directory = store.directory(draft.id), checkpoints = await readdir(path.join(directory, "checkpoints")), history = await readdir(path.join(directory, "history"));
  assert.ok(checkpoints.length >= 3); assert.equal(history.length, 1);
  const archived = await engine.taskHistory({ id: draft.id }); assert.ok("total" in archived); assert.equal(archived.total, 1); assert.equal(archived.history[0]?.taskId, "task_2");
  const service = new DeletionService(store, new TemplateStore(store), { readEffectiveConfig: async () => ({}) });
  const preview = await service.preview({ kind: "run", id: draft.id, revision: done.revision });
  assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  assert.ok(preview.totalFiles >= checkpoints.length + history.length + 1);
  assert.ok(preview.objects.every(object => object.path.startsWith(store.root + path.sep)));
  const deleted = await service.execute({ ...preview.target, fingerprint: preview.fingerprint });
  assert.equal(deleted.deleted, true, JSON.stringify(deleted)); assert.equal(deleted.partial, false); assert.deepEqual(deleted.remaining, []);
  assert.deepEqual(deleted.deletedRunIds, [draft.id]); engine.forgetDeletedRuns(deleted.deletedRunIds);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(directory, "checkpoints")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(directory, "history")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(project, "source.txt"), "utf8"), "existing user edit\nworkflow change retained\n");
  assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), "user notes\n");
  assert.deepEqual(await store.list(), []);
});
