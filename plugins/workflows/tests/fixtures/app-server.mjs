// Protocol-only test fixture. This process never invokes a model or executes a worker task.
import { appendFileSync, readFileSync, renameSync, symlinkSync } from "node:fs";
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
if (scenario === "mcp-no-readonly") delete declaredTools.read_tool;
if (scenario === "mcp-unannotated") declaredTools.unannotated_tool = { name: "unannotated_tool" };
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const response = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threadId = "test-thread";
let turnId = "test-turn";
let turnCount = 0;
const interruptedTurns = new Set();
const publicSource = "https://docs.example.test/guide?lang=zh&section=workflow#native-tools";
const privateBusinessSource = "https://workspace.example.test/review?project=source#L42";
const credentialSource = "https://demo-user:credential-pass@docs.example.test/guide?lang=zh&access_token=credential-token&api%5Fkey=credential-key&X-Amz-Signature=credential-signature&access_token=credential-again#access_token=fragment-secret&section=source";
const sourceOutput = scenario === "public-url" ? { sources: [publicSource, privateBusinessSource] } : { sources: [credentialSource] };

if (scenario === "stubborn" || scenario === "command-stubborn") {
  process.on("SIGTERM", () => {});
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  record({ type: "descendant", pid: descendant.pid });
}

function finish(output, phase = "final_answer", terminalItems = [], activeTurn = turnId, totalTurns = turnCount) {
  notify("item/agentMessage/delta", { threadId, turnId: activeTurn, itemId: "final", delta: output.slice(0, 4) });
  notify("item/agentMessage/delta", { threadId, turnId: activeTurn, itemId: "final", delta: output.slice(4) });
  notify("item/completed", { threadId, turnId: activeTurn, item: { type: "agentMessage", id: "final", text: output, phase } });
  notify("thread/tokenUsage/updated", { threadId, turnId: activeTurn, tokenUsage: { total: { inputTokens: 11 * totalTurns, outputTokens: 7 * totalTurns, totalTokens: 18 * totalTurns } } });
  notify("turn/completed", { threadId, turn: { id: activeTurn, status: "completed", items: terminalItems } });
}

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  record(message);
  const { id, method, params } = message;
  if (!method) return;
  if (method === "initialize") {
    if (scenario === "command-protected-swap") {
      const target = path.join(process.cwd(), ".agents-original");
      renameSync(path.join(process.cwd(), ".agents"), target);
      symlinkSync(target, path.join(process.cwd(), ".agents"), process.platform === "win32" ? "junction" : "dir");
    }
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
    if (scenario === "worker-swap-git-config") {
      renameSync(path.join(process.cwd(), ".git"), path.join(process.cwd(), "original-git"));
      symlinkSync(path.join(process.cwd(), "original-git"), path.join(process.cwd(), ".git"), process.platform === "win32" ? "junction" : "dir");
    }
    let config = { model: scenario === "config-invalid-defaults" ? "removed-model" : "test-inherited-model", model_reasoning_effort: scenario === "config-invalid-defaults" ? "unsupported" : "medium", mcp_servers: { [configuredName]: { command: "must-never-start", enabled: scenario !== "mcp-user-disabled", tool_timeout_sec: null, ...(scenario === "mcp-user-filter" ? { enabled_tools: ["read_tool"], disabled_tools: ["write_tool"], tools: { read_tool: { approval_mode: "prompt" } } } : {}) } } };
    if (scenario.startsWith("auto-review-")) config.mcp_servers[configuredName].tools = { write_tool: { approval_mode: "prompt" } };
    if (scenario.startsWith("catalog-cache-")) {
      const reads = readFileSync(traceFile, "utf8").split("\n").filter(line => line.includes('"method":"config/read"')).length;
      const selected = config.mcp_servers[configuredName];
      selected.env = { FIRST: "stable", SECOND: "stable" };
      selected.args = ["--first", "--second"];
      config.mcp_servers.other = { command: "also-never-start", enabled: false };
      if (reads > 1 && scenario === "catalog-cache-command") selected.command = "changed-never-start";
      if (reads > 1 && scenario === "catalog-cache-env") selected.env.FIRST = "changed";
      if (reads > 1 && scenario === "catalog-cache-argv-order") selected.args.reverse();
      if (scenario === "catalog-cache-order" && reads % 2 === 0) {
        const reverseObjects = value => Array.isArray(value) ? value.map(reverseObjects)
          : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjects(entry)])) : value;
        config = reverseObjects(config);
      }
    }
    response(id, { config });
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
      type: "workspaceWrite", writableRoots: [...params.config["sandbox_workspace_write.writable_roots"]], networkAccess: params.config["sandbox_workspace_write.network_access"], excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    } : { type: "readOnly", networkAccess: false };
    if (scenario === "worker-implicit-cwd") sandbox.writableRoots = sandbox.writableRoots.filter(root => root !== params.cwd);
    if (scenario === "worker-extra-root") sandbox.writableRoots.push(path.dirname(params.cwd));
    if (scenario === "worker-missing-root") sandbox.writableRoots.pop();
    if (scenario === "worker-duplicate-root") sandbox.writableRoots.push(params.cwd);
    if (scenario === "worker-reordered-roots") sandbox.writableRoots.reverse();
    if (scenario === "worker-swap-git-thread") {
      renameSync(path.join(params.cwd, ".git"), path.join(params.cwd, "original-git"));
      symlinkSync(path.join(params.cwd, "original-git"), path.join(params.cwd, ".git"), process.platform === "win32" ? "junction" : "dir");
    }
    response(id, { thread: { id: threadId, ...(scenario === "worker-missing-cwd" ? {} : { cwd: scenario === "worker-wrong-cwd" ? path.dirname(params.cwd) : params.cwd }) }, model: params.model ?? "test-inherited-model", reasoningEffort: params.config.model_reasoning_effort ?? "medium", approvalPolicy: scenario === "auto-review-policy-ignored" ? "never" : params.approvalPolicy, ...(scenario === "auto-review-reviewer-missing" ? {} : { approvalsReviewer: scenario === "auto-review-reviewer-ignored" ? "user" : scenario === "auto-review-reviewer-alias" ? "guardian_subagent" : params.approvalsReviewer ?? "user" }), sandbox: scenario === "unsafe-sandbox" ? { type: "dangerFullAccess" } : sandbox });
  } else if (method === "mcpServerStatus/list") {
    if (scenario === "worker-swap-git-inventory" && params.threadId) {
      renameSync(path.join(threadParams.cwd, ".git"), path.join(threadParams.cwd, "original-git"));
      symlinkSync(path.join(threadParams.cwd, "original-git"), path.join(threadParams.cwd, ".git"), process.platform === "win32" ? "junction" : "dir");
    }
    const selected = threadParams?.config.mcp_servers?.[configuredName];
    let tools = params.serverName && !params.threadId ? declaredTools : selected?.enabled ? Object.fromEntries(Object.entries(declaredTools).filter(([name]) => selected.enabled_tools?.includes(name))) : {};
    if (params.threadId && tools.read_tool && ["mcp-readonly-flipped", "mcp-readonly-missing-runtime"].includes(scenario)) {
      tools = { ...tools, read_tool: { name: "read_tool", ...(scenario === "mcp-readonly-flipped" ? { annotations: { readOnlyHint: false } } : {}) } };
    }
    const data = scenario === "enabled-mcp" ? [{ name: configuredName, runtimeStatus: "connected", tools: { unsafe: {} } }] : [{ name: configuredName, runtimeStatus: params.threadId ? selected?.enabled ? "connected" : "disabled" : null, tools, serverInfo: { name: scenario === "recursive-mcp" ? "workflows" : "fixture-server" } }];
    response(id, { data, nextCursor: null });
  } else if (method === "turn/start") {
    turnCount++;
    turnId = turnCount === 1 ? "test-turn" : `test-turn-${turnCount}`;
    if (!threadParams || params.approvalPolicy !== threadParams.approvalPolicy || params.approvalsReviewer !== threadParams.approvalsReviewer || params.sandboxPolicy.networkAccess !== threadParams.config["sandbox_workspace_write.network_access"] || params.sandboxPolicy.type !== (threadParams.sandbox === "read-only" ? "readOnly" : "workspaceWrite")) process.exit(6);
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    if (scenario === "cancel-before-ack") return;
    if (scenario === "completion-before-ack") {
      finish("finished before acknowledgement");
      setTimeout(() => response(id, { turn: { id: turnId, status: "inProgress" } }), 50);
      return;
    }
    response(id, { turn: { id: scenario === "recovery-ack-mismatch" && turnCount > 1 ? "wrong-new-turn" : scenario === "recovery-old-ack" && turnCount > 1 ? "test-turn" : turnId, status: "inProgress" } });
    if (scenario.startsWith("recovery-")) {
      if (scenario === "recovery-protocol" && turnCount > 1) { process.stdout.write("not-json\n"); return; }
      if (scenario === "recovery-interrupted") { notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", items: [] } }); return; }
      if (scenario === "recovery-host-request") { send({ id: "server-approval", method: "item/permissions/requestApproval", params: { threadId, turnId, permissions: { network: true } } }); return; }
      if (scenario === "recovery-terminal-protocol") {
        const activeTurn = turnId;
        setTimeout(() => process.stdout.write([
          JSON.stringify({ method: "item/completed", params: { threadId, turnId: activeTurn, item: { type: "agentMessage", id: "final", text: '{"ok":false}', phase: "final_answer" } } }),
          JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: activeTurn, status: "completed", items: [] } } }),
          "not-json",
        ].join("\n") + "\n"), 10);
        return;
      }
      if (scenario === "recovery-permission-blocked" || scenario === "recovery-result-permission-text") {
        const permission = "MCP tool call requires approval, but approval policy is never";
        const call = { type: "mcpToolCall", id: `permission-${turnCount}`, server: configuredName, tool: "read_tool", status: "failed", error: scenario === "recovery-permission-blocked" ? { message: permission } : null, result: scenario === "recovery-result-permission-text" ? { isError: true, content: [{ type: "text", text: permission }] } : null };
        notify("item/completed", { threadId, turnId, item: call });
        if (scenario === "recovery-permission-blocked") {
          const blockedTurn = turnId;
          setTimeout(() => {
            if (interruptedTurns.has(blockedTurn)) return;
            record({ type: "native-after-approval-block", turnId: blockedTurn });
            notify("item/completed", { threadId, turnId: blockedTurn, item: { type: "commandExecution", id: "forbidden-follow-on", status: "completed", exitCode: 0 } });
            finish('{"ok":true}', "final_answer", [], blockedTurn);
          }, 80);
          return;
        }
      }
      if (scenario === "recovery-cancel" && turnCount > 1) return;
      if (scenario === "recovery-late" && turnCount > 1) {
        finish('{"ok":false,"secret":"PRIVATE_STALE_OUTPUT"}', "final_answer", [], "test-turn", 900);
        notify("turn/started", { threadId, turn: { id: "test-turn", status: "inProgress" } });
        notify("item/completed", { threadId, turnId: "test-turn", item: { type: "fileChange", id: "stale-edit", status: "completed" } });
      }
      if (scenario === "recovery-git-swap" && turnCount === 1) {
        renameSync(path.join(process.cwd(), ".git"), path.join(process.cwd(), "original-git"));
        symlinkSync(path.join(process.cwd(), "original-git"), path.join(process.cwd(), ".git"), process.platform === "win32" ? "junction" : "dir");
      }
      notify("item/completed", { threadId, turnId, item: turnCount === 1 ? { type: "commandExecution", id: "recovery-command", status: "failed", exitCode: 1, aggregatedOutput: "temporary fixture failure\n" } : { type: "webSearch", id: "recovery-search" } });
      const output = scenario === "recovery-exhaust" || scenario === "recovery-git-swap" || turnCount === 1 && scenario !== "recovery-json" && scenario !== "recovery-shape"
        ? '{"ok":false}' : turnCount === 1 && scenario === "recovery-json" ? "not JSON PRIVATE_INVALID_OUTPUT"
        : turnCount === 1 && scenario === "recovery-shape" ? '{"ok":"PRIVATE_BAD_SHAPE"}' : '{"ok":true}';
      const selectedTurn = turnId, selectedCount = turnCount;
      setTimeout(() => finish(output, "final_answer", [], selectedTurn, selectedCount), scenario === "recovery-total-timeout" ? 80 : 10);
      return;
    }
    if (scenario.startsWith("auto-review-")) {
      if (scenario === "auto-review-host-request") { send({ id: "server-approval", method: "item/permissions/requestApproval", params: { threadId, turnId, permissions: { network: true } } }); return; }
      if (scenario === "auto-review-no-request") { finish("no review necessary"); return; }
      const base = { threadId, turnId, reviewId: "private-review-id", startedAtMs: Date.now(), targetItemId: "review-target", action: { type: "mcpToolCall", server: configuredName, toolName: "write_tool", arguments: { prompt: "PRIVATE_REVIEW_ACTION" } }, review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null } };
      notify("item/autoApprovalReview/completed", { ...base, threadId: "unrelated-thread", review: { status: "denied", rationale: "PRIVATE_UNRELATED_REVIEW" } });
      notify("item/autoApprovalReview/completed", { ...base, turnId: "unrelated-turn", review: { status: "denied", rationale: "PRIVATE_UNRELATED_REVIEW" } });
      notify("item/autoApprovalReview/started", base);
      notify("item/autoApprovalReview/started", base);
      notify("autoApprovalReview/strictReviewRequired", { threadId, turnId, startedAtMs: base.startedAtMs });
      if (scenario === "auto-review-interrupt") return;
      const status = scenario === "auto-review-denied" ? "denied" : scenario === "auto-review-timeout" ? "timedOut" : scenario === "auto-review-aborted" ? "aborted" : scenario === "auto-review-unknown-state" ? "unsafeFallback" : "approved";
      const rationale = scenario === "auto-review-large-rationale" ? "解释".repeat(5000) + "PRIVATE_REVIEW_TAIL" : `Authorized local fixture check; \u001b[31m"password"\u001b[0m: "PRIVATE_REVIEW_SECRET with spaces\nand multiline"; ${credentialSource}; arguments: {"prompt":"PRIVATE_REVIEW_ARGUMENT"}`;
      const completed = { ...base, ...(scenario === "auto-review-missing-turn" ? { turnId: null } : {}), completedAtMs: Date.now(), decisionSource: scenario === "auto-review-unknown-source" ? "user" : "agent", review: { status, riskLevel: "low", userAuthorization: "high", rationale } };
      notify("item/autoApprovalReview/completed", completed);
      notify("item/autoApprovalReview/completed", completed);
      if (["denied", "timedOut", "aborted", "unsafeFallback"].includes(status)) return;
      finish("automatic review complete");
      return;
    }
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
    if (scenario.startsWith("mcp-diagnostic-")) {
      const call = { type: "mcpToolCall", id: "mcp-diagnostic-call", server: configuredName, tool: "write_tool", arguments: { prompt: "MCP_PRIVATE_PROMPT", token: "MCP_PRIVATE_ARGUMENT" }, status: "failed", error: null, result: null };
      if (scenario === "mcp-diagnostic-transport") call.error = { message: 'MCP error -32000: unavailable; \u001b[31m"password"\u001b[0m: "quoted credential with spaces\nand multiline value"; \'authorization\': \'Bearer private-mcp-auth with spaces\'; token=private-mcp-token; ' + credentialSource + '; input validation {"arguments":{"payload":"MCP_PRIVATE_EMBEDDED_ARGUMENT"}}' };
      if (scenario === "mcp-diagnostic-payload") {
        call.status = "completed";
        call.result = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "TARGET_MISSING", message: "No active REA context", detail: '"secret": "private-mcp-secret with spaces"' }, arguments: { prompt: "MCP_PRIVATE_RESULT_ARGUMENT" }, result: "MCP_PRIVATE_SUCCESS_RESULT" }) }, { type: "image", data: "MCP_PRIVATE_IMAGE" }, { type: "resource", resource: { text: "MCP_PRIVATE_RESOURCE" } }] };
      }
      if (scenario === "mcp-diagnostic-structured") call.result = { content: [], structuredContent: { ok: false, data: { error: { code: -32001, message: "Nested MCP error", detail: '"api_key":"private-mcp-key"', details: { prompt: "MCP_PRIVATE_DETAILS" } } }, arguments: { prompt: "MCP_PRIVATE_RESULT_ARGUMENT" }, value: "MCP_PRIVATE_SUCCESS_RESULT" } };
      if (scenario === "mcp-diagnostic-success") {
        call.status = "completed";
        call.result = { isError: false, content: [{ type: "text", text: "MCP_PRIVATE_SUCCESS_TEXT" }], structuredContent: { status: "failed", error: "MCP_PRIVATE_SUCCESS_RESULT" } };
      }
      if (scenario === "mcp-diagnostic-malformed") {
        call.error = { message: { nested: "MCP_PRIVATE_MALFORMED" } };
        call.result = { content: { text: "MCP_PRIVATE_INVALID_CONTENT" }, structuredContent: { nested: { error: "MCP_PRIVATE_DEEP_ERROR" } } };
      }
      notify("item/started", { threadId, turnId, item: { ...call, status: "inProgress", error: null, result: null } });
      if (scenario === "mcp-diagnostic-late-error") {
        notify("item/completed", { threadId, turnId, item: { ...call, status: "completed" } });
        call.status = "completed";
        call.result = { isError: true, content: [{ type: "text", text: "Late MCP error" }] };
      }
      notify("item/completed", { threadId, turnId, item: call });
      notify("item/completed", { threadId, turnId, item: call });
      finish("worker recovered", "final_answer", [call]);
      return;
    }
    if (["terminal-command-output", "terminal-command-long", "streamed-terminal-command", "terminal-command-no-output"].includes(scenario)) {
      const command = { type: "commandExecution", id: "terminal-command", command: ["node", "-e", "full-command-private-marker"], status: "completed", exitCode: scenario === "terminal-command-output" ? -9 : 0,
        aggregatedOutput: scenario === "terminal-command-long" ? "LONG_BEGIN\n" + "x".repeat(32_740) + "\nsk-abcdefghijklmnopqrstuvwxyz1234567890\n" + "tail".repeat(10_000)
          : scenario === "streamed-terminal-command" ? "STREAM_DUPLICATE_MARKER\ntoken=private-stream-terminal-secret\n"
          : "here-document: Operation not permitted\ntoken=private-terminal-secret\n" };
      if (scenario === "terminal-command-no-output") { command.status = "failed"; command.exitCode = null; command.aggregatedOutput = null; }
      notify("item/started", { threadId, turnId, item: { type: command.type, id: command.id, command: command.command, status: "inProgress" } });
      if (scenario === "streamed-terminal-command") notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: command.id, delta: command.aggregatedOutput });
      if (scenario === "terminal-command-long") notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: command.id, delta: "" });
      notify("item/completed", { threadId, turnId, item: command });
      finish("worker complete", "final_answer", [command]);
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
    if (["mcp-no-readonly", "mcp-unannotated"].includes(scenario)) {
      notify("item/completed", { threadId, turnId, item: { type: "commandExecution", id: "native-read-command", status: "completed", exitCode: 0 } });
    }
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "commentary", text: "working commentary", phase: "commentary" } });
    setTimeout(() => finish(["public-url", "credential-url"].includes(scenario) ? JSON.stringify(sourceOutput) : scenario === "structured" ? '{"answer":42}' : scenario === "bad-structured" ? "not structured" : "worker complete"), 20);
  } else if (method === "turn/interrupt") {
    interruptedTurns.add(params.turnId);
    response(id, {});
    if (scenario !== "stubborn") setTimeout(() => notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", items: [] } }), 10);
  } else if (method === "command/exec") {
    commandId = id;
    const environment = params.env ?? {};
    const envKeys = ["TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "npm_config_cache", "NPM_CONFIG_CACHE"];
    const permittedRoots = [params.cwd, path.join(params.cwd, ".git"), ...(scenario === "command-protected" ? [path.join(params.cwd, ".agents/skills")] : scenario === "command-protected-codex" ? [path.join(params.cwd, ".codex")] : [])];
    if (params.sandboxPolicy?.type !== "workspaceWrite" || !Array.isArray(params.command) || typeof params.sandboxPolicy.networkAccess !== "boolean" || Object.keys(environment).length !== envKeys.length || envKeys.some(key => typeof environment[key] !== "string" || !environment[key].startsWith(params.cwd + path.sep) || !environment[key].includes(".workflows-command-")) || params.sandboxPolicy.excludeTmpdirEnvVar !== true || params.sandboxPolicy.excludeSlashTmp !== true || params.sandboxPolicy.writableRoots.some(root => !permittedRoots.includes(root))) process.exit(6);
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
