import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const isolated=await mkdtemp(path.join(tmpdir(),'design-package-'));
let client;let errors='';
async function connect(){
 const env=Object.fromEntries(Object.entries(process.env).filter(([,value])=>value!==undefined));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(isolated,'runtime/index.js')],cwd:tmpdir(),env:{...env,DESIGN_DATA_DIR:path.join(isolated,'data')},stderr:'pipe'});
 transport.stderr?.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-12000);});
 client=new Client({name:'design-isolated-smoke',version:'1'});await client.connect(transport);
}
async function call(name,args={}){const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r.structuredContent;}
try{
 for(const file of ['runtime','skills','plugin.json','mcp.json','package.json','README.md'])await cp(path.join(root,file),path.join(isolated,file),{recursive:true});
 await connect();assert.equal(client.getServerVersion().version,'0.1.1');
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('design_apply_changes'));assert.ok(names.includes('design_request_generation'));
 const panel=(await client.readResource({uri:'ui://design/studio.html'})).contents[0];assert.match(panel.text,/design-editor/);assert.ok(!panel.text.includes('{{SCRIPT}}'));
 assert.equal((await call('design_get_capabilities')).modelModes[0].id,'host');
 const {document}=await call('design_create_project',{name:'Isolated design',template:'mobile'});
 const changed=await call('design_apply_changes',{projectId:document.id,expectedRevision:document.revision,patches:[{op:'replace',path:'/name',value:'Saved isolated design'}]});assert.equal(changed.document.revision,2);
 const conflict=await client.callTool({name:'design_apply_changes',arguments:{projectId:document.id,expectedRevision:1,patches:[{op:'replace',path:'/name',value:'Lost update'}]}});assert.equal(conflict.isError,true);
 const host=await call('design_request_generation',{projectId:document.id,prompt:'Make the title shorter',mode:'host'});assert.equal(host.mode,'host');assert.equal(host.job,undefined);assert.ok(host.prompt.includes(document.id));
 const file=await call('design_export',{projectId:document.id,format:'html'});assert.ok(Buffer.from(file.dataBase64,'base64').toString().includes('design-document'));
 await client.close();await connect();assert.equal((await call('design_get_project',{projectId:document.id})).document.name,'Saved isolated design');
 const undone=await call('design_undo',{projectId:document.id,expectedRevision:2});assert.equal(undone.document.name,'Isolated design');
 const invalid=await client.callTool({name:'design_apply_changes',arguments:{projectId:'../../escape',expectedRevision:1,patches:[]}});assert.equal(invalid.isError,true);
 console.log(JSON.stringify({passed:true,isolatedPackage:true,tools:names.length,modelTurns:0,persistence:true,conflicts:true,hostModeDoesNotSpawn:true}));
}catch(error){if(errors)console.error(errors);throw error;}
finally{await client?.close();await rm(isolated,{recursive:true,force:true});}
