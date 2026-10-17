import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CodexModelCatalog, Session } from '../src/codex-session.ts';

// A protocol fixture, never a model or a fabricated inference result.
const fixture=String.raw`#!/usr/bin/env node
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const record=RECORD,mode=MODE;
const mark=(phase,fields={})=>appendFileSync(record,JSON.stringify({phase,at:Date.now(),...fields})+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let approvalResponse=false,terminating=false;
mark('fixture-started');
process.on('exit',code=>mark('fixture-exited',{code}));
// Consume the actual rejection already written to stdin before acknowledging
// termination. The bounded fallback exposes a missing response as test evidence.
process.on('SIGTERM',()=>{
 terminating=true;mark('termination-requested');
 if(mode==='permission'&&approvalResponse)process.exit(0);
 setTimeout(()=>process.exit(2),1000);
});
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 const request=JSON.parse(line);
 if(request.id===100&&!request.method){
  approvalResponse=true;
  mark('approval-response',{id:request.id,errorCode:request.error?.code,hasResult:Object.hasOwn(request,'result')});
  if(terminating)process.exit(0);
  return;
 }
 if(typeof request.method!=='string')return;
 mark('request',{method:request.method,...(request.id!==undefined?{id:request.id}:{})});
 if(request.id===undefined)return;
 const reply=result=>send({id:request.id,result});
 if(request.method==='initialize')reply({capabilities:{}});
 else if(request.method==='account/read')reply({account:{type:'chatgpt',email:'private@example.test',access_token:'sk-fixture-private'}});
 else if(request.method==='fixture/hang')mark('reply-withheld',{method:request.method,id:request.id});
 else if(request.method==='model/list'){
  if(mode==='permission'){
   mark('approval-sent',{id:100});
   send({id:100,method:'item/commandExecution/requestApproval',params:{private:'sk-fixture-private'}});return;
  }
  reply({data:[{id:request.params.cursor?'second':'first',displayName:request.params.cursor?'Second':'First',isDefault:!request.params.cursor,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:mode==='cursor-loop'?'same-cursor':request.params.cursor?null:'page-two'});
 }else send({id:request.id,error:{code:-32601,message:'Bearer sk-fixture-private'}});
});
input.on('close',()=>{mark('stdin-closed');process.exit(mode==='permission'&&!approvalResponse?2:0);});
send({method:'fixture/ready',params:{}});
`;
type FixtureEvent={phase:string;at:number;method?:string;id?:number;errorCode?:number;hasResult?:boolean;code?:number};
type FixtureContext={command:string;directory:string;record:string};
async function events(record:string):Promise<FixtureEvent[]>{
 try{return (await readFile(record,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
async function usingFixture(t:TestContext,mode:string,run:(context:FixtureContext)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'design-catalog-test-'));const command=join(directory,'catalog.cjs'),record=join(directory,'events.jsonl');
 const startedAt=Date.now();
 await writeFile(command,fixture.replace('RECORD',JSON.stringify(record)).replace('MODE',JSON.stringify(mode)));await chmod(command,0o700);
 try{await run({command,directory,record});}
 catch(error){
  // The fixture only records protocol stages and identifiers, never raw params,
  // account fields, credentials, rejection messages or local file paths.
  t.diagnostic(`Protocol stages: ${JSON.stringify((await events(record)).map(({at,...event})=>({...event,elapsedMs:at-startedAt})))}`);
  throw error;
 }finally{await rm(directory,{recursive:true,force:true});}
}
async function usingCatalog(t:TestContext,mode:string,run:(catalog:CodexModelCatalog,record:string)=>Promise<void>){
 await usingFixture(t,mode,async({command,record})=>{
  // Protocol assertions use the production bounded request budget. A separate
  // ready-gated test below owns the intentionally short timeout case.
  const catalog=new CodexModelCatalog(command);
  try{await run(catalog,record);}finally{await catalog.dispose();}
 });
}
function fixtureReady(session:Session):Promise<void>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Protocol fixture did not reach its ready stage.')),30_000);
  session.onnotification=method=>{if(method==='fixture/ready'){clearTimeout(timer);resolve();}};
  void session.closed.then(()=>{clearTimeout(timer);reject(new Error('Protocol fixture exited before its ready stage.'));});
 });
}
test('actual catalog protocol paginates without exposing private account fields or starting a turn',async t=>usingCatalog(t,'success',async(catalog,record)=>{
 const result=await catalog.listModels();assert.deepEqual(result,{models:[{id:'first',displayName:'First',isDefault:true,supportedReasoningEfforts:['high']},{id:'second',displayName:'Second',isDefault:false,supportedReasoningEfforts:['high']}],accountType:'chatgpt'});
 const requests=(await events(record)).filter(x=>x.phase==='request');assert.equal(requests.filter(x=>x.method==='model/list').length,2);assert.ok(requests.every(x=>!['thread/start','turn/start'].includes(x.method!)));assert.doesNotMatch(JSON.stringify(result),/private@example|sk-fixture/);
}));
test('catalog rejects repeated cursors instead of looping indefinitely',async t=>usingCatalog(t,'cursor-loop',async(catalog)=>{await assert.rejects(catalog.listModels(),/pagination/);}));
test('unexpected permission requests are actually rejected before the catalog worker exits without forwarding private details',async t=>usingCatalog(t,'permission',async(catalog,record)=>{
 await assert.rejects(catalog.listModels(),error=>{assert.doesNotMatch(String(error),/sk-fixture|private@example/);return /unsupported tool or approval|exited/.test(String(error));});
 const stages=await events(record);
 assert.deepEqual(stages.filter(x=>x.phase==='request'&&x.id!==undefined).map(x=>x.method),['initialize','account/read','model/list']);
 const sent=stages.findIndex(x=>x.phase==='approval-sent'&&x.id===100);
 const response=stages.findIndex(x=>x.phase==='approval-response'&&x.id===100);
 assert.ok(sent>=0,'the fixture must actually issue an approval request');
 assert.ok(response>sent,'the fixture must consume the actual host rejection');
 const rejection=stages[response];assert.ok(rejection);
 assert.equal(rejection.errorCode,-32601);assert.equal(rejection.hasResult,false);
 assert.ok(stages.some(x=>x.phase==='fixture-exited'&&x.code===0),'the catalog must wait for the real worker exit');
 assert.doesNotMatch(JSON.stringify(stages),/sk-fixture|private@example/);
 t.diagnostic(`Approval protocol observed: ${JSON.stringify(stages.filter(x=>['approval-sent','approval-response','fixture-exited'].includes(x.phase)).map(({at,...event})=>event))}`);
}));
test('a ready fixture request times out and explicit Session cleanup waits for the actual worker exit',async t=>usingFixture(t,'timeout',async({command,directory,record})=>{
 const session=new Session(command,directory,100);
 try{
  await fixtureReady(session);
  await assert.rejects(session.request('fixture/hang',{}),/Local Codex fixture\/hang timed out/);
 }finally{await session.close();await session.closed;}
 const stages=await events(record);
 assert.ok(stages.some(x=>x.phase==='reply-withheld'&&x.method==='fixture/hang'),'the timeout must reach the deliberately unanswered request');
 assert.ok(stages.some(x=>x.phase==='fixture-exited'),'the fixture must actually exit after cleanup');
 assert.ok(session.child.exitCode!==null||session.child.signalCode!==null,'a sent signal alone is not proof of process exit');
}));
