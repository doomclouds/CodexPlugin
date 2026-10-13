import assert from "node:assert/strict";
import { test } from "node:test";
import { executeScript, validateScript } from "../src/script.ts";
import type { ScriptHooks } from "../src/script.ts";

const script = (body: string): string => `export const meta = { name: "sandbox-test", description: "Exercise the isolated runtime", phases: [{ title: "Inspect" }] };\n${body}`;
const hooks = (agent: ScriptHooks["agent"] = async () => null): ScriptHooks => ({ agent, phase: () => {}, log: () => {} });
const signal = (): AbortSignal => new AbortController().signal;
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

test("metadata is parsed without executing it and top-level await/return is supported", () => {
  const source = script('phase("Inspect"); return await agent("inspect");');
  const validated = validateScript(source);
  assert.deepEqual(validated.meta, { name: "sandbox-test", description: "Exercise the isolated runtime", phases: [{ title: "Inspect" }] });
  assert.match(validated.body, /return await agent/);
  for (const source of [
    'export const meta = {name: "x", description: (() => "x")()}; return 1;',
    'export const meta = {name: "x", ...args}; return 1;',
    'export const meta = {name: "x", description: "x", phases: [{title: "same"}, {title: "same"}]};',
    '; export const meta = {name: "x", description: "x"};',
    'const before = 1; export const meta = {name: "x", description: "x"};',
  ]) assert.throws(() => validateScript(source), /Invalid workflow script/);
});

test("module access, host APIs and nondeterminism are rejected by AST rather than text matching", () => {
  for (const body of [
    'import fs from "node:fs";', 'return import("node:fs");', 'export const other = 1;',
    'return process.cwd();', 'return require("fs");', 'return fetch("https://example.com");',
    'setTimeout(() => {}, 1);', 'return Date.now();', 'return Math.random();', 'return Math["random"]();',
  ]) assert.throws(() => validateScript(script(body)), /Invalid workflow script/);
  assert.doesNotThrow(() => validateScript(script('return "process fetch Date Math.random import()"; // require("fs")')));
});

test("agent RPC preserves JSON and prose, passes cancellation signal, and emits phase/log hooks", async () => {
  const events: string[] = [];
  const result = await executeScript(script(`
    phase("Inspect"); log("starting");
    const result = await agent("inspect " + args.file, { schema: { type: "object" }, label: args.file });
    const prose = await agent("summarize");
    return { result, prose };
  `), { file: "README.md" }, {
    agent: async (prompt, options, taskSignal) => {
      assert.equal(taskSignal.aborted, false);
      if (prompt.startsWith("inspect")) {
        assert.deepEqual(options, { schema: { type: "object" }, label: "README.md" });
        return { ok: true, items: [1, null, "text"] };
      }
      return "A report";
    },
    phase: title => { events.push(`phase:${title}`); },
    log: message => { events.push(`log:${message}`); },
  }, signal());
  assert.deepEqual(result, { result: { ok: true, items: [1, null, "text"] }, prose: "A report" });
  assert.deepEqual(events, ["phase:Inspect", "log:starting"]);
});

test("parallel waits for every task, preserves order and converts rejected tasks to null", async () => {
  const logs: string[] = [];
  const result = await executeScript(script('return await parallel([() => agent("bad"), () => agent("good")]);'), null, {
    ...hooks(async prompt => {
      if (prompt === "bad") throw new Error("expected failure");
      return "good result";
    }),
    log: message => { logs.push(message); },
  }, signal());
  assert.deepEqual(result, [null, "good result"]);
  assert.match(logs[0]!, /parallel task failed.*expected failure/);
});

test("pipeline streams each item independently, retains order, and stops an item at null", async () => {
  const secondFirstStage = deferred<unknown>();
  const calls: string[] = [];
  const result = await executeScript(script(`
    return await pipeline([1, 2, 3],
      value => agent("first " + value),
      value => agent("second " + value));
  `), null, hooks(async prompt => {
    calls.push(prompt);
    if (prompt === "first 1") return 1;
    if (prompt === "first 2") return await secondFirstStage.promise;
    if (prompt === "first 3") return null;
    if (prompt === "second 1") { secondFirstStage.resolve(2); return "one"; }
    if (prompt === "second 2") return "two";
    throw new Error(`Unexpected prompt: ${prompt}`);
  }), signal(), { timeoutMs: 2000 });
  assert.deepEqual(result, ["one", "two", null]);
  assert.ok(calls.indexOf("second 1") < calls.indexOf("second 2"));
  assert.equal(calls.includes("second null"), false);
});

test("direct agent failures can be caught by the script", async () => {
  const result = await executeScript(script('try { await agent("fail"); } catch (error) { return error.message; }'), null,
    hooks(async () => { throw new Error("agent failed"); }), signal());
  assert.equal(result, "agent failed");
});

test("computed names cannot expose Node, network, timers or clocks", async () => {
  const result = await executeScript(script('return args.map(name => typeof globalThis[name]);'),
    ["process", "require", "fs", "fetch", "setTimeout", "Date"], hooks(), signal());
  assert.deepEqual(result, ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
  await assert.rejects(executeScript(script('return Math[args]();'), "random", hooks(), signal()), /deterministically/);
});

test("agent call limit is enforced independently of script control flow", async () => {
  let calls = 0;
  await assert.rejects(executeScript(script('await agent("one"); return await agent("two");'), null,
    hooks(async () => { calls++; return true; }), signal(), { maxCalls: 1 }), /call limit exceeded/);
  assert.equal(calls, 1);
});

test("log loops cannot allocate an unbounded host RPC queue", async () => {
  await assert.rejects(executeScript(script('for (let index = 0; index < 1000000; index++) log("event");'), null,
    hooks(), signal(), { maxCalls: 1 }), /RPC message limit exceeded/);
});

test("non-serializable top-level results are rejected instead of silently disappearing", async () => {
  await assert.rejects(executeScript(script('return () => 1;'), null, hooks(), signal()), /JSON serializable/);
});

test("infinite CPU loops and unresolved promises are terminated by the deadline", async () => {
  for (const body of ['while (true) {}', 'return await new Promise(() => {});']) {
    await assert.rejects(executeScript(script(body), null, hooks(), signal(), { timeoutMs: 150 }), /timed out|interrupted/);
  }
});

test("memory exhaustion remains inside the sandbox", async () => {
  await assert.rejects(executeScript(script('return new Array(10000000).fill(7);'), null,
    hooks(), signal(), { memoryMb: 8, timeoutMs: 2000 }), /memory|alloc/i);
});

test("cancellation aborts and waits for actual agent settlement", async () => {
  const controller = new AbortController();
  const begun = deferred<void>();
  let exited = false;
  const execution = executeScript(script('return await agent("running");'), null, hooks(async (_prompt, _options, taskSignal) => {
    begun.resolve();
    return await new Promise((_resolve, reject) => {
      taskSignal.addEventListener("abort", () => {
        setImmediate(() => { exited = true; reject(new Error("actual worker exited")); });
      }, { once: true });
    });
  }), controller.signal);
  await begun.promise;
  controller.abort();
  await assert.rejects(execution, /aborted|cancelled/i);
  assert.equal(exited, true);
});

test("unawaited agents cannot continue invisibly after a script returns", async () => {
  let exited = false;
  const execution = executeScript(script('agent("forgotten"); return "done";'), null, hooks(async (_prompt, _options, taskSignal) => {
    return await new Promise((_resolve, reject) => {
      const abort = (): void => { exited = true; reject(new Error("stopped")); };
      if (taskSignal.aborted) abort(); else taskSignal.addEventListener("abort", abort, { once: true });
    });
  }), signal());
  await assert.rejects(execution, /unawaited agent/);
  assert.equal(exited, true);
});
