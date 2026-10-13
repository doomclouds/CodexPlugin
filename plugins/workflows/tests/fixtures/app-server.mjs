// Protocol-only test fixture. This process never invokes a model or executes a worker task.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const scenario = process.argv[2];
const traceFile = process.argv[3];
const record = value => appendFileSync(traceFile, JSON.stringify(value) + "\n");
record({ type: "pid", pid: process.pid });
const keepAlive = setInterval(() => {}, 1000);
let initialized = false;
let handshake = false;
let threadParams;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const response = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threadId = "test-thread";
const turnId = "test-turn";

if (scenario === "stubborn") {
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
    response(id, { config: { model: "test-inherited-model", mcp_servers: scenario === "unsafe-mcp-name" ? { "unsafe.name": {} } : { fixture: { command: "must-never-start" } } } });
  } else if (method === "thread/start") {
    threadParams = params;
    const required = ["apps", "plugins", "browser_use", "computer_use", "multi_agent", "hooks"];
    if (required.some(feature => !process.argv.includes(feature) || params.config[`features.${feature}`] !== false) || params.config["mcp_servers.fixture.enabled"] !== false || params.config["mcp_servers.fixture.required"] !== false) {
      send({ id, error: { code: -32000, message: "Missing worker isolation" } });
      return;
    }
    const sandbox = params.sandbox === "workspace-write" ? {
      type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    } : { type: "readOnly", networkAccess: false };
    response(id, { thread: { id: threadId }, sandbox: scenario === "unsafe-sandbox" ? { type: "dangerFullAccess" } : sandbox });
  } else if (method === "mcpServerStatus/list") {
    const data = scenario === "enabled-mcp" ? [{ name: "fixture", runtimeStatus: "connected", tools: { unsafe: {} } }] : [{ name: "fixture", runtimeStatus: "disabled", tools: {} }];
    response(id, { data, nextCursor: null });
  } else if (method === "turn/start") {
    if (!threadParams || params.approvalPolicy !== "never" || params.sandboxPolicy.networkAccess !== false) process.exit(6);
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
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "commentary", text: "working commentary", phase: "commentary" } });
    setTimeout(() => finish(scenario === "structured" ? '{"answer":42}' : scenario === "bad-structured" ? "not structured" : "worker complete"), 20);
  } else if (method === "turn/interrupt") {
    response(id, {});
    if (scenario !== "stubborn") setTimeout(() => notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", items: [] } }), 10);
  } else {
    send({ id, error: { code: -32601, message: "Unknown test method" } });
  }
});

process.stdin.on("end", () => { if (scenario !== "stubborn") clearInterval(keepAlive); });
