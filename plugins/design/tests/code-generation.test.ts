import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,readFile,rm,readdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCodeGenerationContext, CodeGenerationRuntime } from '../src/code-generation.ts';
import type { CodeGenerationJob, CodeGenerationOptions } from '../src/code-generation.ts';
import { createCodeTemplate,codeFileHash } from '../src/code-project.ts';
import type { BrowserInspection } from '../src/code-browser.ts';
import { DESIGN_REFERENCE_VERSION, loadDesignReference } from '../src/design-references.ts';

// This is an explicitly controlled JSON-RPC fixture, not an inference or browser substitute in production.
const script=String.raw`#!/usr/bin/env node
const{createInterface}=require('node:readline');const{appendFileSync}=require('node:fs');const mode=MODE,record=RECORD;let counter=0,currentTurn='';
const phase=name=>appendFileSync(record+'.stages',JSON.stringify({phase:name,atMs:Date.now()})+'\n');phase('process-started');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;appendFileSync(record,JSON.stringify({...r,observedAtMs:Date.now()})+'\n');const result=value=>send({id:r.id,result:value});
if(r.method==='initialize'){if(mode!=='initialize-wait')result({capabilities:{}});}
else if(r.method==='account/read')result({account:{type:mode==='api'?'apiKey':'chatgpt',email:mode==='no-identity'?null:mode==='different-account'?'another@example.test':'secret@example.test',token:'sk-hidden-secret'}});
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
 const inputPayload=JSON.parse(r.params.input[0].text);const receivedImages=inputPayload.workImageInputs?.length>0;
 if(receivedImages)phase('review-images-received');
 if((mode==='review-failure'||mode==='no-identity')&&receivedImages){send({method:'turn/completed',params:{threadId:'code_thread',turn:{id:turnId,status:'failed',items:[],error:{codexErrorInfo:'fixtureReviewFailed'}}}});return;}
 if(mode==='review-wait'&&receivedImages)return;
 if(!receivedImages){files=[{path:'index.html',content:'<!doctype html><html><head><link rel="stylesheet" href="new.css"></head><body><h1>Real frontend proposal</h1><button onclick="this.textContent=\'Done\'">Action</button></body></html>'},{path:'new.css',content:'body{font-family:Arial;margin:24px}h1{font-size:48px}'}];}
 if(mode==='schema-repair'&&attempt===1)files=[{path:'../private.js',content:'must-not-be-written'}];
 if(mode==='compile-failure'||mode==='compile-repair'&&attempt===1)files=[{path:'index.html',content:'<!doctype html><html><body><h1>Broken</h1><script type="module">import value from "not-installed";window.value=value;</script></body></html>'}];
 if(mode==='review-mutate'&&receivedImages&&attempt===2)files=[{path:'new.css',content:'body{font-family:Arial;margin:24px}h1{font-size:52px}'}];
 const text=JSON.stringify({files,summary:receivedImages?'Reviewed the supplied screenshot fixture.':'Created editable source.'});
 const item={type:'agentMessage',id:'message_'+attempt,phase:'final_answer',text};
 setTimeout(()=>{phase(receivedImages?'review-answer-sent':'source-proposal-sent');send({method:'item/completed',params:{threadId:'code_thread',turnId,completedAtMs:Date.now(),item}});send({method:'turn/completed',params:{threadId:'code_thread',turn:{id:turnId,status:'completed',items:[item]}}});},5);
}else send({id:r.id,error:{code:-32601,message:'sk-do-not-log'}});
});`;
const fixturePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCDcAAAAASUVORK5CYII=','base64');
function inspection(width:number,height:number):BrowserInspection{return{png:fixturePng,width,height,metrics:{title:'Fixture render',textLength:30,headings:['Real frontend proposal'],controls:1,horizontalOverflow:false,overflowCandidates:[]},errors:[],blockedRequests:0};}
interface FixtureRender {html:string;width:number;height:number;startedAtMs:number;finishedAtMs?:number}
interface RenderGate {release:()=>void}
interface FixtureControl {checkpointDir:string;setMode:(mode:string)=>Promise<void>;createRuntime:(options?:Partial<CodeGenerationOptions>)=>CodeGenerationRuntime;holdNextRender:()=>RenderGate}
const fixtureEvidence=new WeakMap<CodeGenerationRuntime,{record:string;renders:FixtureRender[]}>();
async function withFixture(mode:string,run:(runtime:CodeGenerationRuntime,record:string,renders:FixtureRender[],control:FixtureControl)=>Promise<void>,options:{timeoutMs?:number;renderDelay?:number;checkpointTtlMs?:number;maxCheckpoints?:number;maxCheckpointBytes?:number}={}):Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'design-code-generation-test-'));const command=join(directory,'fixture.cjs'),record=join(directory,'requests.jsonl');await writeFile(command,script.replace('MODE',JSON.stringify(mode)).replace('RECORD',JSON.stringify(record)));await chmod(command,0o700);
 const checkpointDir=join(directory,'private-drafts'),runtimes:CodeGenerationRuntime[]=[],renders:FixtureRender[]=[];const gates:Array<{release:()=>void;promise:Promise<void>;claimed:boolean}>=[];
 const createRuntime=(overrides:Partial<CodeGenerationOptions>={}):CodeGenerationRuntime=>{const value=new CodeGenerationRuntime({command,...options,timeoutMs:options.timeoutMs??5000,checkpointDir,inspect:async(html,viewport)=>{const render:FixtureRender={html,width:viewport.width,height:viewport.height,startedAtMs:Date.now()};renders.push(render);const gate=gates.find(item=>!item.claimed);if(gate){gate.claimed=true;await gate.promise;}if(options.renderDelay)await delay(options.renderDelay);render.finishedAtMs=Date.now();return inspection(viewport.width,viewport.height);},...overrides});runtimes.push(value);fixtureEvidence.set(value,{record,renders});return value;};
 const runtime=createRuntime();const control:FixtureControl={checkpointDir,createRuntime,holdNextRender:()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});gates.push({release,promise,claimed:false});return{release};},setMode:async next=>{await writeFile(command,script.replace('MODE',JSON.stringify(next)).replace('RECORD',JSON.stringify(record)));}};
 try{await run(runtime,record,renders,control);}finally{for(const gate of gates)gate.release();await Promise.all(runtimes.map(value=>value.dispose()));await rm(directory,{recursive:true,force:true});}
}
async function diagnostic(runtime:CodeGenerationRuntime,id:string){const job=runtime.get(id),evidence=fixtureEvidence.get(runtime);const calls=evidence?await requests(evidence.record).catch(()=>[]):[];const stages=evidence?await readFile(evidence.record+'.stages','utf8').then(value=>value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))).catch(()=>[]):[];return JSON.stringify({status:job.status,error:job.error,budgetMs:job.budgetMs,verification:job.verification,draftStage:job.draft?.stage,log:job.log.slice(-5),fixtureStages:stages,methods:calls.map(call=>({method:call.method,atMs:call.observedAtMs,images:call.method==='turn/start'&&call.params.input.some((input:any)=>input.type==='image')})),renders:evidence?.renders.map(({startedAtMs,finishedAtMs,width,height})=>({startedAtMs,finishedAtMs,width,height}))});}
async function waitForJobStage(runtime:CodeGenerationRuntime,id:string,predicate:(job:CodeGenerationJob)=>boolean|Promise<boolean>,description:string){const initial=runtime.get(id);const deadline=Math.min(Date.parse(initial.createdAt)+initial.budgetMs+5000,Date.now()+10000);while(true){const job=runtime.get(id);if(await predicate(job))return job;if(job.status!=='running')throw new Error(`Fixture stopped before ${description}: ${await diagnostic(runtime,id)}`);if(Date.now()>=deadline)throw new Error(`Fixture did not reach ${description} within its observation/cleanup bound: ${await diagnostic(runtime,id)}`);await delay(10);}}
async function completed(runtime:CodeGenerationRuntime,id:string){return waitForJobStage(runtime,id,job=>job.status!=='running','terminal status');}
async function requests(file:string):Promise<Array<{method:string;params:any;observedAtMs:number}>>{return(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}

test('independent context contains every complete comment rather than only recent or truncated feedback',()=>{
 const project=createCodeTemplate('Complete feedback','html');project.comments=Array.from({length:25},(_,index)=>({id:`comment_${index}`,file:project.pages[0]!.entry,sourceId:`source_${index}`,text:`Feedback ${index}: `+'详细意见'.repeat(300),status:'open' as const,createdAt:project.createdAt}));
 const context=buildCodeGenerationContext(project);assert.deepEqual(context.comments,project.comments);assert.equal(context.comments.length,25);assert.ok(context.comments[0]!.text.length>500);assert.equal(context.comments[24]!.sourceId,'source_24');
});

test('complete comment context over budget is rejected before any worker can start',async()=>{
 const project=createCodeTemplate('Budgeted feedback','html');project.comments=Array.from({length:240},(_,index)=>({id:`comment_${index}`,file:project.pages[0]!.entry,text:'x'.repeat(10_000),status:'open' as const,createdAt:project.createdAt}));
 const runtime=new CodeGenerationRuntime({command:'must-not-start-a-worker'});
 try{await assert.rejects(runtime.start({project,prompt:'Read all feedback'}),/complete comments.*exceeds 2 MiB/);}finally{await runtime.dispose();}
});

test('structured source generation compiles privately, sends actual image inputs, then verifies final code with original CAS hashes',async()=>withFixture('success',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Original project','html'),original=structuredClone(project);const job=await runtime.start({project,prompt:'Design a real responsive frontend'});assert.equal(job.status,'running');
 const result=await completed(runtime,job.id);assert.equal(result.status,'completed',result.error);assert.deepEqual(result.verification,{compiled:true,rendered:true,modelReviewed:true,viewports:2,pages:[project.defaultPageId]});assert.deepEqual(project,original);
 const changed=result.changes!.files!;assert.equal(changed.find(file=>file.path==='index.html')!.expectedHash,codeFileHash(original.files.find(file=>file.path==='index.html')!));assert.equal(changed.find(file=>file.path==='new.css')!.expectedHash,null);
 assert.ok(renders.length===4);assert.match(renders[0]!.html,/Real frontend proposal/);assert.match(renders[0]!.html,/font-size: 48px/);
 const calls=await requests(record),turns=calls.filter(call=>call.method==='turn/start');assert.equal(turns.length,2);assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
 assert.equal(turns[0]!.params.threadId,turns[1]!.params.threadId);const images=turns[1]!.params.input.filter((input:any)=>input.type==='image');assert.equal(images.length,2);assert.equal(images[0].url,'data:image/png;base64,'+fixturePng.toString('base64'));assert.equal(images[0].detail,'original');
 const thread=calls.find(call=>call.method==='thread/start')!.params;assert.deepEqual(thread.environments,[]);assert.deepEqual(thread.dynamicTools,[]);assert.equal(thread.sandbox,'read-only');assert.equal(thread.approvalPolicy,'never');assert.equal(thread.allowProviderModelFallback,false);assert.deepEqual(thread.config.mcp_servers,{recursive:{enabled:false,required:false}});
 assert.doesNotMatch(JSON.stringify(result),/sk-hidden|secret@example/);assert.ok(result.log.some(line=>line.includes('Rendered 2 actual page/viewport')));
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
 await waitForJobStage(runtime,job.id,async()=>{try{return(await requests(record)).some(call=>call.method==='turn/start');}catch{return false;}},'fixture source turn');
 const cancelled=await runtime.cancel(job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.changes,undefined);
}));

test('one total timeout budget covers model and browser work',async()=>withFixture('success',async runtime=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.equal(result.changes,undefined);assert.match(result.error!,/timed out/);
},{timeoutMs:1000,renderDelay:600}));

test('the total budget can expire before a proposal without inventing a compiled checkpoint',async()=>withFixture('initialize-wait',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Startup budget','html'),job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id),evidence=await diagnostic(runtime,job.id);
 assert.equal(result.status,'failed',evidence);assert.match(result.error!,/timed out/,evidence);assert.equal(result.draft,undefined);assert.equal(result.verification.compiled,false);assert.equal(result.changes,undefined);assert.equal(renders.length,0);
 const calls=await requests(record).catch(()=>[]);assert.equal(calls.some(call=>call.method==='turn/start'),false);
},{timeoutMs:1000}));

async function failedReview(runtime:CodeGenerationRuntime,project:ReturnType<typeof createCodeTemplate>){
 // These tests need a durable review checkpoint, independently of cold-start scheduling.
 // Dedicated timeout tests retain the real total-budget behavior.
 const job=await runtime.start({project,prompt:'Create the complete frontend and review its actual screenshots'});
 const result=await completed(runtime,job.id),evidence=await diagnostic(runtime,job.id);assert.equal(result.status,'failed',evidence);assert.match(result.error!,/fixtureReviewFailed/,evidence);assert.equal(result.changes,undefined);assert.ok(result.draft,'A compiled private draft must survive the explicit review failure: '+evidence);assert.equal(result.draft.stage,'reviewing',evidence);return result;
}

test('review timeout preserves compiled source and both actual captures as an unapplied unverified checkpoint',async()=>withFixture('review-wait',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Checkpointed source','html'),original=structuredClone(project);const job=await runtime.start({project,prompt:'Create the complete frontend',timeoutMs:2000});
 await waitForJobStage(runtime,job.id,async job=>job.draft?.stage==='reviewing'&&(await requests(record)).some(call=>call.method==='turn/start'&&call.params.input.some((input:any)=>input.type==='image')),'durable checkpoint and actual fixture screenshot-review receipt');
 // The attached worker can legitimately send its review request after saving
 // the checkpoint, or be interrupted by its total budget. Every other RPC and
 // process start must remain unchanged, including discovery-only workers.
 const nonInterrupt=(calls:Awaited<ReturnType<typeof requests>>)=>calls.filter(call=>call.method!=='turn/interrupt');
 const processStarts=async()=>(await readFile(record+'.stages','utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(stage=>stage.phase==='process-started');
 const callsBefore=nonInterrupt(await requests(record)),processesBefore=await processStarts();assert.equal(callsBefore.filter(call=>call.method==='turn/start').length,2);assert.equal(processesBefore.length,1);
 const checkpoint=join(control.checkpointDir,runtime.get(job.id).draft!.id+'.json'),beforeRead=JSON.parse(await readFile(checkpoint,'utf8'));
 const detached=control.createRuntime(),observed=(await detached.listDrafts()).drafts,afterRead=JSON.parse(await readFile(checkpoint,'utf8'));
 assert.equal(observed.length,1);assert.equal(observed[0]!.id,beforeRead.id);
 // The real timeout may atomically replace the checkpoint during this read.
 // Correlate the reported status with one actual bracketing snapshot.
 assert.ok([beforeRead,afterRead].some(saved=>saved.updatedAt===observed[0]!.updatedAt&&(saved.originStatus==='running'?'not-attached':saved.originStatus)===observed[0]!.originStatus));
 assert.deepEqual(nonInterrupt(await requests(record)),callsBefore);assert.deepEqual(await processStarts(),processesBefore);assert.throws(()=>detached.get(job.id),/not found/);
 const failed=await completed(runtime,job.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/timed out/);assert.equal(failed.changes,undefined);assert.equal(failed.draft!.status,'unverified');assert.equal(failed.draft!.requiresReview,true);assert.equal(failed.draft!.stage,'reviewing');
 const saved=await runtime.getDraft(failed.draft!.id,{includeScreenshots:true});assert.equal(saved.draft.originStatus,'failed');assert.equal(saved.draft.originBudgetMs,2000);assert.match(saved.draft.lastError!,/timed out/);
 assert.deepEqual(saved.draft.verification,{compiled:true,rendered:true,modelReviewed:false,viewports:2,pages:[project.defaultPageId]});assert.equal(saved.captures.length,2);assert.ok(saved.captures.every(capture=>capture.pngBase64===fixturePng.toString('base64')));
 assert.equal(saved.draft.reviewedSourceDigest,null);assert.ok(saved.captures.every(capture=>capture.sourceDigest===saved.draft.sourceDigest));
 assert.match(saved.project.files.find(file=>file.path==='index.html')!.content,/Real frontend proposal/);assert.deepEqual(saved.project.pages,original.pages);assert.equal(saved.project.defaultPageId,original.defaultPageId);assert.equal(saved.baseFileHashes['index.html'],codeFileHash(original.files.find(file=>file.path==='index.html')!));assert.deepEqual(project,original);
 assert.equal((saved as any).changes,undefined);assert.equal((saved as any).accountFingerprint,undefined);const stored=await readFile(join(control.checkpointDir,failed.draft!.id+'.json'),'utf8');assert.doesNotMatch(stored,/secret@example|sk-hidden-secret/);assert.equal((await stat(join(control.checkpointDir,failed.draft!.id+'.json'))).mode&0o777,0o600);
}));

test('explicit resume after runtime restart checks the original base and reviews fresh screenshots in a new worker',async()=>withFixture('review-failure',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Resume proposal','html');const failed=await failedReview(runtime,project);await runtime.dispose();const before=(await requests(record)).length;
 const restarted=control.createRuntime();assert.equal(((await restarted.listDrafts()).drafts).length,1);assert.equal((await requests(record)).length,before);assert.throws(()=>restarted.get(failed.id),/not found/);
 await control.setMode('success');const job=await restarted.resume({checkpointId:failed.draft!.id,project,timeoutMs:4000});assert.notEqual(job.id,failed.id);assert.equal(job.status,'running');assert.equal(job.budgetMs,4000);assert.equal(job.resumedFrom,failed.draft!.id);
 const done=await completed(restarted,job.id);assert.equal(done.status,'completed',done.error);assert.equal(done.baseRevision,project.revision);assert.equal(done.changes!.files!.find(file=>file.path==='index.html')!.expectedHash,codeFileHash(project.files.find(file=>file.path==='index.html')!));assert.equal(done.verification.modelReviewed,true);
 assert.equal(done.draft!.reviewedSourceDigest,done.draft!.sourceDigest);
 const review=(await requests(record)).slice(before).find(call=>call.method==='turn/start')!;assert.equal(review.params.input.filter((item:any)=>item.type==='image').length,2);assert.equal(JSON.parse(review.params.input[0].text).originalBaseRevision,project.revision);
 assert.equal(runtime.get(failed.id).status,'failed');assert.equal(runtime.get(failed.id).changes,undefined);assert.notEqual(done.draft!.id,failed.draft!.id);assert.equal((await restarted.getDraft(failed.draft!.id)).draft.originStatus,'failed');
}));

test('resume rejects revision, file hash and page metadata conflicts before starting another worker',async()=>withFixture('review-failure',async(runtime,record)=>{
 const project=createCodeTemplate('Conflict proposal','html');const failed=await failedReview(runtime,project),before=(await requests(record)).length;
 const changedRevision=structuredClone(project);changedRevision.revision++;await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedRevision}),/base conflict/);
 const changedFile=structuredClone(project);changedFile.files[0]!.content+='\n<!-- user edit -->';await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedFile}),/base conflict/);
 const changedPage=structuredClone(project);changedPage.pages[0]!.route='/new-route';await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedPage}),/base conflict/);
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project,timeoutMs:900001}),/timeout must be between/);
 assert.equal((await requests(record)).length,before);assert.equal(runtime.get(failed.id).status,'failed');
}));

test('resume rejects changed reported login identity without inference or credential disclosure',async()=>withFixture('review-failure',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Account-bound proposal','html');const failed=await failedReview(runtime,project);const before=(await requests(record)).filter(call=>call.method==='turn/start').length;await control.setMode('different-account');
 const next=await runtime.resume({checkpointId:failed.draft!.id,project});assert.equal(next.budgetMs,600000);const stopped=await completed(runtime,next.id);assert.equal(stopped.status,'failed');assert.match(stopped.error!,/login identity differs/);assert.equal(stopped.changes,undefined);assert.equal((await requests(record)).filter(call=>call.method==='turn/start').length,before);assert.doesNotMatch(JSON.stringify(stopped),/another@example|secret@example|sk-hidden/);
}));

test('missing exposed account identity leaves a readable draft with no automatic resume authority',async()=>withFixture('no-identity',async(runtime,record)=>{
 const project=createCodeTemplate('Unknown identity','html');const failed=await failedReview(runtime,project);const draft=await runtime.getDraft(failed.draft!.id);assert.equal(draft.draft.resumable,false);assert.equal(draft.draft.status,'unverified');const before=(await requests(record)).length;
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/account continuity cannot be verified/);assert.equal((await requests(record)).length,before);
}));

test('expired private drafts remain explicitly unverified and cannot launch a resumed task',async()=>withFixture('review-failure',async(runtime,record)=>{
 const project=createCodeTemplate('Expiring proposal','html');const failed=await failedReview(runtime,project);await delay(Math.max(0,Date.parse(failed.draft!.expiresAt)-Date.now()+1));const draft=await runtime.getDraft(failed.draft!.id);assert.equal(draft.draft.expired,true);assert.equal(draft.draft.resumable,false);assert.deepEqual((await runtime.listDrafts()).drafts,[]);assert.equal(((await runtime.listDrafts({includeExpired:true})).drafts).length,1);const before=(await requests(record)).length;
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/expired/);assert.equal((await requests(record)).length,before);
},{checkpointTtlMs:100}));

test('private checkpoint retention enforces count and total-byte limits without touching project files',async()=>withFixture('success',async(runtime,_record,_renders,control)=>{
 const project=createCodeTemplate('Bounded proposal','html');const ids:string[]=[];
 for(let i=0;i<3;i++){const result=await completed(runtime,(await runtime.start({project,prompt:'Create real source'})).id);assert.equal(result.status,'completed',result.error);ids.push(result.draft!.id);}
 assert.equal(((await runtime.listDrafts()).drafts).length,2);await assert.rejects(runtime.getDraft(ids[0]!),/not found/);const latest=ids.at(-1)!,size=(await stat(join(control.checkpointDir,latest+'.json'))).size;
 const byteLimit=Math.ceil(size*1.5),bounded=control.createRuntime({maxCheckpointBytes:byteLimit});const result=await completed(bounded,(await bounded.start({project,prompt:'Create real source'})).id);assert.equal(result.status,'completed',result.error);
 const files=(await readdir(control.checkpointDir)).filter(name=>name.endsWith('.json'));const bytes=(await Promise.all(files.map(name=>stat(join(control.checkpointDir,name))))).reduce((sum,entry)=>sum+entry.size,0);assert.ok(bytes<=byteLimit);assert.equal(((await bounded.listDrafts()).drafts).length,1);
},{maxCheckpoints:2}));

test('explicit draft listing remains consistent while checkpoints are atomically replaced and evicted',async()=>withFixture('success',async(runtime,_record,_renders,control)=>{
 const project=createCodeTemplate('Concurrent private checkpoints','html'),reader=control.createRuntime();let polling=true,polls=0,readError:unknown;
 const observe=(async()=>{while(polling){const drafts=(await reader.listDrafts()).drafts;assert.ok(drafts.length<=1);assert.ok(drafts.every(draft=>draft.status==='unverified'&&draft.requiresReview));polls++;await delay(1);}})().catch(error=>{readError=error;});
 try{for(let i=0;i<3;i++){const job=await runtime.start({project,prompt:'Create real source'});const done=await completed(runtime,job.id);assert.equal(done.status,'completed',done.error);}}
 finally{polling=false;await observe;}
 assert.equal(readError,undefined);assert.ok(polls>20);assert.equal(((await reader.listDrafts()).drafts).length,1);
},{maxCheckpoints:1,renderDelay:25}));

test('cancelling during browser work keeps partial real evidence but never publishes an applicable draft',async()=>withFixture('success',async(runtime,record,renders,control)=>{
 const gate=control.holdNextRender(),project=createCodeTemplate('Cancel rendering','html');const job=await runtime.start({project,prompt:'Create real source'});
 await waitForJobStage(runtime,job.id,()=>renders.length===1,'first owned render entry');assert.equal(renders[0]!.finishedAtMs,undefined);assert.equal(runtime.get(job.id).verification.compiled,true);
 const cancellation=runtime.cancel(job.id);gate.release();const cancelled=await cancellation;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.changes,undefined);assert.ok(cancelled.draft);const draft=await runtime.getDraft(cancelled.draft!.id);assert.equal(draft.draft.originStatus,'cancelled');assert.equal(draft.draft.status,'unverified');assert.equal(draft.captures.length,1);assert.equal(draft.draft.verification.rendered,false);assert.equal((await requests(record)).filter(call=>call.method==='turn/start').length,1);assert.equal(renders.length,1);assert.ok(renders[0]!.finishedAtMs);
}));

test('multi-page generation compiles each page separately and records the actual page/viewport review scope',async()=>withFixture('success',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Two real pages','html');project.pages.push({id:'page_second',name:'Second page',entry:'second.html',route:'/second'});project.files.push({path:'second.html',content:'<!doctype html><h1>Second actual page</h1><p>Independent content</p>',encoding:'utf8'});
 const result=await completed(runtime,(await runtime.start({project,prompt:'Refine this two-page frontend'})).id);assert.equal(result.status,'completed',result.error);assert.deepEqual(result.reviewPageIds,project.pages.map(page=>page.id));assert.deepEqual(result.verification.pages,project.pages.map(page=>page.id));assert.equal(result.verification.viewports,4);
 assert.equal(renders.filter(render=>render.html.includes('Second actual page')).length,4);assert.equal(renders.filter(render=>render.html.includes('Real frontend proposal')).length,4);const draft=await runtime.getDraft(result.draft!.id);assert.equal(draft.captures.filter(capture=>capture.pageId==='page_second').length,2);
 const first=(await requests(record)).find(call=>call.method==='turn/start')!;const context=JSON.parse(first.params.input[0].text).project;assert.deepEqual(context.pages,project.pages);assert.equal(context.defaultPageId,project.defaultPageId);
}));

test('tampered checkpoints fail integrity checking before any new inference',async()=>withFixture('review-failure',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Integrity proposal','html');const failed=await failedReview(runtime,project);const filename=join(control.checkpointDir,failed.draft!.id+'.json');const raw=JSON.parse(await readFile(filename,'utf8'));raw.working.files[0].content+='tampered';await writeFile(filename,JSON.stringify(raw));const before=(await requests(record)).length;
 await assert.rejects(runtime.getDraft(failed.draft!.id),/corrupt, incompatible or changed/);await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/corrupt, incompatible or changed/);assert.equal((await requests(record)).length,before);
}));

test('initial source turn receives actual packaged PNG bytes and excerpts without claiming any work was rendered or reviewed',async()=>withFixture('inference-error',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Original brand','html'),expected=await loadDesignReference({referenceId:'interactive-product'});
 const result=await completed(runtime,(await runtime.start({project,prompt:'Explore a product interaction, retaining my content',referenceId:'interactive-product'})).id);
 assert.equal(result.status,'failed');assert.deepEqual(result.verification,{compiled:false,rendered:false,modelReviewed:false,viewports:0,pages:[]});assert.equal(renders.length,0);assert.equal(result.draft,undefined);
 const calls=await requests(record),turn=calls.find(call=>call.method==='turn/start')!,payload=JSON.parse(turn.params.input[0].text);assert.equal(payload.designReference.metadata.selectedId,'interactive-product');assert.deepEqual(payload.workImageInputs,[]);assert.equal(payload.referenceImageInputs.length,2);assert.equal(payload.designReference.content.snippets.length,3);
 for(const image of expected.images){const slot=payload.referenceImageInputs.find((entry:any)=>entry.view===image.view);assert.equal(turn.params.input[slot.inputIndex].url,'data:image/png;base64,'+image.dataBase64);const actual=await readFile(fileURLToPath(new URL('../'+image.path,import.meta.url)));assert.deepEqual(Buffer.from(image.dataBase64,'base64'),actual);assert.equal(slot.sha256,createHash('sha256').update(actual).digest('hex'));}
 assert.equal(payload.designReference.metadata.digest,result.reference.digest);assert.equal(result.referenceTurns.length,1);assert.equal(result.referenceTurns[0]!.workSourceDigest,null);assert.deepEqual(result.referenceTurns[0]!.workImageHashes,[]);assert.equal(result.referenceTurns[0]!.status,'dispatched');
 const thread=calls.find(call=>call.method==='thread/start')!.params;assert.deepEqual(thread.dynamicTools,[]);assert.deepEqual(thread.runtimeWorkspaceRoots,[]);assert.deepEqual(thread.selectedCapabilityRoots,[]);assert.equal(thread.sandbox,'read-only');assert.equal(thread.approvalPolicy,'never');assert.match(thread.baseInstructions,/No native tools, filesystem, network/);
}));

test('correction and screenshot review reuse one bounded reference snapshot while separately labelling current-work evidence',async()=>withFixture('compile-repair',async(runtime,record)=>{
 const project=createCodeTemplate('Bounded reference corrections','html'),result=await completed(runtime,(await runtime.start({project,prompt:'Create an activity page without copying the example brand',referenceId:'typographic-event'})).id);assert.equal(result.status,'completed',result.error);
 const turns=(await requests(record)).filter(call=>call.method==='turn/start');assert.equal(turns.length,3);assert.deepEqual(result.referenceTurns.map(turn=>turn.phase),['initial','correction','review']);assert.ok(result.referenceTurns.every(turn=>turn.status==='completed'&&turn.referenceDigest===result.reference.digest&&turn.imageHashes.length===2));
 for(const turn of turns){const payload=JSON.parse(turn.params.input[0].text);assert.equal(payload.designReference.metadata.digest,result.reference.digest);assert.equal(payload.referenceImageInputs.length,2);assert.equal(turn.params.input.filter((item:any)=>item.type==='image').length,2+payload.workImageInputs.length);assert.equal(JSON.stringify(payload).includes('dataBase64'),false);assert.equal(payload.designReference.metadata.budget.wireBytes,result.reference.budget.wireBytes);}
 assert.deepEqual(result.referenceTurns.map(turn=>turn.workImageHashes.length),[0,0,2]);const draft=await runtime.getDraft(result.draft!.id);assert.equal(draft.draft.reviewedSourceDigest,draft.draft.sourceDigest);assert.deepEqual(draft.draft.referenceTurns,result.referenceTurns);assert.equal(draft.captures.length,2,'Reference PNGs are never stored as current-work captures');
}));

test('resumed review pins the saved reference bytes and receipts without reselecting or needing the package on disk',async()=>withFixture('review-failure',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Pinned review reference','html'),failed=await completed(runtime,(await runtime.start({project,prompt:'An editorial exploration',referenceId:'editorial-atlas'})).id);assert.equal(failed.status,'failed');assert.equal(failed.verification.modelReviewed,false);assert.equal(failed.draft!.referenceTurns.at(-1)!.workImageHashes.length,2);
 const raw=JSON.parse(await readFile(join(control.checkpointDir,failed.draft!.id+'.json'),'utf8'));assert.equal(raw.version,2);assert.equal(raw.reference.images.length,2);assert.equal(raw.captures.length,2);assert.equal(raw.reference.metadata.digest,failed.reference.digest);
 await runtime.dispose();await control.setMode('success');const restarted=control.createRuntime({referencePackageRoot:join(control.checkpointDir,'missing-package-root')});const before=(await requests(record)).length;
 const done=await completed(restarted,(await restarted.resume({checkpointId:failed.draft!.id,project,prompt:'Continue the same draft; preserve the user brand'})).id);assert.equal(done.status,'completed',done.error);assert.equal(done.reference.digest,failed.reference.digest);assert.equal(done.referenceTurns.length,1);assert.equal(done.referenceTurns[0]!.phase,'resume-review');assert.equal(done.referenceTurns[0]!.referenceDigest,failed.reference.digest);
 const turn=(await requests(record)).slice(before).find(call=>call.method==='turn/start')!,payload=JSON.parse(turn.params.input[0].text);assert.equal(payload.referenceImageInputs.length,2);assert.equal(payload.workImageInputs.length,2);assert.equal(turn.params.input.filter((item:any)=>item.type==='image').length,4);for(const entry of payload.referenceImageInputs){const image=raw.reference.images.find((image:any)=>image.sha256===entry.sha256);assert.equal(turn.params.input[entry.inputIndex].url,'data:image/png;base64,'+image.dataBase64);}
 const final=await restarted.getDraft(done.draft!.id);assert.equal(final.draft.resumedFrom,failed.draft!.id);assert.equal(final.draft.reference.digest,failed.reference.digest);assert.equal(final.draft.referenceTurns.length,1);
}));

test('reference load failure is explicit before launching even a fixture worker',async()=>withFixture('success',async(_runtime,record,_renders,control)=>{
 const runtime=control.createRuntime({referencePackageRoot:join(control.checkpointDir,'missing-package')}),project=createCodeTemplate('No missing resource fallback','html');
 await assert.rejects(runtime.start({project,prompt:'Create a product demo',referenceId:'interactive-product'}),/Design reference: packaged resource root is unavailable/);await assert.rejects(readFile(record,'utf8'),{code:'ENOENT'});
}));

test('unsupported v1 drafts remain byte-identical and separately listed while current drafts can be created and retained',async()=>withFixture('success',async(runtime,record,_renders,control)=>{
 const oldId='draft_00000000-0000-4000-8000-000000000001',filename=join(control.checkpointDir,oldId+'.json');const project=createCodeTemplate('Current reference checkpoint','html');
 const first=await completed(runtime,(await runtime.start({project,prompt:'Create a complete frontend'})).id);assert.equal(first.status,'completed',first.error);const old=JSON.stringify({version:1,id:oldId,source:'Original obsolete data remains untouched'});await writeFile(filename,old,{mode:0o600});
 const list=await runtime.listDrafts();assert.equal(list.drafts.length,1);assert.equal(list.unsupported.length,1);assert.equal(list.unsupported[0]!.format,1);assert.match(list.unsupported[0]!.reason,/unsupported checkpoint format 1.*Current format is 2/);const before=(await requests(record)).length;
 await assert.rejects(runtime.getDraft(oldId),/unsupported checkpoint format 1/);await assert.rejects(runtime.resume({checkpointId:oldId,project}),/unsupported checkpoint format 1/);assert.equal((await requests(record)).length,before);
 const next=await completed(runtime,(await runtime.start({project,prompt:'Create another complete frontend'})).id);assert.equal(next.status,'completed',next.error);assert.equal((await runtime.listDrafts()).drafts.length,1);assert.equal((await runtime.listDrafts()).unsupported.length,1);assert.equal(await readFile(filename,'utf8'),old);
},{maxCheckpoints:1}));

// Construct a valid outer envelope to exercise nested-format rejection after integrity checks.
function checkpointIntegrity(record:Record<string,unknown>):string {
 const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value)??'null';
 const{integrity:_integrity,...payload}=record;return createHash('sha256').update(canonical(payload)).digest('hex');
}

test('unsupported nested reference v2 remains separate and byte-identical while current checkpoint2 drafts can be read and retained',async()=>withFixture('success',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Current outer and material formats','html');
 const first=await completed(runtime,(await runtime.start({project,prompt:'Create a complete frontend'})).id);assert.equal(first.status,'completed',first.error);
 const currentFile=join(control.checkpointDir,first.draft!.id+'.json'),raw=JSON.parse(await readFile(currentFile,'utf8'));
 assert.equal(raw.version,2);assert.equal(raw.reference.metadata.version,DESIGN_REFERENCE_VERSION);assert.equal(DESIGN_REFERENCE_VERSION,3);
 const oldId='draft_00000000-0000-4000-8000-000000000002',oldFile=join(control.checkpointDir,oldId+'.json');
 raw.id=oldId;raw.reference.metadata.version=2;raw.reference.content.rules='Original version-two material remains untouched; this is not a migration input.';raw.expiresAt=new Date(Date.now()-48*60*60*1000).toISOString();raw.integrity=checkpointIntegrity(raw);
 const old=JSON.stringify(raw,null,2)+'\n';await writeFile(oldFile,old,{mode:0o600});
 const reader=control.createRuntime(),callsBefore=await requests(record),stagesBefore=await readFile(record+'.stages','utf8');
 const listing=await reader.listDrafts();assert.deepEqual(listing.drafts.map(draft=>draft.id),[first.draft!.id]);assert.equal(listing.drafts[0]!.reference.version,DESIGN_REFERENCE_VERSION);
 assert.equal(listing.unsupported.length,1);assert.equal(listing.unsupported[0]!.id,oldId);assert.equal(listing.unsupported[0]!.format,'checkpoint-2/reference-2');assert.match(listing.unsupported[0]!.reason,/unsupported checkpoint format checkpoint-2\/reference-2/);assert.match(listing.unsupported[0]!.reason,/original file was not migrated or deleted/);
 const unsupported=(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='DESIGN_DRAFT_FORMAT'&&'format'in error&&error.format==='checkpoint-2/reference-2';
 await assert.rejects(reader.getDraft(oldId),unsupported);await assert.rejects(reader.getDraft(oldId,{includeScreenshots:true}),unsupported);await assert.rejects(reader.resume({checkpointId:oldId,project}),unsupported);
 assert.equal((await reader.getDraft(first.draft!.id)).draft.id,first.draft!.id);assert.equal((await reader.listDrafts({includeExpired:true})).unsupported.length,1);
 assert.deepEqual(await requests(record),callsBefore);assert.equal(await readFile(record+'.stages','utf8'),stagesBefore,'Unsupported reads and resume rejection cannot even start a discovery fixture process');assert.equal(await readFile(oldFile,'utf8'),old);
 const next=await completed(runtime,(await runtime.start({project,prompt:'Create the next complete frontend'})).id);assert.equal(next.status,'completed',next.error);
 const retained=await reader.listDrafts();assert.deepEqual(retained.drafts.map(draft=>draft.id),[next.draft!.id]);assert.deepEqual(retained.unsupported.map(item=>item.id),[oldId]);assert.equal((await reader.getDraft(next.draft!.id)).draft.reference.version,DESIGN_REFERENCE_VERSION);
 assert.equal(await readFile(oldFile,'utf8'),old,'Count/expiry cleanup must leave unsupported nested material byte-for-byte unchanged');await assert.rejects(reader.getDraft(first.draft!.id),/not found/);
},{maxCheckpoints:1}));

test('current nested material corruption is not relabelled as an unsupported reference version',async()=>withFixture('success',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Reference integrity distinction','html'),first=await completed(runtime,(await runtime.start({project,prompt:'Create a complete frontend'})).id);assert.equal(first.status,'completed',first.error);
 const currentFile=join(control.checkpointDir,first.draft!.id+'.json'),raw=JSON.parse(await readFile(currentFile,'utf8')),badId='draft_00000000-0000-4000-8000-000000000003',badFile=join(control.checkpointDir,badId+'.json');
 raw.id=badId;raw.reference.content.rules+=' altered without a material version change';raw.integrity=checkpointIntegrity(raw);const before=JSON.stringify(raw);await writeFile(badFile,before,{mode:0o600});
 const reader=control.createRuntime(),callsBefore=await requests(record),stagesBefore=await readFile(record+'.stages','utf8');
 const corrupt=(error:unknown)=>error instanceof Error&&/corrupt, incompatible or changed/.test(error.message)&&!('code'in error&&error.code==='DESIGN_DRAFT_FORMAT');
 await assert.rejects(reader.getDraft(badId),corrupt);await assert.rejects(reader.resume({checkpointId:badId,project}),corrupt);
 assert.equal((await reader.getDraft(first.draft!.id)).draft.reference.version,DESIGN_REFERENCE_VERSION);assert.deepEqual(await requests(record),callsBefore);assert.equal(await readFile(record+'.stages','utf8'),stagesBefore);assert.equal(await readFile(badFile,'utf8'),before);
}));

test('a model modification after visual review needs a fresh review of that exact source identity',async()=>withFixture('review-mutate',async(runtime,record)=>{
 const result=await completed(runtime,(await runtime.start({project:createCodeTemplate('Reviewed source identity','html'),prompt:'Create real source',referenceId:'interactive-product'})).id);assert.equal(result.status,'completed',result.error);
 const turns=(await requests(record)).filter(call=>call.method==='turn/start');assert.equal(turns.length,3);const draft=await runtime.getDraft(result.draft!.id);assert.equal(draft.draft.reviewedSourceDigest,draft.draft.sourceDigest);assert.notEqual(result.referenceTurns[1]!.workSourceDigest,result.referenceTurns[2]!.workSourceDigest);assert.equal(result.referenceTurns[2]!.workSourceDigest,draft.draft.sourceDigest);
}));

test('reference views match the actual per-page review targets rather than every unused viewport',async()=>withFixture('inference-error',async(runtime,record)=>{
 const project=createCodeTemplate('Bounded actual review views','html');project.viewports=[{id:'review_desktop_one',name:'Desktop one',width:1024,height:800},{id:'review_desktop_two',name:'Desktop two',width:1440,height:1000},{id:'unused_phone',name:'Not in the two captures',width:390,height:844}];
 const result=await completed(runtime,(await runtime.start({project,prompt:'Create an event page',referenceId:'typographic-event'})).id),turn=(await requests(record)).find(call=>call.method==='turn/start')!,payload=JSON.parse(turn.params.input[0].text);
 assert.deepEqual(result.reference.views,['desktop']);assert.deepEqual(payload.referenceImageInputs.map((image:any)=>image.view),['desktop']);assert.equal(turn.params.input.filter((item:any)=>item.type==='image').length,1);assert.equal(result.verification.modelReviewed,false);
}));
