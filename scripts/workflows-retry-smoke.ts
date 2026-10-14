import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const model = "gpt-6-luna", effort = "max";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const argument = (name: string): string | undefined => {
  const position = process.argv.indexOf(name);
  if (position < 0) return undefined;
  const value = process.argv[position + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/https?:\/\/\S+/g, "[url]")
  .replace(/((?:token|secret|password|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]")
  .slice(0, 600);
type Run = Record<string, any>;

async function main() {
  if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers to authorize three real gpt-6-luna/max workers in a disposable fixture.");
  const signedCommand = process.env.CODEX_CLI_PATH;
  if (!signedCommand) throw new Error("CODEX_CLI_PATH must identify the actual desktop CLI for this smoke test.");
  const source = path.resolve(argument("--plugin-root") ?? fileURLToPath(new URL("../plugins/workflows", import.meta.url)));
  const reportPath = argument("--report");
  const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
  const expectedVersion = argument("--expected-version") ?? manifest.version;
  assert.equal(manifest.version, expectedVersion, "Build the requested patch before running the real smoke test.");
  const root = await mkdtemp(path.join(tmpdir(), "workflows-retry-mcp-"));
  const project = path.join(root, "project"), state = path.join(root, "state"), isolatedPackage = path.join(root, "package");
  let client: Client | undefined, run: Run | undefined;
  let connected = false, deletionConfirmed = false;
  let report: Record<string, unknown> | undefined;
  let failure: unknown;

  const tool = async (name: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const response = await client!.callTool({ name, arguments: input });
    const content: unknown[] = Array.isArray(response.content) ? response.content : [];
    const text = content.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    });
    if (response.isError) throw new Error(text.join("\n"));
    if (response.structuredContent) return response.structuredContent as Record<string, any>;
    if (!text.length) throw new Error(`${name} returned no structured result.`);
    return JSON.parse(text[0]!);
  };
  const terminal = async (id: string): Promise<Run> => {
    const deadline = Date.now() + 240_000;
    let stateLabel = "";
    while (Date.now() < deadline) {
      const current = (await tool("workflow_get_run", { id })).run as Run;
      if (current.execution !== stateLabel) {
        stateLabel = current.execution;
        console.log(JSON.stringify({ event: "progress", execution: stateLabel, tasks: current.tasks.map((task: Run) => ({ id: task.id, status: task.status, cached: task.cached })) }));
      }
      if (["completed", "failed", "stopped"].includes(current.execution)) return current;
      await delay(1000);
    }
    await tool("workflow_stop", { id });
    throw new Error("Timed out waiting for a real terminal state.");
  };
  const workerAttempts = (value: Run): Run[] => value.tasks.flatMap((task: Run) => task.attempts.filter((attempt: Run) => attempt.startedAt && attempt.threadId && attempt.turnId));
  const validateWorkers = (value: Run, expectedCount: number) => {
    const attempts = workerAttempts(value);
    assert.equal(attempts.length, expectedCount);
    assert.equal(new Set(attempts.map(attempt => attempt.threadId)).size, expectedCount, "Every real attempt must have an independent Codex worker identity.");
    for (const attempt of attempts) {
      assert.equal(attempt.status, "completed");
      assert.equal(attempt.executionSettings?.model, model);
      assert.equal(attempt.executionSettings?.reasoningEffort, effort);
      assert.equal(attempt.executionSettings?.provenance, "configured");
      assert.ok(attempt.toolsUsed?.includes("native:commandExecution"), "Each worker must actually read its fixture input using native tools.");
    }
    assert.equal(JSON.stringify(value.logs).includes("no rollout found"), false);
    return attempts;
  };
  const fixtureGit = async (args: string[]) => (await execute("git", ["--no-optional-locks", ...args], { cwd: project })).stdout.trim();
  try {
    await cp(source, isolatedPackage, { recursive: true, errorOnExist: true });
    await mkdir(project); await mkdir(state, { mode: 0o700 }); await mkdir(path.join(project, "dist"));
    const emptyHooks = path.join(root, "empty-hooks"); await mkdir(emptyHooks);
    await fixtureGit(["init", "--quiet", "-b", "main"]);
    const marker = `retry-${randomBytes(12).toString("hex")}`;
    await writeFile(path.join(project, "marker.txt"), marker + "\n");
    await writeFile(path.join(project, ".gitignore"), "dist/\n");
    await writeFile(path.join(project, "dist/approval.json"), JSON.stringify({ accepted: false }) + "\n");
    await fixtureGit(["add", "--", "marker.txt", ".gitignore"]);
    await fixtureGit(["-c", "core.hooksPath=" + emptyHooks, "-c", "commit.gpgsign=false", "-c", "user.name=Workflow Retry Smoke", "-c", "user.email=workflow-retry@example.invalid", "commit", "--quiet", "-m", "Create disposable retry fixture"]);
    const initialHead = await fixtureGit(["rev-parse", "HEAD"]);
    assert.equal(await fixtureGit(["status", "--porcelain=v1"]), "");
    const environment = Object.fromEntries(Object.entries({ ...process.env, WORKFLOWS_DATA_DIR: state, WORKFLOWS_CODEX_COMMAND: signedCommand }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(isolatedPackage, "runtime/index.js")], cwd: root, env: environment, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "workflows_retry_mcp_smoke", version: "1" });
    await client.connect(transport); connected = true;
    const capabilities = await tool("workflow_get_capabilities");
    assert.equal(capabilities.version, expectedVersion);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 21);
    const resumeSchema = catalog.tools.find(value => value.name === "workflow_resume")!.inputSchema;
    assert.ok(resumeSchema.properties?.retryFromTaskId, "The public MCP ABI must expose the explicit retry boundary.");
    assert.equal(resumeSchema.required?.includes("retryFromTaskId"), false);

    const schemaMarker = { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false };
    const schemaApproval = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false };
    const args = {
      prefixPrompt: "Use native shell to read marker.txt from the current project and return its exact trimmed contents as marker. Do not modify files, delegate nested agents, access network or use external tools.",
      approvalPrompt: "Use native shell to read dist/approval.json from the current project and return its actual accepted boolean. Do not modify files, delegate nested agents, access network or use external tools. Do not infer approval from this request.",
      schemaMarker, schemaApproval,
    };
    const script = `export const meta = { name: "real-targeted-retry", description: "只读核验外部验收输入；明确重试一个节点并保留前序缓存", phases: [{ title: "前序" }, { title: "验收" }] };
phase("前序");
const prefix = await agent(args.prefixPrompt, { label: "读取固定标识", model: "gpt-6-luna", reasoningEffort: "max", schema: args.schemaMarker });
phase("验收");
const validation = await agent(args.approvalPrompt, { label: "核验验收输入", model: "gpt-6-luna", reasoningEffort: "max", schema: args.schemaApproval });
if (!validation.accepted) throw new Error("Business acceptance not approved");
return { prefix, validation };`;
    run = (await tool("workflow_preview", { projectPath: project, script, args, allowWrite: false, networkAccess: false, allowedMcpServers: [], limits: { maxReadWorkers: 1, maxCalls: 3, timeoutMs: 180000, maxTokens: 0 } })).run;
    await tool("workflow_start", { id: run!.id, revision: run!.revision });
    run = await terminal(run!.id);
    assert.equal(run.execution, "failed");
    assert.match(run.error, /Business acceptance not approved/);
    assert.deepEqual(run.tasks.map((task: Run) => task.status), ["completed", "completed"]);
    assert.deepEqual(run.tasks.map((task: Run) => task.attempts.length), [1, 1]);
    assert.deepEqual(run.tasks[0].output, { marker });
    assert.deepEqual(run.tasks[1].output, { accepted: false });
    const firstAttempts = validateWorkers(run, 2);
    const firstIdentities = firstAttempts.map(attempt => attempt.threadId);
    console.log(JSON.stringify({ event: "initial-business-failure", execution: run.execution, realWorkers: 2, attempts: [1, 1], prefixCompleted: true, validationCompletedButRejected: true }));

    await writeFile(path.join(project, "dist/approval.json"), JSON.stringify({ accepted: true }) + "\n");
    assert.equal(await fixtureGit(["rev-parse", "HEAD"]), initialHead);
    assert.equal(await fixtureGit(["status", "--porcelain=v1"]), "");
    await tool("workflow_resume", { id: run.id, revision: run.revision });
    run = await terminal(run.id);
    assert.equal(run.execution, "failed");
    assert.match(run.error, /Business acceptance not approved/);
    assert.deepEqual(run.tasks.map((task: Run) => task.attempts.length), [1, 1]);
    assert.deepEqual(run.tasks.map((task: Run) => task.cached), [true, true]);
    assert.deepEqual(run.tasks[1].output, { accepted: false });
    assert.deepEqual(validateWorkers(run, 2).map(attempt => attempt.threadId), firstIdentities);
    console.log(JSON.stringify({ event: "ordinary-resume-cached-failure", execution: run.execution, realWorkersAdded: 0, attempts: [1, 1], cached: [true, true] }));

    await tool("workflow_resume", { id: run.id, revision: run.revision, retryFromTaskId: "task_2" });
    run = await terminal(run.id);
    assert.equal(run.execution, "completed", run.error);
    assert.deepEqual(run.result, { prefix: { marker }, validation: { accepted: true } });
    assert.deepEqual(run.tasks.map((task: Run) => task.attempts.length), [1, 2]);
    assert.deepEqual(run.tasks.map((task: Run) => task.cached), [true, false]);
    const finalAttempts = validateWorkers(run, 3);
    assert.equal(run.tasks[0].attempts[0].threadId, firstIdentities[0]);
    assert.equal(run.tasks[1].attempts[0].threadId, firstIdentities[1]);
    assert.notEqual(run.tasks[1].attempts[1].threadId, firstIdentities[1]);
    assert.equal(await fixtureGit(["rev-parse", "HEAD"]), initialHead);
    assert.equal(await fixtureGit(["status", "--porcelain=v1"]), "");
    const node = (await tool("workflow_get_node_process", { id: run.id, taskId: "task_2", detail: "brief" })).process;
    assert.equal(node.status, "completed");
    report = { test: "real-mcp-targeted-retry", success: true, version: capabilities.version, model, effort, publicTools: catalog.tools.length, resumeRetryFieldPresent: true, execution: run.execution, realWorkerCalls: finalAttempts.length, attempts: [1, 2], prefixCached: true, validationFreshRead: true, ordinaryResumeAddedWorkers: 0, originalGitHeadAndStatusUnchanged: true, workers: finalAttempts.map(attempt => ({ id: attempt.id, configured: attempt.executionSettings, tools: attempt.toolsUsed, usage: attempt.usage, startedAt: attempt.startedAt, endedAt: attempt.endedAt })) };
    console.log(JSON.stringify({ event: "explicit-retry-completed", ...report }));
  } catch (error) { failure = error; }
  finally {
    try {
      if (connected && run?.id) {
        const current = (await tool("workflow_get_run", { id: run.id })).run;
        if (["preparing", "running", "stopping"].includes(current.execution)) await tool("workflow_stop", { id: run.id });
        run = (await tool("workflow_get_run", { id: run.id })).run;
        const deletion = (await tool("workflow_preview_deletion", { kind: "run", id: run!.id, revision: run!.revision })).preview;
        assert.equal(deletion.canDelete, true, JSON.stringify(deletion.blocked));
        const deleted = (await tool("workflow_delete", { kind: "run", id: run!.id, revision: run!.revision, fingerprint: deletion.fingerprint })).deletion;
        assert.equal(deleted.deleted, true); assert.deepEqual(deleted.remaining, []);
        assert.equal((await tool("workflow_list_runs")).runs.length, 0);
        await assert.rejects(access(path.join(state, run!.id)), { code: "ENOENT" });
        assert.equal((await readdir(state)).includes(".deletions"), false);
        deletionConfirmed = true;
        console.log(JSON.stringify({ event: "cleanup", deleted: true, remainingRuns: 0, deletionMetadataAbsent: true }));
      }
    } catch (error) { failure ??= error; }
    finally { await client?.close().catch(error => { failure ??= error; }); }
    if (!run || deletionConfirmed) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ event: "cleanup-blocked", preservedFixture: root, error: safeError(failure) }));
    if (report && reportPath) {
      const output = path.resolve(reportPath); await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ ...report, success: !failure && deletionConfirmed, cleanup: { deleted: deletionConfirmed, fixtureRemoved: deletionConfirmed } }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ event: "report", path: output }));
    }
  }
  if (failure) throw failure;
  assert.equal(deletionConfirmed, true);
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ test: "real-mcp-targeted-retry", success: false, error: safeError(error) })); process.exitCode = 1; }
