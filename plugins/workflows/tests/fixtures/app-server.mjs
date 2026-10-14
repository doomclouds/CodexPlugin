// Protocol-only test fixture. This process never invokes a model or executes a worker task.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";

const scenario = process.argv[2];
const traceFile = process.argv[3];
const record = value => appendFileSync(traceFile, JSON.stringify(value) + "\n");
record({ type: "pid", pid: process.pid, arguments: process.argv.slice(4) });
const keepAlive = setInterval(() => {}, 1000);
let initialized = false;
let handshake = false;
let threadParams;
let commandId;
const configuredName = scenario === "dotted-mcp" ? "fixture.docs" : "fixture";
const declaredTools = { read_tool: { name: "read_tool", annotations: { readOnlyHint: true } }, write_tool: { name: "write_tool", annotations: { readOnlyHint: false } } };
if (scenario === "mcp-user-filter") declaredTools.filtered_read_tool = { name: "filtered_read_tool", annotations: { readOnlyHint: true } };
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const response = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threadId = "test-thread";
const turnId = "test-turn";
const publicSource = "https://docs.example.test/guide?lang=zh&section=workflow#native-tools";
const privateBusinessSource = "https://workspace.example.test/review?project=source#L42";
const credentialSource = "https://demo-user:credential-pass@docs.example.test/guide?lang=zh&access_token=credential-token&api%5Fkey=credential-key&X-Amz-Signature=credential-signature&access_token=credential-again#access_token=fragment-secret&section=source";
const sourceOutput = scenario === "public-url" ? { sources: [publicSource, privateBusinessSource] } : { sources: [credentialSource] };

if (scenario === "stubborn" || scenario === "command-stubborn") {
  process.on("SIGTERM", () => {});
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  record({ type: "descendant", pid: descendant.pid });
}

function finish(output, phase = "final_answer") {
  notify("item/agentMessage/delta", { threadId, turnId, itemId: "final", delta: output.slice(0, 4) });
  notify("item/agentMessage/delta", { threadId, turnId, itemId: "final", delta: output.slice(4) });
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "final", text: output, phase } });
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  record(message);
  const { id, method, params } = message;
  if (!method) return;
  if (method === "initialize") {
    if (scenario === "startup-hang") return;
    if (scenario === "malformed") { process.stdout.write("not-json\n"); return; }
    initialized = true;
    response(id, { userAgent: "protocol-test" });
  } else if (method === "initialized") {
    if (!initialized) process.exit(5);
    handshake = true;
  } else if (!handshake) {
    send({ id, error: { code: -32000, message: "Not initialized" } });
  } else if (method === "config/read") {
    response(id, { config: { model: scenario === "config-invalid-defaults" ? "removed-model" : "test-inherited-model", model_reasoning_effort: scenario === "config-invalid-defaults" ? "unsupported" : "medium", mcp_servers: { [configuredName]: { command: "must-never-start", enabled: scenario !== "mcp-user-disabled", tool_timeout_sec: null, ...(scenario === "mcp-user-filter" ? { enabled_tools: ["read_tool"], disabled_tools: ["write_tool"], tools: { read_tool: { approval_mode: "prompt" } } } : {}) } } } });
  } else if (method === "model/list") {
    if (scenario === "catalog-hang") return;
    if (scenario === "catalog-invalid") { response(id, { data: [{ id: "invalid" }], nextCursor: null }); return; }
    const ids = ["test-inherited-model", "explicit-test-model", "low-only-model"];
    response(id, { data: ids.map(model => ({ id: model, model, displayName: model, isDefault: model === "test-inherited-model", supportedReasoningEfforts: (model === "low-only-model" ? ["low"] : ["low", "medium", "high"]).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: model === "low-only-model" ? "low" : "medium" })), nextCursor: null });
  } else if (method === "thread/start") {
    threadParams = params;
    const required = ["apps", "plugins", "browser_use", "computer_use", "multi_agent", "hooks"];
    const server = params.config.mcp_servers?.[configuredName];
    if (required.some(feature => !process.argv.includes(feature) || params.config[`features.${feature}`] !== false) || !process.argv.includes("agents.enabled=false") || params.config["agents.enabled"] !== false || !server || typeof server.enabled !== "boolean" || server.required !== server.enabled || !params.developerInstructions.includes("user-authorized delegated task")) {
      send({ id, error: { code: -32000, message: "Missing worker isolation" } });
      return;
    }
    const sandbox = params.sandbox === "workspace-write" ? {
      type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: params.config["sandbox_workspace_write.network_access"], excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    } : { type: "readOnly", networkAccess: false };
    response(id, { thread: { id: threadId }, model: params.model ?? "test-inherited-model", reasoningEffort: params.config.model_reasoning_effort ?? "medium", sandbox: scenario === "unsafe-sandbox" ? { type: "dangerFullAccess" } : sandbox });
  } else if (method === "mcpServerStatus/list") {
    const selected = threadParams?.config.mcp_servers?.[configuredName];
    const tools = params.serverName && !params.threadId ? declaredTools : selected?.enabled ? Object.fromEntries(Object.entries(declaredTools).filter(([name]) => selected.enabled_tools?.includes(name))) : {};
    const data = scenario === "enabled-mcp" ? [{ name: configuredName, runtimeStatus: "connected", tools: { unsafe: {} } }] : [{ name: configuredName, runtimeStatus: params.threadId ? selected?.enabled ? "connected" : "disabled" : null, tools, serverInfo: { name: scenario === "recursive-mcp" ? "workflows" : "fixture-server" } }];
    response(id, { data, nextCursor: null });
  } else if (method === "turn/start") {
    if (!threadParams || params.approvalPolicy !== "never" || params.sandboxPolicy.networkAccess !== threadParams.config["sandbox_workspace_write.network_access"] || params.sandboxPolicy.type !== (threadParams.sandbox === "read-only" ? "readOnly" : "workspaceWrite")) process.exit(6);
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    if (scenario === "cancel-before-ack") return;
    if (scenario === "completion-before-ack") {
      finish("finished before acknowledgement");
      setTimeout(() => response(id, { turn: { id: turnId, status: "inProgress" } }), 50);
      return;
    }
    response(id, { turn: { id: turnId, status: "inProgress" } });
    if (scenario === "interrupt" || scenario === "stubborn") return;
    if (scenario === "exit") { process.exit(7); return; }
    if (scenario === "host-request") {
      send({ id: "server-approval", method: "item/permissions/requestApproval", params: { threadId, turnId, permissions: { network: true } } });
      return;
    }
    if (scenario === "server-error") {
      notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", items: [], error: { message: "token=private-test-token https://private.example.test/path" } } });
      return;
    }
    if (scenario === "sensitive-stream") {
      notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: "command", delta: "token=private-" });
      notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: "command", delta: "test-secret\n" });
      notify("item/completed", { threadId, turnId, item: { type: "commandExecution", id: "command" } });
    }
    if (scenario === "native-items") {
      notify("item/started", { threadId, turnId, item: { type: "commandExecution", id: "native-command", status: "inProgress" } });
      notify("item/completed", { threadId, turnId, item: { type: "commandExecution", id: "native-command", status: "completed" } });
      notify("item/completed", { threadId, turnId, item: { type: "fileChange", id: "native-edit", status: "completed" } });
      notify("item/completed", { threadId, turnId, item: { type: "webSearch", id: "native-search" } });
    }
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "commentary", text: "working commentary", phase: "commentary" } });
    setTimeout(() => finish(["public-url", "credential-url"].includes(scenario) ? JSON.stringify(sourceOutput) : scenario === "structured" ? '{"answer":42}' : scenario === "bad-structured" ? "not structured" : "worker complete"), 20);
  } else if (method === "turn/interrupt") {
    response(id, {});
    if (scenario !== "stubborn") setTimeout(() => notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", items: [] } }), 10);
  } else if (method === "command/exec") {
    commandId = id;
    const environment = params.env ?? {};
    const envKeys = ["TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "npm_config_cache", "NPM_CONFIG_CACHE"];
    if (params.sandboxPolicy?.type !== "workspaceWrite" || !Array.isArray(params.command) || typeof params.sandboxPolicy.networkAccess !== "boolean" || Object.keys(environment).length !== envKeys.length || envKeys.some(key => typeof environment[key] !== "string" || !environment[key].startsWith(params.cwd + path.sep) || !environment[key].includes(".workflows-command-")) || params.sandboxPolicy.excludeTmpdirEnvVar !== true || params.sandboxPolicy.excludeSlashTmp !== true || params.sandboxPolicy.writableRoots.some(root => root !== params.cwd && root !== path.join(params.cwd, ".git"))) process.exit(6);
    if (scenario === "command-host-request") { send({ id: "command-approval", method: "item/permissions/requestApproval", params: {} }); return; }
    if (scenario === "command-interrupt" || scenario === "command-stubborn") { notify("command/exec/outputDelta", { processId: params.processId, stream: "stdout", deltaBase64: Buffer.from("ready\n").toString("base64") }); return; }
    const attempts = readFileSync(traceFile, "utf8").split("\n").filter(line => line.includes('"method":"command/exec"')).length;
    if (scenario === "command-network-always" || scenario === "command-network-once" && attempts === 1) { response(id, { exitCode: 1, stdout: "", stderr: "ECONNRESET temporary network failure" }); return; }
    if (scenario === "command-failed") { response(id, { exitCode: 1, stdout: "", stderr: "Test failed: assertion mismatch" }); return; }
    if (scenario === "command-conflict") { response(id, { exitCode: 128, stdout: "", stderr: "CONFLICT merge failed; connection reset by peer" }); return; }
    if (["public-url", "credential-url"].includes(scenario)) {
      const output = JSON.stringify(sourceOutput) + "\n";
      const midpoint = Math.floor(output.length / 2);
      notify("command/exec/outputDelta", { processId: params.processId, stream: "stdout", deltaBase64: Buffer.from(output.slice(0, midpoint)).toString("base64") });
      notify("command/exec/outputDelta", { processId: params.processId, stream: "stdout", deltaBase64: Buffer.from(output.slice(midpoint)).toString("base64") });
      response(id, { exitCode: 0, stdout: "", stderr: "" });
      return;
    }
    notify("command/exec/outputDelta", { processId: params.processId, stream: "stdout", deltaBase64: Buffer.from("command complete\n").toString("base64") });
    notify("command/exec/outputDelta", { processId: params.processId, stream: "stderr", deltaBase64: Buffer.from("token=private-").toString("base64") });
    notify("command/exec/outputDelta", { processId: params.processId, stream: "stderr", deltaBase64: Buffer.from("test-secret\n").toString("base64") });
    response(id, { exitCode: 0, stdout: "", stderr: "" });
  } else if (method === "command/exec/terminate") {
    response(id, {});
    if (scenario !== "command-stubborn") setTimeout(() => response(commandId, { exitCode: 130, stdout: "", stderr: "interrupted" }), 10);
  } else {
    send({ id, error: { code: -32601, message: "Unknown test method" } });
  }
});

process.stdin.on("end", () => { if (scenario !== "stubborn" && scenario !== "command-stubborn") clearInterval(keepAlive); });
