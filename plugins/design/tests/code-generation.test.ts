import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,readFile,rm,readdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildCodeGenerationContext, CodeGenerationRuntime } from '../src/code-generation.ts';
import type { CodeGenerationOptions } from '../src/code-generation.ts';
import { createCodeTemplate,codeFileHash } from '../src/code-project.ts';
import type { BrowserInspection } from '../src/code-browser.ts';

// This is an explicitly controlled JSON-RPC fixture, not an inference or browser substitute in production.
const script=String.raw`#!/usr/bin/env node
const{createInterface}=require('node:readline');const{appendFileSync}=require('node:fs');const mode=MODE,record=RECORD;let counter=0,currentTurn='';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;appendFileSync(record,JSON.stringify(r)+'\n');const result=value=>send({id:r.id,result:value});
if(r.method==='initialize')result({capabilities:{}});
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
 const receivedImages=r.params.input.some(input=>input.type==='image');
 if((mode==='review-wait'||mode==='no-identity')&&receivedImages)return;
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
interface FixtureControl {checkpointDir:string;setMode:(mode:string)=>Promise<void>;createRuntime:(options?:Partial<CodeGenerationOptions>)=>CodeGenerationRuntime}
async function withFixture(mode:string,run:(runtime:CodeGenerationRuntime,record:string,renders:Array<{html:string;width:number;height:number}>,control:FixtureControl)=>Promise<void>,options:{timeoutMs?:number;renderDelay?:number;checkpointTtlMs?:number;maxCheckpoints?:number;maxCheckpointBytes?:number}={}):Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'design-code-generation-test-'));const command=join(directory,'fixture.cjs'),record=join(directory,'requests.jsonl');await writeFile(command,script.replace('MODE',JSON.stringify(mode)).replace('RECORD',JSON.stringify(record)));await chmod(command,0o700);
 const checkpointDir=join(directory,'private-drafts'),runtimes:CodeGenerationRuntime[]=[];const renders:Array<{html:string;width:number;height:number}>=[];
 const createRuntime=(overrides:Partial<CodeGenerationOptions>={}):CodeGenerationRuntime=>{const value=new CodeGenerationRuntime({command,...options,timeoutMs:options.timeoutMs??5000,checkpointDir,inspect:async(html,viewport)=>{renders.push({html,width:viewport.width,height:viewport.height});if(options.renderDelay)await delay(options.renderDelay);return inspection(viewport.width,viewport.height);},...overrides});runtimes.push(value);return value;};
 const runtime=createRuntime();const control:FixtureControl={checkpointDir,createRuntime,setMode:async next=>{await writeFile(command,script.replace('MODE',JSON.stringify(next)).replace('RECORD',JSON.stringify(record)));}};
 try{await run(runtime,record,renders,control);}finally{await Promise.all(runtimes.map(value=>value.dispose()));await rm(directory,{recursive:true,force:true});}
}
async function completed(runtime:CodeGenerationRuntime,id:string){for(let i=0;i<800;i++){const job=runtime.get(id);if(job.status!=='running')return job;await delay(10);}throw new Error('Fixture code generation did not finish.');}
async function requests(file:string):Promise<Array<{method:string;params:any}>>{return(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}

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
 for(let i=0;i<200;i++){try{if((await requests(record)).some(call=>call.method==='turn/start'))break;}catch{}await delay(10);}
 const cancelled=await runtime.cancel(job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.changes,undefined);
}));

test('one total timeout budget covers model and browser work',async()=>withFixture('success',async runtime=>{
 const project=createCodeTemplate('Original','html');const job=await runtime.start({project,prompt:'Create real source'});const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.equal(result.changes,undefined);assert.match(result.error!,/timed out/);
},{timeoutMs:1000,renderDelay:600}));

async function failedReview(runtime:CodeGenerationRuntime,project:ReturnType<typeof createCodeTemplate>){
 const job=await runtime.start({project,prompt:'Create the complete frontend and review its actual screenshots',timeoutMs:2000});
 const result=await completed(runtime,job.id);assert.equal(result.status,'failed');assert.match(result.error!,/timed out/);assert.equal(result.changes,undefined);assert.ok(result.draft,'A compiled private draft must survive review timeout');return result;
}

test('review timeout preserves compiled source and both actual captures as an unapplied unverified checkpoint',async()=>withFixture('review-wait',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Checkpointed source','html'),original=structuredClone(project);const job=await runtime.start({project,prompt:'Create the complete frontend',timeoutMs:2000});
 for(let i=0;i<150;i++){if(runtime.get(job.id).draft?.stage==='reviewing')break;await delay(10);}
 const callsBefore=(await requests(record)).length;const detached=control.createRuntime();const observed=await detached.listDrafts();assert.equal(observed[0]?.originStatus,'not-attached');assert.equal((await requests(record)).length,callsBefore);assert.throws(()=>detached.get(job.id),/not found/);
 const failed=await completed(runtime,job.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/timed out/);assert.equal(failed.changes,undefined);assert.equal(failed.draft!.status,'unverified');assert.equal(failed.draft!.requiresReview,true);assert.equal(failed.draft!.stage,'reviewing');
 const saved=await runtime.getDraft(failed.draft!.id,{includeScreenshots:true});assert.equal(saved.draft.originStatus,'failed');assert.equal(saved.draft.originBudgetMs,2000);assert.match(saved.draft.lastError!,/timed out/);
 assert.deepEqual(saved.draft.verification,{compiled:true,rendered:true,modelReviewed:false,viewports:2,pages:[project.defaultPageId]});assert.equal(saved.captures.length,2);assert.ok(saved.captures.every(capture=>capture.pngBase64===fixturePng.toString('base64')));
 assert.equal(saved.draft.reviewedSourceDigest,null);assert.ok(saved.captures.every(capture=>capture.sourceDigest===saved.draft.sourceDigest));
 assert.match(saved.project.files.find(file=>file.path==='index.html')!.content,/Real frontend proposal/);assert.deepEqual(saved.project.pages,original.pages);assert.equal(saved.project.defaultPageId,original.defaultPageId);assert.equal(saved.baseFileHashes['index.html'],codeFileHash(original.files.find(file=>file.path==='index.html')!));assert.deepEqual(project,original);
 assert.equal((saved as any).changes,undefined);assert.equal((saved as any).accountFingerprint,undefined);const stored=await readFile(join(control.checkpointDir,failed.draft!.id+'.json'),'utf8');assert.doesNotMatch(stored,/secret@example|sk-hidden-secret/);assert.equal((await stat(join(control.checkpointDir,failed.draft!.id+'.json'))).mode&0o777,0o600);
}));

test('explicit resume after runtime restart checks the original base and reviews fresh screenshots in a new worker',async()=>withFixture('review-wait',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Resume proposal','html');const failed=await failedReview(runtime,project);await runtime.dispose();const before=(await requests(record)).length;
 const restarted=control.createRuntime();assert.equal((await restarted.listDrafts()).length,1);assert.equal((await requests(record)).length,before);assert.throws(()=>restarted.get(failed.id),/not found/);
 await control.setMode('success');const job=await restarted.resume({checkpointId:failed.draft!.id,project,timeoutMs:4000});assert.notEqual(job.id,failed.id);assert.equal(job.status,'running');assert.equal(job.budgetMs,4000);assert.equal(job.resumedFrom,failed.draft!.id);
 const done=await completed(restarted,job.id);assert.equal(done.status,'completed',done.error);assert.equal(done.baseRevision,project.revision);assert.equal(done.changes!.files!.find(file=>file.path==='index.html')!.expectedHash,codeFileHash(project.files.find(file=>file.path==='index.html')!));assert.equal(done.verification.modelReviewed,true);
 assert.equal(done.draft!.reviewedSourceDigest,done.draft!.sourceDigest);
 const review=(await requests(record)).slice(before).find(call=>call.method==='turn/start')!;assert.equal(review.params.input.filter((item:any)=>item.type==='image').length,2);assert.equal(JSON.parse(review.params.input[0].text).originalBaseRevision,project.revision);
 assert.equal(runtime.get(failed.id).status,'failed');assert.equal(runtime.get(failed.id).changes,undefined);assert.notEqual(done.draft!.id,failed.draft!.id);assert.equal((await restarted.getDraft(failed.draft!.id)).draft.originStatus,'failed');
}));

test('resume rejects revision, file hash and page metadata conflicts before starting another worker',async()=>withFixture('review-wait',async(runtime,record)=>{
 const project=createCodeTemplate('Conflict proposal','html');const failed=await failedReview(runtime,project),before=(await requests(record)).length;
 const changedRevision=structuredClone(project);changedRevision.revision++;await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedRevision}),/base conflict/);
 const changedFile=structuredClone(project);changedFile.files[0]!.content+='\n<!-- user edit -->';await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedFile}),/base conflict/);
 const changedPage=structuredClone(project);changedPage.pages[0]!.route='/new-route';await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project:changedPage}),/base conflict/);
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project,timeoutMs:900001}),/timeout must be between/);
 assert.equal((await requests(record)).length,before);assert.equal(runtime.get(failed.id).status,'failed');
}));

test('resume rejects changed reported login identity without inference or credential disclosure',async()=>withFixture('review-wait',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Account-bound proposal','html');const failed=await failedReview(runtime,project);const before=(await requests(record)).filter(call=>call.method==='turn/start').length;await control.setMode('different-account');
 const next=await runtime.resume({checkpointId:failed.draft!.id,project});assert.equal(next.budgetMs,600000);const stopped=await completed(runtime,next.id);assert.equal(stopped.status,'failed');assert.match(stopped.error!,/login identity differs/);assert.equal(stopped.changes,undefined);assert.equal((await requests(record)).filter(call=>call.method==='turn/start').length,before);assert.doesNotMatch(JSON.stringify(stopped),/another@example|secret@example|sk-hidden/);
}));

test('missing exposed account identity leaves a readable draft with no automatic resume authority',async()=>withFixture('no-identity',async(runtime,record)=>{
 const project=createCodeTemplate('Unknown identity','html');const failed=await failedReview(runtime,project);const draft=await runtime.getDraft(failed.draft!.id);assert.equal(draft.draft.resumable,false);assert.equal(draft.draft.status,'unverified');const before=(await requests(record)).length;
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/account continuity cannot be verified/);assert.equal((await requests(record)).length,before);
}));

test('expired private drafts remain explicitly unverified and cannot launch a resumed task',async()=>withFixture('review-wait',async(runtime,record)=>{
 const project=createCodeTemplate('Expiring proposal','html');const failed=await failedReview(runtime,project);const draft=await runtime.getDraft(failed.draft!.id);assert.equal(draft.draft.expired,true);assert.equal(draft.draft.resumable,false);assert.deepEqual(await runtime.listDrafts(),[]);assert.equal((await runtime.listDrafts({includeExpired:true})).length,1);const before=(await requests(record)).length;
 await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/expired/);assert.equal((await requests(record)).length,before);
},{checkpointTtlMs:100}));

test('private checkpoint retention enforces count and total-byte limits without touching project files',async()=>withFixture('success',async(runtime,_record,_renders,control)=>{
 const project=createCodeTemplate('Bounded proposal','html');const ids:string[]=[];
 for(let i=0;i<3;i++){const result=await completed(runtime,(await runtime.start({project,prompt:'Create real source'})).id);assert.equal(result.status,'completed',result.error);ids.push(result.draft!.id);}
 assert.equal((await runtime.listDrafts()).length,2);await assert.rejects(runtime.getDraft(ids[0]!),/not found/);const latest=ids.at(-1)!,size=(await stat(join(control.checkpointDir,latest+'.json'))).size;
 const byteLimit=Math.ceil(size*1.5),bounded=control.createRuntime({maxCheckpointBytes:byteLimit});const result=await completed(bounded,(await bounded.start({project,prompt:'Create real source'})).id);assert.equal(result.status,'completed',result.error);
 const files=(await readdir(control.checkpointDir)).filter(name=>name.endsWith('.json'));const bytes=(await Promise.all(files.map(name=>stat(join(control.checkpointDir,name))))).reduce((sum,entry)=>sum+entry.size,0);assert.ok(bytes<=byteLimit);assert.equal((await bounded.listDrafts()).length,1);
},{maxCheckpoints:2}));

test('explicit draft listing remains consistent while checkpoints are atomically replaced and evicted',async()=>withFixture('success',async(runtime,_record,_renders,control)=>{
 const project=createCodeTemplate('Concurrent private checkpoints','html'),reader=control.createRuntime();let polling=true,polls=0,readError:unknown;
 const observe=(async()=>{while(polling){const drafts=await reader.listDrafts();assert.ok(drafts.length<=1);assert.ok(drafts.every(draft=>draft.status==='unverified'&&draft.requiresReview));polls++;await delay(1);}})().catch(error=>{readError=error;});
 try{for(let i=0;i<3;i++){const job=await runtime.start({project,prompt:'Create real source'});const done=await completed(runtime,job.id);assert.equal(done.status,'completed',done.error);}}
 finally{polling=false;await observe;}
 assert.equal(readError,undefined);assert.ok(polls>20);assert.equal((await reader.listDrafts()).length,1);
},{maxCheckpoints:1,renderDelay:25}));

test('cancelling during browser work keeps partial real evidence but never publishes an applicable draft',async()=>withFixture('success',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Cancel rendering','html');const job=await runtime.start({project,prompt:'Create real source'});for(let i=0;i<200;i++){if(renders.length)break;await delay(10);}assert.ok(renders.length);
 const cancelled=await runtime.cancel(job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.changes,undefined);assert.ok(cancelled.draft);const draft=await runtime.getDraft(cancelled.draft!.id);assert.equal(draft.draft.originStatus,'cancelled');assert.equal(draft.draft.status,'unverified');assert.equal(draft.captures.length,1);assert.equal(draft.draft.verification.rendered,false);assert.equal((await requests(record)).filter(call=>call.method==='turn/start').length,1);
},{renderDelay:300}));

test('multi-page generation compiles each page separately and records the actual page/viewport review scope',async()=>withFixture('success',async(runtime,record,renders)=>{
 const project=createCodeTemplate('Two real pages','html');project.pages.push({id:'page_second',name:'Second page',entry:'second.html',route:'/second'});project.files.push({path:'second.html',content:'<!doctype html><h1>Second actual page</h1><p>Independent content</p>',encoding:'utf8'});
 const result=await completed(runtime,(await runtime.start({project,prompt:'Refine this two-page frontend'})).id);assert.equal(result.status,'completed',result.error);assert.deepEqual(result.reviewPageIds,project.pages.map(page=>page.id));assert.deepEqual(result.verification.pages,project.pages.map(page=>page.id));assert.equal(result.verification.viewports,4);
 assert.equal(renders.filter(render=>render.html.includes('Second actual page')).length,4);assert.equal(renders.filter(render=>render.html.includes('Real frontend proposal')).length,4);const draft=await runtime.getDraft(result.draft!.id);assert.equal(draft.captures.filter(capture=>capture.pageId==='page_second').length,2);
 const first=(await requests(record)).find(call=>call.method==='turn/start')!;const context=JSON.parse(first.params.input[0].text).project;assert.deepEqual(context.pages,project.pages);assert.equal(context.defaultPageId,project.defaultPageId);
}));

test('tampered checkpoints fail integrity checking before any new inference',async()=>withFixture('review-wait',async(runtime,record,_renders,control)=>{
 const project=createCodeTemplate('Integrity proposal','html');const failed=await failedReview(runtime,project);const filename=join(control.checkpointDir,failed.draft!.id+'.json');const raw=JSON.parse(await readFile(filename,'utf8'));raw.working.files[0].content+='tampered';await writeFile(filename,JSON.stringify(raw));const before=(await requests(record)).length;
 await assert.rejects(runtime.getDraft(failed.draft!.id),/corrupt, incompatible or changed/);await assert.rejects(runtime.resume({checkpointId:failed.draft!.id,project}),/corrupt, incompatible or changed/);assert.equal((await requests(record)).length,before);
}));
