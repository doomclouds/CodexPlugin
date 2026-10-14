import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/((?:token|secret|password|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]").slice(0, 1200);
type Run = Record<string, any>;

async function main() {
  if (!process.argv.includes("--real-commands")) throw new Error("Pass --real-commands to authorize native commands in disposable fixtures. No model turns are sent.");
  assert.ok(process.env.CODEX_CLI_PATH, "CODEX_CLI_PATH must select the actual desktop CLI");
  const source = path.resolve(option("--plugin-root") ?? fileURLToPath(new URL("../plugins/workflows", import.meta.url)));
  const expected = option("--expected-version") ?? JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8")).version;
  const reportPath = option("--report");
  const root = await mkdtemp(path.join(tmpdir(), "workflows-protected-maintenance-"));
  const project = path.join(root, "project"), state = path.join(root, "state"), released = path.join(root, "package");
  let client: Client | undefined, connected = false, cleaned = false, failure: unknown;
  const ids: string[] = [];
  let report: Record<string, unknown> | undefined;
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", ...args], { cwd: project })).stdout.trim();
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Run> => {
    const response = await client!.callTool({ name, arguments: args });
    if (response.isError) throw new Error((response.content as Array<{ text?: string }>).map(value => value.text ?? "").join("\n"));
    return response.structuredContent as Run;
  };
  const terminal = async (id: string) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const run = (await call("workflow_get_run", { id })).run as Run;
      if (["completed", "failed", "stopped"].includes(run.execution)) return run;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await call("workflow_stop", { id });
    throw new Error("Native fixture exceeded its deadline");
  };
  try {
    await cp(source, released, { recursive: true }); await mkdir(project); await mkdir(state);
    const hooks = path.join(root, "empty-hooks"); await mkdir(hooks);
    await git("init", "--quiet", "-b", "main");
    await git("config", "core.hooksPath", hooks);
    await mkdir(path.join(project, ".agents/skills/old"), { recursive: true });
    await writeFile(path.join(project, ".agents/skills/old/SKILL.md"), "Old tracked skill\n");
    await writeFile(path.join(project, ".agents/guard.txt"), "Protected sibling\n");
    await writeFile(path.join(project, "original-guard.txt"), "Original project\n");
    await git("add", ".");
    const commit = async (message: string) => git("-c", "commit.gpgsign=false", "-c", "user.name=Workflow Maintenance Smoke", "-c", "user.email=workflow-maintenance@example.invalid", "commit", "--quiet", "-m", message);
    await commit("Create disposable protected-path fixture");
    const base = await git("rev-parse", "HEAD");
    await git("checkout", "--quiet", "-b", "incoming");
    await rm(path.join(project, ".agents/skills/old"), { recursive: true });
    await mkdir(path.join(project, ".agents/skills/new"));
    await writeFile(path.join(project, ".agents/skills/new/SKILL.md"), "New tracked skill\n");
    await git("add", "."); await commit("Update tracked skills in disposable fixture");
    const target = await git("rev-parse", "HEAD"); await git("checkout", "--quiet", "main");
    const initialStatus = await git("status", "--porcelain=v1"); assert.equal(initialStatus, "");
    const environment = Object.fromEntries(Object.entries({ ...process.env, WORKFLOWS_DATA_DIR: state, WORKFLOWS_CODEX_COMMAND: process.env.CODEX_CLI_PATH }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(released, "runtime/index.js")], cwd: root, env: environment, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "workflow_protected_maintenance_smoke", version: "1" }); await client.connect(transport); connected = true;
    assert.equal((await call("workflow_get_capabilities")).version, expected);
    const boundaryCode = String.raw`const fs=require('node:fs'); const p=require('node:path');
const denied=[];
for(const name of [p.resolve('.agents/guard.txt'),p.join(process.argv[1],'original-guard.txt')]) {
 try {fs.writeFileSync(name,'UNAUTHORIZED');throw new Error('Sandbox permitted a forbidden write');}
 catch(error){if(!['EPERM','EACCES','EROFS'].includes(error.code))throw error;denied.push(true);}
}
const allowed=p.resolve('.agents/skills/probe.txt'); fs.writeFileSync(allowed,'Allowed isolated scratch'); fs.unlinkSync(allowed);
console.log(JSON.stringify({protectedSiblingDenied:denied[0],originalDenied:denied[1],declaredDirectoryWritable:true}));`;
    const script = 'export const meta={name:"protected-maintenance-smoke",description:"Fast-forward tracked skills inside an isolated checkout and verify write boundaries",phases:[{title:"Update"},{title:"Boundaries"}]}; phase("Update"); await operation("fast-forward"); phase("Boundaries"); return JSON.parse((await operation("boundary")).stdout);';
    const input = { projectPath: project, script, args: {}, allowWrite: true, networkAccess: false, workspaceMode: "git-worktree", maintenance: { steps: [
      { id: "fast-forward", command: ["git", "merge", "--ff-only", target], timeoutMs: 30_000 },
      { id: "boundary", command: [process.execPath, "-e", boundaryCode, project], timeoutMs: 30_000 },
    ] }, limits: { maxCalls: 3, timeoutMs: 120_000 } };
    let denied = (await call("workflow_preview", input)).run as Run; ids.push(denied.id);
    await call("workflow_start", { id: denied.id, revision: denied.revision }); denied = await terminal(denied.id);
    assert.equal(denied.execution, "failed"); assert.match(denied.error, /Operation fast-forward failed/);
    assert.match(denied.error, /Operation not permitted|Permission denied/);
    const scoped = { ...input, maintenance: { steps: input.maintenance.steps.map(step => ({ ...step, protectedPaths: [".agents/skills"] })) } };
    await assert.rejects(call("workflow_update", { id: denied.id, revision: denied.revision, script, args: {}, maintenance: scoped.maintenance }), /scope requires a new preview/);
    let granted = (await call("workflow_preview", scoped)).run as Run; ids.push(granted.id);
    assert.deepEqual(granted.maintenance.steps[0].protectedPaths, [".agents/skills"]);
    await call("workflow_start", { id: granted.id, revision: granted.revision }); granted = await terminal(granted.id);
    assert.equal(granted.execution, "completed", granted.error);
    assert.deepEqual(granted.result, { protectedSiblingDenied: true, originalDenied: true, declaredDirectoryWritable: true });
    const work = granted.workspace.root;
    const gitWork = async (...args: string[]) => (await execute("git", ["--no-optional-locks", ...args], { cwd: work })).stdout.trim();
    assert.equal(await gitWork("rev-parse", "HEAD"), target); assert.equal(await gitWork("status", "--porcelain=v1"), "");
    await assert.rejects(access(path.join(work, ".agents/skills/old/SKILL.md")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(work, ".agents/skills/new/SKILL.md"), "utf8"), "New tracked skill\n");
    assert.equal(await git("rev-parse", "HEAD"), base); assert.equal(await git("status", "--porcelain=v1"), initialStatus);
    assert.equal(await readFile(path.join(project, "original-guard.txt"), "utf8"), "Original project\n");
    assert.equal(await readFile(path.join(project, ".agents/guard.txt"), "utf8"), "Protected sibling\n");
    assert.equal(granted.tasks.some((task: Run) => task.attempts.some((attempt: Run) => attempt.threadId)), false);
    report = { success: true, version: expected, ungrantedFastForwardRejected: true, grantedFastForwardCompleted: true, updateRequiresNewPreview: true, targetHeadVerified: true, trackedRemovalAndAdditionVerified: true, isolatedCheckoutClean: true, originalHeadAndStatusUnchanged: true, ...granted.result, modelTurns: 0 };
    console.log(JSON.stringify({ event: "verified", ...report }));
  } catch (error) { failure = error; }
  finally {
    try {
      if (connected) {
        for (const id of ids) {
          let run = (await call("workflow_get_run", { id })).run as Run;
          if (["preparing", "running", "stopping"].includes(run.execution)) { await call("workflow_stop", { id }); run = (await call("workflow_get_run", { id })).run; }
          const target = { kind: "run", id, revision: run.revision };
          const preview = (await call("workflow_preview_deletion", target)).preview;
          assert.equal(preview.canDelete, true, JSON.stringify(preview.blocked));
          const deleted = (await call("workflow_delete", { ...target, fingerprint: preview.fingerprint })).deletion;
          assert.equal(deleted.deleted, true); assert.deepEqual(deleted.remaining, []);
        }
        assert.deepEqual((await call("workflow_list_runs")).runs, []);
        assert.equal((await readdir(state)).includes(".deletions"), false); cleaned = true;
      }
    } catch (error) { failure ??= error; }
    await client?.close().catch(error => { failure ??= error; });
    if (cleaned || !ids.length) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ event: "cleanup-blocked", preservedFixture: root }));
    if (reportPath) await writeFile(path.resolve(reportPath), JSON.stringify({ ...report, success: !failure && cleaned, cleaned, ...(failure ? { error: safeError(failure) } : {}) }, null, 2), { mode: 0o600 });
  }
  if (failure) throw failure;
  assert.equal(cleaned, true);
}
try { await main(); }
catch (error) { console.error(JSON.stringify({ success: false, error: safeError(error) })); process.exitCode = 1; }
