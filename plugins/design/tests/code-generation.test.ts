import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildCodeGenerationContext, CodeGenerationRuntime } from '../src/code-generation.ts';
import { createCodeTemplate,codeFileHash } from '../src/code-project.ts';
import type { BrowserInspection } from '../src/code-browser.ts';

// This is an explicitly controlled JSON-RPC fixture, not an inference or browser substitute in production.
const script=String.raw`#!/usr/bin/env node
const{createInterface}=require('node:readline');const{appendFileSync}=require('node:fs');const mode=MODE,record=RECORD;let counter=0,currentTurn='';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;appendFileSync(record,JSON.stringify(r)+'\n');const result=value=>send({id:r.id,result:value});
if(r.method==='initialize')result({capabilities:{}});
else if(r.method==='account/read')result({account:{type:mode==='api'?'apiKey':'chatgpt',email:'secret@example.test',token:'sk-hidden-secret'}});
else if(r.method==='config/read')result({config:{model:'fixture-model',model_provider:mode==='provider'?'private-provider':'openai',mcp_servers:{recursive:{command:'forbidden'}}}});
else if(r.method==='model/list')result({data:[{id:'fixture-model',model:'fixture-model',isDefault:true,inputModalities:mode==='no-image'?['text']:['text','image']}]});
else if(r.method==='thread/start')result({thread:{id:'code_thread'}});
else if(r.method==='turn/interrupt'){result({});send({method:'turn/completed',params:{threadId:'code_thread',turn:{id:currentTurn,status:'interrupted',items:[]}}});}
else if(r.method==='turn/start'){
 const attempt=++counter,turnId=currentTurn='code_turn_'+attempt;result({turn:{id:turnId,status:'inProgress',items:[]}});
 if(mode==='wait')return;
 if(mode==='approval'){send({id:999,method:'item/commandExecution/requestApproval',params:{token:'sk-hidden-approval'}});return;}
 if(mode==='inference-error'){send({method:'turn/completed',params:{threadId:'code_thread',turn:{id:turnId,status:'failed',items:[],error:{codexErrorInfo:'usageLimitExceeded',message:'Authorization: Bearer sk-never-display'}}}});return;}
 let files=[];
 const receivedImages=r.params.input.some(input=>input.type==='image');
 if(!receivedImages){files=[{path:'index.html',content:'<!doctype html><html><head><link rel="stylesheet" href="new.css"></head><body><h1>Real frontend proposal</h1><button onclick="this.textContent=\'Done\'">Action</button></body></html>'},{path:'new.css',content:'body{font-family:Arial;margin:24px}h1{font-size:48px}'}];}
 if(mode==='schema-repair'&&attempt===1)files=[{path:'../private.js',content:'must-not-be-written'}];
 if(mode==='compile-failure'||mode==='compile-repair'&&attempt===1)files=[{path:'index.html',content:'<!doctype html><html><body><h1>Broken</h1><script type="module">import value from "not-installed";window.value=value;</script></body></html>'}];
 const text=JSON.stringify({files,summary:receivedImages?'Reviewed the supplied screenshot fixture.':'Created editable source.'});
 const item={type:'agentMessage',id:'message_'+attempt,phase:'final_answer',text};
 setTimeout(()=>{send({method:'item/completed',params:{threadId:'code_thread',turnId,completedAtMs:Date.now(),item}});send({method:'turn/completed',params:{threadId:'code_thread',turn:{id:turnId,status:'completed',items:[item]}}});},5);
}else send({id:r.id,error:{code:-32601,message:'sk-do-not-log'}});
});`;
const fixturePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCDcAAAAASUVORK5CYII=','base64');
function inspection(width:number,height:number):BrowserInspection{return{png:fixturePng,width,height,metrics:{title:'Fixture render',textLength:30,headings:['Real frontend proposal'],controls:1,horizontalOverflow:false,overflowCandidates:[]},errors:[],blockedRequests:0};}
async function withFixture(mode:string,run:(runtime:CodeGenerationRuntime,record:string,renders:Array<{html:string;width:number;height:number}>)=>Promise<void>,options:{timeoutMs?:number;renderDelay?:number}={}):Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'design-code-generation-test-'));const command=join(directory,'fixture.cjs'),record=join(directory,'requests.jsonl');await writeFile(command,script.replace('MODE',JSON.stringify(mode)).replace('RECORD',JSON.stringify(record)));await chmod(command,0o700);
 const renders:Array<{html:string;width:number;height:number}>=[];const runtime=new CodeGenerationRuntime({command,timeoutMs:options.timeoutMs??5000,inspect:async(html,viewport)=>{renders.push({html,width:viewport.width,height:viewport.height});if(options.renderDelay)await delay(options.renderDelay);return inspection(viewport.width,viewport.height);}});
 try{await run(runtime,record,renders);}finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
}
async function completed(runtime:CodeGenerationRuntime,id:string){for(let i=0;i<800;i++){const job=runtime.get(id);if(job.status!=='running')return job;await delay(10);}throw new Error('Fixture code generation did not finish.');}
async function requests(file:string):Promise<Array<{method:string;params:any}>>{return(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}

test('independent context contains every complete comment rather than only recent or truncated feedback',()=>{
 const project=createCodeTemplate('Complete feedback','html');project.comments=Array.from({length:25},(_,index)=>({id:`comment_${index}`,file:project.entry,sourceId:`source_${index}`,text:`Feedback ${index}: `+'详细意见'.repeat(300),status:'open' as const,createdAt:project.createdAt}));
 const context=buildCodeGenerationContext(project);assert.deepEqual(context.comments,project.comments);assert.equal(context.comments.length,25);assert.ok(context.comments[0]!.text.length>500);assert.equal(context.comments[24]!.sourceId,'source_24');
});

test('complete comment context over budget is rejected before any worker can start',async()=>{
 const project=createCodeTemplate('Budgeted feedback','html');project.comments=Array.from({length:240},(_,index)=>({id:`comment_${index}`,file:project.entry,text:'x'.repeat(10_000),status:'open' as const,createdAt:project.createdAt}));
 const runtime=new CodeGenerationRuntime({command:'must-not-start-a-worker'});
 try{await assert.rejects(runtime.start({project,prompt:'Read all feedback'}),/complete comments.*exceeds 2 MiB/);}finally{await runtime.dispose();}
});

test('structured source generation compiles privately, sends actual image inputs, then verifies final code with original CAS hashes',async()=>withFixture('success',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Original project','html'),original=structuredClone(project);const job=await runtime.start({project,prompt:'Design a real responsive frontend'});assert.equal(job.status,'running');
 const result=await completed(runtime,job.id);assert.equal(result.status,'completed',result.error);assert.deepEqual(result.verification,{compiled:true,rendered:true,modelReviewed:true,viewports:2});assert.deepEqual(project,original);
 const changed=result.changes!.files!;assert.equal(changed.find(file=>file.path==='index.html')!.expectedHash,codeFileHash(original.files.find(file=>file.path==='index.html')!));assert.equal(changed.find(file=>file.path==='new.css')!.expectedHash,null);
 assert.ok(renders.length===4);assert.match(renders[0]!.html,/Real frontend proposal/);assert.match(renders[0]!.html,/font-size: 48px/);
 const calls=await requests(record),turns=calls.filter(call=>call.method==='turn/start');assert.equal(turns.length,2);assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
 assert.equal(turns[0]!.params.threadId,turns[1]!.params.threadId);const images=turns[1]!.params.input.filter((input:any)=>input.type==='image');assert.equal(images.length,2);assert.equal(images[0].url,'data:image/png;base64,'+fixturePng.toString('base64'));assert.equal(images[0].detail,'original');
 const thread=calls.find(call=>call.method==='thread/start')!.params;assert.deepEqual(thread.environments,[]);assert.deepEqual(thread.dynamicTools,[]);assert.equal(thread.sandbox,'read-only');assert.equal(thread.approvalPolicy,'never');assert.equal(thread.allowProviderModelFallback,false);assert.deepEqual(thread.config.mcp_servers,{recursive:{enabled:false,required:false}});
 assert.doesNotMatch(JSON.stringify(result),/sk-hidden|secret@example/);assert.ok(result.log.some(line=>line.includes('Rendered 2 actual viewport')));
}));

test('compiler diagnostics receive a bounded same-thread correction before screenshot review',async()=>withFixture('compile-repair',async(runtime,record)=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'completed',result.error);
 const turns=(await requests(record)).filter(call=>call.method==='turn/start');assert.equal(turns.length,3);
 const fix=JSON.parse(turns[1]!.params.input[0].text);assert.ok(fix.feedback.compileDiagnostics.length);assert.match(fix.feedback.compileDiagnostics[0].message,/Dependency is not bundled/);
 assert.equal(turns[1]!.params.input.filter((input:any)=>input.type==='image').length,0);assert.equal(turns[2]!.params.input.filter((input:any)=>input.type==='image').length,2);
}));

test('unsafe source paths are corrected only in the private proposal and never written to disk',async()=>withFixture('schema-repair',async(runtime,record)=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'completed',result.error);assert.ok(result.changes!.files!.every(file=>!file.path.includes('..')));
 const turns=(await requests(record)).filter(call=>call.method==='turn/start');assert.equal(turns.length,3);assert.match(JSON.parse(turns[1]!.params.input[0].text).feedback.schemaError,/proposal.files.0.path/);
}));

test('compiler failures exhaust at most two corrections and never return applicable changes',async()=>withFixture('compile-failure',async(runtime,record)=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.equal(result.changes,undefined);assert.match(result.error!,/Source compilation failed/);assert.equal(result.verification.compiled,false);
 assert.equal((await requests(record)).filter(call=>call.method==='turn/start').length,3);
}));

for(const mode of ['api','provider','no-image','approval','inference-error'])test(`code generation rejects ${mode} without inference fallback or permission retry`,async()=>withFixture(mode,async(runtime,record,renders)=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.equal(result.changes,undefined);assert.equal(renders.length,0);assert.doesNotMatch(JSON.stringify(result),/sk-|secret@example|Authorization|Bearer/);
 const turns=(await requests(record)).filter(call=>call.method==='turn/start');assert.equal(turns.length,['approval','inference-error'].includes(mode)?1:0);
 if(mode==='inference-error')assert.match(result.error!,/usageLimitExceeded/);if(mode==='no-image')assert.match(result.error!,/screenshot image input/);
}));

test('cancellation waits for the owned local worker and never publishes source changes',async()=>withFixture('wait',async(runtime,record)=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});
 for(let i=0;i<200;i++){try{if((await requests(record)).some(call=>call.method==='turn/start'))break;}catch{}await delay(10);}
 const cancelled=await runtime.cancel(job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.changes,undefined);
}));

test('one total timeout budget covers model and browser work',async()=>withFixture('success',async runtime=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.equal(result.changes,undefined);assert.match(result.error!,/timed out/);
},{timeoutMs:1000,renderDelay:600}));
