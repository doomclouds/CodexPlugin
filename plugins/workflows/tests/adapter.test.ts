import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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
    assert.deepEqual(Object.keys(call.params.env).sort(), ["NPM_CONFIG_CACHE", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache"].sort());
    for (const directory of Object.values(call.params.env) as string[]) assert.ok(directory.startsWith(call.params.cwd + path.sep));
    assert.equal(call.params.env.npm_config_cache, call.params.env.NPM_CONFIG_CACHE);
    assert.equal(call.params.env.TMPDIR, call.params.env.TEMP);
    assert.deepEqual(await readdir(context.request.cwd), ["protocol.jsonl"]);
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
