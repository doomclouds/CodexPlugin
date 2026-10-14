import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Opt-in real host-loader regression. Uses the supplied desktop CLI, a private
// CODEX_HOME and temporary local marketplace. Never sends a model turn or
// changes the user's installation/configuration.
const cli = process.env.CODEX_CLI_PATH;
assert.ok(cli, "CODEX_CLI_PATH must explicitly select the desktop host CLI");
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "workflows-native-loader-"));
const sentinel = "workflows-native-loader-env-sentinel";
const realProjects = process.argv.includes("--real-projects");
const nativeTransport = realProjects || process.argv.includes("--native-transport");
if (nativeTransport) assert.ok(process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim(), "Real project verification requires the running desktop's supplied project pipe");
const startedAt = Date.now();
const records = [];

// This development-only MCP fixture calls tools/list, which needs no App chat
// identity. It proves the actual native transport separately from whether the
// desktop recognizes a genuine ephemeral SDK thread as an App tool caller.
const transportProbeSource = String.raw`
import net from "node:net";
import { createInterface } from "node:readline";
async function catalog() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: process.env.CODEX_APP_TOOLS_PIPE_PATH });
    let done = false, buffer = Buffer.alloc(0);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error("Native transport did not respond")), 10000);
    socket.once("connect", () => {
      const body = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: { threadStartKind: "all" } }));
      const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
    });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) return finish(new Error("Native response exceeded its frame bound"));
      if (buffer.length < 4 + length) return;
      try {
        const response = JSON.parse(buffer.subarray(4, 4 + length).toString());
        if (response.id !== 1 || response.error || !Array.isArray(response.result?.tools)) return finish(new Error("Native transport rejected the catalog request"));
        const tools = response.result.tools;
        finish(null, { toolCount: tools.length, hasProjects: tools.some(tool => tool.namespace === "codex_app" && tool.name === "list_projects"), hasThreads: tools.some(tool => tool.namespace === "codex_app" && tool.name === "list_threads") });
      } catch { finish(new Error("Native response was malformed")); }
    });
    socket.on("error", () => finish(new Error("Native transport socket failed")));
    socket.once("end", () => finish(new Error("Native transport ended before a response")));
    socket.once("close", () => finish(new Error("Native transport closed before a response")));
  });
}
createInterface({ input: process.stdin }).on("line", async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  try {
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "desktop-transport-probe", version: "1" } };
    else if (request.method === "tools/list") result = { tools: [{ name: "readonly_desktop_catalog", description: "Read native desktop tool directory without an App thread", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
    else if (request.method === "tools/call" && request.params.name === "readonly_desktop_catalog") {
      const facts = await catalog(); result = { content: [{ type: "text", text: JSON.stringify(facts) }], structuredContent: facts };
    } else throw new Error("Unsupported probe request");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  } catch (error) { console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })); }
});
`;

class HostClient {
  constructor(cwd, env) {
    this.child = spawn(cli, ["app-server", "--stdio", "--enable", "plugins", "--disable", "remote_plugin", "--disable", "apps"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 0; this.pending = new Map(); this.methods = []; this.stderr = "";
    this.closed = new Promise(resolve => this.child.once("close", resolve));
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-64 * 1024); });
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.once("close", () => this.fail(new Error("Native host closed before completing a request")));
    createInterface({ input: this.child.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Host loader regression cannot grant approvals or execute server requests" } }) + "\n");
          this.fail(new Error(`Unexpected host request ${message.method}`)); return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
  request(method, params) {
    assert.notEqual(method, "turn/start", "The host-loader regression must never invoke a model");
    this.methods.push(method);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native host ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async close() {
    this.child.stdin.end();
    let timer;
    try { await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => { this.child.kill("SIGTERM"); reject(new Error("Native host did not shut down after stdin closed")); }, 5000); })]); }
    finally { clearTimeout(timer); await this.closed; }
  }
}

async function variant(name, mutation) {
  const directory = path.join(root, name), home = path.join(directory, "home"), marketplace = path.join(directory, "marketplace"), plugin = path.join(marketplace, "plugins", "workflows");
  await mkdir(home, { recursive: true }); await mkdir(plugin, { recursive: true });
  for (const item of ["plugin.json", "package.json", "mcp.json", "runtime", "assets", "workflows", "skills", ".codex-plugin"]) await cp(path.join(packageRoot, item), path.join(plugin, item), { recursive: true });
  const mcp = JSON.parse(await readFile(path.join(plugin, "mcp.json"), "utf8"));
  mcp.mcpServers.workflows.env = { ...(mcp.mcpServers.workflows.env ?? {}), WORKFLOWS_DATA_DIR: path.join(directory, "workflow-state") };
  await mutation(mcp, plugin);
  await writeFile(path.join(plugin, "mcp.json"), JSON.stringify(mcp));
  await mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "native-loader-fixture", plugins: [{ name: "workflows", source: { source: "local", path: "./plugins/workflows" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity" }] }));
  const liveProjectProbe = name === "real-desktop-projects";
  const env = { ...process.env, CODEX_HOME: home, WORKFLOWS_DATA_DIR: path.join(directory, "workflow-state"), CODEX_APP_TOOLS_PIPE_PATH: liveProjectProbe ? process.env.CODEX_APP_TOOLS_PIPE_PATH : sentinel };
  let config = '[features]\nplugins = true\napps = false\nremote_plugin = false\n';
  if (liveProjectProbe) {
    const probe = path.join(directory, "native-transport-probe.mjs");
    await writeFile(probe, transportProbeSource);
    config += `\n[mcp_servers.desktop_transport_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(probe)}]\n[mcp_servers.desktop_transport_probe.env]\nCODEX_APP_TOOLS_PIPE_PATH = ${JSON.stringify(process.env.CODEX_APP_TOOLS_PIPE_PATH)}\n`;
  }
  await writeFile(path.join(home, "config.toml"), config);
  await exec(cli, ["plugin", "marketplace", "add", marketplace, "--json"], { cwd: directory, env, windowsHide: true, timeout: 30_000 });
  await exec(cli, ["plugin", "add", "workflows@native-loader-fixture", "--json"], { cwd: directory, env, windowsHide: true, timeout: 30_000 });
  const host = new HostClient(directory, env);
  try {
    await host.request("initialize", { clientInfo: { name: "workflows_host_loader_regression", version: "1" }, capabilities: { experimentalApi: true } });
    host.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    const detail = await host.request("plugin/read", { marketplacePath: path.join(marketplace, ".agents", "plugins", "marketplace.json"), pluginName: "workflows" });
    const registered = detail.plugin.mcpServers;
    if (name === "bad-root-env-vars") {
      assert.deepEqual(registered, [], "Actual host loader must reject the unsupported portable MCP field");
      assert.match(host.stderr, /env_vars/);
      records.push({ variant: name, mcpServers: registered, entrypointDiscovered: false });
      return;
    }
    assert.equal(registered.length, 1);
    const thread = await host.request("thread/start", { cwd: directory, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const inventory = await host.request("mcpServerStatus/list", { threadId: thread.thread.id, limit: 100 });
    const server = inventory.data.find(server => server.pluginId?.includes("workflows") || server.name.includes("workflows"));
    assert.ok(server, "Native plugin MCP server is present in the actual host runtime");
    assert.equal(server.runtimeStatus, "connected", server.toolsError ?? "Native plugin MCP did not connect");
    assert.equal(server.toolsError, null);
    const tools = Object.values(server.tools);
    assert.equal(tools.length, 21);
    const entrypoint = tools.find(tool => tool.name === "workflow_open_panel");
    assert.ok(entrypoint, "Actual host discovers the Workflows entrypoint tool");
    assert.deepEqual(entrypoint._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    if (liveProjectProbe) {
      const probe = inventory.data.find(server => server.name === "desktop_transport_probe");
      assert.equal(probe?.runtimeStatus, "connected", probe?.toolsError ?? "Read-only native transport fixture is unavailable");
      const result = await host.request("mcpServer/tool/call", { threadId: thread.thread.id, server: probe.name, tool: "readonly_desktop_catalog", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent?.hasProjects, true);
      assert.equal(result.structuredContent?.hasThreads, true);
      records.push({ variant: "native-desktop-transport", desktopCatalogAvailable: true, projectsToolPresent: true, threadsToolPresent: true, nativeToolCount: result.structuredContent.toolCount });
      if (!realProjects) return;
    }
    const projectsResponse = await host.request("mcpServer/tool/call", { threadId: thread.thread.id, server: server.name, tool: "workflow_get_projects", arguments: {}, _meta: { threadId: thread.thread.id, thread_id: thread.thread.id } });
    assert.notEqual(projectsResponse.isError, true);
    const projects = projectsResponse.structuredContent;
    assert.ok(projects, "Actual production project tool returns structured facts");
    if (liveProjectProbe) {
      if (!projects.available) records.push({ variant: name, tools: tools.length, entrypointDiscovered: true, projectsAvailable: false, desktopTransportResponded: /Codex project tool request failed/.test(projects.reason ?? ""), reason: projects.reason });
      assert.equal(projects.available, true, projects.reason ?? "Desktop project discovery did not return a usable inventory");
      assert.ok(Array.isArray(projects.projects));
      assert.equal(projects.currentProjectId, undefined, "This genuine ephemeral CLI thread does not belong to a saved desktop project");
      assert.equal(projects.contextSource, "global-or-unassigned");
      assert.equal(host.methods.includes("turn/start"), false);
      records.push({ variant: name, tools: tools.length, entrypointDiscovered: true, projectsAvailable: true, localProjectCount: projects.projects.length, ephemeralThreadUnassigned: true });
      return;
    }
    assert.equal(projects.available, false, "The sentinel deliberately is not a desktop pipe");
    assert.deepEqual(projects.projects, []);
    const pipeForwarded = name === "good-overlay";
    assert.match(projects.reason, pipeForwarded ? /local desktop project pipe/ : /CODEX_APP_TOOLS_PIPE_PATH/);
    assert.equal(host.methods.includes("turn/start"), false);
    records.push({ variant: name, mcpServers: registered, tools: tools.length, entrypointDiscovered: true, entrypoints: entrypoint._meta["openai/ui"].entrypoints, pipeForwarded });
  } finally { await host.close(); }
}

try {
  const { stdout } = await exec(cli, ["--version"], { windowsHide: true, timeout: 10_000 });
  const version = stdout.trim();
  await variant("bad-root-env-vars", async (mcp, plugin) => { mcp.mcpServers.workflows.env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]; await rm(path.join(plugin, ".codex-plugin"), { recursive: true, force: true }); });
  await variant("good-root", async (_mcp, plugin) => { await rm(path.join(plugin, ".codex-plugin"), { recursive: true, force: true }); });
  await variant("good-overlay", async () => {});
  if (nativeTransport) await variant("real-desktop-projects", async () => {});
  console.log(JSON.stringify({ cliVersion: version, elapsedMs: Date.now() - startedAt, variants: records, modelTurns: 0, isolatedHome: true, userConfigurationChanged: false }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, variants: records, modelTurns: 0, isolatedHome: true, userConfigurationChanged: false, success: false }, null, 2));
  throw error;
} finally { await rm(root, { recursive: true, force: true }); }
