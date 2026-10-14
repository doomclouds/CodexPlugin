import assert from "node:assert/strict";
import { test } from "node:test";
import { executeScript, validateScript, validateWorkflowArgs } from "../src/script.ts";
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

test("literal parameter declarations are parsed once with safe unique named fields", () => {
  const parameters = [{ name: "bugNumber", label: "Bug 编号", type: "string", required: true, description: "交给已选工作流的 Bug 编号", placeholder: "例如 123" }, { name: "description", label: "问题描述", type: "string", multiline: true }, { name: "attempts", label: "次数", type: "number" }, { name: "verify", label: "验证", type: "boolean", required: false }];
  const source = `export const meta={name:"parameter-test",description:"Input metadata",parameters:${JSON.stringify(parameters)}}; return args;`;
  assert.deepEqual(validateScript(source).meta.parameters, parameters);
  for (const declaration of [
    '[{name:"bug",label:"Bug",type:"string"},{name:"bug",label:"Duplicate",type:"string"}]',
    '[{name:"constructor",label:"Unsafe",type:"string"}]',
    '[{name:"nested.field",label:"Nested",type:"string"}]',
    '[{name:"bug",label:"Bug",type:["string"]}]',
    '[{name:"bug",label:"Bug",type:"string",required:"yes"}]',
    '[{name:"bug",label:"Bug",type:"number",multiline:true}]',
    '[{name:"bug",label:"Bug",type:"string",default:"extra"}]',
    '[{name:"bug",label:"Bug",type:"string",description:args.description}]',
    '[{name:"bug",label:(() => "executed")(),type:"string"}]',
  ]) assert.throws(() => validateScript(`export const meta={name:"parameter-test",description:"Input metadata",parameters:${declaration}}; return 1;`), /Invalid workflow script/);
});

test("agent capability observation includes aliases and dynamic uncertainty while pure orchestration remains independent", () => {
  assert.equal(validateScript(script("return args.value + 1;")).mayUseAgent, false);
  assert.equal(validateScript(script('phase("Inspect"); log("Begin"); return await operation("build");')).mayUseAgent, false);
  for (const body of ['const inspect = agent; return await inspect("read");', 'return await globalThis[args.name]("read");', 'const invoke=()=>1; return invoke();', 'return (0, eval)(args.code);']) assert.equal(validateScript(script(body)).mayUseAgent, true);
});

test("declared argument validation preserves JSON values and never coerces named input", () => {
  const { meta } = validateScript('export const meta={name:"typed-input",description:"Typed args",parameters:[{name:"text",label:"文字",type:"string",required:true},{name:"count",label:"次数",type:"number",required:true},{name:"enabled",label:"启用",type:"boolean",required:true},{name:"files",label:"文件",type:"string[]",required:true}]}; return args;');
  const args = { text: "  caller supplied text\n", count: 0, enabled: false, files: ["one", "two"], extra: { preserved: null } };
  const before = structuredClone(args);
  validateWorkflowArgs(meta, args);
  assert.deepEqual(args, before);
  for (const invalid of [null, [], "plain", { ...args, text: " " }, { ...args, text: undefined }, { ...args, text: 7 }, { ...args, count: "0" }, { ...args, count: Infinity }, { ...args, enabled: "false" }, { ...args, files: "one" }, { ...args, files: [] }, { ...args, files: [null] }]) assert.throws(() => validateWorkflowArgs(meta, invalid), /Workflow parameter|Missing required|args object/);
  const optional = validateScript('export const meta={name:"optional-input",description:"Optional args",parameters:[{name:"text",label:"文字",type:"string"}]}; return args;').meta;
  assert.doesNotThrow(() => validateWorkflowArgs(optional, {}));
  assert.throws(() => validateWorkflowArgs(optional, { text: null }), /must be string/);
  const legacy = validateScript(script("return args;")).meta;
  for (const value of [null, false, 3, "description", [1, "two"]]) assert.doesNotThrow(() => validateWorkflowArgs(legacy, value));
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

test("declared operations cross the sandbox RPC without host code execution", async () => {
  const calls: string[] = [];
  const result = await executeScript('export const meta = {name:"operations",description:"Approved argv steps"}; const report = await operation("build_main"); return report.exitCode;', {}, {
    agent: async () => { throw new Error("No agent needed"); }, phase() {}, log() {},
    operation: async id => { calls.push(id); return { exitCode: 0 }; },
  }, new AbortController().signal);
  assert.deepEqual(calls, ["build_main"]);
  assert.equal(result, 0);
});

test("operations require a host grant and must be awaited", async () => {
  const hooks = {agent: async () => ({}), phase() {}, log() {}};
  await assert.rejects(executeScript('export const meta = {name:"no-grant",description:"No operation grant"}; return await operation("build");', {}, hooks, new AbortController().signal), /No operations were approved/);
});
