import { parse } from "acorn";

export interface FlowCall { nodeId: string }
export type FlowEvent =
  | { nodeId: string; kind: "condition"; value: boolean }
  | { nodeId: string; kind: "iteration"; iteration: number }
  | { nodeId: ""; kind: "trace-truncated" };
export interface FlowBlock {
  id: string;
  kind: "task" | "condition" | "loop" | "parallel" | "opaque";
  label: string;
  yes?: FlowBlock[];
  no?: FlowBlock[];
  body?: FlowBlock[];
  maxIterations?: number;
  terminal?: "return" | "throw" | "break" | "continue";
  terminalLabel?: string;
}
export interface FlowPlan { version: 1; blocks: FlowBlock[]; warnings: string[]; truncated: boolean }
export type FlowAstNode = { type: string; start: number; end: number; [key: string]: unknown };
export interface CompiledControlFlow { plan: FlowPlan; body: string; helperName: string }

const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const loops = new Set(["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
const node = (value: unknown): value is FlowAstNode => !!value && typeof value === "object" && "type" in value;
function children(value: FlowAstNode): FlowAstNode[] {
  const result: FlowAstNode[] = [];
  for (const child of Object.values(value)) {
    if (node(child)) result.push(child);
    else if (Array.isArray(child)) for (const item of child) if (node(item)) result.push(item);
  }
  return result;
}
function visit(value: FlowAstNode, callback: (value: FlowAstNode, parents: FlowAstNode[]) => void, parents: FlowAstNode[] = []): void {
  callback(value, parents);
  for (const child of children(value)) visit(child, callback, [...parents, value]);
}
function identifiers(pattern: FlowAstNode | undefined, result = new Set<string>()): Set<string> {
  if (!pattern) return result;
  if (pattern.type === "Identifier") result.add(String(pattern.name));
  else if (pattern.type === "Property") identifiers(pattern.value as FlowAstNode, result);
  else if (pattern.type === "AssignmentPattern") identifiers(pattern.left as FlowAstNode, result);
  else for (const child of children(pattern)) identifiers(child, result);
  return result;
}
function flowId(value: FlowAstNode, kind: string): string { return `flow_${kind}_${value.start.toString(36)}_${value.end.toString(36)}`; }
function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 80) : fallback;
}
function explicitLabel(source: string, value: FlowAstNode, fallback: string): string {
  const lineStart = source.lastIndexOf("\n", value.start - 1) + 1;
  if (source.slice(lineStart, value.start).trim() || lineStart === 0) return fallback;
  const previousEnd = lineStart - 1;
  const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
  const marker = /^\s*\/\/\s*@flow-label:\s*(.*?)\s*$/.exec(source.slice(previousStart, previousEnd));
  return marker ? safeLabel(marker[1], fallback) : fallback;
}
function literalLabel(call: FlowAstNode, name: string): string {
  const args = call.arguments as FlowAstNode[];
  if (name === "operation") return safeLabel(args[0]?.type === "Literal" ? args[0].value : undefined, "维护操作");
  const options = args[1];
  if (options?.type === "ObjectExpression") {
    // Computed/spread properties can replace a preceding label at execution time.
    if ((options.properties as FlowAstNode[]).some(property => property.type !== "Property" || property.computed || property.method || property.kind !== "init")) return "AI 任务";
    let label: unknown;
    for (const property of options.properties as FlowAstNode[]) {
      const key = property.key as FlowAstNode;
      if (key.name === "label" || key.value === "label") {
        const value = property.value as FlowAstNode;
        label = value.type === "Literal" ? value.value : undefined;
      }
    }
    return safeLabel(label, "AI 任务");
  }
  return "AI 任务";
}
function constantInteger(value: FlowAstNode | undefined): number | undefined {
  if (value?.type === "Literal" && Number.isSafeInteger(value.value)) return value.value as number;
  if (value?.type === "UnaryExpression" && ["+", "-"].includes(String(value.operator))) {
    const inner = constantInteger(value.argument as FlowAstNode);
    return inner === undefined ? undefined : value.operator === "-" ? -inner : inner;
  }
  return undefined;
}
function staticMaximum(loop: FlowAstNode): number | undefined {
  // A lexical counter, a literal bound and a single monotonic update are the
  // only bounds asserted here. Unknown expressions remain visibly unbounded.
  if (loop.type !== "ForStatement") return undefined;
  const init = loop.init as FlowAstNode | undefined;
  const declarations = init?.declarations as FlowAstNode[] | undefined;
  const declaration = declarations?.[0];
  const counter = declaration?.id as FlowAstNode | undefined;
  const start = constantInteger(declaration?.init as FlowAstNode | undefined);
  const test = loop.test as FlowAstNode | undefined;
  const update = loop.update as FlowAstNode | undefined;
  if (init?.type !== "VariableDeclaration" || init.kind !== "let" || declarations?.length !== 1 || counter?.type !== "Identifier" || start === undefined || test?.type !== "BinaryExpression" || (test.left as FlowAstNode)?.name !== counter.name) return undefined;
  const end = constantInteger(test.right as FlowAstNode);
  if (end === undefined || update?.type !== "UpdateExpression" || (update.argument as FlowAstNode)?.name !== counter.name || !["++", "--"].includes(String(update.operator))) return undefined;
  const ascending = update.operator === "++";
  if (!(ascending ? ["<", "<="].includes(String(test.operator)) : [">", ">="].includes(String(test.operator)))) return undefined;
  let unsafe = false;
  visit(loop.body as FlowAstNode, value => {
    if (value.type === "CallExpression" && (value.callee as FlowAstNode).type === "Identifier" && (value.callee as FlowAstNode).name === "eval") unsafe = true;
    if (value.type === "AssignmentExpression" && identifiers(value.left as FlowAstNode).has(String(counter.name))) unsafe = true;
    if (value.type === "UpdateExpression" && identifiers(value.argument as FlowAstNode).has(String(counter.name))) unsafe = true;
    if (["ForOfStatement", "ForInStatement"].includes(value.type) && identifiers(value.left as FlowAstNode).has(String(counter.name))) unsafe = true;
  });
  if (unsafe) return undefined;
  const count = Math.max(0, ascending ? end - start + (test.operator === "<=" ? 1 : 0) : start - end + (test.operator === ">=" ? 1 : 0));
  return Number.isSafeInteger(count) && count <= 10000 ? count : undefined;
}

export function compileControlFlow(source: string, bodyStart = 0, suppliedProgram?: FlowAstNode): CompiledControlFlow {
  const program = suppliedProgram ?? parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as FlowAstNode;
  const allNames = new Set<string>();
  const shadowed = new Set<string>();
  let reflective = false;
  visit(program, value => {
    if (value.type === "Identifier") allNames.add(String(value.name));
    if (value.start >= bodyStart && value.type === "Identifier" && ["eval", "Function", "globalThis"].includes(String(value.name))) reflective = true;
    if (value.start >= bodyStart && value.type === "MemberExpression") {
      const property = value.property as FlowAstNode;
      if ((!value.computed && property.name === "toString") || (value.computed && property.type === "Literal" && property.value === "toString")) reflective = true;
    }
    if (value.start >= bodyStart && value.type === "CallExpression" && (value.callee as FlowAstNode).type === "Identifier" && (value.callee as FlowAstNode).name === "String") reflective = true;
    if (value.type === "VariableDeclarator") for (const name of identifiers(value.id as FlowAstNode)) shadowed.add(name);
    if (functions.has(value.type)) {
      if (node(value.id)) shadowed.add(String(value.id.name));
      for (const parameter of value.params as FlowAstNode[]) for (const name of identifiers(parameter)) shadowed.add(name);
    }
    if (["ClassDeclaration", "ClassExpression"].includes(value.type) && node(value.id)) shadowed.add(String(value.id.name));
    if (value.type === "CatchClause") for (const name of identifiers(value.param as FlowAstNode)) shadowed.add(name);
  });
  let helperName = "__workflowFlow";
  for (let suffix = 1; allNames.has(helperName); suffix++) helperName = `__workflowFlow${suffix}`;
  const plan: FlowPlan = { version: 1, blocks: [], warnings: [], truncated: false };
  let count = 0;
  const warn = (message: string): void => { if (!plan.warnings.includes(message) && plan.warnings.length < 16) plan.warnings.push(message); };
  const make = (value: FlowAstNode, kind: FlowBlock["kind"], label: string, depth: number): FlowBlock | undefined => {
    if (count >= 200 || depth > 12) { plan.truncated = true; warn("流程结构超过展示上限；请结合实际任务查看完整执行过程。"); return undefined; }
    count++;
    return { id: flowId(value, kind), kind, label: safeLabel(label, "流程步骤") };
  };
  const opaque = (value: FlowAstNode, depth: number): FlowBlock[] => {
    warn("存在动态调用或复杂控制流；该部分仅依据实际派发任务展示，不推断完整依赖。");
    const block = make(value, "opaque", "动态步骤 · 以实际执行为准", depth);
    return block ? [block] : [];
  };
  if (reflective) {
    plan.warnings.push("存在动态代码或可识别的源码反射入口；为保持执行语义，不插入控制流观测，仅展示实际任务。");
    plan.blocks = [{ id: flowId(program, "opaque"), kind: "opaque", label: "动态执行 · 显示实际任务" }];
    return { plan, body: source.slice(bodyStart), helperName: "" };
  }
  const hasCalls = (value: FlowAstNode): boolean => { let found = false; visit(value, child => { if (child.type === "CallExpression") found = true; }); return found; };
  const sequence = (values: FlowAstNode[], depth: number): FlowBlock[] => {
    const result: FlowBlock[] = [];
    for (const value of values) {
      result.push(...extract(value, depth));
      if (["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(value.type)) break;
    }
    return result;
  };
  const extract = (value: FlowAstNode | undefined, depth: number): FlowBlock[] => {
    if (!value || value.end <= bodyStart) return [];
    if (depth > 12 || count >= 200) { if (hasCalls(value)) { plan.truncated = true; warn("流程结构超过展示上限；请结合实际任务查看完整执行过程。"); } return []; }
    if (value.type === "BlockStatement" || value.type === "Program") return sequence(value.body as FlowAstNode[], depth);
    if (["ExpressionStatement", "AwaitExpression"].includes(value.type)) return extract((value.expression ?? value.argument) as FlowAstNode | undefined, depth);
    if (["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(value.type)) {
      const terminal = ({ ReturnStatement: "return", ThrowStatement: "throw", BreakStatement: "break", ContinueStatement: "continue" } as const)[value.type as "ReturnStatement" | "ThrowStatement" | "BreakStatement" | "ContinueStatement"];
      const label = { return: "返回结果", throw: "抛出异常", break: "退出当前控制段", continue: "继续下一轮" }[terminal];
      const before = extract(value.argument as FlowAstNode | undefined, depth);
      const block = make(value, "opaque", label, depth);
      if (!block) return before;
      const labelNode = value.label as FlowAstNode | undefined;
      return [...before, { ...block, terminal, ...(labelNode?.type === "Identifier" ? { terminalLabel: safeLabel(labelNode.name, "标签") } : {}) }];
    }
    if (value.type === "VariableDeclaration") return sequence(value.declarations as FlowAstNode[], depth);
    if (value.type === "VariableDeclarator") {
      const pattern = value.id as FlowAstNode;
      return [...extract(value.init as FlowAstNode | undefined, depth), ...(hasCalls(pattern) ? opaque(pattern, depth) : [])];
    }
    if (value.type === "LabeledStatement") return extract(value.body as FlowAstNode, depth);
    if (value.type === "IfStatement" || value.type === "ConditionalExpression") {
      const condition = make(value, "condition", value.type === "IfStatement" ? explicitLabel(source, value, "条件判断") : "条件判断", depth);
      if (!condition) return [];
      condition.yes = extract(value.consequent as FlowAstNode, depth + 1);
      condition.no = extract(value.alternate as FlowAstNode | undefined, depth + 1);
      return [...extract(value.test as FlowAstNode, depth), condition];
    }
    if (loops.has(value.type)) {
      const loop = make(value, "loop", explicitLabel(source, value, value.type === "ForOfStatement" || value.type === "ForInStatement" ? "逐项循环" : "循环"), depth);
      if (!loop) return [];
      loop.body = extract(value.body as FlowAstNode, depth + 1);
      const maximum = staticMaximum(value);
      if (maximum !== undefined) loop.maxIterations = maximum;
      // Header calls can run once, every iteration or never; do not draw them
      // as an unconditional predecessor of the body.
      if ([value.init, value.test, value.update, value.left, value.right].some(item => node(item) && hasCalls(item))) warn("循环头部包含调用；请结合实际任务查看其执行次序。");
      return [loop];
    }
    if (value.type === "CallExpression") {
      const callee = value.callee as FlowAstNode;
      const name = callee.type === "Identifier" ? String(callee.name) : "";
      const args = value.arguments as FlowAstNode[];
      if (["agent", "operation"].includes(name) && !shadowed.has(name)) {
        // Argument calls may run before this task; their control flow is kept.
        const before = sequence(args, depth);
        const task = make(value, "task", literalLabel(value, name), depth);
        return task ? [...before, task] : before;
      }
      if (name === "parallel" && !shadowed.has(name) && args.length === 1 && args[0]?.type === "ArrayExpression" && (args[0].elements as Array<FlowAstNode | null>).every(item => item && functions.has(item.type) && !(item.params as FlowAstNode[]).length)) {
        const parallel = make(value, "parallel", "并行任务", depth);
        if (!parallel) return [];
        parallel.body = (args[0].elements as FlowAstNode[]).flatMap(callback => {
          const branch = extract(callback.body as FlowAstNode, depth + 1);
          if (branch.length <= 1) return branch;
          const wrapper = make(callback, "opaque", "并行分支 · 按顺序执行", depth + 1);
          return wrapper ? [{ ...wrapper, body: branch }] : [];
        });
        return [parallel];
      }
      if (["phase", "log"].includes(name) && !shadowed.has(name)) return sequence(args, depth);
      return opaque(value, depth);
    }
    if (functions.has(value.type)) {
      if (hasCalls(value.body as FlowAstNode)) warn("函数体将在调用时执行；函数内的动态步骤依据实际派发任务展示。");
      return [];
    }
    if (["Literal", "Identifier", "ThisExpression", "EmptyStatement", "BreakStatement", "ContinueStatement", "DebuggerStatement"].includes(value.type)) return [];
    if (value.type === "AssignmentExpression") {
      if (["&&=", "||=", "??="].includes(String(value.operator))) return opaque(value, depth);
      const left = value.left as FlowAstNode;
      if (["ArrayPattern", "ObjectPattern"].includes(left.type)) return [...extract(value.right as FlowAstNode, depth), ...(hasCalls(left) ? opaque(left, depth) : [])];
      return sequence(children(value), depth);
    }
    if (["NewExpression", "TaggedTemplateExpression", "ChainExpression"].includes(value.type)) return opaque(value, depth);
    if (["ArrayExpression", "ObjectExpression", "Property", "UnaryExpression", "BinaryExpression", "MemberExpression", "SequenceExpression", "UpdateExpression", "TemplateLiteral", "TemplateElement", "SpreadElement"].includes(value.type)) return sequence(children(value), depth);
    if (hasCalls(value)) return opaque(value, depth);
    return [];
  };
  plan.blocks = extract(program, 0);
  const observed = new Set<string>();
  const collect = (blocks: FlowBlock[]): void => { for (const block of blocks) { observed.add(block.id); collect(block.yes ?? []); collect(block.no ?? []); collect(block.body ?? []); } };
  collect(plan.blocks);

  type Edit = { at: number; text: string; order: number; span: number };
  const edits: Edit[] = [];
  const wrap = (value: FlowAstNode, before: string, after: string, order: number): void => {
    edits.push({ at: value.start, text: before, order, span: value.end - value.start });
    edits.push({ at: value.end, text: after, order: -order, span: -(value.end - value.start) });
  };
  visit(program, (value, parents) => {
    if (value.start < bodyStart) return;
    if (value.type === "CallExpression") {
      const callee = value.callee as FlowAstNode;
      const name = callee.type === "Identifier" ? String(callee.name) : "";
      if (["agent", "operation"].includes(name) && !shadowed.has(name)) {
        // Wrapping the callee preserves argument evaluation, spreads, optional
        // calls and ignored extra arguments without exposing metadata options.
        wrap(callee, `${helperName}.call(${JSON.stringify(flowId(value, "task"))},`, `,${JSON.stringify(name)})`, 20);
      }
    }
    if ((value.type === "IfStatement" || value.type === "ConditionalExpression") && observed.has(flowId(value, "condition"))) {
      const test = value.test as FlowAstNode;
      wrap(test, `${helperName}.condition(${JSON.stringify(flowId(value, "condition"))},(`, "))", 10);
    }
    if (loops.has(value.type) && observed.has(flowId(value, "loop"))) {
      const id = JSON.stringify(flowId(value, "loop"));
      let outer = value;
      for (let index = parents.length - 1; index >= 0 && parents[index]?.type === "LabeledStatement"; index--) outer = parents[index]!;
      wrap(outer, `{${helperName}.reset(${id});`, "}", 5);
      const body = value.body as FlowAstNode;
      if (body.type === "BlockStatement") edits.push({ at: body.start + 1, text: `${helperName}.iteration(${id});`, order: 0, span: 0 });
      else wrap(body, `{${helperName}.iteration(${id});`, "}", 15);
    }
  });
  // At shared boundaries closing wrappers precede opening wrappers; nested
  // openings are outer-first and closings inner-first.
  edits.sort((a, b) => a.at - b.at || (a.span < 0 ? -1 : 1) - (b.span < 0 ? -1 : 1) || (a.span >= 0 ? b.span - a.span : b.span - a.span) || a.order - b.order);
  let result = "";
  let position = bodyStart;
  for (const edit of edits) {
    result += source.slice(position, edit.at) + edit.text;
    position = edit.at;
  }
  result += source.slice(position);
  return { plan, body: result, helperName: edits.length ? helperName : "" };
}

export function analyzeControlFlow(source: string, bodyStart = 0, program?: FlowAstNode): FlowPlan {
  return compileControlFlow(source, bodyStart, program).plan;
}
