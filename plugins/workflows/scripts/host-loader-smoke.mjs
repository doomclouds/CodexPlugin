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
const startedAt = Date.now();
const records = [];

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
  await writeFile(path.join(home, "config.toml"), '[features]\nplugins = true\napps = false\nremote_plugin = false\n');
  const env = { ...process.env, CODEX_HOME: home, WORKFLOWS_DATA_DIR: path.join(directory, "workflow-state"), CODEX_APP_TOOLS_PIPE_PATH: sentinel };
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
    assert.equal(tools.length, 18);
    const entrypoint = tools.find(tool => tool.name === "workflow_open_panel");
    assert.ok(entrypoint, "Actual host discovers the Workflows entrypoint tool");
    assert.deepEqual(entrypoint._meta["openai/ui"].entrypoints, [{ type: "thread" }, { type: "global" }]);
    const projectsResponse = await host.request("mcpServer/tool/call", { threadId: thread.thread.id, server: server.name, tool: "workflow_get_projects", arguments: {}, _meta: { threadId: thread.thread.id, thread_id: thread.thread.id } });
    assert.notEqual(projectsResponse.isError, true);
    const projects = projectsResponse.structuredContent;
    assert.ok(projects, "Actual production project tool returns structured facts");
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
  console.log(JSON.stringify({ cliVersion: version, elapsedMs: Date.now() - startedAt, variants: records, modelTurns: 0, isolatedHome: true, userConfigurationChanged: false }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
