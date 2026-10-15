import assert from "node:assert/strict";
import test from "node:test";
import { NativeToolFailureDiagnostics, nativeToolItemFailed } from "../src/native-tool-diagnostics.ts";

function item(overrides: Record<string, unknown> = {}) {
  return { type: "dynamicToolCall", id: "fixture-call", namespace: "functions", tool: "exec", status: "failed", success: false, arguments: { input: "private-tool-input" }, contentItems: [{ type: "inputText", text: "SyntaxError: Unexpected identifier" }], ...overrides };
}

test("native diagnostics capture observed dynamic tool failures without arguments or successful payloads", () => {
  const diagnostics = new NativeToolFailureDiagnostics(value => value);
  assert.equal(diagnostics.capture(item({ status: "completed", success: true, contentItems: [{ type: "inputText", text: "Error is a documentation term; private success payload" }] })), undefined);
  const log = diagnostics.capture(item());
  assert.equal(log, "Native tool call failed (functions/exec): SyntaxError: Unexpected identifier");
  assert.doesNotMatch(log!, /private-tool-input|arguments|MCP/);
  assert.equal(diagnostics.capture(item()), undefined);
  assert.equal(nativeToolItemFailed(item({ status: "completed", success: false })), true);
  assert.equal(nativeToolItemFailed(item({ status: "failed", success: null })), true);
  assert.equal(nativeToolItemFailed(item({ status: "inProgress", success: null })), false);
  assert.equal(nativeToolItemFailed({ type: "mcpToolCall", status: "failed" }), false);
});

test("native diagnostics read only bounded shallow textual failure fields", () => {
  const diagnostics = new NativeToolFailureDiagnostics(value => value);
  const value = item({ contentItems: [
    { type: "inputImage", imageUrl: "private-image" },
    { type: "inputAudio", audioUrl: "private-audio" },
    { type: "inputText", text: JSON.stringify({ error: { code: "E_TOOL", message: "fixture missing dependency", arguments: { unsafe: "private-arguments" } }, payload: "private-envelope" }) },
    { type: "text", text: "Terminal tool failed" },
  ] });
  const log = diagnostics.capture(value)!;
  assert.match(log, /code: E_TOOL; message: fixture missing dependency; Terminal tool failed/);
  assert.doesNotMatch(log, /private|unsafe|imageUrl|audioUrl/);
  const unsupported = new NativeToolFailureDiagnostics(value => value).capture(item({ contentItems: [{ type: "inputText", text: JSON.stringify({ nested: { data: { error: { message: "private-deep-payload" } } }, ignored: "private-field" }) }] }));
  assert.match(unsupported!, /without a supported error message/);
  assert.doesNotMatch(unsupported!, /private|nested|ignored/);
});

test("native diagnostics apply shared strong credential omission with independent Native provenance", () => {
  const credentialKeys = ["credentials", "clientSecret", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "password", "access_token", "cookie", "authorization"];
  for (const key of credentialKeys) {
    const log = new NativeToolFailureDiagnostics(value => value).capture(item({ contentItems: [{ type: "inputText", text: `Validation failed: ${key}=private first second\nprivate trailing content` }] }));
    assert.match(log!, /Validation failed:/);
    assert.match(log!, /\[Native sensitive details omitted\.\]/);
    assert.doesNotMatch(log!, /private|trailing|MCP/);
  }
  for (const key of ["input", "args", "arguments", "prompt", "params", "payload"]) {
    const log = new NativeToolFailureDiagnostics(value => value).capture(item({ contentItems: [{ type: "inputText", text: `Validation failed: ${JSON.stringify(JSON.stringify({ [key]: "private input payload" }))}` }] }));
    assert.match(log!, /\[Native input details omitted\.\]/);
    assert.doesNotMatch(log!, /private|MCP/);
  }
  const injected = new NativeToolFailureDiagnostics(value => value.replaceAll("sensitive-bearer", "[redacted]")).capture(item({ contentItems: [{ type: "inputText", text: "Rejected sensitive-bearer" }] }));
  assert.match(injected!, /Rejected \[redacted\]/);
});

test("function output is not classified by arbitrary error text and accepts only explicit shallow failure envelopes", () => {
  const base = { type: "functionCallOutput", id: "function-output", name: "exec_command", namespace: "functions" };
  for (const output of ["No error occurred", "Error: documentation example", "SyntaxError: rejected code", JSON.stringify({ status: "failed", message: "ordinary business output" }), JSON.stringify({ nested: { error: { message: "private-deep-value" } } }), [{ type: "input_text", text: "Error is ordinary text" }]]) {
    const value = { ...base, output };
    assert.equal(nativeToolItemFailed(value), false);
    assert.equal(new NativeToolFailureDiagnostics(value => value).capture(value), undefined);
  }
  for (const output of [
    JSON.stringify({ isError: true, message: "explicit function failure" }),
    JSON.stringify({ error: { code: "E_FUNCTION", message: "explicit function failure" } }),
    [{ type: "input_text", text: JSON.stringify({ isError: true, error: "explicit function failure" }) }],
  ]) {
    const value = { ...base, output };
    assert.equal(nativeToolItemFailed(value), true);
    assert.match(new NativeToolFailureDiagnostics(value => value).capture(value)!, /Native tool call failed \(functions\/exec_command\).*explicit function failure/);
  }
  assert.match(new NativeToolFailureDiagnostics(value => value).capture({ ...base, isError: true, output: "explicit top-level failure" })!, /explicit top-level failure/);
});

test("native diagnostics use safe names, deduplicate IDs and enforce UTF-8 and aggregate budgets", () => {
  const diagnostics = new NativeToolFailureDiagnostics(value => value), logs: string[] = [];
  const unsafeNames = diagnostics.capture(item({ namespace: "secret=private", tool: "private/input?password=private", contentItems: [{ type: "inputText", text: "Observed failure" }] }))!;
  assert.equal(unsafeNames, "Native tool call failed: Observed failure");
  for (let index = 0; index < 200; index++) {
    const value = item({ id: String(index), contentItems: [{ type: "inputText", text: "普通错误。".repeat(3000) }] });
    const log = diagnostics.capture(value);
    if (log) logs.push(log);
    assert.equal(diagnostics.capture(value), undefined);
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every(log => Buffer.byteLength(log) <= 8192));
  assert.ok(logs.reduce((total, log) => total + Buffer.byteLength(log), Buffer.byteLength(unsafeNames)) <= 65_536);
  assert.doesNotMatch(logs.join("\n"), /\ufffd|MCP/);
  assert.match(logs.join("\n"), /Native error diagnostics/);
  const small = new NativeToolFailureDiagnostics(value => value);
  let count = 0;
  for (let index = 0; index < 110; index++) if (small.capture(item({ id: String(index) }))) count++;
  assert.equal(count, 101, "At most 100 sampled calls plus one budget notice are emitted.");
});

test("native diagnostics do not parse oversized function envelopes or retain large structured and binary payloads", () => {
  const large = JSON.stringify({ isError: true, error: "private-large-payload".repeat(1000) });
  assert.equal(nativeToolItemFailed({ type: "functionCallOutput", output: large }), false);
  const diagnostics = new NativeToolFailureDiagnostics(value => value);
  const structured = diagnostics.capture(item({ id: "large", contentItems: [{ type: "inputText", text: large }] }))!;
  assert.match(structured, /diagnostic limit/);
  assert.doesNotMatch(structured, /private-large-payload/);
  const binary = diagnostics.capture(item({ id: "binary", contentItems: [{ type: "inputText", text: "ABCD".repeat(1000) }] }))!;
  assert.match(binary, /non-textual failure/);
});
