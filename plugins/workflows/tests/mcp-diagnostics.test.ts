import assert from "node:assert/strict";
import test from "node:test";
import { McpFailureDiagnostics } from "../src/mcp-diagnostics.ts";

function diagnostic(message: string) {
  return new McpFailureDiagnostics(value => value).capture({ type: "mcpToolCall", id: "fixture-error", status: "failed", error: { message } });
}

test("MCP error diagnostics omit common credential assignments across textual and escaped JSON forms", () => {
  const keys = ["credentials", "credential", "client_secret", "clientSecret", "private_key", "privateKey", "access_key", "accessKeyId", "secret_access_key", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "api_key", "password", "passwd", "secret", "access_token", "refresh_token", "session_token", "id_token", "token", "sessionId", "session_key", "authorization", "authentication", "auth", "cookie", "set-cookie", "sessionCookie"];
  const secret = "private first second\nprivate subsequent line";
  for (const key of keys) {
    const json = JSON.stringify({ [key]: secret });
    const forms = [`${key}=${secret}`, `${key}: ${secret}`, json, JSON.stringify(json), JSON.stringify(JSON.stringify(json))];
    for (const form of forms) {
      const log = diagnostic(`Protocol error: ${form}; do not retain trailing content`);
      assert.ok(log, `${key}: an actual error must remain visible`);
      assert.match(log, /Protocol error:/);
      assert.match(log, /MCP sensitive details omitted/);
      assert.doesNotMatch(log, /private|first second|subsequent line|trailing content/, key);
    }
  }
});

test("MCP error diagnostics omit echoed inputs with quoted, escaped, colon and equals keys", () => {
  for (const key of ["arguments", "args", "prompt", "input", "payload", "params"]) {
    const secret = "private delegated input with spaces\nand another line", json = JSON.stringify({ [key]: { unknownKey: secret } });
    for (const form of [`${key}: {unknownKey: ${secret}}`, `${key}=${secret}`, json, JSON.stringify(json), JSON.stringify(JSON.stringify(json))]) {
      const log = diagnostic(`Validation failed: ${form}`);
      assert.ok(log); assert.match(log, /Validation failed:/); assert.match(log, /MCP input details omitted/);
      assert.doesNotMatch(log, /unknownKey|private|delegated input|another line/, key);
    }
  }
});

test("the earliest sensitive or input assignment hides the complete remaining error payload", () => {
  assert.match(diagnostic("Failure: password=private first payload=private second")!, /Failure: \[MCP sensitive details omitted\.\]$/);
  assert.match(diagnostic("Failure: input: private first credentials=private second")!, /Failure: \[MCP input details omitted\.\]$/);
  assert.doesNotMatch(diagnostic('Failure: {"password":"' + "private quoted credential ".repeat(1000) + '"}')!, /private|quoted credential/);
});

test("ordinary native approval and protocol failures retain their useful diagnostic text", () => {
  for (const error of [
    "MCP tool call requires approval, but approval policy is never",
    "MCP error -32000: unavailable",
    "No active REA context",
    "MCP returned an invalid structured error payload.",
  ]) assert.equal(diagnostic(error), `MCP tool call failed: message: ${error}`);
});

test("credential omission still honors UTF-8 byte budgets and per-call deduplication", () => {
  const diagnostics = new McpFailureDiagnostics(value => value), logs: string[] = [];
  for (let index = 0; index < 200; index++) {
    const item = { type: "mcpToolCall", id: String(index), status: "failed", error: { message: "普通错误。".repeat(1000) + " password=private first second" } };
    const log = diagnostics.capture(item);
    if (log) logs.push(log);
    assert.equal(diagnostics.capture(item), undefined);
  }
  assert.ok(logs.length > 0); assert.ok(logs.every(log => Buffer.byteLength(log) <= 8192));
  assert.ok(logs.reduce((total, log) => total + Buffer.byteLength(log), 0) <= 65_536);
  assert.doesNotMatch(logs.join("\n"), /private|first second|\ufffd/);
});
