import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneJson, compileDefinition, DEFINITION_LIMITS, evaluateExpression, validateDefinition, validateDefinitionArgs, walkNodes } from "../src/definition.ts";
import type { Expression, ExpressionEnvironment, WorkflowDefinition } from "../src/definition.ts";

const definition = (steps: unknown[] = []): unknown => ({ schemaVersion: 1, name: "structured-test", description: "Explicit structured execution", steps });
const transform = (id: string, value: unknown = true): unknown => ({ id, type: "transform", value });
const env: ExpressionEnvironment = { args: { enabled: true, count: 2 }, steps: { inspect: { status: "completed", output: { changed: false, values: [1, 2] } } } };

test("structured definitions normalize once and compile the same explicit branches and joins", () => {
  const compiled = compileDefinition(definition([
    { id: "inspect", type: "agent", task: "Observe the project" },
    { id: "route", type: "choice", cases: [{ id: "changed", when: { ref: "steps.inspect.output.changed" }, steps: [transform("update")] }], default: [] },
    { id: "verify", type: "parallel", policy: "all-settled", branches: [{ id: "code", steps: [transform("code")] }, { id: "docs", steps: [transform("docs")] }] },
    { id: "retry", type: "repeat", maxIterations: 3, until: { ref: "steps.check.output" }, steps: [transform("check", true)] },
    transform("deliver", { ref: "steps.retry.output" }),
  ]));
  assert.equal(compiled.definition.steps[0]!.type, "agent");
  assert.equal((compiled.definition.steps[0] as { mode: string }).mode, "read");
  assert.equal((compiled.definition.steps[0] as { maxRecoveryAttempts: number }).maxRecoveryAttempts, 0);
  assert.ok(compiled.plan.edges.some(edge => edge.from === "route" && edge.to === "update" && edge.kind === "case" && edge.branchId === "changed"));
  assert.ok(compiled.plan.edges.some(edge => edge.from === "route" && edge.to === "$join:route" && edge.kind === "default"));
  assert.ok(compiled.plan.edges.some(edge => edge.from === "$join:route" && edge.to === "verify" && edge.kind === "sequence"));
  assert.ok(compiled.plan.edges.some(edge => edge.from === "check" && edge.to === "retry" && edge.kind === "repeat"));
  assert.ok(compiled.plan.edges.some(edge => edge.from === "retry" && edge.to === "$join:retry" && edge.kind === "exit"));
  const keys = compiled.plan.nodes.map(node => node.id);
  assert.equal(new Set(keys).size, keys.length);
  const seen: string[] = [];
  walkNodes(compiled.definition, node => seen.push(node.id));
  assert.deepEqual(seen, ["inspect", "route", "update", "verify", "code", "docs", "retry", "check", "deliver"]);
  const reordered = JSON.parse(JSON.stringify(compiled.definition), (key, value: unknown) => key === "" ? value : value);
  assert.equal(compileDefinition(reordered).hash, compiled.hash);
  assert.match(compiled.hash, /^[a-f0-9]{64}$/);
});

test("definition hashes ignore object key insertion order and retain meaningful structure", () => {
  const a = compileDefinition(definition([transform("one", { a: 1, b: 2 })]));
  const b = compileDefinition({ description: "Explicit structured execution", steps: [{ value: { b: 2, a: 1 }, type: "transform", id: "one" }], name: "structured-test", schemaVersion: 1 });
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.plan, b.plan);
  assert.notEqual(compileDefinition(definition([transform("one", { a: 2, b: 2 })])).hash, a.hash);
});

test("lexical scopes reject forward, self, sibling and escaped branch outputs", () => {
  for (const steps of [
    [transform("first", { ref: "steps.later.output" }), transform("later")],
    [transform("self", { ref: "steps.self.output" })],
    [{ id: "parallel", type: "parallel", policy: "fail-fast", branches: [{ id: "a", steps: [transform("left")] }, { id: "b", steps: [transform("right", { ref: "steps.left.output" })] }] }],
    [{ id: "choose", type: "choice", cases: [{ id: "a", when: true, steps: [transform("branch")] }], default: [] }, transform("after", { ref: "steps.branch.output" })],
    [{ id: "repeat", type: "repeat", maxIterations: 2, while: { ref: "steps.body.output" }, steps: [transform("body")] }],
  ]) assert.throws(() => validateDefinition(definition(steps)), /unavailable|precedes/);
  assert.doesNotThrow(() => validateDefinition(definition([{ id: "repeat", type: "repeat", maxIterations: 2, until: { ref: "steps.body.output" }, steps: [transform("body")] }, transform("after", { ref: "steps.repeat.output" })])));
});

test("loop, collection and catch variables have explicit lexical availability", () => {
  for (const ref of ["item", "key", "iteration", "error"]) assert.throws(() => validateDefinition(definition([transform("invalid", { ref })])), /unavailable/);
  assert.doesNotThrow(() => validateDefinition(definition([
    { id: "map", type: "map", items: [1, 2], itemKey: { ref: "item" }, steps: [transform("mapped", { key: { ref: "key" }, item: { ref: "item" } })] },
    { id: "repeat", type: "repeat", maxIterations: 2, while: { op: "lt", args: [{ ref: "iteration" }, 2] }, steps: [transform("iteration", { ref: "iteration" })] },
    { id: "guard", type: "try", steps: [transform("work")], catch: [transform("handled", { ref: "error" })], finally: [transform("cleanup", { ref: "error" })] },
  ])));
  assert.throws(() => validateDefinition(definition([{ id: "map", type: "map", items: [], itemKey: { ref: "key" }, steps: [] }])), /unavailable/);
});

test("unsafe JSON is rejected without executing getters", () => {
  let reads = 0;
  const getter: Record<string, unknown> = {};
  Object.defineProperty(getter, "value", { enumerable: true, get() { reads++; return true; } });
  const array: unknown[] = [true];
  Object.defineProperty(array, "0", { enumerable: true, get() { reads++; return true; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [getter, array, cyclic, new Date(), NaN, Infinity, undefined, () => true, BigInt(1), new Array(2), Object.create({ inherited: true }), JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: true }]) assert.throws(() => cloneJson(value));
  assert.equal(reads, 0);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("expressions preserve JSON types, strict comparisons and lazy Boolean evaluation", () => {
  const evaluate = (expr: Expression) => evaluateExpression(expr, env);
  assert.equal(evaluate(null), null);
  assert.equal(evaluate(false), false);
  assert.equal(evaluate({ ref: "args.count" }), 2);
  assert.equal(evaluate({ op: "lt", args: [1, 2] }), true);
  assert.equal(evaluate({ op: "gte", args: ["b", "a"] }), true);
  assert.equal(evaluate({ op: "not", args: [false] }), true);
  assert.throws(() => evaluate({ value: undefined } as unknown as Expression), /JSON/);
});

test("expression operators have no coercion, prototype access or hidden I/O", () => {
  const evaluate = (expr: Expression) => evaluateExpression(expr, env);
  assert.deepEqual(evaluate({ object: { ref: "steps.inspect.output" }, list: [{ ref: "args.count" }] }), { object: { changed: false, values: [1, 2] }, list: [2] });
  assert.deepEqual(evaluate({ literal: { ref: "not-an-expression", op: "not-an-operator" } }), { ref: "not-an-expression", op: "not-an-operator" });
  assert.equal(evaluate({ op: "eq", args: [{ literal: { a: 1, b: 2 } }, { literal: { b: 2, a: 1 } }] }), true);
  assert.equal(evaluate({ op: "eq", args: [1, "1"] }), false);
  assert.equal(evaluate({ op: "and", args: [false, { ref: "args.missing" }] }), false);
  assert.equal(evaluate({ op: "or", args: [true, { ref: "args.missing" }] }), true);
  assert.equal(evaluate({ op: "coalesce", args: [null, false, { ref: "args.missing" }] }), false);
  assert.equal(evaluate({ op: "add", args: [1, 2, 3] }), 6);
  assert.equal(evaluate({ op: "sub", args: [6, 2] }), 4);
  assert.equal(evaluate({ op: "mul", args: [2, 3] }), 6);
  assert.equal(evaluate({ op: "div", args: [6, 2] }), 3);
  assert.equal(evaluate({ op: "concat", args: ["a", "b"] }), "ab");
  assert.deepEqual(evaluate({ op: "concat", args: [[1], [2]] }), [1, 2]);
  assert.equal(evaluate({ op: "get", args: [{ ref: "steps.inspect.output.values" }, 0] }), 1);
  assert.equal(evaluate({ op: "length", args: [{ ref: "steps.inspect.output.values" }] }), 2);
  for (const expr of [
    { op: "eq", args: [1] }, { op: "add", args: [1, "2"] }, { op: "and", args: [1] }, { op: "lt", args: [1, "2"] },
    { op: "div", args: [1, 0] }, { op: "mul", args: [1e308, 1e308] }, { ref: "args.__proto__" }, { op: "get", args: [{}, "constructor"] },
    { ref: "process.env" }, { op: "eval", args: ["anything"] }, { op: "length", args: [3] }, { op: "concat", args: ["a", [1]] },
  ]) assert.throws(() => evaluate(expr as Expression));
});

test("parameters are validated and defaults are independent JSON snapshots", () => {
  const compiled = compileDefinition({ ...(definition() as object), parameters: [{ name: "count", type: "integer", default: 2 }, { name: "enabled", type: "boolean", required: true }, { name: "mode", type: "string", enum: ["a", "b"], default: "a" }] });
  assert.deepEqual(validateDefinitionArgs(compiled.definition, { enabled: false }), { enabled: false, count: 2, mode: "a" });
  assert.throws(() => validateDefinitionArgs(compiled.definition, {}), /required/);
  assert.throws(() => validateDefinitionArgs(compiled.definition, { enabled: true, count: 1.2 }), /integer/);
  assert.throws(() => validateDefinitionArgs(compiled.definition, { enabled: true, mode: "c" }), /enum/);
  assert.throws(() => validateDefinitionArgs(compiled.definition, { enabled: true, unknown: 1 }), /unknown/);
  assert.throws(() => compileDefinition({ ...(definition([transform("read", { ref: "args.missing" })]) as object), parameters: [] }), /unknown workflow parameter/);
});

test("only explicit structural fields and bounded controls can be executed", () => {
  for (const input of [
    { script: "export const meta={};" },
    definition([{ id: "run", type: "script", source: "while(true){}" }]),
    definition([{ id: "a", type: "transform", value: 1, script: "no" }]),
    definition([transform("same"), transform("same")]),
    definition([{ id: "loop", type: "repeat", maxIterations: 0, steps: [] }]),
    definition([{ id: "loop", type: "repeat", maxIterations: 2, while: true, until: true, steps: [] }]),
    definition([{ id: "parallel", type: "parallel", branches: [], policy: "fail-fast" }]),
    definition([{ id: "command", type: "command", argv: ["tool"], effect: "read", protectedPaths: [".agents"] }]),
    definition([{ id: "command", type: "command", argv: ["tool"], effect: "write", protectedPaths: [".agents/../private"] }]),
    definition([{ id: "sub", type: "subflow", ref: { id: "saved:child", revision: 0 } }]),
    definition(Array.from({ length: DEFINITION_LIMITS.nodes + 1 }, (_, index) => transform(`n${index}`))),
    definition([transform("big", "x".repeat(DEFINITION_LIMITS.bytes))]),
  ]) assert.throws(() => compileDefinition(input));
});

test("subflows use independent definitions and count against total compile bounds", () => {
  const inline = validateDefinition(definition([{ id: "child", type: "subflow", definition: definition([transform("inside")]) }])) as WorkflowDefinition;
  assert.equal(inline.steps[0]!.type, "subflow");
  assert.throws(() => validateDefinition(definition([{ id: "child", type: "subflow", definition: definition(Array.from({ length: DEFINITION_LIMITS.nodes }, (_, index) => transform(`n${index}`))) } ])), /node limit/);
});

test("output and wait contracts are validated before a definition can dispatch any activity", () => {
  for (const node of [
    { id: "bad", type: "agent", task: "Inspect", accept: { type: "object" } },
    { id: "bad", type: "agent", task: "Inspect", schema: { type: "string", pattern: ".*" } },
    { id: "bad", type: "wait", message: "Input", schema: { $ref: "https://untrusted.invalid/schema" } },
  ]) assert.throws(() => compileDefinition(definition([node])), /contract|schema|validation/);
  assert.doesNotThrow(() => compileDefinition(definition([{ id: "good", type: "agent", task: "Inspect", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, accept: { type: "object", properties: { ok: { const: true } }, required: ["ok"] } }])));
});

test("protected command paths use the exact native normalizer before execution", () => {
  const compiled = compileDefinition(definition([{ id: "write", type: "command", argv: ["tool"], effect: "write", protectedPaths: [".codex/config", ".agents/skills", ".agents/skills"] }]));
  assert.deepEqual((compiled.definition.steps[0] as { protectedPaths: string[] }).protectedPaths, [".agents/skills", ".codex/config"]);
  for (const protectedPaths of [[], [".agents/../escape"], [".agents\\skills"], [".agents/*"], Array.from({ length: 17 }, (_, index) => `.agents/d${index}`)]) assert.throws(() => compileDefinition(definition([{ id: "bad", type: "command", argv: ["tool"], effect: "write", protectedPaths }])));
});

test("JSON byte budgets cover total serialized parameters, outputs, UTF-8 and escaped strings", () => {
  const many = { first: "文".repeat(90000), second: "文".repeat(90000) };
  assert.throws(() => cloneJson(many), /byte limit/);
  assert.throws(() => validateDefinitionArgs(compileDefinition(definition()).definition, many), /byte limit/);
  assert.throws(() => cloneJson("\\".repeat(270000)), /byte limit/);
  assert.equal(cloneJson("x".repeat(DEFINITION_LIMITS.bytes - 2)), "x".repeat(DEFINITION_LIMITS.bytes - 2));
  assert.throws(() => cloneJson("x".repeat(DEFINITION_LIMITS.bytes - 1)), /byte limit/);
  const largeEnvironment: ExpressionEnvironment = { args: {}, steps: { first: { status: "completed", output: "x".repeat(300000) }, second: { status: "completed", output: "y".repeat(300000) } } };
  assert.equal(evaluateExpression({ op: "length", args: [{ ref: "steps.first.output" }] }, largeEnvironment), 300000);
  assert.throws(() => evaluateExpression({ op: "concat", args: [{ ref: "steps.first.output" }, { ref: "steps.second.output" }] }, largeEnvironment), /limit/);
});

test("branch display labels compile into edge metadata without changing control topology", () => {
  const labelled = definition([
    { id: "choose", type: "choice", cases: [{ id: "internalCase", label: "存在更新", when: true, steps: [] }], default: [] },
    { id: "checks", type: "parallel", policy: "fail-fast", branches: [{ id: "internalCode", label: "代码检查", steps: [transform("code")] }, { id: "internalDocs", steps: [transform("docs")] }] },
  ]);
  const compiled = compileDefinition(labelled);
  assert.equal(compiled.plan.edges.find(edge => edge.kind === "case")?.label, "存在更新");
  assert.equal(compiled.plan.edges.find(edge => edge.kind === "branch" && edge.branchId === "internalCode")?.label, "代码检查");
  assert.equal(compiled.plan.edges.find(edge => edge.kind === "branch" && edge.branchId === "internalDocs")?.label, undefined);
  assert.ok(compiled.plan.edges.filter(edge => ["join", "default", "sequence"].includes(edge.kind)).every(edge => edge.label === undefined));
  const plain = JSON.parse(JSON.stringify(labelled), (key, value: unknown) => key === "label" ? undefined : value);
  const withoutDisplay = (plan: typeof compiled.plan) => plan.edges.map(({ label: _label, ...edge }) => edge);
  assert.deepEqual(withoutDisplay(compiled.plan), withoutDisplay(compileDefinition(plain).plan));
  assert.equal(compileDefinition(compiled.definition).hash, compiled.hash);
});
