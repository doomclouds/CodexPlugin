import { createHash } from "node:crypto";
import { normalizeProtectedPaths } from "./protected-paths.ts";
import { validateTaskContracts } from "./task-output.ts";

/** Structured workflow definitions are the single source of execution and layout. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Expression = JsonValue | { ref: string } | { literal: JsonValue } | { op: ExpressionOperator; args: Expression[] };
export type Expr = Expression;
export type ValueExpr = Expression;
export type ExpressionOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not" | "add" | "sub" | "mul" | "div" | "concat" | "get" | "coalesce" | "length";
export interface DefinitionParameter { name: string; label?: string; description?: string; type: "string" | "number" | "integer" | "boolean" | "object" | "array"; required?: boolean; default?: JsonValue; enum?: JsonValue[]; }
export interface BaseNode { id: string; type: string; label?: string; }
export interface AgentNode extends BaseNode { type: "agent"; task: Expression; mode?: "read" | "write"; model?: string; reasoningEffort?: string; schema?: JsonValue; accept?: JsonValue; maxRecoveryAttempts?: number; }
export interface CommandNode extends BaseNode { type: "command"; argv: Expression[]; effect: "read" | "write"; networkAccess?: boolean; protectedPaths?: string[]; timeoutMs?: number; idempotent?: boolean; }
export interface TransformNode extends BaseNode { type: "transform"; value: Expression; }
export interface WaitNode extends BaseNode { type: "wait"; message: Expression; schema?: JsonValue; }
export interface SubflowNode extends BaseNode { type: "subflow"; ref?: { id: string; revision: number }; definition?: WorkflowDefinition; args?: Expression; }
export interface ExpandNode extends BaseNode { type: "expand"; task: Expression; }
export interface ChoiceCase { id: string; label?: string; when: Expression; steps: DefinitionNode[]; }
export interface ChoiceNode extends BaseNode { type: "choice"; cases: ChoiceCase[]; default: DefinitionNode[]; }
export interface ParallelBranch { id: string; label?: string; steps: DefinitionNode[]; }
export interface ParallelNode extends BaseNode { type: "parallel"; branches: ParallelBranch[]; policy: "fail-fast" | "all-settled"; concurrency?: number; }
export interface MapNode extends BaseNode { type: "map"; items: Expression; itemKey: Expression; steps: DefinitionNode[]; concurrency?: number; }
export interface RepeatNode extends BaseNode { type: "repeat"; maxIterations: number; while?: Expression; until?: Expression; steps: DefinitionNode[]; }
export interface TryNode extends BaseNode { type: "try"; steps: DefinitionNode[]; catch?: DefinitionNode[]; finally?: DefinitionNode[]; }
export type DefinitionNode = AgentNode | CommandNode | TransformNode | WaitNode | SubflowNode | ExpandNode | ChoiceNode | ParallelNode | MapNode | RepeatNode | TryNode;
export interface WorkflowDefinition { schemaVersion: 1; name: string; description: string; parameters?: DefinitionParameter[]; steps: DefinitionNode[]; }
export interface ExpressionEnvironment { args: JsonValue; steps: Record<string, { output?: JsonValue; status: string }>; item?: JsonValue; key?: JsonValue; iteration?: number; error?: JsonValue; state?: JsonValue; }
export interface DefinitionPlanNode { id: string; type: DefinitionNode["type"] | "join"; label: string; parentId?: string; branchId?: string; }
export interface DefinitionPlanEdge { id: string; from: string; to: string; kind: "sequence" | "case" | "default" | "branch" | "body" | "repeat" | "catch" | "finally" | "join" | "exit"; branchId?: string; }
export interface DefinitionPlan { version: 1; nodes: DefinitionPlanNode[]; edges: DefinitionPlanEdge[]; }
export interface CompiledDefinition { definition: WorkflowDefinition; hash: string; plan: DefinitionPlan; }
export interface DefinitionWalkContext { parentId?: string; branchId?: string; }

export const DEFINITION_LIMITS = Object.freeze({ bytes: 512 * 1024, nodes: 500, depth: 24, expressionDepth: 40, expressionValues: 20000, maxIterations: 1000, concurrency: 32 });
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const operators = new Set<ExpressionOperator>(["eq", "ne", "lt", "lte", "gt", "gte", "and", "or", "not", "add", "sub", "mul", "div", "concat", "get", "coalesce", "length"]);
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;

export class DefinitionValidationError extends Error {
  constructor(message: string) { super(message); this.name = "DefinitionValidationError"; }
}
export class ExpressionEvaluationError extends Error {
  constructor(message: string) { super(message); this.name = "ExpressionEvaluationError"; }
}
function invalid(path: string, message: string): never { throw new DefinitionValidationError(`${path}: ${message}`); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function object(value: unknown, path: string): Record<string, unknown> { if (!isObject(value)) invalid(path, "expected an object"); return value; }
function fields(value: Record<string, unknown>, allowed: string[], required: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}.${key}`, "unknown field");
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "required field is missing");
}
function textField(value: unknown, path: string, max = 1000, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) invalid(path, `expected ${empty ? "a" : "a nonempty"} string of at most ${max} characters`);
  return value;
}
function idField(value: unknown, path: string): string { const id = textField(value, path, 80); if (!identifier.test(id) || forbiddenKeys.has(id)) invalid(path, "invalid identifier"); return id; }
function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(path, `expected an integer between ${minimum} and ${maximum}`);
  return value as number;
}

/** Copy only JSON data. Accessors, inherited data, cycles and non-finite numbers never enter execution. */
export function cloneJson(value: unknown, path = "value", maximumBytes = DEFINITION_LIMITS.bytes): JsonValue {
  let count = 0;
  let bytes = 0;
  const active = new Set<object>();
  function spend(amount: number, location: string): void { bytes += amount; if (bytes > maximumBytes) invalid(location, "serialized JSON byte limit exceeded"); }
  function copy(input: unknown, location: string, depth: number): JsonValue {
    if (++count > DEFINITION_LIMITS.expressionValues) invalid(location, "JSON value limit exceeded");
    if (depth > DEFINITION_LIMITS.expressionDepth + DEFINITION_LIMITS.depth) invalid(location, "JSON depth limit exceeded");
    if (typeof input === "string") { if (input.length > maximumBytes) invalid(location, "JSON string byte limit exceeded"); spend(Buffer.byteLength(JSON.stringify(input), "utf8"), location); return input; }
    if (input === null || typeof input === "boolean") { spend(input === null || input === true ? 4 : 5, location); return input; }
    if (typeof input === "number" && Number.isFinite(input)) { spend(JSON.stringify(input).length, location); return input; }
    if (typeof input !== "object" || input === null) invalid(location, "expected JSON data");
    if (active.has(input)) invalid(location, "cyclic JSON data is forbidden");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(input) && prototype === Array.prototype)) invalid(location, "non-JSON object is forbidden");
    if (Object.getOwnPropertySymbols(input).length) invalid(location, "symbol keys are forbidden");
    active.add(input);
    try {
      if (Array.isArray(input)) {
        const keys = Object.keys(input);
        if (keys.length !== input.length || keys.some((key, index) => key !== `${index}`)) invalid(location, "sparse arrays or extra array fields are forbidden");
        spend(2 + Math.max(0, input.length - 1), location);
        return Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`)!;
          if (!Object.hasOwn(descriptor, "value")) invalid(location, "accessors are forbidden");
          return copy(descriptor.value, `${location}[${index}]`, depth + 1);
        });
      }
      const result: { [key: string]: JsonValue } = {};
      const keys = Object.getOwnPropertyNames(input);
      spend(2 + Math.max(0, keys.length - 1), location);
      for (const key of keys) {
        if (forbiddenKeys.has(key)) invalid(location, "prototype keys are forbidden");
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid(location, "accessors and hidden fields are forbidden");
        spend(Buffer.byteLength(JSON.stringify(key), "utf8") + 1, location);
        result[key] = copy(descriptor.value, `${location}.${key}`, depth + 1);
      }
      return result;
    } finally { active.delete(input); }
  }
  return copy(value, path, 0);
}

/** Canonical key ordering makes hashes independent of input object key ordering. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

interface Scope { visible: Set<string>; item: boolean; key: boolean; iteration: boolean; error: boolean; parameters?: Set<string>; }
function referenceParts(reference: unknown, path: string): string[] {
  const text = textField(reference, path, 1000);
  const parts = text.split(".");
  if (parts.some(part => !part || forbiddenKeys.has(part) || !/^[A-Za-z0-9_-]+$/.test(part))) invalid(path, "invalid reference path");
  if (!["args", "steps", "item", "key", "iteration", "error", "state"].includes(parts[0]!)) invalid(path, "unknown reference root");
  return parts;
}
function validateExpression(value: unknown, path: string, scope: Scope, depth = 0): void {
  if (depth > DEFINITION_LIMITS.expressionDepth) invalid(path, "expression depth limit exceeded");
  if (Array.isArray(value)) { value.forEach((part, index) => validateExpression(part, `${path}[${index}]`, scope, depth + 1)); return; }
  if (!isObject(value)) return;
  if (Object.hasOwn(value, "literal")) { fields(value, ["literal"], ["literal"], path); return; }
  if (Object.hasOwn(value, "ref")) {
    fields(value, ["ref"], ["ref"], path);
    const [root, name, slot] = referenceParts(value.ref, `${path}.ref`);
    if (root === "steps") {
      if (!name || !scope.visible.has(name)) invalid(path, "node reference is unavailable in this scope or precedes its commit");
      if (slot && slot !== "output" && slot !== "status") invalid(path, "node references expose only output and status");
    }
    if ((root === "item" && !scope.item) || (root === "key" && !scope.key) || (root === "iteration" && !scope.iteration) || (root === "error" && !scope.error)) invalid(path, `${root} is unavailable in this scope`);
    if (root === "args" && name && scope.parameters && !scope.parameters.has(name)) invalid(path, "unknown workflow parameter");
    return;
  }
  if (Object.hasOwn(value, "op")) {
    fields(value, ["op", "args"], ["op", "args"], path);
    if (!operators.has(value.op as ExpressionOperator)) invalid(`${path}.op`, "unsupported expression operator");
    if (!Array.isArray(value.args)) invalid(`${path}.args`, "expected an array");
    const count = value.args.length;
    const unary = ["not", "length"].includes(value.op as string);
    const binary = ["eq", "ne", "lt", "lte", "gt", "gte", "sub", "div", "get"].includes(value.op as string);
    if ((unary && count !== 1) || (binary && count !== 2) || (!unary && !binary && count < 1)) invalid(path, "invalid operator argument count");
    value.args.forEach((part, index) => validateExpression(part, `${path}.args[${index}]`, scope, depth + 1));
    return;
  }
  for (const [key, part] of Object.entries(value)) validateExpression(part, `${path}.${key}`, scope, depth + 1);
}
function validateBooleanExpression(value: unknown, path: string, scope: Scope): void {
  validateExpression(value, path, scope);
  if (typeof value === "boolean") return;
  if (!isObject(value) || Array.isArray(value)) invalid(path, "a condition must produce a boolean");
  if (Object.hasOwn(value, "literal") && typeof value.literal !== "boolean") invalid(path, "a condition literal must be boolean");
  if (Object.hasOwn(value, "op") && !["eq", "ne", "lt", "lte", "gt", "gte", "and", "or", "not", "get", "coalesce"].includes(value.op as string)) invalid(path, "this operator does not produce a boolean condition");
  if (!["ref", "literal", "op"].some(key => Object.hasOwn(value, key))) invalid(path, "a condition must produce a boolean");
}

/** Validate and normalize the only accepted workflow protocol; legacy scripts are rejected. */
export function validateDefinition(input: unknown): WorkflowDefinition { return validateDefinitionInternal(input, { nodes: 0 }, 0); }
function validateDefinitionInternal(input: unknown, budget: { nodes: number }, definitionDepth: number): WorkflowDefinition {
  const json = cloneJson(input, "definition");
  if (Buffer.byteLength(JSON.stringify(json), "utf8") > DEFINITION_LIMITS.bytes) invalid("definition", "definition byte limit exceeded");
  const definition = object(json, "definition");
  fields(definition, ["schemaVersion", "name", "description", "parameters", "steps"], ["schemaVersion", "name", "description", "steps"], "definition");
  if (definition.schemaVersion !== 1) invalid("definition.schemaVersion", "only structured schemaVersion 1 is supported");
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(textField(definition.name, "definition.name", 80))) invalid("definition.name", "expected a lowercase hyphenated name");
  textField(definition.description, "definition.description", 4000);
  const parameters = new Set<string>();
  if (definition.parameters !== undefined) {
    if (!Array.isArray(definition.parameters) || definition.parameters.length > 100) invalid("definition.parameters", "expected at most 100 parameters");
    for (const [index, entry] of definition.parameters.entries()) {
      const path = `definition.parameters[${index}]`;
      const parameter = object(entry, path);
      fields(parameter, ["name", "label", "description", "type", "required", "default", "enum"], ["name", "type"], path);
      const name = idField(parameter.name, `${path}.name`);
      if (parameters.has(name)) invalid(path, "duplicate parameter name");
      parameters.add(name);
      if (!["string", "number", "integer", "boolean", "object", "array"].includes(parameter.type as string)) invalid(`${path}.type`, "unsupported parameter type");
      if (parameter.label !== undefined) textField(parameter.label, `${path}.label`, 120);
      if (parameter.description !== undefined) textField(parameter.description, `${path}.description`, 2000);
      if (parameter.required !== undefined && typeof parameter.required !== "boolean") invalid(`${path}.required`, "expected a boolean");
      if (parameter.enum !== undefined && (!Array.isArray(parameter.enum) || !parameter.enum.length || parameter.enum.length > 100)) invalid(`${path}.enum`, "expected a nonempty bounded array");
      if (parameter.default !== undefined) validateParameterValue(parameter, parameter.default, `${path}.default`);
      if (Array.isArray(parameter.enum)) for (const member of parameter.enum) validateParameterType(parameter.type as string, member, `${path}.enum`);
    }
  }
  const ids = new Set<string>();
  function sequence(inputSteps: unknown, path: string, scope: Scope, depth: number): Set<string> {
    if (depth + definitionDepth > DEFINITION_LIMITS.depth) invalid(path, "workflow nesting limit exceeded");
    if (!Array.isArray(inputSteps)) invalid(path, "expected a steps array");
    const visible = new Set(scope.visible);
    for (const [index, entry] of inputSteps.entries()) {
      const here = `${path}[${index}]`;
      const node = object(entry, here);
      if (++budget.nodes > DEFINITION_LIMITS.nodes) invalid(here, "workflow node limit exceeded");
      const id = idField(node.id, `${here}.id`);
      if (ids.has(id)) invalid(`${here}.id`, "node identifiers must be globally unique");
      ids.add(id);
      if (node.label !== undefined) textField(node.label, `${here}.label`, 120);
      const local: Scope = { ...scope, visible };
      const expr = (key: string, targetScope = local): void => validateExpression(node[key], `${here}.${key}`, targetScope);
      const nested = (key: string, targetScope = local): Set<string> => sequence(node[key], `${here}.${key}`, targetScope, depth + 1);
      const base = ["id", "type", "label"];
      switch (node.type) {
        case "agent":
          fields(node, [...base, "task", "mode", "model", "reasoningEffort", "schema", "accept", "maxRecoveryAttempts"], [...base.slice(0, 2), "task"], here);
          expr("task");
          node.mode ??= "read";
          if (!["read", "write"].includes(node.mode as string)) invalid(`${here}.mode`, "expected read or write");
          if (node.model !== undefined) textField(node.model, `${here}.model`, 120);
          if (node.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(node.reasoningEffort as string)) invalid(`${here}.reasoningEffort`, "unsupported reasoning effort");
          if (node.schema !== undefined) object(node.schema, `${here}.schema`);
          if (node.accept !== undefined) object(node.accept, `${here}.accept`);
          if (node.accept !== undefined && node.schema === undefined) invalid(here, "an acceptance contract requires an output schema");
          try { validateTaskContracts(node.schema, node.accept); } catch (error) { invalid(here, error instanceof Error ? error.message : "invalid output contract"); }
          node.maxRecoveryAttempts ??= 0;
          boundedInteger(node.maxRecoveryAttempts, `${here}.maxRecoveryAttempts`, 0, 2);
          break;
        case "command":
          fields(node, [...base, "argv", "effect", "networkAccess", "protectedPaths", "timeoutMs", "idempotent"], ["id", "type", "argv", "effect"], here);
          if (!Array.isArray(node.argv) || !node.argv.length || node.argv.length > 256) invalid(`${here}.argv`, "expected 1 to 256 argument expressions");
          expr("argv");
          if (!["read", "write"].includes(node.effect as string)) invalid(`${here}.effect`, "expected an explicit read or write effect");
          for (const key of ["networkAccess", "idempotent"]) if (node[key] !== undefined && typeof node[key] !== "boolean") invalid(`${here}.${key}`, "expected a boolean");
          if (node.timeoutMs !== undefined) boundedInteger(node.timeoutMs, `${here}.timeoutMs`, 1, 3_600_000);
          if (node.protectedPaths !== undefined) {
            try { node.protectedPaths = normalizeProtectedPaths(node.protectedPaths); } catch (error) { invalid(`${here}.protectedPaths`, error instanceof Error ? error.message : "invalid protected paths"); }
            if (node.effect !== "write") invalid(`${here}.protectedPaths`, "protected write scope requires a write command");
          }
          break;
        case "transform": fields(node, [...base, "value"], ["id", "type", "value"], here); expr("value"); break;
        case "wait": fields(node, [...base, "message", "schema"], ["id", "type", "message"], here); expr("message"); if (node.schema !== undefined) { object(node.schema, `${here}.schema`); try { validateTaskContracts(node.schema, undefined); } catch (error) { invalid(here, error instanceof Error ? error.message : "invalid wait schema"); } } break;
        case "expand": fields(node, [...base, "task"], ["id", "type", "task"], here); expr("task"); break;
        case "subflow": {
          fields(node, [...base, "ref", "definition", "args"], ["id", "type"], here);
          if ((node.ref === undefined) === (node.definition === undefined)) invalid(here, "subflow requires exactly one fixed ref or inline definition");
          if (node.ref !== undefined) {
            const ref = object(node.ref, `${here}.ref`);
            fields(ref, ["id", "revision"], ["id", "revision"], `${here}.ref`);
            textField(ref.id, `${here}.ref.id`, 200);
            boundedInteger(ref.revision, `${here}.ref.revision`, 1, Number.MAX_SAFE_INTEGER);
          }
          if (node.definition !== undefined) node.definition = validateDefinitionInternal(node.definition, budget, definitionDepth + depth + 1);
          if (node.args !== undefined) expr("args");
          break;
        }
        case "choice": {
          fields(node, [...base, "cases", "default"], ["id", "type", "cases", "default"], here);
          if (!Array.isArray(node.cases) || !node.cases.length || node.cases.length > 32) invalid(`${here}.cases`, "expected 1 to 32 cases");
          const caseIds = new Set<string>();
          for (const [caseIndex, entry] of node.cases.entries()) {
            const casePath = `${here}.cases[${caseIndex}]`;
            const branch = object(entry, casePath);
            fields(branch, ["id", "label", "when", "steps"], ["id", "when", "steps"], casePath);
            const caseId = idField(branch.id, `${casePath}.id`);
            if (caseId === "default" || caseIds.has(caseId)) invalid(casePath, "duplicate or reserved case identifier");
            caseIds.add(caseId);
            if (branch.label !== undefined) textField(branch.label, `${casePath}.label`, 120);
            validateBooleanExpression(branch.when, `${casePath}.when`, local);
            sequence(branch.steps, `${casePath}.steps`, local, depth + 1);
          }
          nested("default");
          break;
        }
        case "parallel": {
          fields(node, [...base, "branches", "policy", "concurrency"], ["id", "type", "branches", "policy"], here);
          if (!["fail-fast", "all-settled"].includes(node.policy as string)) invalid(`${here}.policy`, "expected fail-fast or all-settled");
          if (!Array.isArray(node.branches) || !node.branches.length || node.branches.length > 32) invalid(`${here}.branches`, "expected 1 to 32 branches");
          if (node.concurrency !== undefined) boundedInteger(node.concurrency, `${here}.concurrency`, 1, DEFINITION_LIMITS.concurrency);
          const branchIds = new Set<string>();
          for (const [branchIndex, entry] of node.branches.entries()) {
            const branchPath = `${here}.branches[${branchIndex}]`;
            const branch = object(entry, branchPath);
            fields(branch, ["id", "label", "steps"], ["id", "steps"], branchPath);
            const branchId = idField(branch.id, `${branchPath}.id`);
            if (branchIds.has(branchId)) invalid(branchPath, "duplicate branch identifier");
            branchIds.add(branchId);
            if (branch.label !== undefined) textField(branch.label, `${branchPath}.label`, 120);
            sequence(branch.steps, `${branchPath}.steps`, local, depth + 1);
          }
          break;
        }
        case "map":
          fields(node, [...base, "items", "itemKey", "steps", "concurrency"], ["id", "type", "items", "itemKey", "steps"], here);
          expr("items"); expr("itemKey", { ...local, item: true });
          if (node.concurrency !== undefined) boundedInteger(node.concurrency, `${here}.concurrency`, 1, DEFINITION_LIMITS.concurrency);
          nested("steps", { ...local, item: true, key: true });
          break;
        case "repeat": {
          fields(node, [...base, "maxIterations", "while", "until", "steps"], ["id", "type", "maxIterations", "steps"], here);
          boundedInteger(node.maxIterations, `${here}.maxIterations`, 1, DEFINITION_LIMITS.maxIterations);
          if (node.while !== undefined && node.until !== undefined) invalid(here, "repeat cannot combine a pre-test while with a post-test until");
          const bodyScope = { ...local, iteration: true };
          if (node.while !== undefined) validateBooleanExpression(node.while, `${here}.while`, bodyScope);
          const bodyVisible = nested("steps", bodyScope);
          if (node.until !== undefined) validateBooleanExpression(node.until, `${here}.until`, { ...bodyScope, visible: bodyVisible });
          break;
        }
        case "try": {
          fields(node, [...base, "steps", "catch", "finally"], ["id", "type", "steps"], here);
          if (node.catch === undefined && node.finally === undefined) invalid(here, "try requires catch or finally");
          nested("steps");
          if (node.catch !== undefined) nested("catch", { ...local, error: true });
          if (node.finally !== undefined) nested("finally", { ...local, error: true });
          break;
        }
        default: invalid(`${here}.type`, "unsupported structured node type");
      }
      visible.add(id);
    }
    return visible;
  }
  sequence(definition.steps, "definition.steps", { visible: new Set(), item: false, key: false, iteration: false, error: false, ...(definition.parameters !== undefined ? { parameters } : {}) }, 0);
  if (Buffer.byteLength(JSON.stringify(definition), "utf8") > DEFINITION_LIMITS.bytes) invalid("definition", "normalized definition byte limit exceeded");
  return definition as unknown as WorkflowDefinition;
}

function validateParameterType(type: string, value: unknown, path: string): void {
  const valid = type === "integer" ? Number.isSafeInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? isObject(value) : typeof value === type;
  if (!valid) invalid(path, `expected ${type}`);
}
function validateParameterValue(parameter: Record<string, unknown>, value: unknown, path: string): void {
  validateParameterType(parameter.type as string, value, path);
  if (Array.isArray(parameter.enum) && !parameter.enum.some(member => canonicalJson(member as JsonValue) === canonicalJson(value as JsonValue))) invalid(path, "value is outside the parameter enum");
}
export function validateDefinitionArgs(definition: WorkflowDefinition, input: unknown): { [key: string]: JsonValue } {
  const args = object(cloneJson(input, "args"), "args");
  if (!definition.parameters) return args as { [key: string]: JsonValue };
  for (const name of Object.keys(args)) if (!definition.parameters.some(parameter => parameter.name === name)) invalid(`args.${name}`, "unknown workflow parameter");
  for (const parameter of definition.parameters) {
    if (!Object.hasOwn(args, parameter.name)) {
      if (parameter.default !== undefined) args[parameter.name] = cloneJson(parameter.default);
      else if (parameter.required) invalid(`args.${parameter.name}`, "required parameter is missing");
      else continue;
    }
    validateParameterValue(parameter as unknown as Record<string, unknown>, args[parameter.name], `args.${parameter.name}`);
  }
  return args as { [key: string]: JsonValue };
}

/** Visit definition nodes in tree order, retaining the owning control and branch. */
export function walkNodes(definition: WorkflowDefinition, visitor: (node: DefinitionNode, context: DefinitionWalkContext) => void): void {
  function visit(steps: DefinitionNode[], context: DefinitionWalkContext): void {
    for (const node of steps) {
      visitor(node, context);
      if (node.type === "choice") { for (const branch of node.cases) visit(branch.steps, { parentId: node.id, branchId: branch.id }); visit(node.default, { parentId: node.id, branchId: "default" }); }
      else if (node.type === "parallel") for (const branch of node.branches) visit(branch.steps, { parentId: node.id, branchId: branch.id });
      else if (node.type === "map" || node.type === "repeat") visit(node.steps, { parentId: node.id, branchId: "body" });
      else if (node.type === "try") { visit(node.steps, { parentId: node.id, branchId: "try" }); if (node.catch) visit(node.catch, { parentId: node.id, branchId: "catch" }); if (node.finally) visit(node.finally, { parentId: node.id, branchId: "finally" }); }
    }
  }
  visit(definition.steps, {});
}

function executionError(message: string): never { throw new ExpressionEvaluationError(message); }
/** Evaluate JSON expressions without JavaScript coercion, global access or side effects. */
export function evaluateExpression(input: Expression, environment: ExpressionEnvironment): JsonValue {
  const expression = cloneJson(input, "expression");
  const env = cloneJson(environment, "environment", 32 * 1024 * 1024);
  let evaluations = 0;
  function boolean(value: JsonValue): boolean { if (typeof value !== "boolean") executionError("Boolean operator requires boolean operands"); return value; }
  function number(value: JsonValue): number { if (typeof value !== "number") executionError("Arithmetic operator requires number operands"); return value; }
  function own(value: JsonValue, key: JsonValue): JsonValue {
    if (typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0)) executionError("get requires a string key or nonnegative integer index");
    const name = `${key}`;
    if (forbiddenKeys.has(name)) executionError("Prototype property access is forbidden");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, name)) executionError("Referenced JSON property is missing");
    return (value as { [key: string]: JsonValue })[name]!;
  }
  function evaluate(value: JsonValue, depth: number): JsonValue {
    if (++evaluations > DEFINITION_LIMITS.expressionValues || depth > DEFINITION_LIMITS.expressionDepth) executionError("Expression evaluation limit exceeded");
    if (Array.isArray(value)) return value.map(part => evaluate(part, depth + 1));
    if (value === null || typeof value !== "object") return value;
    if (Object.hasOwn(value, "literal")) { if (Object.keys(value).length !== 1) executionError("literal accepts no sibling fields"); return value.literal!; }
    if (Object.hasOwn(value, "ref")) {
      if (Object.keys(value).length !== 1) executionError("ref accepts no sibling fields");
      const parts = referenceParts(value.ref, "expression.ref");
      return parts.reduce<JsonValue>((current, part) => own(current, part), env);
    }
    if (!Object.hasOwn(value, "op")) return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, evaluate(part, depth + 1)]));
    if (Object.keys(value).some(key => !["op", "args"].includes(key)) || !Array.isArray(value.args) || !operators.has(value.op as ExpressionOperator)) executionError("Malformed expression operator");
    const op = value.op as ExpressionOperator;
    const args = value.args as JsonValue[];
    const unary = op === "not" || op === "length";
    const binary = ["eq", "ne", "lt", "lte", "gt", "gte", "sub", "div", "get"].includes(op);
    if ((unary && args.length !== 1) || (binary && args.length !== 2) || (!unary && !binary && !args.length)) executionError("Invalid expression argument count");
    if (op === "and") return args.every(part => boolean(evaluate(part, depth + 1)));
    if (op === "or") return args.some(part => boolean(evaluate(part, depth + 1)));
    if (op === "coalesce") { for (const part of args) { const result = evaluate(part, depth + 1); if (result !== null) return result; } return null; }
    const values = args.map(part => evaluate(part, depth + 1));
    const first = values[0]!; const second = values[1]!;
    switch (op) {
      case "eq": return canonicalJson(first) === canonicalJson(second);
      case "ne": return canonicalJson(first) !== canonicalJson(second);
      case "not": return !boolean(first);
      case "lt": case "lte": case "gt": case "gte": {
        if ((typeof first !== "number" && typeof first !== "string") || typeof first !== typeof second) executionError("Comparison requires two numbers or two strings");
        return op === "lt" ? first < (second as typeof first) : op === "lte" ? first <= (second as typeof first) : op === "gt" ? first > (second as typeof first) : first >= (second as typeof first);
      }
      case "add": { const result = values.reduce<number>((sum, part) => sum + number(part), 0); if (!Number.isFinite(result)) executionError("Arithmetic result is not finite"); return result; }
      case "sub": case "mul": case "div": {
        const result = op === "sub" ? number(first) - number(second) : op === "div" ? number(first) / number(second) : values.reduce<number>((product, part) => product * number(part), 1);
        if (!Number.isFinite(result)) executionError("Arithmetic result is not finite");
        return result;
      }
      case "concat":
        if (values.every(part => typeof part === "string")) { if ((values as string[]).reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0) > DEFINITION_LIMITS.bytes) executionError("Concatenation byte limit exceeded"); return (values as string[]).join(""); }
        else if (values.every(Array.isArray)) { if ((values as JsonValue[][]).reduce((total, part) => total + part.length, 0) > DEFINITION_LIMITS.expressionValues) executionError("Concatenation item limit exceeded"); return (values as JsonValue[][]).flat(); }
        else executionError("concat requires all strings or all arrays");
      case "get": return own(first, second);
      case "length": if (typeof first === "string" || Array.isArray(first)) return first.length; else executionError("length requires a string or an array");
    }
    return executionError("Unsupported expression operator");
  }
  return cloneJson(evaluate(expression, 0));
}
export const evaluateValue = evaluateExpression;

const defaultLabels: Record<DefinitionNode["type"], string> = { agent: "AI 任务", command: "执行命令", transform: "转换数据", wait: "等待输入", subflow: "子工作流", expand: "动态展开", choice: "选择分支", parallel: "并行任务", map: "遍历集合", repeat: "循环", try: "异常处理" };

/** Compile execution structure into a lossless plan. Synthetic joins have no independent work. */
export function compileDefinition(input: unknown): CompiledDefinition {
  const definition = validateDefinition(input);
  const plan: DefinitionPlan = { version: 1, nodes: [], edges: [] };
  let edgeSequence = 0;
  function edge(from: string, to: string, kind: DefinitionPlanEdge["kind"], branchId?: string): void {
    plan.edges.push({ id: `edge:${++edgeSequence}`, from, to, kind, ...(branchId === undefined ? {} : { branchId }) });
  }
  function sequence(steps: DefinitionNode[], context: DefinitionWalkContext): { entry?: string; exit?: string } {
    let entry: string | undefined; let previous: string | undefined;
    for (const node of steps) {
      plan.nodes.push({ id: node.id, type: node.type, label: node.label ?? defaultLabels[node.type], ...context });
      entry ??= node.id;
      if (previous) edge(previous, node.id, "sequence");
      previous = node.id;
      if (!["choice", "parallel", "map", "repeat", "try", "subflow", "expand"].includes(node.type)) continue;
      const joinId = `$join:${node.id}`;
      plan.nodes.push({ id: joinId, type: "join", label: "汇合", parentId: node.id });
      const branch = (steps: DefinitionNode[], kind: DefinitionPlanEdge["kind"], branchId: string, from = node.id, to = joinId): void => {
        const nested = sequence(steps, { parentId: node.id, branchId });
        edge(from, nested.entry ?? to, kind, branchId);
        if (nested.exit) edge(nested.exit, to, kind === "body" ? "repeat" : "join", branchId);
      };
      if (node.type === "choice") { for (const item of node.cases) branch(item.steps, "case", item.id); branch(node.default, "default", "default"); }
      else if (node.type === "parallel") for (const item of node.branches) branch(item.steps, "branch", item.id);
      else if (node.type === "map" || node.type === "repeat") { branch(node.steps, "body", "body", node.id, node.id); edge(node.id, joinId, "exit"); }
      else if (node.type === "try") {
        const final = node.finally ? sequence(node.finally, { parentId: node.id, branchId: "finally" }) : {};
        const body = sequence(node.steps, { parentId: node.id, branchId: "try" });
        edge(node.id, body.entry ?? final.entry ?? joinId, "body", "try");
        if (body.exit) edge(body.exit, final.entry ?? joinId, final.entry ? "finally" : "join", "try");
        if (node.catch) branch(node.catch, "catch", "catch", node.id, final.entry ?? joinId);
        if (final.exit) edge(final.exit, joinId, "join", "finally");
      }
      else if (node.type === "subflow" || node.type === "expand") edge(node.id, joinId, "exit");
      previous = joinId;
    }
    return { ...(entry ? { entry } : {}), ...(previous ? { exit: previous } : {}) };
  }
  sequence(definition.steps, {});
  const hash = createHash("sha256").update(canonicalJson(definition as unknown as JsonValue)).digest("hex");
  return { definition, hash, plan };
}
