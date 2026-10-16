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
 await connect();assert.equal(client.getServerVersion().version,'0.2.0');
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('design_apply_changes'));assert.ok(names.includes('design_request_generation'));
 const panel=(await client.readResource({uri:'ui://design/studio.html'})).contents[0];assert.match(panel.text,/design-editor/);assert.ok(!panel.text.includes('{{SCRIPT}}'));
 assert.equal((await call('design_get_capabilities')).modelModes[0].id,'host');
 const {document}=await call('design_create_project',{name:'Isolated design',template:'mobile'});
 const changed=await call('design_apply_changes',{projectId:document.id,expectedRevision:document.revision,patches:[{op:'replace',path:'/name',value:'Saved isolated design'}]});assert.equal(changed.document.revision,2);
 const conflict=await client.callTool({name:'design_apply_changes',arguments:{projectId:document.id,expectedRevision:1,patches:[{op:'replace',path:'/name',value:'Lost update'}]}});assert.equal(conflict.isError,true);
 const host=await call('design_request_generation',{projectId:document.id,prompt:'Make the title shorter',mode:'host'});assert.equal(host.mode,'host');assert.equal(host.job,undefined);assert.ok(host.prompt.includes(document.id));
 const file=await call('design_export',{projectId:document.id,format:'html'});assert.ok(Buffer.from(file.dataBase64,'base64').toString().includes('design-document'));
 const code=await call('design_code_create',{name:'Isolated React design',template:'react'});
 const source=await call('design_code_get',{projectId:code.project.id});assert.equal(source.project.entry,'index.html');
 const preview=await call('design_code_preview',{projectId:code.project.id});assert.equal(preview.diagnostics.filter(item=>item.level==='error').length,0);assert.match(preview.html,/__DesignReact/);assert.ok(preview.sources.some(item=>item.file==='src/App.tsx'));
 const heading=preview.sources.find(item=>item.file==='src/App.tsx'&&item.tag==='h2'&&item.editableText);assert.ok(heading);
 const edited=await call('design_code_edit_element',{projectId:code.project.id,expectedRevision:1,sourceId:heading.id,fileHash:heading.fileHash,text:'Isolated source edit'});assert.equal(edited.project.revision,2);
 const editedPreview=await call('design_code_preview',{projectId:code.project.id});const stable=editedPreview.sources.find(item=>item.id===heading.id)||editedPreview.sources.find(item=>item.tag==='h2'&&item.identity==='stable');assert.ok(stable);
 const comment=await call('design_code_add_comment',{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Verify stable source anchor'});assert.equal(comment.project.revision,3);assert.ok(comment.comment.sourceId);
 const codeConflict=await client.callTool({name:'design_code_edit_element',arguments:{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Must not apply'}});assert.equal(codeConflict.isError,true);
 const codeHost=await call('design_code_guidance',{projectId:code.project.id,prompt:'Keep the brand; shorten this heading'});assert.equal(codeHost.mode,'host');assert.equal(codeHost.job,undefined);assert.match(codeHost.prompt,/design_code_update/);
 const codeExport=await call('design_code_export',{projectId:code.project.id,format:'html'});const exportedHtml=Buffer.from(codeExport.dataBase64,'base64').toString();assert.ok(exportedHtml.includes('Isolated source edit'));assert.ok(!exportedHtml.includes('data-design-source='));
 const unchanged=await call('design_code_get',{projectId:code.project.id,ifRevision:3});assert.equal(unchanged.unchanged,true);
 const guidance=await call('design_get_guidance',{brief:'已有品牌的工作台只修改标题',medium:'code'});assert.equal(guidance.medium,'code');assert.ok(guidance.directions.length>=20);assert.equal(guidance.preserveExisting,true);
 await client.close();await connect();assert.equal((await call('design_get_project',{projectId:document.id})).document.name,'Saved isolated design');
 const undone=await call('design_undo',{projectId:document.id,expectedRevision:2});assert.equal(undone.document.name,'Isolated design');
 const invalid=await client.callTool({name:'design_apply_changes',arguments:{projectId:'../../escape',expectedRevision:1,patches:[]}});assert.equal(invalid.isError,true);
 console.log(JSON.stringify({passed:true,isolatedPackage:true,tools:names.length,modelTurns:0,persistence:true,conflicts:true,hostModeDoesNotSpawn:true,realReactCompilation:true,stableSourceComments:true,codeConflicts:true}));
}catch(error){if(errors)console.error(errors);throw error;}
finally{await client?.close();await rm(isolated,{recursive:true,force:true});}
