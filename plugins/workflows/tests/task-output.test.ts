import assert from "node:assert/strict";
import test from "node:test";
import { TaskOutputValidationError, validateTaskContracts, validateTaskOutput } from "../src/task-output.ts";

const shape = {
  type: "object", additionalProperties: false,
  properties: { status: { type: "string", enum: ["passed", "failed"] }, report: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false } },
  required: ["status", "report"],
};
const accept = { type: "object", properties: { status: { const: "passed" } }, required: ["status"] };
function rejected(action: () => void, code: TaskOutputValidationError["code"], contract?: TaskOutputValidationError["contract"]): TaskOutputValidationError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof TaskOutputValidationError);
  assert.equal(caught.code, code);
  if (contract) assert.equal(caught.contract, contract);
  assert.match(caught.message, /validation failed at \$/);
  return caught;
}

test("valid output satisfies independent shape and acceptance contracts without mutation", () => {
  const value = Object.freeze({ status: "passed", report: Object.freeze({ count: 3 }) });
  const before = JSON.stringify(value), schemaBefore = JSON.stringify(shape), acceptBefore = JSON.stringify(accept);
  validateTaskContracts(shape, accept);
  validateTaskOutput(value, shape, accept);
  assert.equal(JSON.stringify(value), before);
  assert.equal(JSON.stringify(shape), schemaBefore);
  assert.equal(JSON.stringify(accept), acceptBefore);
});

test("a failed status remains legitimate branch data without an explicit success condition", () => {
  validateTaskOutput({ status: "failed", report: { count: 0 } }, shape);
  validateTaskOutput({ status: "failed" });
  validateTaskOutput("unstructured worker output");
});

test("only the explicit acceptance contract rejects a valid business result", () => {
  const value = { status: "failed", report: { count: 0 } };
  const error = rejected(() => validateTaskOutput(value, shape, accept), "output-accept-rejected", "accept");
  assert.equal(error.location, "$/status");
  assert.deepEqual(value, { status: "failed", report: { count: 0 } });
});

test("missing fields and wrong nested types are shape failures before acceptance", () => {
  rejected(() => validateTaskOutput({ status: "passed" }, shape, accept), "output-shape-invalid", "schema");
  const error = rejected(() => validateTaskOutput({ status: "passed", report: { count: "wrong" } }, shape), "output-shape-invalid");
  assert.equal(error.location, "$/report/count");
});

test("error messages never quote actual values or rejected enum values", () => {
  const secret = "sk-DO-NOT-ECHO-input-value", expectedSecret = "PRIVATE_SCHEMA_EXPECTED_VALUE";
  const contract = { type: "object", properties: { token: { enum: [expectedSecret] } }, required: ["token"], additionalProperties: false };
  const error = rejected(() => validateTaskOutput({ token: secret }, contract), "output-shape-invalid");
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes(expectedSecret), false);
  const maliciousKey = "PRIVATE-INPUT-KEY-NOT-A-SAFE-PATH";
  const nested = { type: "object", additionalProperties: { type: "integer" } };
  const keyError = rejected(() => validateTaskOutput({ [maliciousKey]: secret }, nested), "output-shape-invalid");
  assert.equal(keyError.location, "$");
  assert.equal(keyError.message.includes(maliciousKey), false);
  const validIdentifierKey = "PRIVATE_INPUT_KEY";
  const identifierError = rejected(() => validateTaskOutput({ [validIdentifierKey]: secret }, nested), "output-shape-invalid");
  assert.equal(identifierError.location, "$");
  assert.equal(identifierError.message.includes(validIdentifierKey), false);
});

test("annotations cannot fill defaults, coerce input or remove extra properties", () => {
  const defaults = { type: "object", properties: { count: { type: "integer", default: 8 } }, required: ["count"], additionalProperties: false };
  const absent = {}, textual = { count: "4" }, extra = { count: 4, private: "secret" };
  rejected(() => validateTaskOutput(absent, defaults), "output-shape-invalid");
  rejected(() => validateTaskOutput(textual, defaults), "output-shape-invalid");
  rejected(() => validateTaskOutput(extra, defaults), "output-shape-invalid");
  assert.deepEqual(absent, {});
  assert.deepEqual(textual, { count: "4" });
  assert.deepEqual(extra, { count: 4, private: "secret" });
});

test("nested objects, type unions, enum, arrays and numeric bounds use SDK validation", () => {
  const contract = { type: "object", properties: {
    name: { type: ["string", "null"], minLength: 2, maxLength: 8 },
    records: { type: "array", items: { type: "object", properties: { kind: { enum: ["a", "b"] }, score: { type: "number", minimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 } }, required: ["kind", "score"] }, minItems: 1, maxItems: 3 },
  }, required: ["name", "records"] };
  validateTaskContracts(contract);
  validateTaskOutput({ name: null, records: [{ kind: "a", score: 9.5 }] }, contract);
  validateTaskOutput({ name: "ok", records: [{ kind: "b", score: 0 }] }, contract);
  rejected(() => validateTaskOutput({ name: "x", records: [{ kind: "b", score: 0 }] }, contract), "output-shape-invalid");
  rejected(() => validateTaskOutput({ name: null, records: [{ kind: "c", score: 0 }] }, contract), "output-shape-invalid");
});

test("anyOf, oneOf, allOf, not and conditional constraints preserve normal JSON Schema semantics", () => {
  const contract = { allOf: [
    { anyOf: [{ type: "integer" }, { type: "string" }] },
    { oneOf: [{ type: "number", minimum: 1 }, { type: "string", minLength: 2 }] },
    { not: { enum: ["blocked", 4] } },
  ] };
  validateTaskOutput(2, contract);
  validateTaskOutput("ok", contract);
  for (const value of [null, 0, "x", "blocked", 4]) rejected(() => validateTaskOutput(value, contract), "output-shape-invalid");
  const conditional = { if: { type: "number" }, then: { minimum: 5 }, else: { const: "skip" } };
  validateTaskOutput(8, conditional); validateTaskOutput("skip", conditional);
  rejected(() => validateTaskOutput(2, conditional), "output-shape-invalid");
  validateTaskOutput({ value: 2 }, { type: "object", properties: { value: true }, additionalProperties: false });
  rejected(() => validateTaskOutput({ value: 2 }, { type: "object", properties: { value: false } }), "output-shape-invalid");
});

test("external and local references, unknown keywords, regex and format are rejected before execution", () => {
  for (const schema of [
    { $ref: "https://private.example/schema?token=SECRET_REFERENCE" },
    { $ref: "file:///PRIVATE_SCHEMA_FILE" },
    { $ref: "#/definitions/local" },
    { type: "string", pattern: "(a+)+$" },
    { type: "string", format: "email" },
    { type: "object", misspelledProperties: {} },
    { $id: "PRIVATE_SCHEMA_ID", type: "string" },
  ]) {
    const error = rejected(() => validateTaskContracts(schema), "schema-contract-invalid", "schema");
    assert.equal(/SECRET_REFERENCE|PRIVATE_SCHEMA/.test(error.message), false);
  }
  rejected(() => validateTaskContracts(undefined, { $ref: "https://invalid.example" }), "accept-contract-invalid", "accept");
});

test("malformed schemas fail preflight, including unsupported unbounded uniqueness", () => {
  for (const schema of [
    null, true, [], "schema", { type: "private-secret-invalid-type" }, { type: ["string", "string"] },
    { required: [1] }, { required: ["one", "one"] }, { properties: [] }, { properties: { ok: null } },
    { enum: [] }, { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }, { minimum: "secret" },
    { minLength: -1 }, { multipleOf: 0 }, { anyOf: [] }, { items: [] }, { uniqueItems: true },
    { then: { const: true } },
  ]) rejected(() => validateTaskContracts(schema), "schema-contract-invalid");
  validateTaskContracts({ type: "array", items: { type: "integer" }, uniqueItems: true, maxItems: 16 });
});

test("non-JSON worker values are syntax failures without changing the original", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, () => 0, Symbol("PRIVATE_SYMBOL"), new Date(), cycle, [1, , 2]]) {
    rejected(() => validateTaskOutput(value, {}), "output-syntax-invalid", "output");
  }
  let called = false;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { called = true; return "PRIVATE_GETTER_VALUE"; } });
  rejected(() => validateTaskOutput(accessor, {}), "output-syntax-invalid");
  rejected(() => validateTaskContracts(accessor), "schema-contract-invalid");
  assert.equal(called, false);
});

test("schema and data size, depth and alternatives are bounded", () => {
  rejected(() => validateTaskContracts({ description: "x".repeat(65_536) }), "schema-contract-invalid");
  rejected(() => validateTaskContracts({ description: "\u0000".repeat(12_000) }), "schema-contract-invalid");
  let deepSchema: object = { type: "string" };
  for (let index = 0; index < 30; index++) deepSchema = { properties: { child: deepSchema } };
  rejected(() => validateTaskContracts(deepSchema), "schema-contract-invalid");
  rejected(() => validateTaskContracts({ anyOf: Array.from({ length: 17 }, () => ({ type: "string" })) }), "schema-contract-invalid");
  rejected(() => validateTaskOutput("x".repeat(1024 * 1024), {}), "output-syntax-invalid");
  let deepValue: object = {};
  for (let index = 0; index < 66; index++) deepValue = { child: deepValue };
  rejected(() => validateTaskOutput(deepValue, {}), "output-syntax-invalid");
});

test("compilation cache cannot let mutated schemas or annotations alias other contracts", () => {
  const mutable = { type: "integer" };
  validateTaskContracts(mutable);
  mutable.type = "string";
  validateTaskOutput("now a string", mutable);
  rejected(() => validateTaskOutput(5, mutable), "output-shape-invalid");
  for (let index = 0; index < 40; index++) validateTaskContracts({ type: "integer", minimum: index });
  validateTaskOutput(2, { type: "integer", minimum: 1 });
});
