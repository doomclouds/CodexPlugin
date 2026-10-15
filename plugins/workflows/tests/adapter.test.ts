import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { CodexAdapter } from "../src/adapter.ts";
import type { CommandRequest, WorkerEvent, WorkerRequest } from "../src/adapter.ts";
import { normalizeProtectedPaths } from "../src/protected-paths.ts";
import { McpFailureDiagnostics, mcpItemFailed } from "../src/mcp-diagnostics.ts";

const fixture = fileURLToPath(new URL("fixtures/app-server.mjs", import.meta.url));

async function setup(scenario: string, options: { startupTimeoutMs?: number; interruptTimeoutMs?: number; shutdownTimeoutMs?: number } = {}) {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-adapter-test-")));
  const trace = path.join(cwd, "protocol.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath, args: [fixture, scenario, trace], startupTimeoutMs: 5000, interruptTimeoutMs: 100, shutdownTimeoutMs: 100, ...options });
  const request: WorkerRequest = { id: "test-worker", prompt: "Protocol test task", cwd, mode: "read" };
  const events: WorkerEvent[] = [];
  const controller = new AbortController();
  const cleanup = async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); };
  const transcript = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
  return { adapter, request, events, controller, cleanup, transcript };
}

test("protocol fixture streams final output and usage with an initialized, isolated worker", async () => {
  const context = await setup("complete");
  try {
    const result = await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    assert.equal(result.output, "worker complete");
    assert.equal(result.threadId, "test-thread");
    assert.equal(result.turnId, "test-turn");
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    assert.ok(context.events.some(event => event.type === "log"));
    assert.ok(context.events.some(event => event.type === "usage"));
    const transcript = await context.transcript();
    assert.deepEqual(transcript.filter(message => message.method).map(message => message.method), ["initialize", "initialized", "config/read", "thread/start", "mcpServerStatus/list", "turn/start"]);
    const thread = transcript.find(message => message.method === "thread/start")!;
    assert.equal("model" in thread.params, false);
    assert.equal(thread.params.approvalPolicy, "never");
    assert.equal(thread.params.ephemeral, true);
    assert.deepEqual(thread.params.config.mcp_servers.fixture, { enabled: false, required: false });
    assert.equal(transcript.find(message => message.method === "initialize")!.params.clientInfo.version, JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8")).version);
    const turn = transcript.find(message => message.method === "turn/start")!;
    assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  } finally { await context.cleanup(); }
});

test("temporary-file command guidance is scoped to the enforced read-only sandbox", async () => {
  for (const mode of ["read", "write"] as const) {
    const context = await setup("native-items");
    try {
      const result = await context.adapter.run({ ...context.request, mode }, context.controller.signal, () => {});
      assert.ok(result.toolsUsed?.includes("native:commandExecution"));
      const transcript = await context.transcript();
      const thread = transcript.find(message => message.method === "thread/start")!;
      const turn = transcript.find(message => message.method === "turn/start")!;
      if (mode === "read") {
        assert.equal(thread.params.sandbox, "read-only");
        assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
        assert.match(thread.params.developerInstructions, /does not grant temporary-file writes/);
        assert.match(thread.params.developerInstructions, /native file-reading tools and direct argument vectors/);
        assert.match(thread.params.developerInstructions, /here-documents, here-strings and output file redirection/);
        assert.match(thread.params.developerInstructions, /node -e, python -c or printf pipelines/);
        assert.match(thread.params.developerInstructions, /Do not expand the sandbox/);
      } else {
        assert.equal(thread.params.sandbox, "workspace-write");
        assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
        assert.equal(thread.params.developerInstructions.includes("temporary-file writes"), false);
      }
    } finally { await context.cleanup(); }
  }
});

test("automatic approval review is scoped to the worker and preserves exact sandbox and MCP grants", async () => {
  for (const mode of ["read", "write"] as const) {
    const context = await setup("auto-review-approved");
    try {
      const result = await context.adapter.run({ ...context.request, mode, approvalMode: "auto-review", networkAccess: false, mcpServers: ["fixture"], mcpTools: { fixture: [mode === "read" ? "read_tool" : "write_tool"] } }, context.controller.signal, event => context.events.push(event));
      assert.equal(result.output, "automatic review complete");
      const transcript = await context.transcript();
      const thread = transcript.find(message => message.method === "thread/start")!;
      const turn = transcript.find(message => message.method === "turn/start")!;
      for (const message of [thread, turn]) {
        assert.equal(message.params.approvalPolicy, "on-request");
        assert.equal(message.params.approvalsReviewer, "auto_review");
      }
      assert.equal(thread.params.config.approval_policy, "on-request");
      assert.equal(thread.params.config.approvals_reviewer, "auto_review");
      assert.equal(thread.params.config["agents.enabled"], false);
      assert.equal(thread.params.config["features.multi_agent"], false);
      assert.equal(thread.params.config.mcp_servers.fixture.tools.write_tool.approval_mode, "prompt");
      assert.deepEqual(thread.params.config.mcp_servers.fixture.enabled_tools, [mode === "read" ? "read_tool" : "write_tool"]);
      assert.deepEqual(turn.params.sandboxPolicy, mode === "read" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [context.request.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
      assert.match(thread.params.developerInstructions, /do not retry, work around the decision or ask for persistent preapproval/);
      assert.equal(transcript.some(message => ["config/value/write", "config/batchWrite", "thread/approveGuardianDeniedAction"].includes(message.method)), false);
      const reviewActivities = context.events.filter((event): event is Extract<WorkerEvent, { type: "activity" }> => event.type === "activity" && event.activity.id.startsWith("review:"));
      assert.equal(reviewActivities.at(-1)?.activity.status, "completed");
      const logs = context.events.filter((event): event is Extract<WorkerEvent, { type: "log" }> => event.type === "log").map(event => event.message);
      assert.equal(logs.filter(message => message.startsWith("Codex automatic approval review approved")).length, 1);
      assert.equal(logs.filter(message => message === "Codex automatic approval review started.").length, 1);
      assert.match(logs.join("\n"), /stricter review/);
      assert.doesNotMatch(JSON.stringify(context.events), /PRIVATE_REVIEW_|PRIVATE_UNRELATED_REVIEW|private-review-id|credential-pass|credential-token|fragment-secret|\x1b/);
    } finally { await context.cleanup(); }
  }
});

for (const scenario of ["reviewer-ignored", "reviewer-missing", "reviewer-alias", "policy-ignored"] as const) {
  test(`automatic approval review refuses an unverified effective setting: ${scenario}`, async () => {
    const context = await setup(`auto-review-${scenario}`);
    try {
      await assert.rejects(context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => context.events.push(event)), /did not enforce the requested worker approval policy and reviewer/);
      assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
    } finally { await context.cleanup(); }
  });
}

for (const [scenario, status] of [["denied", "denied"], ["timeout", "timedOut"], ["aborted", "aborted"]] as const) {
  test(`automatic approval ${scenario} interrupts once without retries or preapproval`, async () => {
    const context = await setup(`auto-review-${scenario}`);
    try {
      await assert.rejects(context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => context.events.push(event)), new RegExp(`automatic approval review ${status}`));
      const transcript = await context.transcript();
      assert.equal(transcript.filter(message => message.method === "turn/start").length, 1);
      assert.equal(transcript.filter(message => message.method === "turn/interrupt").length, 1);
      assert.equal(transcript.some(message => message.id === "server-approval" && message.result), false);
      assert.doesNotMatch(JSON.stringify(context.events), /PRIVATE_REVIEW_|PRIVATE_UNRELATED_REVIEW|credential-pass|credential-token|fragment-secret|\x1b/);
      const final = context.events.findLast(event => event.type === "activity" && event.activity.id.startsWith("review:"));
      assert.equal(final?.type === "activity" ? final.activity.status : undefined, scenario === "aborted" ? "interrupted" : "failed");
    } finally { await context.cleanup(); }
  });
}

test("automatic review rationale is bounded and valid UTF-8", async () => {
  const context = await setup("auto-review-large-rationale");
  try {
    await context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => context.events.push(event));
    const log = context.events.find(event => event.type === "log" && event.message.startsWith("Codex automatic approval review approved"));
    assert.equal(log?.type, "log");
    if (log?.type !== "log") return;
    assert.ok(Buffer.byteLength(log.message) < 1024);
    assert.doesNotMatch(log.message, /\ufffd|PRIVATE_REVIEW_TAIL/);
    assert.match(log.message, /Review rationale truncated/);
  } finally { await context.cleanup(); }
});

test("automatic review does not require a review for ordinary allowed actions", async () => {
  const context = await setup("auto-review-no-request");
  try {
    const result = await context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => context.events.push(event));
    assert.equal(result.output, "no review necessary");
    assert.equal(context.events.some(event => event.type === "activity" && event.activity.id.startsWith("review:")), false);
  } finally { await context.cleanup(); }
});

test("automatic review still rejects human approval requests and unknown native review states", async () => {
  for (const [scenario, error] of [["host-request", /unsupported host interaction/], ["unknown-state", /unsupported automatic approval review state/], ["unknown-source", /agent-produced automatic approval review decision/], ["missing-turn", /invalid automatic approval review thread or turn identity/]] as const) {
    const context = await setup(`auto-review-${scenario}`);
    try {
      await assert.rejects(context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => context.events.push(event)), error);
      assert.equal((await context.transcript()).some(message => message.id === "server-approval" && message.result), false);
    } finally { await context.cleanup(); }
  }
});

test("stopping a worker while automatic review is pending interrupts the owned turn", async () => {
  const context = await setup("auto-review-interrupt");
  try {
    await assert.rejects(context.adapter.run({ ...context.request, approvalMode: "auto-review" }, context.controller.signal, event => {
      context.events.push(event);
      if (event.type === "activity" && event.activity.id.startsWith("review:") && event.activity.status === "running") context.controller.abort();
    }), { name: "AbortError" });
    assert.equal((await context.transcript()).filter(message => message.method === "turn/interrupt").length, 1);
  } finally { await context.cleanup(); }
});

test("invalid approval modes fail before starting a worker process", async () => {
  const context = await setup("complete");
  try {
    await assert.rejects(context.adapter.run({ ...context.request, approvalMode: "approve-all" as any }, context.controller.signal, () => {}), /approval mode/);
    await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
  } finally { await context.cleanup(); }
});

for (const [scenario, expected] of [
  ["transport", /MCP error -32000: unavailable/],
  ["payload", /TARGET_MISSING.*No active REA context/],
  ["structured", /-32001.*Nested MCP error/],
  ["malformed", /without a supported error message/],
  ["late-error", /Late MCP error/],
] as const) {
  test(`MCP ${scenario} failures retain bounded diagnostics without failing a recovered worker`, async () => {
    const context = await setup(`mcp-diagnostic-${scenario}`);
    try {
      const result = await context.adapter.run({ ...context.request, mode: "write", mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool"] } }, context.controller.signal, event => context.events.push(event));
      assert.equal(result.output, "worker recovered");
      assert.ok(result.toolsUsed?.includes("mcp:fixture/write_tool"));
      const diagnostics = context.events.filter((event): event is Extract<WorkerEvent, { type: "log" }> => event.type === "log" && event.message.startsWith("MCP tool call failed"));
      assert.equal(diagnostics.length, 1, "Repeated item/completed and terminal items must not duplicate the error.");
      assert.match(diagnostics[0]!.message, expected);
      assert.match(diagnostics[0]!.message, /^MCP tool call failed \(fixture\/write_tool\): /);
      assert.ok(Buffer.byteLength(diagnostics[0]!.message) <= 8192);
      const diagnostic = diagnostics[0]!.message;
      assert.doesNotMatch(diagnostic, /MCP_PRIVATE_|private-mcp-|quoted credential with spaces|multiline value|credential-pass|credential-token|credential-key|credential-signature|fragment-secret|\x1b/);
      const activities = context.events.filter((event): event is Extract<WorkerEvent, { type: "activity" }> => event.type === "activity" && event.activity.id === "mcp-diagnostic-call");
      assert.equal(activities.at(-1)?.activity.status, "failed");
    } finally { await context.cleanup(); }
  });
}

test("successful MCP results and business status fields do not enter failure diagnostics", async () => {
  const context = await setup("mcp-diagnostic-success");
  try {
    const result = await context.adapter.run({ ...context.request, mode: "write", mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool"] } }, context.controller.signal, event => context.events.push(event));
    assert.equal(result.output, "worker recovered");
    assert.ok(result.toolsUsed?.includes("mcp:fixture/write_tool"));
    assert.equal(context.events.some(event => event.type === "log" && /MCP tool call failed|MCP_PRIVATE/.test(event.message)), false);
    assert.equal(context.events.findLast(event => event.type === "activity" && event.activity.id === "mcp-diagnostic-call")?.type, "activity");
    assert.equal(context.events.some(event => event.type === "activity" && event.activity.id === "mcp-diagnostic-call" && event.activity.status === "failed"), false);
  } finally { await context.cleanup(); }
});

test("MCP diagnostic projection ignores cyclic/deep data, resources, malformed fields and large JSON payloads", () => {
  const diagnostics = new McpFailureDiagnostics(value => value);
  const cyclic: Record<string, unknown> = { arguments: { prompt: "MCP_PRIVATE_PROMPT" } }; cyclic.error = cyclic;
  const deep = { nested: { nested: { nested: { error: "MCP_PRIVATE_DEEP" } } } };
  const items = [
    { error: { message: cyclic }, result: { structuredContent: cyclic } },
    { result: { structuredContent: deep, content: [{ type: "image", data: "MCP_PRIVATE_IMAGE" }, { type: "resource", resource: { text: "MCP_PRIVATE_RESOURCE" } }, { type: "text", text: 4 }] } },
    { result: { content: [{ type: "text", text: '{"arguments":"' + "MCP_PRIVATE_LARGE".repeat(100_000) + '"}' }] } },
    { result: { content: [{ type: "text", text: "{" + "[".repeat(4000) + "}" }] } },
  ];
  for (const [index, item] of items.entries()) {
    const result = diagnostics.capture({ ...item, id: String(index), type: "mcpToolCall", status: "failed" });
    assert.ok(result);
    assert.ok(Buffer.byteLength(result) <= 8192);
    assert.doesNotMatch(result, /MCP_PRIVATE/);
  }
  assert.equal(mcpItemFailed({ type: "mcpToolCall", status: "completed", result: { structuredContent: { status: "failed", error: "business result" } } }), false);
});

test("MCP diagnostics cap total errors and UTF-8 bytes while preserving ID deduplication", () => {
  for (const detail of ["small error", "失败。".repeat(10_000)]) {
    const diagnostics = new McpFailureDiagnostics(value => value);
    const logs: string[] = [];
    for (let index = 0; index < 1000; index++) {
      const item = { id: String(index), type: "mcpToolCall", status: "failed", error: { message: detail } };
      const result = diagnostics.capture(item);
      if (result) logs.push(result);
      assert.equal(diagnostics.capture(item), undefined);
    }
    assert.ok(logs.length <= 101);
    assert.ok(logs.every(log => Buffer.byteLength(log) <= 8192));
    assert.ok(logs.reduce((sum, log) => sum + Buffer.byteLength(log), 0) <= 65_536);
    assert.match(logs.at(-1)!, /limit reached/);
    assert.equal(logs.some(log => log.includes("\ufffd")), false, "Truncation preserves UTF-8 boundaries.");
  }
});

test("MCP error redaction handles escaped JSON keys and truncation inside a quoted credential", () => {
  const diagnostics = new McpFailureDiagnostics(value => value);
  for (const [index, message] of [
    'validation error: "{\\"password\\":\\"private escaped credential\\"}"',
    'validation error: {"password":"' + "private quoted credential ".repeat(1000) + '"}',
    'validation error: {"arguments":{"unknownKey":"private input payload"}}',
  ].entries()) {
    const log = diagnostics.capture({ id: String(index), type: "mcpToolCall", status: "failed", error: { message } });
    assert.ok(log);
    assert.match(log, /validation error/);
    assert.doesNotMatch(log, /private escaped|private quoted|quoted credential|private input|unknownKey/);
  }
});

test("MCP error diagnostics include only ordinary validated server and tool names", () => {
  const diagnostics = new McpFailureDiagnostics(value => value);
  const call = { type: "mcpToolCall", status: "failed", error: { message: "Protocol failed" } };
  assert.match(diagnostics.capture({ ...call, id: "valid", server: "rea", tool: "binary_session" })!, /^MCP tool call failed \(rea\/binary_session\): /);
  for (const [index, names] of [
    { server: "secret-private-server", tool: "read_tool" },
    { server: "rea", tool: "token-private-tool" },
    { server: "https://private.example.test/server", tool: "read_tool" },
    { server: "rea", tool: "x".repeat(81) },
    { server: "rea", tool: "bad\nprivate-tool" },
  ].entries()) {
    assert.equal(diagnostics.capture({ ...call, ...names, id: String(index) }), "MCP tool call failed: message: Protocol failed");
  }
});

test("completion received before the turn/start acknowledgement is retained", async () => {
  const context = await setup("completion-before-ack");
  try {
    const result = await context.adapter.run(context.request, context.controller.signal, () => {});
    assert.equal(result.output, "finished before acknowledgement");
  } finally { await context.cleanup(); }
});

test("execution settings discovery reads real protocol config and catalogue without a thread or turn", async () => {
  const context = await setup("complete");
  try {
    const environment = await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
    assert.deepEqual(environment.defaults, { model: "test-inherited-model", reasoningEffort: "medium" });
    assert.deepEqual(environment.models.find(model => model.id === "low-only-model")?.supportedReasoningEfforts, ["low"]);
    const transcript = await context.transcript();
    assert.deepEqual(transcript.filter(message => message.method).map(message => message.method), ["initialize", "initialized", "config/read", "model/list"]);
    assert.equal(transcript.some(message => /thread\/|turn\//.test(String(message.method))), false);
  } finally { await context.cleanup(); }
});

test("catalogue reuse keeps fresh config reads and separate worker processes without repeated model/list", async () => {
  const context = await setup("complete");
  try {
    await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
    for (let index = 0; index < 2; index++) await context.adapter.run({ ...context.request, id: `cached-${index}`, model: "explicit-test-model", reasoningEffort: "high" }, context.controller.signal, event => context.events.push(event));
    const transcript = await context.transcript();
    assert.equal(transcript.filter(message => message.method === "model/list").length, 1);
    assert.equal(transcript.filter(message => message.method === "config/read").length, 3);
    assert.equal(transcript.filter(message => message.method === "initialize").length, 3);
    assert.equal(transcript.filter(message => message.method === "thread/start").length, 2);
    const starts = context.events.filter(event => event.type === "process" && event.state === "started");
    assert.equal(new Set(starts.map(event => event.type === "process" ? event.pid : undefined)).size, 2);
    const other = path.join(context.request.cwd, "other"); await mkdir(other);
    await context.adapter.executionEnvironment(other, context.controller.signal);
    assert.equal((await context.transcript()).filter(message => message.method === "model/list").length, 2);
  } finally { await context.cleanup(); }
});

test("catalogue cache survives reordered fresh configuration objects in the same cwd", async () => {
  const context = await setup("catalog-cache-order");
  try {
    const first = await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal), first);
    }
    const transcript = await context.transcript();
    assert.equal(transcript.filter(message => message.method === "config/read").length, 3);
    assert.equal(transcript.filter(message => message.method === "model/list").length, 1);
    assert.equal(transcript.some(message => /thread\/|turn\//.test(String(message.method))), false);
  } finally { await context.cleanup(); }
});

for (const change of ["command", "env", "argv-order"] as const) {
  test(`catalogue cache misses for real fresh configuration changes: ${change}`, async () => {
    const context = await setup(`catalog-cache-${change}`);
    try {
      for (let index = 0; index < 3; index++) await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
      const transcript = await context.transcript();
      assert.equal(transcript.filter(message => message.method === "config/read").length, 3);
      assert.equal(transcript.filter(message => message.method === "model/list").length, 2,
        "A real value or argument order change invalidates the directory; unchanged subsequent reads reuse it.");
    } finally { await context.cleanup(); }
  });
}

test("native item notifications produce safe live actions followed by terminal activity", async () => {
  const context = await setup("native-items");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    const activities = context.events.filter(event => event.type === "activity").map(event => event.type === "activity" ? event.activity : undefined)!;
    assert.ok(activities.some(activity => activity?.kind === "initializing" && activity.status === "running"));
    assert.ok(activities.some(activity => activity?.id === "native-command" && activity.status === "running"));
    assert.ok(activities.some(activity => activity?.id === "native-command" && activity.status === "completed" && activity.endedAt));
    assert.ok(activities.some(activity => activity?.kind === "files"));
    assert.ok(activities.some(activity => activity?.kind === "search"));
    assert.equal(JSON.stringify(activities).includes("working commentary"), false);
  } finally { await context.cleanup(); }
});

test("terminal-only command output is redacted and reports negative exits without duplicate capture", async () => {
  const context = await setup("terminal-command-output");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    const logs = context.events.filter(event => event.type === "log").map(event => event.message).join("\n");
    assert.equal(logs.match(/here-document: Operation not permitted/g)?.length, 1);
    assert.equal(logs.match(/Native command failed \(exit -9\)/g)?.length, 1);
    assert.equal(logs.includes("private-terminal-secret"), false);
    assert.equal(logs.includes("full-command-private-marker"), false);
    assert.ok(logs.includes("[redacted]"));
    assert.ok(context.events.some(event => event.type === "activity" && event.activity.id === "terminal-command" && event.activity.status === "failed"));
  } finally { await context.cleanup(); }
});

test("terminal command output never repeats already streamed output", async () => {
  const context = await setup("streamed-terminal-command");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    const logs = context.events.filter(event => event.type === "log").map(event => event.message).join("\n");
    assert.equal(logs.match(/STREAM_DUPLICATE_MARKER/g)?.length, 1);
    assert.equal(logs.includes("private-stream-terminal-secret"), false);
  } finally { await context.cleanup(); }
});

test("terminal aggregate fallback is bounded after redaction and empty deltas do not suppress it", async () => {
  const context = await setup("terminal-command-long");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    const logs = context.events.filter(event => event.type === "log").map(event => event.message);
    assert.equal(logs.filter(message => message.includes("LONG_BEGIN")).length, 1);
    assert.ok(logs.every(message => message.length <= 32_768));
    assert.ok(logs.some(message => message.includes("[Native command output truncated.]")));
    assert.equal(logs.join("\n").includes("sk-abc"), false, "Redact before the cap can split a credential below its recognizer's minimum length.");
  } finally { await context.cleanup(); }
});

test("terminal command failures without captured output still produce a short failure log", async () => {
  const context = await setup("terminal-command-no-output");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    assert.equal(context.events.filter(event => event.type === "log" && event.message === "Native command failed.").length, 1);
  } finally { await context.cleanup(); }
});

test("ephemeral workers exclude code-mode delegation without disabling native execution", async () => {
  const context = await setup("native-items");
  try {
    const result = await context.adapter.run(context.request, context.controller.signal, () => {});
    assert.ok(result.toolsUsed?.includes("native:commandExecution"));
    assert.ok(result.toolsUsed?.includes("native:fileChange"));
    const transcript = await context.transcript();
    const startupArguments = transcript.find(message => message.type === "pid")!.arguments as string[];
    assert.ok(startupArguments.some((value, index) => value === "-c" && startupArguments[index + 1] === "agents.enabled=false"));
    assert.equal(startupArguments.includes("code_mode_host"), false);
    const thread = transcript.find(message => message.method === "thread/start")!;
    assert.equal(thread.params.ephemeral, true);
    assert.equal(thread.params.config["agents.enabled"], false);
    assert.equal(thread.params.config["features.code_mode_host"], undefined);
  } finally { await context.cleanup(); }
});

test("model and effort overrides are catalogue-validated and observed configured settings are reported", async () => {
  const context = await setup("complete");
  try {
    const result = await context.adapter.run({ ...context.request, model: "explicit-test-model", reasoningEffort: "high", settingsSource: "phase" }, context.controller.signal, event => context.events.push(event));
    assert.deepEqual(result.executionSettings, { model: "explicit-test-model", reasoningEffort: "high", source: "phase", provenance: "configured" });
    assert.ok(context.events.some(event => event.type === "execution-settings" && event.settings.provenance === "configured"));
    const transcript = await context.transcript();
    assert.equal(transcript.find(message => message.method === "thread/start")?.params.config.model_reasoning_effort, "high");
    assert.equal(transcript.find(message => message.method === "turn/start")?.params.effort, "high");
    assert.equal(transcript.find(message => message.method === "thread/start")?.params.allowProviderModelFallback, false);
    await assert.rejects(context.adapter.run({ ...context.request, model: "low-only-model" }, context.controller.signal, () => {}), /unsupported/);
    await assert.rejects(context.adapter.run({ ...context.request, model: "unknown-model" }, context.controller.signal, () => {}), /unavailable/);
    const requests = (await context.transcript()).filter(message => message.method === "turn/start");
    assert.equal(requests.length, 1);
  } finally { await context.cleanup(); }
});

test("catalogue failures and shutdown cannot leak a discovery process or fake model list", async () => {
  const invalid = await setup("catalog-invalid");
  try { await assert.rejects(invalid.adapter.executionEnvironment(invalid.request.cwd, invalid.controller.signal)); }
  finally { await invalid.cleanup(); }
  const context = await setup("catalog-hang", { startupTimeoutMs: 3000 });
  try {
    const discovery = context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
    const rejected = assert.rejects(discovery, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 80));
    await context.adapter.close();
    await rejected;
    await assert.rejects(context.adapter.executionEnvironment(context.request.cwd, context.controller.signal), /closed/);
  } finally { await context.cleanup(); }
});

test("explicit valid selection repairs unavailable CLI defaults at the production protocol boundary", async () => {
  const context = await setup("config-invalid-defaults");
  try {
    const environment = await context.adapter.executionEnvironment(context.request.cwd, context.controller.signal);
    assert.deepEqual(environment.defaults, { model: "removed-model", reasoningEffort: "unsupported" });
    assert.equal(environment.models.length, 3);
    const result = await context.adapter.run({ ...context.request, model: "explicit-test-model", reasoningEffort: "low", settingsSource: "workflow-settings" }, context.controller.signal, () => {});
    assert.deepEqual(result.executionSettings, { model: "explicit-test-model", reasoningEffort: "low", source: "workflow-settings", provenance: "configured" });
  } finally { await context.cleanup(); }
});

test("write worker confines writes to its workspace and forwards an explicit model and schema", async () => {
  const context = await setup("structured");
  try {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
    const result = await context.adapter.run({ ...context.request, mode: "write", model: "explicit-test-model", outputSchema: schema }, context.controller.signal, () => {});
    assert.deepEqual(result.data, { answer: 42 });
    const transcript = await context.transcript();
    const thread = transcript.find(message => message.method === "thread/start")!;
    assert.equal(thread.params.model, "explicit-test-model");
    const turn = transcript.find(message => message.method === "turn/start")!;
    assert.deepEqual(turn.params.outputSchema, schema);
    assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [context.request.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  } finally { await context.cleanup(); }
});

test("new local write workers grant only their own contained Git directory at every protocol stage", async () => {
  const context = await setup("complete");
  try {
    execFileSync("git", ["init", "--quiet", context.request.cwd]);
    await context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {});
    const cwd = await realpath(context.request.cwd), roots = [cwd, path.join(cwd, ".git")];
    const transcript = await context.transcript(), thread = transcript.find(message => message.method === "thread/start")!, turn = transcript.find(message => message.method === "turn/start")!;
    assert.deepEqual(thread.params.config["sandbox_workspace_write.writable_roots"], roots);
    assert.deepEqual(turn.params.sandboxPolicy.writableRoots, roots);
    assert.match(thread.params.developerInstructions, /contained Git metadata is writable/);
    assert.match(thread.params.developerInstructions, /\.agents and \.codex remain protected/);
    assert.equal(turn.params.approvalPolicy, "never");
  } finally { await context.cleanup(); }
});

test("legacy local write requests do not gain Git metadata permission", async () => {
  const context = await setup("complete");
  try {
    execFileSync("git", ["init", "--quiet", context.request.cwd]);
    await context.adapter.run({ ...context.request, mode: "write" }, context.controller.signal, () => {});
    const transcript = await context.transcript();
    assert.deepEqual(transcript.find(message => message.method === "thread/start")!.params.config["sandbox_workspace_write.writable_roots"], [context.request.cwd]);
    assert.deepEqual(transcript.find(message => message.method === "turn/start")!.params.sandboxPolicy.writableRoots, [context.request.cwd]);
  } finally { await context.cleanup(); }
});

test("read workers reject the internal local Git write capability before launching", async () => {
  const context = await setup("complete");
  try {
    await assert.rejects(context.adapter.run({ ...context.request, localGitWrite: true }, context.controller.signal, () => {}), /requires a write worker/);
    await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
  } finally { await context.cleanup(); }
});

for (const scenario of ["worker-extra-root", "worker-missing-root", "worker-duplicate-root", "worker-wrong-cwd", "worker-missing-cwd"]) {
  test(`local Git scope refuses an incorrectly enforced sandbox (${scenario})`, async () => {
    const context = await setup(scenario);
    try {
      execFileSync("git", ["init", "--quiet", context.request.cwd]);
      await assert.rejects(context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {}), /does not match its declared workspace and Git scope/);
      assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
    } finally { await context.cleanup(); }
  });
}

for (const withGit of [true, false]) {
  test(`native workspace-write implicit cwd is verified with the exact additional roots (Git ${withGit})`, async () => {
    const context = await setup("worker-implicit-cwd");
    try {
      if (withGit) execFileSync("git", ["init", "--quiet", context.request.cwd]);
      const result = await context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {});
      assert.equal(result.output, "worker complete");
      const transcript = await context.transcript();
      assert.deepEqual(transcript.find(message => message.method === "turn/start")!.params.sandboxPolicy.writableRoots, [context.request.cwd, ...(withGit ? [path.join(context.request.cwd, ".git")] : [])]);
    } finally { await context.cleanup(); }
  });
}

test("local Git write capability rejects a replaced project root that became a symbolic link", async () => {
  const context = await setup("complete"), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-local-root-outside-")));
  try {
    const alias = path.join(context.request.cwd, "linked-project");
    await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(context.adapter.run({ ...context.request, cwd: alias, mode: "write", localGitWrite: true }, context.controller.signal, () => {}), /canonical project directory without symbolic links/);
    await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
  } finally { await context.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

for (const scenario of ["worker-swap-git-config", "worker-swap-git-thread", "worker-swap-git-inventory"]) {
  test(`local Git scope refuses metadata replaced during worker startup (${scenario})`, async () => {
    const context = await setup(scenario);
    try {
      execFileSync("git", ["init", "--quiet", context.request.cwd]);
      await assert.rejects(context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {}), /Git metadata identity or writable scope changed/);
      assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
      if (scenario === "worker-swap-git-config") assert.equal((await context.transcript()).some(message => message.method === "thread/start"), false);
    } finally { await context.cleanup(); }
  });
}

test("local Git sandbox comparison accepts only the complete root set independent of order", async () => {
  const context = await setup("worker-reordered-roots");
  try {
    execFileSync("git", ["init", "--quiet", context.request.cwd]);
    const result = await context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {});
    assert.equal(result.output, "worker complete");
  } finally { await context.cleanup(); }
});

for (const kind of ["linked", "symlink", "external-common", "absent"] as const) {
  test(`local source editing does not grant unsafe Git metadata (${kind})`, async () => {
    const context = await setup("complete"), outside = await mkdtemp(path.join(os.tmpdir(), "workflows-local-git-outside-"));
    try {
      if (kind !== "absent") execFileSync("git", ["init", "--quiet", context.request.cwd]);
      if (kind === "linked" || kind === "symlink") {
        const metadata = path.join(outside, "metadata");
        const { rename } = await import("node:fs/promises");
        await rename(path.join(context.request.cwd, ".git"), metadata);
        if (kind === "linked") await writeFile(path.join(context.request.cwd, ".git"), `gitdir: ${metadata}\n`);
        else await symlink(metadata, path.join(context.request.cwd, ".git"), process.platform === "win32" ? "junction" : "dir");
      } else if (kind === "external-common") {
        execFileSync("git", ["init", "--quiet", "--bare", outside]);
        await writeFile(path.join(context.request.cwd, ".git", "commondir"), outside + "\n");
      }
      const before = kind === "absent" ? undefined : await readFile(path.join(kind === "linked" || kind === "symlink" ? path.join(outside, "metadata") : path.join(context.request.cwd, ".git"), "HEAD"), "utf8");
      const result = await context.adapter.run({ ...context.request, mode: "write", localGitWrite: true }, context.controller.signal, () => {});
      assert.equal(result.output, "worker complete");
      const transcript = await context.transcript(), thread = transcript.find(message => message.method === "thread/start")!;
      assert.deepEqual(thread.params.config["sandbox_workspace_write.writable_roots"], [await realpath(context.request.cwd)]);
      assert.deepEqual(transcript.find(message => message.method === "turn/start")!.params.sandboxPolicy.writableRoots, [await realpath(context.request.cwd)]);
      assert.match(thread.params.developerInstructions, /Git metadata writing is not granted/);
      if (before !== undefined) assert.equal(await readFile(path.join(kind === "linked" || kind === "symlink" ? path.join(outside, "metadata") : path.join(context.request.cwd, ".git"), "HEAD"), "utf8"), before);
    } finally { await context.cleanup(); await rm(outside, { recursive: true, force: true }); }
  });
}

for (const scenario of ["interrupt", "cancel-before-ack"]) {
  test(`abort sends turn/interrupt and waits for terminal status (${scenario})`, async () => {
    const context = await setup(scenario);
    try {
      await assert.rejects(context.adapter.run(context.request, context.controller.signal, event => {
        if (event.type === "identity" && event.turnId) context.controller.abort();
      }), { name: "AbortError" });
      const transcript = await context.transcript();
      assert.ok(transcript.some(message => message.method === "turn/interrupt" && message.params.turnId === "test-turn"));
    } finally { await context.cleanup(); }
  });
}

test("startup timeout terminates a process that never acknowledges initialize", async () => {
  const context = await setup("startup-hang", { startupTimeoutMs: 100 });
  try {
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, event => context.events.push(event)), { name: "TimeoutError" });
    const processes = context.events.filter(event => event.type === "process");
    assert.equal(processes[0]?.state, "started");
    assert.deepEqual(processes[1], { type: "process", state: "exited", pid: processes[0]!.pid });
    assert.equal(context.events.some(event => event.type === "identity"), false);
  } finally { await context.cleanup(); }
});

test("abort during startup terminates before sending a turn", async () => {
  const context = await setup("complete");
  try {
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, event => {
      if (event.type === "identity" && !event.turnId) context.controller.abort();
    }), { name: "AbortError" });
    assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
  } finally { await context.cleanup(); }
});

test("independent worker processes can run concurrently", async () => {
  const context = await setup("complete");
  try {
    const results = await Promise.all([
      context.adapter.run({ ...context.request, id: "one" }, context.controller.signal, () => {}),
      context.adapter.run({ ...context.request, id: "two" }, context.controller.signal, () => {}),
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.output === "worker complete"));
    assert.equal((await context.transcript()).filter(message => message.type === "pid").length, 2);
  } finally { await context.cleanup(); }
});

test("execution timeout escalates to forced cleanup when interrupt and SIGTERM are ignored", async () => {
  const context = await setup("stubborn");
  try {
    await assert.rejects(context.adapter.run({ ...context.request, timeoutMs: 80 }, context.controller.signal, () => {}), { name: "TimeoutError" });
    const transcript = await context.transcript();
    assert.ok(transcript.some(message => message.method === "turn/interrupt"));
    const pid = transcript.find(message => message.type === "pid")!.pid;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    // The descendant belongs to the same detached process group and is killed with the worker host.
    const descendant = transcript.find(message => message.type === "descendant")!.pid;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  } finally { await context.cleanup(); }
});

test("closing the adapter interrupts active workers and rejects further runs", async () => {
  const context = await setup("interrupt");
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const operation = context.adapter.run(context.request, context.controller.signal, event => { if (event.type === "identity" && event.turnId) started(); });
    const rejection = assert.rejects(operation, { name: "AbortError" });
    await ready;
    await context.adapter.close();
    await rejection;
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), /closed/);
  } finally { await context.cleanup(); }
});

for (const [scenario, pattern] of [
  ["enabled-mcp", /MCP tools remain enabled/],
  ["unsafe-sandbox", /requested worker sandbox/],
  ["host-request", /unsupported host interaction/],
  ["exit", /exited before completion/],
  ["malformed", /invalid JSON/],
] as const) {
  test(`fails closed for ${scenario}`, async () => {
    const context = await setup(scenario);
    try {
      await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), pattern);
      if (scenario === "enabled-mcp" || scenario === "unsafe-sandbox") {
        assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
      }
    } finally { await context.cleanup(); }
  });
}

test("server failure diagnostics redact credentials and omit unnecessary endpoint details", async () => {
  const context = await setup("server-error");
  try {
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-test-token"), false);
      assert.equal(error.message.includes("private.example.test"), false);
      assert.ok(error.message.includes("[redacted]"));
      return true;
    });
  } finally { await context.cleanup(); }
});

test("source URLs survive worker results, streamed logs and command outputs", async () => {
  const context = await setup("public-url");
  try {
    const schema = { type: "object", properties: { sources: { type: "array", items: { type: "string" } } }, required: ["sources"], additionalProperties: false };
    const result = await context.adapter.run({ ...context.request, outputSchema: schema }, context.controller.signal, event => context.events.push(event));
    const links = ["https://docs.example.test/guide?lang=zh&section=workflow#native-tools", "https://workspace.example.test/review?project=source#L42"];
    assert.deepEqual(result.data, { sources: links });
    assert.deepEqual(JSON.parse(result.output), result.data);
    const command = await context.adapter.command({ id: "public-source", cwd: context.request.cwd, command: ["curl", "https://docs.example.test/guide"] }, context.controller.signal, event => context.events.push(event));
    assert.deepEqual(JSON.parse(command.stdout), result.data);
    const logs = context.events.filter(event => event.type === "log").map(event => event.message).join("");
    for (const link of links) assert.ok(logs.includes(link));
  } finally { await context.cleanup(); }
});

test("URL credentials and sensitive parameters are removed without erasing the source", async () => {
  const context = await setup("credential-url");
  try {
    const result = await context.adapter.run({ ...context.request, outputSchema: { type: "object" } }, context.controller.signal, event => context.events.push(event));
    const command = await context.adapter.command({ id: "credential-source", cwd: context.request.cwd, command: ["curl", "https://docs.example.test/guide"] }, context.controller.signal, event => context.events.push(event));
    const source = "https://docs.example.test/guide?lang=zh#section=source";
    assert.deepEqual(result.data, { sources: [source] });
    assert.deepEqual(JSON.parse(result.output), result.data);
    assert.deepEqual(JSON.parse(command.stdout), result.data);
    const logs = context.events.filter(event => event.type === "log").map(event => event.message).join("");
    const all = [result.output, command.stdout, logs].join("\n");
    for (const secret of ["demo-user", "credential-pass", "credential-token", "credential-key", "credential-signature", "credential-again", "fragment-secret"]) assert.equal(all.includes(secret), false);
    assert.ok(logs.includes(source));
    const unstructured = await context.adapter.run(context.request, context.controller.signal, () => {});
    assert.equal(unstructured.output.includes("credential-token"), false);
    assert.ok(unstructured.output.includes(source));
  } finally { await context.cleanup(); }
});

test("credentials split across output deltas are redacted before logs are emitted", async () => {
  const context = await setup("sensitive-stream");
  try {
    await context.adapter.run(context.request, context.controller.signal, event => context.events.push(event));
    const logs = context.events.filter(event => event.type === "log").map(event => event.message).join("");
    assert.equal(logs.includes("private-test-secret"), false);
    assert.equal(logs.includes("test-secret"), false);
    assert.ok(logs.includes("token=[redacted]"));
  } finally { await context.cleanup(); }
});

test("malformed structured output fails instead of producing invented data", async () => {
  const context = await setup("bad-structured");
  try {
    await assert.rejects(context.adapter.run({ ...context.request, outputSchema: { type: "object" } }, context.controller.signal, () => {}), /valid structured JSON/);
  } finally { await context.cleanup(); }
});

test("already-aborted requests and missing executables fail without hanging", async () => {
  const context = await setup("complete");
  try {
    context.controller.abort();
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), { name: "AbortError" });
    const adapter = new CodexAdapter({ command: path.join(context.request.cwd, "missing-codex"), startupTimeoutMs: 100, shutdownTimeoutMs: 100 });
    try { await assert.rejects(adapter.run(context.request, new AbortController().signal, () => {}), /Could not launch/); }
    finally { await adapter.close(); }
  } finally { await context.cleanup(); }
});

for (const mode of ["read", "write"] as const) {
  test(`explicit network permission preserves ${mode} sandbox and enables native live search`, async () => {
    const context = await setup("complete");
    try {
      await context.adapter.run({ ...context.request, mode, networkAccess: true }, context.controller.signal, () => {});
      const trace = await context.transcript();
      const thread = trace.find(item => item.method === "thread/start")!;
      const turn = trace.find(item => item.method === "turn/start")!;
      assert.equal(thread.params.config.web_search, "live");
      assert.equal(turn.params.sandboxPolicy.type, mode === "read" ? "readOnly" : "workspaceWrite");
      assert.equal(turn.params.sandboxPolicy.networkAccess, true);
      if (mode === "read") assert.equal("writableRoots" in turn.params.sandboxPolicy, false);
    } finally { await context.cleanup(); }
  });
}

test("native item evidence is recorded rather than inferred from result text", async () => {
  const context = await setup("native-items");
  try {
    const result = await context.adapter.run({ ...context.request, mode: "write" }, context.controller.signal, () => {});
    assert.deepEqual(result.toolsUsed, ["native:commandExecution", "native:fileChange", "native:webSearch"]);
  } finally { await context.cleanup(); }
});

test("MCP grants use exact configured dotted names and retain user per-tool approvals", async () => {
  for (const scenario of ["dotted-mcp", "mcp-user-filter"]) {
    const context = await setup(scenario);
    const name = scenario === "dotted-mcp" ? "fixture.docs" : "fixture";
    try {
      await context.adapter.run({ ...context.request, mcpServers: [name], mcpTools: { [name]: ["read_tool"] } }, context.controller.signal, () => {});
      const thread = (await context.transcript()).find(item => item.method === "thread/start")!;
      const configured = thread.params.config.mcp_servers[name];
      assert.deepEqual(configured.enabled_tools, ["read_tool"]);
      assert.equal(configured.required, true);
      assert.equal("tool_timeout_sec" in configured, false);
      if (scenario === "mcp-user-filter") {
        assert.deepEqual(configured.disabled_tools, ["write_tool"]);
        assert.equal(configured.tools.read_tool.approval_mode, "prompt");
      }
    } finally { await context.cleanup(); }
  }
});

for (const [scenario, request, error] of [
  ["complete", { mcpServers: ["missing"] }, /not present/],
  ["complete", { mcpServers: ["workflows"] }, /recursively/],
  ["recursive-mcp", { mcpServers: ["fixture"] }, /inventory could not/],
  ["mcp-user-disabled", { mcpServers: ["fixture"] }, /disabled in the user's/],
  ["mcp-user-filter", { mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool"] } }, /existing user tool filters/],
  ["complete", { mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool", "missing_tool"] } }, /absent or disabled/],
  ["mcp-user-filter", { mcpServers: ["fixture"], mcpTools: { fixture: ["read_tool", "write_tool"] } }, /existing user tool filters/],
  ["complete", { mode: "write", mcpServers: ["fixture"] }, /explicit MCP tool grant/],
] as const) {
  test(`MCP request fails closed: ${error.source}`, async () => {
    const context = await setup(scenario);
    try {
      await assert.rejects(context.adapter.run({ ...context.request, ...request }, context.controller.signal, () => {}), error);
    } finally { await context.cleanup(); }
  });
}

test("explicit write-task MCP tool grant does not expose unrequested tools", async () => {
  const context = await setup("complete");
  try {
    await context.adapter.run({ ...context.request, mode: "write", mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool"] } }, context.controller.signal, () => {});
    const thread = (await context.transcript()).find(item => item.method === "thread/start")!;
    assert.deepEqual(thread.params.config.mcp_servers.fixture.enabled_tools, ["write_tool"]);
  } finally { await context.cleanup(); }
});

test("a shared workflow MCP grant narrows read nodes and preserves the exact write-node grant", async () => {
  const globalGrant = { fixture: ["read_tool", "write_tool"] };
  const originalGrant = structuredClone(globalGrant);
  for (const mode of ["read", "write"] as const) {
    const context = await setup("complete");
    try {
      await context.adapter.run({ ...context.request, mode, mcpServers: ["fixture"], mcpTools: globalGrant }, context.controller.signal, () => {});
      const trace = await context.transcript();
      const thread = trace.find(item => item.method === "thread/start")!;
      assert.deepEqual(thread.params.config.mcp_servers.fixture.enabled_tools, mode === "read" ? ["read_tool"] : ["read_tool", "write_tool"]);
      assert.equal(thread.params.config.mcp_servers.fixture.enabled, true);
      assert.equal(thread.params.config.mcp_servers.fixture.required, true);
      assert.equal(trace.some(item => item.method === "turn/start"), true);
      assert.deepEqual(globalGrant, originalGrant);
    } finally { await context.cleanup(); }
  }
});

for (const [scenario, tools] of [
  ["mcp-no-readonly", undefined],
  ["mcp-no-readonly", ["write_tool"]],
  ["mcp-unannotated", ["unannotated_tool", "write_tool"]],
  ["mcp-unannotated", []],
] as const) {
  test(`read nodes disable empty MCP intersections and retain native commands: ${scenario}/${tools?.join(",") ?? "automatic"}`, async () => {
    const context = await setup(scenario);
    try {
      const result = await context.adapter.run({ ...context.request, mcpServers: ["fixture"], ...(tools ? { mcpTools: { fixture: [...tools] } } : {}) }, context.controller.signal, () => {});
      const trace = await context.transcript();
      const thread = trace.find(item => item.method === "thread/start")!;
      assert.deepEqual(thread.params.config.mcp_servers.fixture, { enabled: false, required: false });
      assert.match(thread.params.developerInstructions, /No external MCP tools are authorized/);
      assert.equal(thread.params.sandbox, "read-only");
      assert.ok(result.toolsUsed?.includes("native:commandExecution"));
      assert.equal(trace.some(item => item.method === "turn/start"), true);
    } finally { await context.cleanup(); }
  });
}

test("unannotated MCP tools cannot enter a read node's mixed explicit grant", async () => {
  const context = await setup("mcp-unannotated");
  try {
    await context.adapter.run({ ...context.request, mcpServers: ["fixture"], mcpTools: { fixture: ["unannotated_tool", "read_tool", "write_tool"] } }, context.controller.signal, () => {});
    const thread = (await context.transcript()).find(item => item.method === "thread/start")!;
    assert.deepEqual(thread.params.config.mcp_servers.fixture.enabled_tools, ["read_tool"]);
  } finally { await context.cleanup(); }
});

for (const scenario of ["mcp-readonly-flipped", "mcp-readonly-missing-runtime"]) {
  test(`changed runtime MCP read-only declarations prevent the worker turn: ${scenario}`, async () => {
    const context = await setup(scenario);
    try {
      await assert.rejects(context.adapter.run({ ...context.request, mcpServers: ["fixture"], mcpTools: { fixture: ["read_tool", "write_tool"] } }, context.controller.signal, () => {}), /read-only tool declarations changed/);
      const trace = await context.transcript();
      assert.equal(trace.some(item => item.method === "thread/start"), true);
      assert.equal(trace.some(item => item.method === "turn/start"), false);
    } finally { await context.cleanup(); }
  });
}

test("automatic read-only MCP grants intersect existing user filters", async () => {
  const context = await setup("mcp-user-filter");
  try {
    await context.adapter.run({ ...context.request, mcpServers: ["fixture"] }, context.controller.signal, () => {});
    const thread = (await context.transcript()).find(item => item.method === "thread/start")!;
    assert.deepEqual(thread.params.config.mcp_servers.fixture.enabled_tools, ["read_tool"]);
    assert.deepEqual(thread.params.config.mcp_servers.fixture.disabled_tools, ["write_tool"]);
    assert.equal(thread.params.config.mcp_servers.fixture.tool_timeout_sec, undefined);
  } finally { await context.cleanup(); }
});

test("command protocol uses exact argv, bounded sandbox and redacts streamed output", async () => {
  const context = await setup("command-complete");
  try {
    const command = ["git", "status", "--short"];
    const result = await context.adapter.command({ id: "command-test", cwd: context.request.cwd, command, networkAccess: true }, context.controller.signal, event => context.events.push(event));
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 1);
    assert.equal(result.stdout, "command complete\n");
    assert.equal(result.stderr, "token=[redacted]\n");
    const call = (await context.transcript()).find(item => item.method === "command/exec")!;
    assert.deepEqual(call.params.command, command);
    assert.equal(call.params.cwd, await realpath(context.request.cwd));
    assert.equal(call.params.sandboxPolicy.networkAccess, true);
    assert.equal(call.params.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(Object.keys(call.params.env).sort(), ["NPM_CONFIG_CACHE", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache"].sort());
    for (const directory of Object.values(call.params.env) as string[]) assert.ok(directory.startsWith(call.params.cwd + path.sep));
    assert.equal(call.params.env.npm_config_cache, call.params.env.NPM_CONFIG_CACHE);
    assert.equal(call.params.env.TMPDIR, call.params.env.TEMP);
    assert.deepEqual(await readdir(context.request.cwd), ["protocol.jsonl"]);
    assert.equal(call.params.streamStdoutStderr, true);
  } finally { await context.cleanup(); }
});

test("protected maintenance paths normalize only literal .agents and .codex directories", () => {
  assert.deepEqual(normalizeProtectedPaths([".codex", ".agents/skill docs", ".agents", ".codex"]), [".agents", ".agents/skill docs", ".codex"]);
  for (const value of [undefined, null, " .agents", [], Array(17).fill(".agents"), ["/tmp"], ["C:/tmp"], [".git"], [".agents-old"], [".agents/"], [".agents//skills"], [".agents/./skills"], [".agents/../other"], [".agents\\skills"], [".agents/*"], [".agents/?"], [".agents/[x]"], [".agents/{x}"], [".agents/ skill"], [".agents/skill "], [".agents/skill\nname"], [".agents/" + "x".repeat(1024)]]) {
    assert.throws(() => normalizeProtectedPaths(value), /protectedPaths/);
  }
});

test("command protocol grants only its declared existing protected directory", async () => {
  for (const relative of [".agents/skills", ".codex"]) {
    const context = await setup(relative === ".codex" ? "command-protected-codex" : "command-protected");
    try {
      await mkdir(path.join(context.request.cwd, ".git"));
      await mkdir(path.join(context.request.cwd, relative), { recursive: true });
      const result = await context.adapter.command({ id: "protected", command: ["git", "merge", "--ff-only", "fixed-target"], cwd: context.request.cwd, protectedPaths: [relative, relative] }, context.controller.signal);
      assert.equal(result.exitCode, 0);
      const call = (await context.transcript()).find(message => message.method === "command/exec")!;
      const cwd = await realpath(context.request.cwd);
      assert.deepEqual(call.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [cwd, path.join(cwd, ".git"), path.join(cwd, relative)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
      assert.deepEqual(call.params.command, ["git", "merge", "--ff-only", "fixed-target"]);
    } finally { await context.cleanup(); }
  }
});

for (const invalid of ["not-git", "missing", "file"] as const) {
  test(`protected command scope rejects ${invalid} before launching an executor`, async () => {
    const context = await setup("command-protected");
    try {
      await mkdir(path.join(context.request.cwd, ".agents"));
      if (invalid !== "not-git") await mkdir(path.join(context.request.cwd, ".git"));
      if (invalid === "file") await writeFile(path.join(context.request.cwd, ".agents/skills"), "file");
      else if (invalid === "not-git") await mkdir(path.join(context.request.cwd, ".agents/skills"));
      await assert.rejects(context.adapter.command({ id: "bad-protected", command: ["git", "status"], cwd: context.request.cwd, protectedPaths: [".agents/skills"] }, context.controller.signal), /Protected maintenance director/);
      await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
    } finally { await context.cleanup(); }
  });
}

test("protected command scope rejects linked ancestors and linked leaf directories", async () => {
  for (const relative of [".agents", ".agents/skills"]) {
    const context = await setup("command-protected");
    const outside = await mkdtemp(path.join(os.tmpdir(), "workflows-protected-outside-"));
    try {
      await mkdir(path.join(context.request.cwd, ".git"));
      await writeFile(path.join(outside, "guard.txt"), "unchanged");
      if (relative !== ".agents") await mkdir(path.join(context.request.cwd, ".agents"));
      await symlink(outside, path.join(context.request.cwd, relative), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(context.adapter.command({ id: "linked-protected", command: ["git", "status"], cwd: context.request.cwd, protectedPaths: [".agents/skills"] }, context.controller.signal), /without symbolic links/);
      assert.equal(await readFile(path.join(outside, "guard.txt"), "utf8"), "unchanged");
      await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
    } finally { await context.cleanup(); await rm(outside, { recursive: true, force: true }); }
  }
});

test("protected command scope rechecks links after executor startup", async () => {
  const context = await setup("command-protected-swap");
  try {
    await mkdir(path.join(context.request.cwd, ".git"));
    await mkdir(path.join(context.request.cwd, ".agents/skills"), { recursive: true });
    await assert.rejects(context.adapter.command({ id: "swapped-protected", command: ["git", "status"], cwd: context.request.cwd, protectedPaths: [".agents/skills"] }, context.controller.signal), /without symbolic links/);
    const transcript = await context.transcript();
    assert.ok(transcript.some(message => message.method === "initialize"));
    assert.equal(transcript.some(message => message.method === "command/exec"), false);
  } finally { await context.cleanup(); }
});

test("protected command scope rejects a linked checkout root", async () => {
  const context = await setup("command-protected");
  try {
    await mkdir(path.join(context.request.cwd, ".git"));
    await mkdir(path.join(context.request.cwd, ".agents/skills"), { recursive: true });
    const alias = path.join(context.request.cwd, "checkout-alias");
    await symlink(context.request.cwd, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(context.adapter.command({ id: "linked-checkout", command: ["git", "status"], cwd: alias, protectedPaths: [".agents/skills"] }, context.controller.signal), /checkout must be a real directory/);
    await assert.rejects(access(path.join(context.request.cwd, "protocol.jsonl")), { code: "ENOENT" });
  } finally { await context.cleanup(); }
});

for (const [scenario, networkAccess, expected] of [
  ["command-network-once", true, 2], ["command-network-always", true, 3],
  ["command-network-always", false, 1], ["command-failed", true, 1], ["command-conflict", true, 1],
] as const) {
  test(`command retries only transient authorized network failures: ${scenario}/${networkAccess}`, async () => {
    const context = await setup(scenario);
    try {
      const result = await context.adapter.command({ id: "retry-test", cwd: context.request.cwd, command: ["git", "fetch"], networkAccess, retries: 2 }, context.controller.signal);
      assert.equal(result.attempts, expected);
      assert.equal((await context.transcript()).filter(item => item.method === "command/exec").length, expected);
    } finally { await context.cleanup(); }
  });
}

test("command abort sends terminate and waits for the final command result", async () => {
  const context = await setup("command-interrupt");
  try {
    await assert.rejects(context.adapter.command({ id: "cancel-command", cwd: context.request.cwd, command: ["node", "fixture.mjs"] }, context.controller.signal, event => { if (event.type === "log" && event.message.includes("ready")) context.controller.abort(); }), { name: "AbortError" });
    assert.ok((await context.transcript()).some(item => item.method === "command/exec/terminate"));
  } finally { await context.cleanup(); }
});

test("command timeout forcibly cleans up a nonresponsive host", async () => {
  const context = await setup("command-stubborn");
  try {
    await assert.rejects(context.adapter.command({ id: "timeout-command", cwd: context.request.cwd, command: ["node", "fixture.mjs"], timeoutMs: 60 }, context.controller.signal), { name: "TimeoutError" });
    const trace = await context.transcript();
    assert.ok(trace.some(item => item.method === "command/exec/terminate"));
    assert.throws(() => process.kill(trace.find(item => item.type === "pid")!.pid, 0), { code: "ESRCH" });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.throws(() => process.kill(trace.find(item => item.type === "descendant")!.pid, 0), { code: "ESRCH" });
  } finally { await context.cleanup(); }
});

test("command requests refuse environment injection, linked Git and approvals", async () => {
  const context = await setup("command-host-request");
  try {
    const request: CommandRequest = { id: "scope-test", cwd: context.request.cwd, command: ["git", "status"] };
    await assert.rejects(context.adapter.command({ ...request, env: { SECRET: "fixture-only" } } as CommandRequest, context.controller.signal), /unsupported fields/);
    await assert.rejects(context.adapter.command(request, context.controller.signal), /unsupported host interaction/);
    await writeFile(path.join(context.request.cwd, ".git"), "gitdir: ../linked-metadata\n");
    await assert.rejects(context.adapter.command(request, context.controller.signal), /linked or external Git metadata/);
  } finally { await context.cleanup(); }
});

test("command protocol accepts absolute read-only toolchain argv without expanding write roots", async () => {
  const context = await setup("command-complete");
  try {
    const command = ["/usr/bin/env", "HUSKY=0", "PATH=/toolchain/bin", process.execPath, path.join(os.tmpdir(), "installed-toolchain", "npm-cli.js"), "ci"];
    await context.adapter.command({ id: "absolute-toolchain", cwd: context.request.cwd, command }, context.controller.signal);
    const call = (await context.transcript()).find(item => item.method === "command/exec")!;
    assert.deepEqual(call.params.command, command);
    assert.deepEqual(call.params.sandboxPolicy.writableRoots, [await realpath(context.request.cwd)]);
    assert.equal(call.params.sandboxPolicy.excludeTmpdirEnvVar, true);
    assert.equal(call.params.sandboxPolicy.excludeSlashTmp, true);
  } finally { await context.cleanup(); }
});

test("real command sandbox reads external tools, isolates npm defaults and refuses external writes", {
  skip: process.env.WORKFLOWS_REAL_COMMAND_TESTS !== "1" || !["darwin", "linux"].includes(process.platform),
}, async () => {
  // Opt-in integration test: real installed CLI and OS sandbox, no model invocation.
  const root = await mkdtemp(path.join(os.tmpdir(), "workflows-real-command-"));
  const cwd = path.join(root, "owned");
  const tool = path.join(root, "external-tool.mjs");
  const external = path.join(root, "external-marker.txt");
  const adapter = new CodexAdapter();
  const signal = new AbortController().signal;
  try {
    await mkdir(cwd);
    await writeFile(external, "external-read-only\n");
    await writeFile(tool, "import fs from 'node:fs';const marker=fs.readFileSync(process.argv[2],'utf8').trim();console.log(JSON.stringify({marker,cache:process.env.npm_config_cache,tmp:process.env.TMPDIR}));\n");
    const read = await adapter.command({ id: "external-tool-read", cwd, command: [process.execPath, tool, external] }, signal);
    assert.equal(read.exitCode, 0, read.stderr);
    const observed = JSON.parse(read.stdout);
    assert.equal(observed.marker, "external-read-only");
    const resolved = await realpath(cwd);
    assert.ok(observed.cache.startsWith(resolved + path.sep));
    assert.ok(observed.tmp.startsWith(resolved + path.sep));
    assert.deepEqual(await readdir(cwd), []);
    const denied = await adapter.command({ id: "outside-write-denied", cwd, command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", external] }, signal);
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.stderr, /EPERM|EACCES|Operation not permitted|Permission denied/);
    assert.equal(await readFile(external, "utf8"), "external-read-only\n");
    let npmCli: string | undefined;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const executable = path.join(directory, "npm");
      try { await access(executable, constants.X_OK); npmCli = await realpath(executable); break; } catch { /* Try the next PATH entry. */ }
    }
    assert.ok(npmCli, "An installed npm CLI is required for this opt-in test.");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "isolated-command-fixture", version: "1.0.0", private: true, scripts: { build: "node -e \"require('node:fs').writeFileSync('build.txt','built')\"" } }));
    await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "isolated-command-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "isolated-command-fixture", version: "1.0.0" } } }));
    const prefix = ["/usr/bin/env", "HUSKY=0", `PATH=${process.env.PATH ?? ""}`, process.execPath, npmCli];
    const effectiveCache = await adapter.command({ id: "absolute-npm-cache", cwd, command: [...prefix, "config", "get", "cache"] }, signal);
    assert.equal(effectiveCache.exitCode, 0, effectiveCache.stderr);
    assert.ok(effectiveCache.stdout.trim().startsWith(resolved + path.sep));
    const install = await adapter.command({ id: "absolute-npm-ci", cwd, command: [...prefix, "ci", "--ignore-scripts", "--offline", "--no-audit"] }, signal);
    assert.equal(install.exitCode, 0, install.stderr);
    const build = await adapter.command({ id: "absolute-npm-build", cwd, command: [...prefix, "run", "build"] }, signal);
    assert.equal(build.exitCode, 0, build.stderr);
    assert.equal(await readFile(path.join(cwd, "build.txt"), "utf8"), "built");
    assert.equal((await readdir(cwd)).some(name => name.startsWith(".workflows-command-")), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
