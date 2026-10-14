import assert from "node:assert/strict";
import test from "node:test";
import { executeScript } from "../src/script.ts";

const script = (body: string) => `export const meta = { name: "script-stability", description: "Deterministic sandbox regression fixture" };\n${body}`;

for (const [name, body] of [
  ["parallel", 'return await parallel([() => agent("bad"), () => agent("good")]);'],
  ["pipeline", 'return await pipeline(["bad", "good"], value => agent(value));'],
] as const) {
  test(`${name} keeps handled worker failures handled when diagnostics are long`, async () => {
    const logs: string[] = [];
    const result = await executeScript(script(body), {}, {
      agent: async prompt => {
        if (prompt === "bad") throw new Error(`Command failed: ${"output ".repeat(1000)}`);
        return "good result";
      },
      phase() {},
      log: text => { logs.push(text); },
    }, new AbortController().signal, { timeoutMs: 3000 });
    assert.deepEqual(result, [null, "good result"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /failed.*Command failed/);
    assert.ok(logs[0]!.length <= 4096, "Helper diagnostics must fit the documented log transport bound.");
  });
}
