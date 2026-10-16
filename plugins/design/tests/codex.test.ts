import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CodexDesignRuntime } from '../src/codex.ts';
import { createTemplate } from '../src/templates.ts';
import { buildArtDirectionPrompt, getDesignGuidance } from '../src/art-direction.ts';

// This fixture implements the real local JSON-RPC envelope. It is not a model.
const fixture = String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const mode = MODE;
const record = RECORD;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const note = (method,params) => send({method,params});
let turnCounter=0;let currentTurnId='';
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line); if (!request.id) return;
 appendFileSync(record, JSON.stringify(request)+'\n');
 const result = value => send({id:request.id,result:value});
 if(request.method==='initialize') result({capabilities:{}});
 else if(request.method==='account/read') result({account:{type:mode==='api'?'apiKey':'chatgpt',email:'private@example.test',access_token:'sk-private-token'},requiresOpenaiAuth:true});
 else if(request.method==='model/list') result({data:[{id:request.params.cursor?'second':'first',displayName:request.params.cursor?'Second':'First',isDefault:!request.params.cursor,supportedReasoningEfforts:[{reasoningEffort:'high',description:'High'}]}],nextCursor:request.params.cursor?null:'page-two'});
 else if(request.method==='config/read') result({config:{model_provider:mode==='provider'?'custom':'openai',mcp_servers:{recursive:{command:'never-start'},'dotted.server':{enabled:true}}}});
 else if(request.method==='thread/start') result({thread:{id:'thread_fixture'},model:request.params.model??'first'});
 else if(request.method==='turn/interrupt') { result({}); note('turn/completed',{threadId:'thread_fixture',turn:{id:currentTurnId,items:[],status:'interrupted'}}); }
 else if(request.method==='turn/start') {
   const attempt=++turnCounter;const turnId=currentTurnId='turn_fixture_'+attempt;
   result({turn:{id:turnId,status:'inProgress'}});
   if(mode==='wait') return;
   if(mode==='repair-wait'&&attempt===2) return;
   if(mode==='approval') {send({id:900,method:'item/commandExecution/requestApproval',params:{token:'sk-do-not-leak'}});return;}
   setTimeout(()=>{
    let patch={op:'replace',path:mode==='invalid-document'?'/artboards/0/width':'/name',valueJson:mode==='invalid-document'?'-1':JSON.stringify('Generated design')};
    if(mode==='repair-success'||mode==='repair-failed'||mode==='repair-wait'||mode==='unsafe-local-value'){
      const style=mode==='unsafe-local-value'?{fill:'$sk-value-must-not-leak'}:{lineHeight:mode==='repair-success'&&attempt===2?1.5:24};
      patch={op:'add',path:'/artboards/0/nodes/-',valueJson:JSON.stringify({id:'heading_fixture',name:'Heading',type:'text',x:0,y:0,width:100,height:100,text:'sk-sensitive-text-never-forward',style,children:[]})};
    }
    if(mode==='bad-value-json')patch.valueJson='{"sk-value-must-not-leak';
    const text=mode==='invalid'?'not-json':JSON.stringify({patches:[patch]});
    const item={id:'message_fixture',type:'agentMessage',phase:'final_answer',text};
    if(mode!=='turn-items-only') note('item/completed',{threadId:'thread_fixture',turnId,completedAtMs:Date.now(),item});
    note('turn/completed',{threadId:'thread_fixture',turn:{id:turnId,items:[item],status:mode==='failed'?'failed':'completed',error:mode==='failed'?{message:'Authorization: Bearer sk-do-not-leak'}:null}});
   },10);
 } else send({id:request.id,error:{code:-32601,message:'Bearer sk-never-forward'}});
});
`;

async function withFixture(mode: string, run: (runtime: CodexDesignRuntime, record: string) => Promise<void>, timeoutMs=3000): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(),'design-codex-fixture-'));
  const command = join(directory,'codex-fixture.cjs'); const record=join(directory,'requests.jsonl');
  await writeFile(command,fixture.replace('MODE',JSON.stringify(mode)).replace('RECORD',JSON.stringify(record))); await chmod(command,0o700);
  const runtime=new CodexDesignRuntime({command,timeoutMs});
  try { await run(runtime,record); } finally { await runtime.dispose(); await rm(directory,{recursive:true,force:true}); }
}
async function complete(runtime: CodexDesignRuntime, id: string) {
  for(let attempts=0;attempts<300;attempts++){const job=runtime.get(id);if(job.status!=='running')return job;await delay(10);}
  throw new Error('Fixture job did not finish');
}
async function recorded(file: string): Promise<Array<{method:string;params:any}>> { return (await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line)); }

test('real catalog protocol paginates and strips account private fields',async()=>withFixture('success',async(runtime,record)=>{
 const result=await runtime.listModels();
 assert.deepEqual(result,{models:[{id:'first',displayName:'First',isDefault:true,supportedReasoningEfforts:['high']},{id:'second',displayName:'Second',isDefault:false,supportedReasoningEfforts:['high']}],accountType:'chatgpt'});
 assert.equal((await recorded(record)).filter(value=>value.method==='model/list').length,2);
 assert.doesNotMatch(JSON.stringify(result),/private@example|sk-private/);
}));

test('completed proposals validate against the original document and disable external capabilities',async()=>withFixture('success',async(runtime,record)=>{
 const document=createTemplate('Original','blank'); const job=await runtime.start({projectId:document.id,prompt:'Rename design',document,model:'first'});
 assert.equal(job.status,'running'); assert.match(job.id,/^job_/);
 const completed=await complete(runtime,job.id);assert.equal(completed.status,'completed');assert.equal(completed.baseRevision,1);
 assert.deepEqual(completed.output,[{op:'replace',path:'/name',value:'Generated design'}]);assert.equal(document.name,'Original');
 const requests=await recorded(record); const start=requests.find(value=>value.method==='thread/start')!.params;
 assert.equal(start.ephemeral,true);assert.equal(start.approvalPolicy,'never');assert.equal(start.sandbox,'read-only');assert.equal(start.allowProviderModelFallback,false);
 assert.deepEqual(start.environments,[]);assert.deepEqual(start.dynamicTools,[]);assert.deepEqual(start.runtimeWorkspaceRoots,[]);
 assert.equal(start.config['features.shell_tool'],false);assert.equal(start.config['features.plugins'],false);assert.equal(start.config['features.apps'],false);
 assert.deepEqual(start.config.mcp_servers,{'recursive':{enabled:false,required:false},'dotted.server':{enabled:false,required:false}});
 assert.ok(requests.find(value=>value.method==='turn/start')?.params.outputSchema);
 const generationInput=JSON.parse(requests.find(value=>value.method==='turn/start')!.params.input[0].text);
 assert.equal(generationInput.task,'Rename design');
 assert.equal(generationInput.artDirection,buildArtDirectionPrompt({brief:'Rename design'}));
 assert.match(generationInput.artDirection,/局部修改维持既有视觉语言/);
 assert.match(generationInput.guide,/lineHeight:number\[0\.5,4\] AS A UNITLESS RATIO/);
 assert.match(generationInput.guide,/width,height is finite >0 and <=20000/);
 const snapshot=runtime.get(job.id);snapshot.log.push('external mutation'); assert.ok(!runtime.get(job.id).log.includes('external mutation'));
}));

test('art direction offers distinct content-driven concepts and a concrete selected recipe',()=>{
 const catalog=getDesignGuidance();
 assert.ok(catalog.directions.length>=20);assert.equal(new Set(catalog.directions.map(direction=>direction.summary)).size,catalog.directions.length);
 const editorial=getDesignGuidance({directionId:'editorial',brief:'给研究者阅读的深度报道'});
 assert.match(editorial.guidance,/用户指定的主方向：编辑叙事/);
 assert.match(editorial.guidance,/正文限制行长/);
 assert.match(editorial.guidance,/给研究者阅读的深度报道/);
 const precision=getDesignGuidance({directionId:'precision'});
 assert.match(precision.guidance,/关键指标同时给单位与时间范围/);
 assert.doesNotMatch(precision.guidance,/纸张色或中性色承担约80–90%面积/);
 assert.match(catalog.guidance,/没有查看真实渲染时不得声称完成视觉验收/);
 assert.match(catalog.guidance,/navigate\/url\/toggle/);
 assert.throws(()=>getDesignGuidance({directionId:'made-up'}),/Unknown Design direction/);
 assert.throws(()=>getDesignGuidance({brief:'a'.repeat(30001)}),/30000/);
});

test('local completion notification with nested turn items completes without item streaming',async()=>withFixture('turn-items-only',async runtime=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Rename design',document});
 const completed=await complete(runtime,job.id);assert.equal(completed.status,'completed');
 assert.deepEqual(completed.output,[{op:'replace',path:'/name',value:'Generated design'}]);
}));

for(const mode of ['failed','invalid','invalid-document','approval','api','provider']) test(`rejects ${mode} without exposing secrets or completed output`,async()=>withFixture(mode,async(runtime,record)=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Make a design',document});const ended=await complete(runtime,job.id);
 assert.equal(ended.status,'failed');assert.equal(ended.output,undefined);assert.doesNotMatch(JSON.stringify(ended),/sk-do-not-leak|sk-private|Bearer|private@example/);
 const count=(await recorded(record)).filter(request=>request.method==='turn/start').length;
 assert.equal(count,['api','provider'].includes(mode)?0:['invalid','invalid-document'].includes(mode)?2:1);
}));

test('one same-thread structural repair validates against the unchanged original document',async()=>withFixture('repair-success',async(runtime,record)=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Create a heading',document});
 const completed=await complete(runtime,job.id);assert.equal(completed.status,'completed');assert.equal(completed.baseRevision,document.revision);
 assert.equal(document.artboards[0]!.nodes.length,0);assert.equal(completed.output?.length,1);
 const patch=completed.output![0]!;assert.equal(patch.op,'add');assert.equal((patch as {value:any}).value.style.lineHeight,1.5);
 const requests=await recorded(record);assert.equal(requests.filter(request=>request.method==='thread/start').length,1);
 const turns=requests.filter(request=>request.method==='turn/start');assert.equal(turns.length,2);assert.equal(turns[0]!.params.threadId,turns[1]!.params.threadId);
 const repair=JSON.parse(turns[1]!.params.input[0].text);assert.equal(repair.baseRevision,document.revision);assert.equal(repair.projectId,document.id);
 assert.match(repair.validationError,/artboards\.0\.nodes\.0\.style\.lineHeight/);assert.match(repair.validationError,/<=4/);
 assert.doesNotMatch(repair.validationError,/sk-sensitive-text|24/);
}));

test('failed repair retains the safe exact field and numeric constraint and never requests a third turn',async()=>withFixture('repair-failed',async(runtime,record)=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Create a heading',document});
 const failed=await complete(runtime,job.id);assert.equal(failed.status,'failed');assert.equal(failed.output,undefined);
 assert.match(failed.error!,/artboards\.0\.nodes\.0\.style\.lineHeight/);assert.match(failed.error!,/<=4/);
 assert.doesNotMatch(JSON.stringify(failed),/sk-sensitive-text|lineHeight":24/);
 assert.equal((await recorded(record)).filter(request=>request.method==='turn/start').length,2);
}));

for(const mode of ['unsafe-local-value','bad-value-json'])test(`local diagnostics strip model values for ${mode}`,async()=>withFixture(mode,async runtime=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Create a heading',document});
 const failed=await complete(runtime,job.id);assert.equal(failed.status,'failed');assert.doesNotMatch(JSON.stringify(failed),/sk-value|sk-sensitive|private@example/);
 assert.match(failed.error!,mode==='bad-value-json'?/patches\.0\.valueJson/:/Unknown design token reference/);
}));

test('structural repair shares the original timeout budget and never starts a third turn',async()=>withFixture('repair-wait',async(runtime,record)=>{
 const document=createTemplate('Original');const started=Date.now();
 const job=await runtime.start({projectId:document.id,prompt:'Create a heading',document});
 const failed=await complete(runtime,job.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/timed out/);
 assert.ok(Date.now()-started<2000);assert.equal((await recorded(record)).filter(request=>request.method==='turn/start').length,2);
},1000));

test('cancel waits for the owned process to exit and preserves cancelled terminal state',async()=>withFixture('wait',async(runtime,record)=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Make a design',document});
 for(let attempt=0;attempt<100;attempt++){try{if((await recorded(record)).some(value=>value.method==='turn/start'))break;}catch{}await delay(10);}
 const cancelled=await runtime.cancel(job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.output,undefined);assert.deepEqual(await runtime.cancel(job.id),cancelled);
}));

test('generation timeout kills the worker and produces a failed terminal job',async()=>withFixture('wait',async runtime=>{
 const document=createTemplate('Original');const job=await runtime.start({projectId:document.id,prompt:'Make a design',document});
 const failed=await complete(runtime,job.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/timed out/);
},300));

test('concurrency, project identity, cancellation during startup and disposal are bounded',async()=>withFixture('wait',async runtime=>{
 const document=createTemplate('Original');await assert.rejects(runtime.start({projectId:'wrong',prompt:'Make a design',document}),/does not match/);
 const job=await runtime.start({projectId:document.id,prompt:'Make a design',document});await assert.rejects(runtime.start({projectId:document.id,prompt:'Another',document}),/already running/);
 assert.equal((await runtime.cancel(job.id)).status,'cancelled');
 const next=await runtime.start({projectId:document.id,prompt:'Another',document});await runtime.dispose();assert.equal(runtime.get(next.id).status,'cancelled');await assert.rejects(runtime.listModels(),/disposed/);
}));
