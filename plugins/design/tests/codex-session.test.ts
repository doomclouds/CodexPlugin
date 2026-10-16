import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexModelCatalog } from '../src/codex-session.ts';

// A protocol fixture, never a model or a fabricated inference result.
const fixture=String.raw`#!/usr/bin/env node
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const record=RECORD,mode=MODE;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 appendFileSync(record,JSON.stringify({method:request.method,params:request.params})+'\n');
 const reply=result=>send({id:request.id,result});
 if(request.method==='initialize')reply({capabilities:{}});
 else if(request.method==='account/read')reply({account:{type:'chatgpt',email:'private@example.test',access_token:'sk-fixture-private'}});
 else if(request.method==='model/list'){
  if(mode==='permission'){send({id:100,method:'item/commandExecution/requestApproval',params:{private:'sk-fixture-private'}});return;}
  reply({data:[{id:request.params.cursor?'second':'first',displayName:request.params.cursor?'Second':'First',isDefault:!request.params.cursor,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:mode==='cursor-loop'?'same-cursor':request.params.cursor?null:'page-two'});
 }else send({id:request.id,error:{code:-32601,message:'Bearer sk-fixture-private'}});
});
`;
async function usingFixture(mode:string,run:(catalog:CodexModelCatalog,record:string)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'design-catalog-test-'));const command=join(directory,'catalog.cjs'),record=join(directory,'requests.jsonl');
 await writeFile(command,fixture.replace('RECORD',JSON.stringify(record)).replace('MODE',JSON.stringify(mode)));await chmod(command,0o700);
 const catalog=new CodexModelCatalog(command,1000);
 try{await run(catalog,record);}finally{await catalog.dispose();await rm(directory,{recursive:true,force:true});}
}
test('actual catalog protocol paginates without exposing private account fields or starting a turn',async()=>usingFixture('success',async(catalog,record)=>{
 const result=await catalog.listModels();assert.deepEqual(result,{models:[{id:'first',displayName:'First',isDefault:true,supportedReasoningEfforts:['high']},{id:'second',displayName:'Second',isDefault:false,supportedReasoningEfforts:['high']}],accountType:'chatgpt'});
 const requests=(await readFile(record,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(requests.filter(x=>x.method==='model/list').length,2);assert.ok(requests.every(x=>!['thread/start','turn/start'].includes(x.method)));assert.doesNotMatch(JSON.stringify(result),/private@example|sk-fixture/);
}));
test('catalog rejects repeated cursors instead of looping indefinitely',async()=>usingFixture('cursor-loop',async(catalog)=>{await assert.rejects(catalog.listModels(),/pagination/);}));
test('unexpected permission requests stop the catalog worker without forwarding private details',async()=>usingFixture('permission',async(catalog)=>{await assert.rejects(catalog.listModels(),error=>{assert.doesNotMatch(String(error),/sk-fixture|private@example/);return /unsupported tool or approval|exited/.test(String(error));});}));
