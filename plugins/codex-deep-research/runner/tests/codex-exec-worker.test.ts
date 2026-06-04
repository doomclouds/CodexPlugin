import { describe, expect, it } from "vitest";
import {
  buildCodexExecSpawnOptions,
  parseCodexExecJsonOutput,
} from "../src/workers/codex-exec-worker.js";

describe("buildCodexExecSpawnOptions", () => {
  it("uses cmd.exe for the default Codex shim on Windows", () => {
    const options = buildCodexExecSpawnOptions({ platform: "win32" });

    expect(options.command).toBe("cmd.exe");
    expect(options.args).toEqual(["/d", "/s", "/c", "codex exec --json -"]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.shell).toBe(false);
  });

  it("keeps explicit codexBinary overrides direct", () => {
    const options = buildCodexExecSpawnOptions({ platform: "win32", codexBinary: "C:\\tools\\codex.exe" });

    expect(options.command).toBe("C:\\tools\\codex.exe");
    expect(options.args).toEqual(["exec", "--json", "-"]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.shell).toBe(false);
  });

  it("uses cmd.exe for explicit Windows command shim overrides", () => {
    const options = buildCodexExecSpawnOptions({ platform: "win32", codexBinary: "C:\\tools with spaces\\codex.cmd" });

    expect(options.command).toBe("cmd.exe");
    expect(options.args).toEqual(["/d", "/s", "/c", "\"C:\\tools with spaces\\codex.cmd\" exec --json -"]);
    expect(options.shell).toBe(false);
  });

  it("uses direct Codex execution on non-Windows platforms", () => {
    const options = buildCodexExecSpawnOptions({ platform: "linux" });

    expect(options.command).toBe("codex");
    expect(options.args).toEqual(["exec", "--json", "-"]);
  });
});

describe("parseCodexExecJsonOutput", () => {
  it("returns the latest valid final message candidate", () => {
    const output = [
      JSON.stringify({ type: "message", message: "{\"older\":true}" }),
      JSON.stringify({ type: "message", item: { text: "{\"latest\":true}" } }),
    ].join("\n");

    expect(parseCodexExecJsonOutput(output)).toEqual({ latest: true });
  });

  it("throws when the latest final message candidate is invalid JSON", () => {
    const output = [
      JSON.stringify({ type: "message", message: "{\"older\":true}" }),
      JSON.stringify({ type: "message", item: { text: "{not json}" } }),
    ].join("\n");

    expect(() => parseCodexExecJsonOutput(output)).toThrow(/Latest codex final message candidate was not valid JSON/);
  });

  it("throws when no final message candidate is present", () => {
    const output = JSON.stringify({ type: "status", message: "still working" });

    expect(() => parseCodexExecJsonOutput(output)).toThrow("No final message candidate found in codex exec output");
  });
});
