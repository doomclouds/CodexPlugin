import assert from "node:assert/strict";
import test from "node:test";
import { commandActivityLabel, itemActivity } from "../src/activity.ts";

test("native activity shows observed categories without reasoning, command arguments or credentials", () => {
  assert.equal(itemActivity({ type: "reasoning", id: "private", text: "private reasoning" }, "running"), undefined);
  const command = itemActivity({ type: "commandExecution", id: "cmd", command: ["/usr/bin/git", "fetch", "https://name:secret@example.invalid?token=secret"], arguments: "password=secret" }, "running")!;
  assert.equal(command.label, "执行命令 · git fetch");
  assert.equal(JSON.stringify(command).includes("secret"), false);
  assert.equal(commandActivityLabel(["/private/toolchain/node", "/private/scripts/run.mjs", "token=secret"]), "执行命令 · node");
  assert.equal(itemActivity({ type: "mcpToolCall", id: "tool", server: "rea", tool: "binary_session", arguments: { token: "secret" } }, "running")!.label, "调用工具 · rea/binary_session");
  assert.equal(itemActivity({ type: "agentMessage", id: "message", text: "user output token=secret", phase: "final_answer" }, "completed")!.label, "整理任务结果");
});

test("read/search/file activity uses categorical actions and preserves real start to completion times", () => {
  const startedAt = "2026-10-14T00:00:00.000Z";
  const result = itemActivity({ type: "commandExecution", id: "read", commandActions: [{ type: "read", path: "/private/file" }] }, "completed", startedAt)!;
  assert.equal(result.label, "读取项目文件");
  assert.equal(result.startedAt, startedAt);
  assert.ok(result.endedAt);
  assert.equal(itemActivity({ type: "commandExecution", id: "search", commandActions: [{ type: "search", query: "secret" }] }, "running")!.label, "搜索项目内容");
  assert.equal(itemActivity({ type: "fileChange", id: "files", changes: [{ path: "/private/a" }, { path: "/private/b" }] }, "completed")!.label, "修改文件 · 2 个");
});

test("dynamic and function tools show safe observed names without arguments or output payloads", () => {
  const dynamic = itemActivity({ type: "dynamicToolCall", id: "native", namespace: "functions", tool: "exec", arguments: { code: "private-input" }, contentItems: [{ type: "inputText", text: "private-output" }] }, "failed")!;
  assert.equal(dynamic.kind, "command");
  assert.equal(dynamic.label, "调用原生工具 · functions/exec");
  assert.equal(dynamic.status, "failed");
  assert.doesNotMatch(JSON.stringify(dynamic), /private|arguments|contentItems/);
  assert.equal(itemActivity({ type: "functionCallOutput", name: "exec_command", namespace: null, output: "private-output" }, "completed")!.label, "调用原生工具 · exec_command");
  assert.equal(itemActivity({ type: "dynamicToolCall", namespace: "functions", tool: "token=private", arguments: "private-input" }, "running")!.label, "调用原生工具");
});
