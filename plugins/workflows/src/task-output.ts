import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { WorkerResult } from "./adapter.ts";

export type TaskOutputErrorCode = "schema-contract-invalid" | "accept-contract-invalid" | "output-syntax-invalid" | "output-shape-invalid" | "output-accept-rejected" | "output-budget-exhausted";
export type TaskOutputContract = "schema" | "accept" | "output";

export class TaskOutputValidationError extends Error {
  readonly code: TaskOutputErrorCode;
  readonly contract: TaskOutputContract;
  readonly location: string;
  declare readonly outputData?: unknown;
  declare readonly workerResult?: Omit<WorkerResult, "data" | "output">;

  constructor(code: TaskOutputErrorCode, contract: TaskOutputContract, location: string, reason: string) {
    super(`Task output ${contract} validation failed at ${location}: ${reason}.`);
    this.name = "TaskOutputValidationError";
    this.code = code; this.contract = contract; this.location = location;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Contract = "schema" | "accept";
type Compiled = { validator: JsonSchemaValidator<unknown>; complexity: number; propertyNames: Set<string> };
type Budget = { nodes: number; bytes: number; maximumNodes: number; maximumBytes: number; maximumDepth: number };

const contracts = new Map<string, Compiled>();
const keywords = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "enum", "const", "anyOf", "oneOf", "allOf", "not", "if", "then", "else", "title", "description", "$comment", "default", "examples"]);
const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const own = (value: object, key: string) => Object.hasOwn(value, key);

function invalid(contract: Contract, location: string, reason: string): never {
  throw new TaskOutputValidationError(`${contract}-contract-invalid`, contract, location, reason);
}

// Inspect descriptors rather than invoking getters. Inputs arrive over JSON in
// production, but this boundary also rejects accidental executable local values.
function jsonCopy(value: unknown, budget: Budget, fail: (reason: string) => never, depth = 0, ancestors = new Set<object>()): Json {
  if (++budget.nodes > budget.maximumNodes || depth > budget.maximumDepth) fail("JSON complexity limit exceeded");
  let result: Json;
  if (value === null || typeof value === "boolean") result = value;
  else if (typeof value === "string") {
    if (value.length > budget.maximumBytes) fail("JSON size limit exceeded");
    budget.bytes += Buffer.byteLength(JSON.stringify(value), "utf8"); result = value;
  }
  else if (typeof value === "number" && Number.isFinite(value)) { budget.bytes += 24; result = value; }
  else {
    if (!value || typeof value !== "object" || ancestors.has(value)) fail("value must be finite, acyclic JSON data");
    if (Object.getOwnPropertySymbols(value).length) fail("JSON data cannot contain symbol keys");
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("JSON data must use plain objects and arrays");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length > budget.maximumNodes || Object.keys(descriptors).length !== value.length + 1) fail("JSON arrays cannot contain holes or extra properties");
      const array: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !own(descriptor, "value") || !descriptor.enumerable) fail("JSON data cannot contain accessors or hidden values");
        array.push(jsonCopy(descriptor.value, budget, fail, depth + 1, ancestors));
      }
      result = array;
    } else {
      const record: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!own(descriptor, "value") || !descriptor.enumerable) fail("JSON data cannot contain accessors or hidden values");
        if (key.length > budget.maximumBytes) fail("JSON size limit exceeded");
        budget.bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        if (budget.bytes > budget.maximumBytes) fail("JSON size limit exceeded");
        record[key] = jsonCopy(descriptor.value, budget, fail, depth + 1, ancestors);
      }
      result = record;
    }
    ancestors.delete(value);
  }
  budget.bytes += 2;
  if (budget.bytes > budget.maximumBytes) fail("JSON size limit exceeded");
  return result;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

function inspectSchema(value: Json, contract: Contract, location: string, state: { nodes: number; propertyNames: Set<string> }, nested = false): void {
  if (++state.nodes > 512) invalid(contract, location, "schema complexity limit exceeded");
  if (typeof value === "boolean" && nested) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(contract, location, "schema must be an object");
  const schema = value as { [key: string]: Json };
  for (const key of Object.keys(schema)) if (!keywords.has(key)) invalid(contract, location, "unsupported schema keyword; references, regular expressions and formats are not supported");
  if (own(schema, "type")) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.length || declared.length > types.size || declared.some(type => typeof type !== "string" || !types.has(type)) || new Set(declared).size !== declared.length) invalid(contract, `${location}.type`, "invalid JSON Schema type");
  }
  for (const key of ["title", "description", "$comment"]) if (own(schema, key) && typeof schema[key] !== "string") invalid(contract, `${location}.${key}`, "annotation must be a string");
  if (own(schema, "examples") && !Array.isArray(schema.examples)) invalid(contract, `${location}.examples`, "examples must be an array");
  if (own(schema, "properties")) {
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 256) invalid(contract, `${location}.properties`, "properties must be an object with at most 256 entries");
    let index = 0;
    for (const [key, child] of Object.entries(properties)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || key.length > 256) invalid(contract, `${location}.properties[${index}]`, "unsupported property name");
      state.propertyNames.add(key);
      inspectSchema(child, contract, `${location}.properties[${index++}]`, state, true);
    }
  }
  if (own(schema, "required")) {
    const required = schema.required;
    if (!Array.isArray(required) || required.length > 256 || required.some(key => typeof key !== "string" || key.length > 256) || new Set(required).size !== required.length) invalid(contract, `${location}.required`, "required must contain unique property names");
  }
  if (own(schema, "enum")) {
    const choices = schema.enum;
    if (!Array.isArray(choices) || !choices.length || choices.length > 128 || new Set(choices.map(canonical)).size !== choices.length) invalid(contract, `${location}.enum`, "enum must contain between 1 and 128 unique JSON values");
  }
  for (const key of ["minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength"]) {
    if (own(schema, key) && (typeof schema[key] !== "number" || !Number.isSafeInteger(schema[key]) || schema[key] < 0)) invalid(contract, `${location}.${key}`, "bound must be a nonnegative safe integer");
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (own(schema, key) && (typeof schema[key] !== "number" || key === "multipleOf" && schema[key] <= 0)) invalid(contract, `${location}.${key}`, "bound must be a finite number and multipleOf must be positive");
  }
  if (own(schema, "uniqueItems") && (typeof schema.uniqueItems !== "boolean" || schema.uniqueItems && (typeof schema.maxItems !== "number" || schema.maxItems > 256))) invalid(contract, `${location}.uniqueItems`, "uniqueItems requires a boolean and a maxItems bound of at most 256 when enabled");
  for (const key of ["additionalProperties", "items", "not", "if", "then", "else"]) if (own(schema, key)) inspectSchema(schema[key]!, contract, `${location}.${key}`, state, true);
  if ((own(schema, "then") || own(schema, "else")) && !own(schema, "if")) invalid(contract, location, "conditional schemas require if");
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!own(schema, key)) continue;
    const branches = schema[key];
    if (!Array.isArray(branches) || !branches.length || branches.length > 16) invalid(contract, `${location}.${key}`, "schema alternatives require between 1 and 16 branches");
    branches.forEach((branch, index) => inspectSchema(branch, contract, `${location}.${key}[${index}]`, state, true));
  }
}

function compile(value: unknown, contract: Contract): Compiled | undefined {
  if (value === undefined) return;
  let schema: Json;
  const fail = (reason: string): never => invalid(contract, "$", reason);
  try { schema = jsonCopy(value, { nodes: 0, bytes: 0, maximumNodes: 8192, maximumBytes: 65_536, maximumDepth: 24 }, fail); }
  catch (error) { if (error instanceof TaskOutputValidationError) throw error; return fail("schema must be plain JSON data"); }
  const state = { nodes: 0, propertyNames: new Set<string>() };
  inspectSchema(schema, contract, "$", state);
  const key = canonical(schema);
  const cached = contracts.get(key);
  if (cached) return cached;
  let validator: JsonSchemaValidator<unknown>;
  try { validator = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType); }
  catch { return fail("schema could not be compiled"); }
  const result = { validator, complexity: state.nodes, propertyNames: state.propertyNames };
  if (contracts.size >= 32) contracts.delete(contracts.keys().next().value!);
  contracts.set(key, result);
  return result;
}

// AJV's prose can contain enum values and property names. Only a conservative
// JSON Pointer prefix is accepted for diagnostics; the prose is never exposed.
function safeLocation(message: string, propertyNames: Set<string>): string {
  const pointer = /^data((?:\/(?:[A-Za-z_][A-Za-z0-9_]{0,47}|[0-9]{1,8})){0,12})\s/.exec(message)?.[1];
  if (pointer?.split("/").slice(1).some(segment => !/^[0-9]+$/.test(segment) && !propertyNames.has(segment))) return "$";
  return pointer ? `$${pointer}` : "$";
}

export function validateTaskContracts(schema?: unknown, accept?: unknown): void {
  compile(schema, "schema");
  compile(accept, "accept");
}

export function validateTaskOutput(value: unknown, schema?: unknown, accept?: unknown): void {
  const shape = compile(schema, "schema"), acceptance = compile(accept, "accept");
  if (!shape && !acceptance) return;
  const budget = { nodes: 0, bytes: 0, maximumNodes: 65_536, maximumBytes: 1024 * 1024, maximumDepth: 64 };
  const fail = (reason: string): never => { throw new TaskOutputValidationError("output-syntax-invalid", "output", "$", reason); };
  let input: Json;
  try { input = jsonCopy(value, budget, fail); }
  catch (error) { if (error instanceof TaskOutputValidationError) throw error; return fail("value must be plain JSON data"); }
  for (const [contract, compiled] of [["schema", shape], ["accept", acceptance]] as const) {
    if (!compiled) continue;
    if (compiled.complexity * budget.nodes > 4_000_000) fail("combined JSON and schema complexity limit exceeded");
    let result;
    try { result = compiled.validator(input); }
    catch { throw new TaskOutputValidationError(contract === "schema" ? "output-shape-invalid" : "output-accept-rejected", contract, "$", "validation could not complete"); }
    if (!result.valid) throw new TaskOutputValidationError(contract === "schema" ? "output-shape-invalid" : "output-accept-rejected", contract, safeLocation(result.errorMessage, compiled.propertyNames), contract === "schema" ? "returned data does not match the declared shape" : "returned data does not satisfy the explicit success condition");
  }
}
