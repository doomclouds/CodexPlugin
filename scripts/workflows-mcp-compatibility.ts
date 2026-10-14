import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProtocolSession } from "../plugins/workflows/src/adapter.ts";

const execute = promisify(execFile);
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "[url]").replace(/((?:token|password|secret|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]").slice(0, 300);
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = async (filename: string) => createHash("sha256").update(await readFile(filename)).digest("hex");
const started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "workflows-mcp-compatibility-"));
const project = path.join(root, "project");
const state = path.join(root, "state");
const isolatedPackage = path.join(root, "installed-package");
const reportPath = process.env.WORKFLOWS_MCP_REPORT ?? path.join(root, "report.json");
const report: Record<string, any> = { model: "gpt-6-luna", reasoningEffort: "max", scope: { mode: "read", allowWrite: false, networkAccess: false, allowedMcpServers: ["rea"], allowedMcpTools: { rea: ["binary_session"] } }, status: "preparing", fixtureRoot: root };
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let session: ProtocolSession | undefined;
let run: Record<string, any> | undefined;

async function checkpoint() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ...report, durationMs: Date.now() - started }, null, 2), { mode: 0o600 });
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  if (response.isError) throw new Error(`${name}: ${(response.content as Array<{ text?: string }>).map(item => item.text ?? "").join(" ")}`);
  return object(response.structuredContent);
}
async function cleanupRun() {
  if (!run || !client) return;
  let latest = object((await call("workflow_get_run", { id: run.id })).run);
  if (["preparing", "running", "stopping"].includes(latest.execution)) latest = object((await call("workflow_stop", { id: run.id })).run);
  const target = { kind: "run", id: latest.id, revision: latest.revision };
  const preview = object((await call("workflow_preview_deletion", target)).preview);
  report.cleanupPreview = { canDelete: preview.canDelete, files: preview.totalFiles, bytes: preview.totalBytes, blocked: preview.blocked };
  assert.equal(preview.canDelete, true, `Fixture cleanup blocked: ${JSON.stringify(preview.blocked)}`);
  const deleted = object((await call("workflow_delete", { ...target, fingerprint: preview.fingerprint })).deletion);
  report.cleanup = { deleted: deleted.deleted, partial: deleted.partial, remaining: deleted.remaining, blocked: deleted.blocked };
  assert.equal(deleted.deleted, true, "Fixture deletion must complete through the product API.");
  assert.deepEqual((await call("workflow_list_runs")).runs, []);
  assert.equal(await stat(path.join(state, latest.id)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false);
  assert.equal(await stat(path.join(state, ".deletions")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false);
}

async function main() {
  if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers for one authorized real read-only worker and fixture cleanup.");
  const cli = process.env.CODEX_CLI_PATH;
  if (!cli || !path.isAbsolute(cli)) throw new Error("CODEX_CLI_PATH must select the signed desktop CLI explicitly.");
  const installed = process.env.WORKFLOWS_INSTALLED_PACKAGE ?? path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "plugins", "cache", "codex-plugin-workspace", "workflows", "0.5.3");
  const manifest = JSON.parse(await readFile(path.join(installed, "plugin.json"), "utf8"));
  assert.equal(manifest.version, "0.5.3");
  const expectedFile = process.env.WORKFLOWS_REA_EXPECTED_IDENTITY_FILE;
  if (!expectedFile) throw new Error("Provide independently read main-chat REA identity through WORKFLOWS_REA_EXPECTED_IDENTITY_FILE.");
  const expected = JSON.parse(await readFile(expectedFile, "utf8"));
  report.independentReaIdentity = expected;
  report.cliVersion = (await execute(cli, ["--version"])).stdout.trim();
  report.installedVersion = manifest.version;
  await mkdir(project);
  await execute("git", ["init", "--quiet", "-b", "main"], { cwd: project });
  await writeFile(path.join(project, "marker.txt"), "Read-only authorized REA MCP compatibility fixture\n");
  await execute("git", ["add", "marker.txt"], { cwd: project });
  await execute("git", ["-c", "user.name=Workflow Compatibility", "-c", "user.email=workflow-compatibility@example.invalid", "commit", "--quiet", "-m", "Create disposable MCP compatibility fixture"], { cwd: project });
  const projectBefore = (await execute("git", ["status", "--porcelain=v1"], { cwd: project })).stdout;

  // Public config and inventory requests do not write configuration or start a model turn.
  session = new ProtocolSession(cli, ["app-server", "--stdio", "--disable", "plugins", "--disable", "apps", "--disable", "remote_plugin", "-c", "agents.enabled=false"], project, 30000, 2000, () => {});
  await session.request("initialize", { clientInfo: { name: "workflow_mcp_compatibility_preflight", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  session.send({ method: "initialized", params: {} });
  const config = object(object(await session.request("config/read", { cwd: project })).config);
  const configured = object(config.mcp_servers);
  report.configuredServerNames = Object.keys(configured).sort();
  assert.ok(Object.hasOwn(configured, "rea"), "The real user configuration must contain the exact authorized server name rea.");
  assert.notEqual(object(configured.rea).enabled, false);
  const roster = object(await session.request("mcpServerStatus/list", { serverName: "rea", limit: 100 }, 45000));
  const rea = (Array.isArray(roster.data) ? roster.data : []).map(object).find(server => server.name === "rea");
  if (!rea || rea.toolsError) throw new Error("Public REA MCP inventory is unavailable; no worker was dispatched.");
  const tools = Object.entries(object(rea.tools)).map(([key, value]) => ({ key, tool: object(value) }));
  const binarySession = tools.find(({ key, tool }) => (typeof tool.name === "string" ? tool.name : key) === "binary_session");
  report.preflight = { serverName: rea.name, serverInfo: rea.serverInfo, runtimeStatus: rea.runtimeStatus, toolCount: tools.length, toolName: binarySession?.tool.name ?? binarySession?.key, annotations: binarySession?.tool.annotations };
  if (!binarySession || object(binarySession.tool.annotations).readOnlyHint !== true) {
    report.status = "scope-unavailable";
    report.error = "rea/binary_session is absent or lacks readOnlyHint=true. No worker or broader grant was used.";
    console.log(JSON.stringify({ event: "rea-mcp-scope-unavailable", preflight: report.preflight, error: report.error }));
    return;
  }
  await session.close(); session = undefined;
  console.log(JSON.stringify({ event: "rea-mcp-preflight", ...report.preflight }));

  // Copy the complete already-installed GitHub package; no source-tree runtime fallback is used.
  await cp(installed, isolatedPackage, { recursive: true });
  const runtimeFiles = ["runtime/index.js", "runtime/script-worker.js", "runtime/launcher.mjs", "runtime/panel.html"];
  report.installedPackageFiles = [];
  for (const filename of runtimeFiles) { const originalHash = await sha256(path.join(installed, filename)); assert.equal(await sha256(path.join(isolatedPackage, filename)), originalHash); report.installedPackageFiles.push({ file: filename, sha256: originalHash }); }
  const sdkEnvironment = Object.fromEntries(Object.entries({ ...process.env, PATH: `${path.dirname(cli)}${path.delimiter}${process.env.PATH ?? ""}`, WORKFLOWS_CODEX_COMMAND: cli, WORKFLOWS_DATA_DIR: state }).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(isolatedPackage, "runtime", "launcher.mjs")], cwd: project, env: sdkEnvironment, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "workflows-installed-rea-compatibility", version: "1.0.0" });
  await client.connect(transport);
  const capabilities = await call("workflow_get_capabilities");
  assert.equal(capabilities.version, manifest.version); report.capabilitiesVersion = capabilities.version;
  const defaultSettings = await call("workflow_get_execution_settings", { projectPath: project });
  await call("workflow_update_execution_settings", { revision: defaultSettings.settings.revision, projectPath: project, model: report.model, reasoningEffort: report.reasoningEffort });

  const schema = { type: "object", properties: { open: { type: "boolean" }, packageVersion: { type: "string" }, serverName: { type: "string" }, serverVersion: { type: "string" }, mcpToolCount: { type: "integer" }, toolsDigest: { type: "string" }, combinedDigest: { type: "string" } }, required: ["open", "packageVersion", "serverName", "serverVersion", "mcpToolCount", "toolsDigest", "combinedDigest"], additionalProperties: false };
  const prompt = "Call the explicitly authorized rea binary_session MCP tool exactly once with an empty object. Do not use any other MCP, native shell, files, web search, network, binary opening, build or configuration writes. Do not spawn agents. From the actual returned result, report open and the following server_identity fields: package.version as packageVersion; server.name as serverName; server.version as serverVersion; catalog.counts.mcp_tools as mcpToolCount; catalog.digests.tools_sha256 as toolsDigest; catalog.digests.combined_sha256 as combinedDigest. Do not guess fields or copy facts from instructions. This is target-free status inspection only.";
  const script = 'export const meta={name:"rea-mcp-readonly-compatibility",description:"One real authorized target-free REA MCP call",phases:[{title:"REA 只读核验"}]};phase("REA 只读核验");return await agent(args.prompt,{model:"gpt-6-luna",reasoningEffort:"max",schema:args.schema,label:"REA 状态核验"});';
  const { mode: _mode, ...previewScope } = report.scope;
  run = object((await call("workflow_preview", { projectPath: project, script, args: { prompt, schema }, ...previewScope, limits: { maxCalls: 1, maxReadWorkers: 1, timeoutMs: 180000 } })).run);
  report.preview = { id: run.id, execution: run.execution, tasks: run.tasks.length };
  assert.equal(run.execution, "draft"); assert.equal(run.tasks.length, 0);
  await call("workflow_start", { id: run.id, revision: run.revision });
  const deadline = Date.now() + 190000;
  while (Date.now() < deadline) {
    run = object((await call("workflow_get_run", { id: run.id })).run);
    if (!["preparing", "running", "stopping"].includes(run.execution)) break;
    await delay(500);
  }
  const task = object(run.tasks[0]); const attempt = object(task.attempts?.at(-1));
  report.execution = { execution: run.execution, error: run.error, result: run.result, taskStatus: task.status, mode: task.mode, executionSettings: task.executionSettings, attemptError: attempt.error, toolsUsed: attempt.toolsUsed, usage: attempt.usage, activities: attempt.activities, progressSequence: run.progressSequence };
  report.nodeBrief = (await call("workflow_get_node_process", { id: run.id, taskId: task.id ?? "task_1", detail: "brief" })).process;
  await checkpoint();
  assert.equal(run.execution, "completed", run.error);
  assert.equal(task.status, "completed"); assert.equal(task.mode, "read"); assert.equal(task.executionSettings.model, report.model); assert.equal(task.executionSettings.reasoningEffort, report.reasoningEffort); assert.equal(task.executionSettings.provenance, "configured");
  assert.ok(attempt.toolsUsed?.includes("mcp:rea/binary_session"), "The real authorized MCP tool call must be recorded.");
  assert.ok(attempt.toolsUsed.every((name: string) => name === "mcp:rea/binary_session"), "No other tool was authorized by the task prompt.");
  assert.deepEqual(run.result, expected, "Worker-observed REA facts must match the independently read main-chat identity.");
  assert.equal((await execute("git", ["status", "--porcelain=v1"], { cwd: project })).stdout, projectBefore);
  assert.equal(run.workspace, undefined);
  await cleanupRun();
  report.status = "passed";
  console.log(JSON.stringify({ event: "rea-mcp-compatibility", status: report.status, version: manifest.version, model: report.model, reasoningEffort: report.reasoningEffort, facts: run.result, toolsUsed: attempt.toolsUsed, usage: attempt.usage, cleanup: report.cleanup }));
}

try { await main(); }
catch (error) { report.status = "failed"; report.error = safeError(error); console.error(JSON.stringify({ event: "rea-mcp-compatibility", status: report.status, error: report.error, preflight: report.preflight, execution: report.execution })); process.exitCode = 1; }
finally {
  if (run && !report.cleanup?.deleted) { try { await cleanupRun(); } catch (error) { report.cleanupError = safeError(error); process.exitCode = 1; } }
  await session?.close(); await client?.close(); await transport?.close();
  await checkpoint();
  // The published package, user's configurations and real workflow state are never removed.
  if (!reportPath.startsWith(`${root}${path.sep}`)) { await rm(root, { recursive: true, force: true }); report.fixtureRemoved = true; await checkpoint(); }
  console.log(JSON.stringify({ event: "rea-mcp-final", status: report.status, reportPath, durationMs: Date.now() - started, fixtureRemoved: report.fixtureRemoved ?? false }));
}
