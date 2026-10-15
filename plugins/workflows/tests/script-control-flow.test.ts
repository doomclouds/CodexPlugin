import assert from "node:assert/strict";
import { test } from "node:test";
import { executeScript, validateScript } from "../src/script.ts";
import type { ScriptHooks } from "../src/script.ts";
import type { FlowCall, FlowEvent } from "../src/control-flow.ts";

const script = (body: string): string => `export const meta={name:"flow-runtime",description:"Actual control flow"};\n${body}`;
async function run(body: string, args: unknown = {}, custom: Partial<ScriptHooks> = {}): Promise<{result:unknown; events:FlowEvent[]; calls:Array<{prompt:string;options:Record<string,unknown>;call?:FlowCall}>}> {
  const events: FlowEvent[] = [];
  const calls: Array<{prompt:string;options:Record<string,unknown>;call?:FlowCall}> = [];
  const result = await executeScript(script(body), args, {
    agent: async (prompt, options, _signal, call) => { calls.push({prompt,options,call}); return prompt; },
    phase() {}, log() {}, flow: event => { events.push(event); }, ...custom,
  }, new AbortController().signal, {timeoutMs:5000});
  return {result,events,calls};
}

test("if and ternary observations evaluate asynchronous tests once and preserve truthy original values", async () => {
  const body = `let count=0; const test=async()=>{count++; return {value:7};};
    let result; if(await test()) result="yes"; else result="no";
    const other = (count++, 0) ? await agent("wrong") : await agent("right", {label:"Selected"});
    return {count,result,other};`;
  const {result,events,calls} = await run(body);
  assert.deepEqual(result,{count:2,result:"yes",other:"right"});
  assert.deepEqual(events.filter(event=>event.kind==="condition").map(event=>event.value),[true,false]);
  assert.deepEqual(calls.map(call=>call.prompt),["right"]);
  assert.deepEqual(calls[0]!.options,{label:"Selected"});
  assert.match(calls[0]!.call!.nodeId,/^flow_task_/);
  assert.ok(JSON.stringify(validateScript(script(body)).flowPlan).includes(calls[0]!.call!.nodeId));
});

test("labels, continue, break, finally and nested loop reentry retain their business ordering", async () => {
  const body = `const steps=[]; outer: for(let i=0;i<3;i++) {
    for(let j=0;j<3;j++) { try { if(j===1) continue outer; steps.push(i+":"+j); } finally {steps.push("f"+i+j);} }
  }
  let n=0; do { n++; if(n<2) continue; break; } while(n<10);
  return {steps,n};`;
  const {result,events} = await run(body);
  assert.deepEqual(result,{steps:["0:0","f00","f01","1:0","f10","f11","2:0","f20","f21"],n:2});
  const iterations = events.filter(event=>event.kind==="iteration");
  const byNode = new Map<string,number[]>();
  for(const event of iterations) { const values=byNode.get(event.nodeId)??[]; values.push(event.iteration); byNode.set(event.nodeId,values); }
  assert.deepEqual([...byNode.values()],[[1,2,3],[1,2,1,2,1,2],[1,2]]);
});

test("for-of iterator return and exceptions are preserved without fictional loop exit events", async () => {
  const body = `const events=[]; const values={ [Symbol.iterator]() { let i=0; return {next(){events.push("next");return {value:++i,done:false};},return(){events.push("return"); return {done:true};}};} };
    for(const value of values) {events.push(value); if(value===2) break;}
    while(false) await agent("never"); for(const value of []) await agent("empty");
    try { if((events.push("throw"), (()=>{throw new Error("expected");})())) events.push("bad"); } catch(error){events.push(error.message);}
    return events;`;
  const {result,events,calls} = await run(body);
  assert.deepEqual(result,["next",1,"next",2,"return","throw","expected"]);
  assert.deepEqual(events.filter(event=>event.kind==="iteration").map(event=>event.iteration),[1,2]);
  assert.deepEqual(events.filter(event=>event.kind==="condition").map(event=>event.value),[false,true]);
  assert.equal(calls.length,0);
});

test("spread and ignored extra arguments preserve evaluation and never contaminate agent options", async () => {
  const {result,calls} = await run(`const order=[]; const values=()=>{order.push("args");return ["work",{label:"Task"},order.push("extra")];};
    const result=await agent(...values()); return {result,order};`);
  assert.deepEqual(result,{result:"work",order:["args","extra"]});
  assert.deepEqual(calls[0]!.options,{label:"Task"});
  assert.deepEqual(Object.keys(calls[0]!.call!),["nodeId"]);
});

test("legitimate task-name shadowing, aliases and helper identifiers retain original semantics", async () => {
  for (const body of [
    'const agent=x=>"local:"+x; return agent("x");',
    'function use(operation){return operation("x");} return use(x=>"local:"+x);',
    'const __workflowFlow=1; const __workflowFlow_=2; if(true) return "local:"+(__workflowFlow+__workflowFlow_);',
  ]) { const {result,calls}=await run(body); assert.match(String(result),/^local:/); assert.equal(calls.length,0); }
  const {calls}=await run('const invoke=agent; return await invoke("alias");');
  assert.equal(calls[0]!.call,undefined);
});

test("approved operations carry their source callsite separately from their ID", async () => {
  const seen: Array<{id:string;call?:FlowCall}> = [];
  const {result}=await run('return await operation("build");',{}, {operation:async(id,_signal,call)=>{seen.push({id,call});return {okay:true};}});
  assert.deepEqual(result,{okay:true});
  assert.equal(seen[0]!.id,"build");
  assert.match(seen[0]!.call!.nodeId,/^flow_task_/);
});

test("loop wrapping preserves dangling else, multiple labels and early return", async () => {
  const {result,events}=await run(`let total=0; if(true) outer: inner: for(let i=0;i<4;i++) {
    if(i===0) continue inner; if(i===2) break outer; total+=i;
  } else total=999;
  for(;;) if(total===1) return total; else return 100;`);
  assert.equal(result,1);
  assert.deepEqual(events.filter(event=>event.kind==="iteration").map(event=>event.iteration),[1,2,3,1]);
});

test("parallel callbacks retain real callsite identity without serializing their dispatch", async () => {
  const entered: string[] = [];
  let release!:()=>void;
  const begun = new Promise<void>(resolve=>{release=resolve;});
  const calls: Array<FlowCall|undefined> = [];
  const {result}=await run('return await parallel([()=>agent("one"),()=>agent("two")]);',{}, {
    agent:async(prompt,_options,_signal,call)=>{entered.push(prompt);calls.push(call);if(prompt==="two")release();await begun;return prompt;},
  });
  assert.deepEqual(result,["one","two"]);
  assert.deepEqual(entered,["one","two"]);
  assert.ok(calls.every(call=>!!call?.nodeId));
  assert.notEqual(calls[0]!.nodeId,calls[1]!.nodeId);
});

test("observation truncation has its own bound and cannot stop business code or exhaust RPC logs", async () => {
  const {result,events,calls}=await run('let total=0; for(let i=0;i<6000;i++) {if(i%2===0) total++;} await agent("after"); return total;');
  assert.equal(result,3000);
  assert.equal(events.length,2001);
  assert.equal(events.filter(event=>event.kind==="trace-truncated").length,1);
  assert.equal(calls[0]!.prompt,"after");
  const throwing=await run('if(true) return 5;',{}, {flow(){throw new Error("observer failed");}});
  assert.equal(throwing.result,5);
});

test("dynamic evaluation and function source reflection execute the untouched original script", async () => {
  const body='function sample(){if(true)return 1;} return sample.toString();';
  const reflected=await run(body);
  assert.equal(reflected.result,'function sample(){if(true)return 1;}');
  assert.equal(reflected.events.length,0);
  const evaluated=await run('return eval(args);','typeof __workflowFlow');
  assert.equal(evaluated.result,'undefined');
  assert.equal(evaluated.events.length,0);
});
