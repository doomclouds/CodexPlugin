import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerAdapter } from "../src/adapter.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";

if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and starts four real logged-in Codex workers.");

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-local-git-real-")));
const origin = path.join(root, "origin.git"), author = path.join(root, "author"), project = path.join(root, "project");
const nativeNode = await realpath(process.execPath);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim();
const commit = (message: string) => git(author, ["-c", "user.name=Workflow Fixture", "-c", "user.email=workflow@example.invalid", "commit", "--quiet", "-m", message]);
const real = new CodexAdapter({ command: process.env.CODEX_CLI_PATH ?? "codex" });
let realWorkers = 0;
const adapter: WorkerAdapter = {
  executionEnvironment: (cwd, signal) => real.executionEnvironment(cwd, signal),
  run: async (request, signal, onEvent) => {
    assert.equal(request.cwd, project);
    assert.equal(request.mode, "write");
    assert.equal(request.networkAccess, false);
    assert.deepEqual(request.mcpServers ?? [], []);
    assert.equal(request.model, "gpt-6-luna");
    assert.equal(request.reasoningEffort, "max");
    realWorkers++;
    return real.run(request, signal, onEvent);
  },
  close: () => real.close(),
};
let engine: WorkflowEngine | undefined;

// The same workflow is used for both remote states. Its agents execute native
// commands, and the harness independently verifies their filesystem results.
const script = `export const meta = {name:"local-git-real",description:"Fetch the fixed fixture remote, fast-forward if needed, and always build",phases:[{title:"更新代码"},{title:"构建"}]};
phase("更新代码");
const update = await agent(args.updateCommand,{mode:"write",label:"获取远端并核对本地提交",model:"gpt-6-luna",reasoningEffort:"max",schema:{type:"object",additionalProperties:false,properties:{status:{type:"string",enum:["updated","unchanged"]},beforeSha:{type:"string"},targetSha:{type:"string"},trackedClean:{type:"boolean"}},required:["status","beforeSha","targetSha","trackedClean"]}});
if (!["updated","unchanged"].includes(update.status) || !update.trackedClean || !update.targetSha) throw new Error("Git update was not verified");
phase("构建");
const build = await agent(args.buildCommand+"\\nRequired HEAD: "+update.targetSha,{mode:"write",label:"执行原生 Node 构建验证",model:"gpt-6-luna",reasoningEffort:"max",schema:{type:"object",additionalProperties:false,properties:{passed:{type:"boolean"},targetSha:{type:"string"},version:{type:"string"},buildCount:{type:"integer"}},required:["passed","targetSha","version","buildCount"]}});
if (!build.passed || build.targetSha !== update.targetSha) throw new Error("Build did not verify the fetched commit");
return {update,build};`;

const updateSource = `const wf_fs=require("node:fs"),wf_path=require("node:path"),wf_cp=require("node:child_process");
const wf_expected=${JSON.stringify(project)};
if(wf_fs.realpathSync(process.cwd())!==wf_expected)throw new Error("Unexpected worker directory");
const wf_git=(wf_args)=>{const wf_result=wf_cp.spawnSync("git",wf_args,{cwd:wf_expected,encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});if(wf_result.error)throw wf_result.error;if(wf_result.status!==0)throw new Error("git "+wf_args[0]+": "+wf_result.stderr);return wf_result.stdout.trim();};
if(wf_git(["branch","--show-current"])!=="main")throw new Error("Unexpected branch");
if(wf_git(["status","--porcelain=v1","--untracked-files=all"])!=="")throw new Error("Source tree is dirty");
const wf_before=wf_git(["rev-parse","HEAD"]);
wf_git(["fetch","--no-tags","origin","+refs/heads/main:refs/remotes/origin/main"]);
const wf_target=wf_git(["rev-parse","refs/remotes/origin/main"]);
if(!/^[0-9a-f]{40,64}$/.test(wf_target))throw new Error("Invalid target identity");
if(wf_before!==wf_target){wf_git(["merge-base","--is-ancestor",wf_before,wf_target]);wf_git(["merge","--ff-only",wf_target]);}
if(wf_git(["rev-parse","HEAD"])!==wf_target)throw new Error("HEAD did not reach the pinned target");
const wf_result={status:wf_before===wf_target?"unchanged":"updated",beforeSha:wf_before,targetSha:wf_target,trackedClean:wf_git(["status","--porcelain=v1","--untracked-files=all"])===""};
if(!wf_result.trackedClean)throw new Error("Source tree changed unexpectedly");
wf_fs.writeFileSync(wf_path.join(wf_expected,".workflow-test","update-proof.json"),JSON.stringify(wf_result));
process.stdout.write(JSON.stringify(wf_result)+"\\n");`;

const buildSource = `const wf_fs=require("node:fs"),wf_cp=require("node:child_process");
const wf_run=wf_cp.spawnSync(${JSON.stringify(nativeNode)},["--test","build.test.mjs"],{cwd:process.cwd(),encoding:"utf8"});
if(wf_run.error)throw wf_run.error;if(wf_run.status!==0)throw new Error(wf_run.stdout+wf_run.stderr);
const wf_result=JSON.parse(wf_fs.readFileSync(".workflow-test/build-proof.json","utf8"));
process.stdout.write(JSON.stringify(wf_result)+"\\n");`;

const instructions = (source: string) => `Execute exactly this native command once and return its actual JSON output. Do not rewrite the command, edit source files, stage or commit, use external MCP tools or network services, or assign shell variables. A command error must stop the task; do not retry or bypass its sandbox. The only Git remote is the local disposable fixture. Command:\n${quote(nativeNode)} -e ${quote(source)}`;

try {
  await mkdir(author);
  await git(root, ["init", "--bare", "--initial-branch=main", "--quiet", origin]);
  await git(author, ["init", "--initial-branch=main", "--quiet"]);
  await writeFile(path.join(author, ".gitignore"), ".workflow-test/\nuser-notes.txt\n");
  await writeFile(path.join(author, "version.mjs"), 'export const version = "v1";\n');
  await writeFile(path.join(author, "build.test.mjs"), `import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import test from "node:test";
import {version} from "./version.mjs";
test("build the actual checked-out fixture",()=>{
  assert.ok(["v1","v2"].includes(version));
  const wf_target=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  const wf_update=JSON.parse(readFileSync(".workflow-test/update-proof.json","utf8"));
  assert.equal(wf_target,wf_update.targetSha);
  let wf_count=0;
  try{wf_count=JSON.parse(readFileSync(".workflow-test/build-proof.json","utf8")).buildCount;}catch(wf_error){if(wf_error.code!=="ENOENT")throw wf_error;}
  writeFileSync(".workflow-test/build-proof.json",JSON.stringify({passed:true,targetSha:wf_target,version,buildCount:wf_count+1}));
});\n`);
  await git(author, ["add", ".gitignore", "version.mjs", "build.test.mjs"]);
  await commit("Add local Git build fixture");
  await git(author, ["remote", "add", "origin", origin]);
  await git(author, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  await git(root, ["clone", "--quiet", origin, project]);
  await mkdir(path.join(project, ".workflow-test"));
  const userNote = "Existing ignored user file: keep its contents unchanged.\n";
  await writeFile(path.join(project, "user-notes.txt"), userNote);
  const initialSha = await git(project, ["rev-parse", "HEAD"]);
  const initialIndex = await git(project, ["ls-files", "--stage"]);
  const originalTest = await readFile(path.join(project, "build.test.mjs"), "utf8");
  engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });

  const run = async (expectedStatus: "updated" | "unchanged", targetSha: string, version: string, count: number) => {
    const draft = await engine!.preview({
      projectPath: project, script, allowWrite: true, workspaceMode: "local", networkAccess: false, allowedMcpServers: [],
      limits: { maxCalls: 2, maxReadWorkers: 1, timeoutMs: 600000 },
      args: { updateCommand: instructions(updateSource), buildCommand: instructions(buildSource) },
    });
    console.log(JSON.stringify({ stage: `real-local-git-${expectedStatus}-then-build`, id: draft.id, model: "gpt-6-luna", effort: "max" }));
    await engine!.start({ id: draft.id, revision: draft.revision });
    const done = await engine!.wait(draft.id);
    assert.equal(done.execution, "completed", done.error);
    assert.equal(done.review, "ready");
    assert.equal(done.application, "none");
    assert.equal(done.tasks.length, 2);
    assert.ok(done.tasks.every(task => task.status === "completed" && task.attempts.length === 1));
    assert.ok(done.tasks.every(task => task.executionSettings?.model === "gpt-6-luna" && task.executionSettings.reasoningEffort === "max"));
    assert.ok(done.tasks.every(task => task.attempts[0]?.toolsUsed?.includes("native:commandExecution")));
    const report = done.result as { update: { status: string; beforeSha: string; targetSha: string; trackedClean: boolean }; build: { passed: boolean; targetSha: string; version: string; buildCount: number } };
    assert.equal(report.update.status, expectedStatus);
    assert.equal(report.update.beforeSha, initialSha);
    assert.equal(report.update.targetSha, targetSha);
    assert.equal(report.update.trackedClean, true);
    assert.deepEqual(report.build, { passed: true, targetSha, version, buildCount: count });
    assert.deepEqual(JSON.parse(await readFile(path.join(project, ".workflow-test", "update-proof.json"), "utf8")), report.update);
    assert.deepEqual(JSON.parse(await readFile(path.join(project, ".workflow-test", "build-proof.json"), "utf8")), report.build);
    assert.equal(await git(project, ["rev-parse", "HEAD"]), targetSha);
    assert.equal(await git(project, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(await readFile(path.join(project, "user-notes.txt"), "utf8"), userNote);
    assert.equal(await readFile(path.join(project, "build.test.mjs"), "utf8"), originalTest);
    return done;
  };

  const unchanged = await run("unchanged", initialSha, "v1", 1);
  assert.equal(await git(project, ["ls-files", "--stage"]), initialIndex);
  await writeFile(path.join(author, "version.mjs"), 'export const version = "v2";\n');
  await git(author, ["add", "version.mjs"]);
  await commit("Advance only the fixture version");
  await git(author, ["push", "--quiet", "origin", "main"]);
  const advancedSha = await git(author, ["rev-parse", "HEAD"]);
  assert.notEqual(advancedSha, initialSha);
  assert.equal(await git(project, ["rev-parse", "HEAD"]), initialSha);
  const updated = await run("updated", advancedSha, "v2", 2);
  assert.equal(unchanged.script, updated.script);
  assert.equal(realWorkers, 4);
  console.log(JSON.stringify({ success: true, realWorkers, model: "gpt-6-luna", effort: "max", noSourceChangesStillBuilt: true, fastForwardThenBuilt: true, nativeGitAndTestsVerified: true, localRemoteOnly: true, identicalWorkflow: true, ignoredUserFilePreserved: true, unchangedIndexPreserved: true, applicationRequired: false }));
} finally {
  await engine?.close();
  if (!engine) await real.close();
  await rm(root, { recursive: true, force: true });
}
