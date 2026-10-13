import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "../src/adapter.ts";
import type { CommandRequest, WorkerEvent, WorkerRequest } from "../src/adapter.ts";

const fixture = fileURLToPath(new URL("fixtures/app-server.mjs", import.meta.url));

async function setup(scenario: string, options: { startupTimeoutMs?: number; interruptTimeoutMs?: number; shutdownTimeoutMs?: number } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflows-adapter-test-"));
  const trace = path.join(cwd, "protocol.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath, args: [fixture, scenario, trace], startupTimeoutMs: 1000, interruptTimeoutMs: 100, shutdownTimeoutMs: 100, ...options });
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
    assert.equal(transcript.find(message => message.method === "initialize")!.params.clientInfo.version, "0.3.0");
    const turn = transcript.find(message => message.method === "turn/start")!;
    assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  } finally { await context.cleanup(); }
});

test("completion received before the turn/start acknowledgement is retained", async () => {
  const context = await setup("completion-before-ack");
  try {
    const result = await context.adapter.run(context.request, context.controller.signal, () => {});
    assert.equal(result.output, "finished before acknowledgement");
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
    await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), { name: "TimeoutError" });
    const transcript = await context.transcript();
    assert.equal(transcript.some(message => message.method === "turn/start"), false);
    const pid = transcript.find(message => message.type === "pid")!.pid;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
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
  ["complete", { mcpServers: ["fixture"], mcpTools: { fixture: ["write_tool"] } }, /not declared read-only/],
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
    assert.equal(call.params.env, undefined);
    assert.equal(call.params.streamStdoutStderr, true);
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

test("command requests refuse environment injection, undeclared paths, linked Git and approvals", async () => {
  const context = await setup("command-host-request");
  try {
    const request: CommandRequest = { id: "scope-test", cwd: context.request.cwd, command: ["git", "status"] };
    await assert.rejects(context.adapter.command({ ...request, env: { SECRET: "fixture-only" } } as CommandRequest, context.controller.signal), /unsupported fields/);
    await assert.rejects(context.adapter.command({ ...request, command: ["npm", "--prefix", "../other"] }, context.controller.signal), /outside the declared/);
    await assert.rejects(context.adapter.command(request, context.controller.signal), /unsupported host interaction/);
    await writeFile(path.join(context.request.cwd, ".git"), "gitdir: ../linked-metadata\n");
    await assert.rejects(context.adapter.command(request, context.controller.signal), /linked or external Git metadata/);
  } finally { await context.cleanup(); }
});
