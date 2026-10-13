import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerEvent, WorkerRequest } from "../src/adapter.ts";

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
  ["unsafe-mcp-name", /safely disable/],
  ["unsafe-sandbox", /requested worker sandbox/],
  ["host-request", /unsupported host interaction/],
  ["exit", /exited before completion/],
  ["malformed", /invalid JSON/],
] as const) {
  test(`fails closed for ${scenario}`, async () => {
    const context = await setup(scenario);
    try {
      await assert.rejects(context.adapter.run(context.request, context.controller.signal, () => {}), pattern);
      if (scenario === "enabled-mcp" || scenario === "unsafe-mcp-name" || scenario === "unsafe-sandbox") {
        assert.equal((await context.transcript()).some(message => message.method === "turn/start"), false);
      }
    } finally { await context.cleanup(); }
  });
}

test("server failure diagnostics redact tokens and URLs", async () => {
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
