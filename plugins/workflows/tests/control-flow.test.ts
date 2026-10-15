import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeControlFlow, compileControlFlow } from "../src/control-flow.ts";
import type { FlowBlock } from "../src/control-flow.ts";
import { validateScript } from "../src/script.ts";

const script = (body: string): string => `export const meta={name:"flow-test",description:"Flow observations"};\n${body}`;
function flatten(blocks: FlowBlock[]): FlowBlock[] { return blocks.flatMap(block => [block, ...flatten(block.yes ?? []), ...flatten(block.no ?? []), ...flatten(block.body ?? [])]); }

test("the bounded plan distinguishes conditions, real parallel calls and monotonic loops", () => {
  const source = script(`
    if (args.update) await operation("update"); else await agent("inspect", {label:"检查当前代码"});
    for (let index=0; index<3; index++) {
      const okay = await agent("verify", {label:"验证"});
      if (okay) break;
    }
    await parallel([() => agent("one", {label:"检查一"}), async () => agent("two", {label:"检查二"})]);
  `);
  const plan = validateScript(source).flowPlan;
  assert.equal(plan.version, 1);
  assert.equal(plan.truncated, false);
  assert.deepEqual(plan.blocks.map(block => block.kind), ["condition", "loop", "parallel"]);
  assert.equal(plan.blocks[0]!.yes![0]!.label, "update");
  assert.equal(plan.blocks[0]!.no![0]!.label, "检查当前代码");
  assert.equal(plan.blocks[1]!.maxIterations, 3);
  assert.deepEqual(plan.blocks[2]!.body!.map(block => block.label), ["检查一", "检查二"]);
  assert.deepEqual(validateScript(source).flowPlan, plan);
  assert.equal(new Set(flatten(plan.blocks).map(block => block.id)).size, flatten(plan.blocks).length);
});

test("source expressions, dynamic options and aliases never become display labels or invented dependencies", () => {
  const source = script(`
    const invoke=agent;
    if(args.privateSecret === "DO_NOT_DISPLAY") await invoke("secret");
    await agent("another secret", {label:args.privateSecret});
    await agent("safe", {label:"old", ...args.options});
    function dynamic() { return agent("inside"); }
    return dynamic();
  `);
  const plan = validateScript(source).flowPlan;
  assert.ok(plan.warnings.length);
  assert.equal(JSON.stringify(plan).includes("DO_NOT_DISPLAY"), false);
  assert.equal(JSON.stringify(plan).includes("privateSecret"), false);
  assert.equal(JSON.stringify(plan).includes("another secret"), false);
  assert.ok(flatten(plan.blocks).some(block => block.kind === "opaque"));
  assert.deepEqual(flatten(plan.blocks).filter(block => block.kind === "task").map(block => block.label), ["AI 任务", "AI 任务"]);
});

test("unreliable loop bounds remain unknown and helpers avoid legitimate identifier collisions", () => {
  for (const body of [
    'for(let i=0;i<args.limit;i++) await agent("x");',
    'for(let i=0;i<3;i++) { i--; await agent("x"); }',
    'for(let i=0;i<3;i++) { for(i of args.values) {} await agent("x"); }',
    'while(args.ok) await agent("x");',
    'for(const value of args.values) await agent("x");',
  ]) assert.equal(validateScript(script(body)).flowPlan.blocks[0]!.maxIterations, undefined);
  const source = script('const __workflowFlow = 1; const __workflowFlow_ = 2; if (args.ok) return __workflowFlow + __workflowFlow_;');
  const compiled = compileControlFlow(source, source.indexOf("\n") + 1);
  assert.equal(compiled.helperName, "__workflowFlow1");
});

test("dynamic code and recognizable function reflection keep the original body without a helper binding", () => {
  for (const body of [
    'if(true) return eval(args.code);',
    'const F=Function; return new F(args.code)();',
    'function sample(){if(true)return 1;} return sample.toString();',
    'const fn=()=>1; return Function.prototype["toString"].call(fn);',
    'const fn=()=>1; return String(fn);',
  ]) {
    const source=script(body);
    const validated=validateScript(source);
    const compiled=compileControlFlow(source,source.length-validated.body.length);
    assert.equal(compiled.body,validated.body);
    assert.equal(compiled.helperName,"");
    assert.deepEqual(compiled.plan.blocks.map(block=>block.kind),["opaque"]);
    assert.match(compiled.plan.warnings.join(" "),/源码反射/);
  }
});

test("terminal branches retain preceding tasks and do not invent a merge or unreachable successor", () => {
  const plan=validateScript(script('if(args.early) return await agent("early",{label:"提前返回"}); await agent("continue"); return 1; await agent("unreachable");')).flowPlan;
  assert.equal(plan.blocks[0]!.kind,"condition");
  assert.deepEqual(plan.blocks[0]!.yes!.map(block=>block.kind),["task","opaque"]);
  assert.equal(plan.blocks[0]!.yes![1]!.terminal,"return");
  assert.equal(plan.blocks[2]!.terminal,"return");
  assert.equal(flatten(plan.blocks).filter(block=>block.kind==="task").length,2);
  const opaque=validateScript(script('function dynamic(){if(true)return agent("inside");} return dynamic();')).flowPlan;
  assert.equal(flatten(opaque.blocks).some(block=>block.kind==="condition"),false);
});

test("short circuit assignments and destructuring defaults stay visibly uncertain", () => {
  const source=script('let ready=true; ready ||= await agent("not necessarily dispatched"); const {value=await agent("default")} = await agent("source");');
  const plan=validateScript(source).flowPlan;
  assert.deepEqual(plan.blocks.map(block=>block.kind),["opaque","task","opaque"]);
  assert.ok(plan.warnings.length);
});

test("plan size and label length are bounded without discarding executable source", () => {
  const body = Array.from({length:250}, (_,index) => `await agent("${index}", {label:${JSON.stringify("x".repeat(100))}});`).join("\n");
  const source = script(body);
  const validated = validateScript(source);
  assert.equal(validated.flowPlan.truncated, true);
  assert.equal(flatten(validated.flowPlan.blocks).length, 200);
  assert.ok(flatten(validated.flowPlan.blocks).every(block => block.label.length <= 80));
  assert.ok(validated.body.includes('agent("249"'));
  const depth = analyzeControlFlow("if(true){".repeat(20) + 'agent("deep")' + "}".repeat(20));
  assert.equal(depth.truncated, true);
  assert.ok(flatten(depth.blocks).length <= 200);
});

test("shadowed task names are represented conservatively and never rewritten as builtin calls", () => {
  for (const body of [
    'const agent = x => x; return agent("local");',
    'function run(agent) { return agent("local"); } return run(x=>x);',
    'const {agent} = args; return agent("local");',
    'try { throw x => x; } catch (operation) { return operation("local"); }',
    'const C=class agent { static run(){ return agent("local"); } }; return C;',
  ]) {
    const source = script(body);
    const validated = validateScript(source);
    assert.equal(flatten(validated.flowPlan.blocks).some(block => block.kind === "task"), false);
    const compiled = compileControlFlow(source, source.length - validated.body.length);
    assert.equal(compiled.body.includes(`${compiled.helperName}.call`), false);
  }
});

test("explicit adjacent flow-label comments name conditions and loops without exposing tests", () => {
  const source=script(`// @flow-label: 远端有新提交？
    if(args.privateToken === "secret") await operation("update");
    // @flow-label: 验证与修复
    for(let i=0;i<3;i++) await agent("check");
    // ordinary business comment is not a display label
    while(false) await agent("never");`);
  const plan=validateScript(source).flowPlan;
  assert.deepEqual(plan.blocks.map(block=>block.label),["远端有新提交？","验证与修复","循环"]);
  assert.equal(JSON.stringify(plan).includes("privateToken"),false);
  assert.equal(JSON.stringify(plan).includes("secret"),false);
});

test("flow-label comments are bounded, cleaned and must immediately precede the statement", () => {
  const source=script(`// @flow-label: ${"x".repeat(100)}\u0001
    if(true) {}
    // @flow-label: detached
    // another comment
    for(;;) break;
    // @flow-label: same-line statements are not marked
    const unrelated=1; while(false) {}
    // @flow-label: clean\u202e label
    if(false) {}`);
  const plan=validateScript(source).flowPlan;
  assert.equal(plan.blocks[0]!.label.length,80);
  assert.deepEqual(plan.blocks.slice(1).map(block=>block.label),["循环","循环","clean  label"]);
  assert.ok(flatten(plan.blocks).every(block=>!/\u0001|\u202e/.test(block.label)));
});

test("long strings and comments cannot inflate the lexical helper name while real collisions remain safe", () => {
  const longName=`__workflowFlow${"_".repeat(1024)}`;
  const source=script(`const text=${JSON.stringify(longName)}; // ${longName}\nconst __workflowFlow=1; const __workflowFlow1=2; if(true) return text.length+__workflowFlow+__workflowFlow1;`);
  const compiled=compileControlFlow(source,source.indexOf("\n")+1);
  assert.equal(compiled.helperName,"__workflowFlow2");
  assert.ok(compiled.helperName.length < 32);
  const run=new Function(compiled.helperName,`return (async()=>{${compiled.body}})();`);
  return run({condition:(_id:string,value:unknown)=>value}).then((value:unknown)=>{assert.equal(value,longName.length+3);});
});

test("labeled terminals preserve their explicit target without assuming the nearest loop", () => {
  const plan=validateScript(script('outer: for(let i=0;i<3;i++) { for(let j=0;j<3;j++) { if(j) continue outer; break outer; } }')).flowPlan;
  const terminals=flatten(plan.blocks).filter(block=>block.terminal);
  assert.deepEqual(terminals.map(block=>[block.terminal,block.terminalLabel]),[["continue","outer"],["break","outer"]]);
});
