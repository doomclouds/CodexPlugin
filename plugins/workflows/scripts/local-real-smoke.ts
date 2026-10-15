import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerAdapter } from "../src/adapter.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import { DeletionService } from "../src/deletion.ts";
import { localWorkspaceFingerprint } from "../src/local-workspace.ts";

if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and starts real logged-in Codex workers.");
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-real-")));
const project = path.join(root, "project"), state = path.join(root, "state");
const originalTest = "import assert from 'node:assert/strict'; import test from 'node:test'; import {add} from './sum.mjs'; test('adds signed values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);assert.equal(add(0,0),0);});\n";
let real = new CodexAdapter(); let calls = 0, realCalls = 0, pausedOnce = false, visibleBeforeCompletion = false;
let reachedPause!: () => void;
const pauseReached = new Promise<void>(resolve => { reachedPause = resolve; });
const adapter: WorkerAdapter = {
  executionEnvironment: (cwd, signal) => real.executionEnvironment(cwd, signal),
  run: async (request, signal, onEvent) => {
    calls++; assert.equal(request.cwd, project);
    // Hold one dispatch before contacting the model so stop/restart recovery can
    // be exercised without racing or interrupting a native editing command.
    if (request.mode === "read" && !pausedOnce) {
      pausedOnce = true; reachedPause();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("Fixture dispatch interrupted before starting its worker");
    }
    realCalls++;
    const result = await real.run(request, signal, onEvent);
    if (request.mode === "write") { assert.match(await readFile(path.join(project, "sum.mjs"), "utf8"), /a\s*\+\s*b/); visibleBeforeCompletion = true; }
    return result;
  }, close: () => real.close(),
};
let engine: WorkflowEngine | undefined;
try {
  await mkdir(project);
  await exec("git", ["init", "--quiet"], { cwd: project });
  await writeFile(path.join(project, "sum.mjs"), "export const add = (a,b) => a-b;\n");
  await writeFile(path.join(project, "sum.test.mjs"), originalTest);
  await exec("git", ["add", "sum.mjs", "sum.test.mjs"], { cwd: project });
  await exec("git", ["-c", "user.name=Workflow Fixture", "-c", "user.email=workflow@example.invalid", "commit", "--quiet", "-m", "Add arithmetic fixture"], { cwd: project });
  await writeFile(path.join(project, "notes.txt"), "existing user edit; preserve this file\n");
  const indexBefore = (await exec("git", ["ls-files", "--stage"], { cwd: project })).stdout;
  let exposedBug = false;
  try { await exec(process.execPath, ["--test", "sum.test.mjs"], { cwd: project }); } catch (error) { exposedBug = (error as { code?: number }).code === 1; }
  assert.equal(exposedBug, true);
  const store = new RunStore(state); engine = new WorkflowEngine({ store, adapter });
  const script = 'export const meta={name:"local-real-edit",description:"Fix only sum.mjs in the current local project and verify its existing tests",phases:[{title:"修复"},{title:"验证"}]}; phase("修复"); const edit=await agent(args.edit,{mode:"write",model:args.model,reasoningEffort:"max"}); if(!edit) throw new Error("Missing actual edit report"); phase("验证"); return await agent(args.verify,{model:args.model,reasoningEffort:"max"});';
  const draft = await engine.preview({ projectPath: project, script, allowWrite: true, workspaceMode: "local", limits: { maxCalls: 3, maxReadWorkers: 1, timeoutMs: 600000 }, args: {
    model: "gpt-6-luna",
    edit: "Fix the arithmetic bug in sum.mjs. Modify only sum.mjs so add performs addition. Run node --test sum.test.mjs. Preserve sum.test.mjs and notes.txt, and do not stage or commit files, install dependencies, use network services, or change Git metadata. Report the actual test result.",
    verify: "Read sum.mjs and run node --test sum.test.mjs to independently verify addition. This is read-only: do not change any files, stage or commit, install anything, or use network services. Report the actual test result.",
  } });
  console.log(JSON.stringify({ stage: "starting-real-local-workflow", model: "gpt-6-luna", effort: "max", id: draft.id }));
  await engine.start({ id: draft.id, revision: draft.revision }); await pauseReached;
  const stopped = await engine.stop(draft.id);
  assert.equal(stopped.execution, "stopped"); assert.equal(stopped.tasks[0]?.status, "completed");
  assert.match(stopped.workspaceCheckpoint!, /^local-v2:/);
  const tree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: project })).stdout.trim();
  await exec("git", ["update-ref", "refs/codex/turn-diffs/checkpoints/fixture/resume", tree], { cwd: project });
  assert.equal(await localWorkspaceFingerprint(stopped.workspace!), stopped.workspaceCheckpoint);
  await engine.close(); real = new CodexAdapter(); engine = new WorkflowEngine({ store: new RunStore(state), adapter });
  await engine.start({ id: stopped.id, revision: stopped.revision }, true); const done = await engine.wait(stopped.id);
  assert.equal(done.execution, "completed", done.error); assert.equal(done.review, "ready"); assert.equal(done.application, "none"); assert.equal(calls, 3); assert.equal(realCalls, 2);
  assert.equal(done.tasks[0]?.cached, true); assert.equal(done.tasks[0]?.attempts.length, 1);
  assert.equal(visibleBeforeCompletion, true); assert.equal(done.workspacePath, project); assert.match(done.workspaceCheckpoint!, /^local-v2:/);
  assert.ok(done.tasks.every(task => task.executionSettings?.model === "gpt-6-luna" && task.executionSettings.reasoningEffort === "max"));
  await exec(process.execPath, ["--test", "sum.test.mjs"], { cwd: project });
  assert.equal(await readFile(path.join(project, "sum.test.mjs"), "utf8"), originalTest);
  assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), "existing user edit; preserve this file\n");
  assert.equal((await exec("git", ["ls-files", "--stage"], { cwd: project })).stdout, indexBefore);
  await assert.rejects(engine.apply(done.id, done.revision), /already in the original project/);
  const deletion = new DeletionService(store, new TemplateStore(store), { readEffectiveConfig: async () => ({}) });
  const preview = await deletion.preview({ kind: "run", id: done.id, revision: done.revision }); assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
  const removed = await deletion.execute({ ...preview.target, fingerprint: preview.fingerprint }); assert.equal(removed.deleted, true);
  await assert.rejects(stat(store.directory(done.id)), { code: "ENOENT" });
  await exec(process.execPath, ["--test", "sum.test.mjs"], { cwd: project });
  console.log(JSON.stringify({ success: true, realWorkers: realCalls, heldDispatches: calls - realCalls, model: "gpt-6-luna", effort: "max", stoppedAndRestarted: true, internalCheckpointRefPreservedCache: true, immediateLocalEdits: true, independentTestsPassed: true, userFilesAndIndexPreserved: true, applicationRequired: false, deletedRunPreservedProject: true }));
} finally { await engine?.close(); if (!engine) await real.close(); await rm(root, { recursive: true, force: true }); }
