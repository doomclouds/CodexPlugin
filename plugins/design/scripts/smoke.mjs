import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 await connect();assert.equal(client.getServerVersion().version,'0.4.0');
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('design_code_update'));assert.ok(names.includes('design_code_request_generation'));
 for(const obsolete of ['design_apply_changes','design_get_schema','design_create_project','design_replace_document','design_request_generation','design_export'])assert.ok(!names.includes(obsolete),`Obsolete tool still published: ${obsolete}`);
 const panel=(await client.readResource({uri:'ui://design/studio.html'})).contents[0];assert.match(panel.text,/design-editor/);assert.ok(!panel.text.includes('{{SCRIPT}}'));assert.ok(!panel.text.includes('图层设计'));
 const capabilities=await call('design_get_capabilities');assert.equal(capabilities.modelModes[0].id,'host');assert.equal(capabilities.editor,'source');assert.equal(capabilities.projectFormat,2);assert.ok(!capabilities.formats.includes('svg'));
 const code=await call('design_code_create',{name:'Isolated React design',template:'react'});assert.equal(code.project.schemaVersion,2);assert.equal(code.project.pages.length,1);assert.equal(code.project.defaultPageId,code.project.pages[0].id);assert.equal(code.project.entry,undefined);
 const preview=await call('design_code_preview',{projectId:code.project.id});assert.equal(preview.diagnostics.filter(item=>item.level==='error').length,0);assert.match(preview.html,/__DesignReact/);assert.equal(preview.pageId,code.project.defaultPageId);
 const heading=preview.sources.find(item=>item.file==='src/App.tsx'&&item.tag==='h2'&&item.editableText);assert.ok(heading);
 const edited=await call('design_code_edit_element',{projectId:code.project.id,expectedRevision:1,sourceId:heading.id,fileHash:heading.fileHash,text:'Isolated source edit'});assert.equal(edited.project.revision,2);
 const editedPreview=await call('design_code_preview',{projectId:code.project.id});const stable=editedPreview.sources.find(item=>item.tag==='h2'&&item.identity==='stable');assert.ok(stable);
 const comment=await call('design_code_add_comment',{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Verify stable source anchor'});assert.equal(comment.project.revision,3);assert.ok(comment.comment.sourceId);
 const conflict=await client.callTool({name:'design_code_edit_element',arguments:{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Must not apply'}});assert.equal(conflict.isError,true);
 const host=await call('design_code_guidance',{projectId:code.project.id,prompt:'Keep the brand; shorten this heading'});assert.equal(host.mode,'host');assert.equal(host.job,undefined);assert.match(host.prompt,/design_code_update/);assert.equal(host.context.pages.length,1);
 const second={id:'page_details',name:'Details',entry:'details.html',route:'/details'};
 await call('design_code_update',{projectId:code.project.id,expectedRevision:3,changes:{pages:[...code.project.pages,second],files:[{path:second.entry,encoding:'utf8',expectedHash:null,content:'<!doctype html><html><body><h1>Actual second page</h1><a href="/">Back home</a></body></html>'}]}});
 const detail=await call('design_code_preview',{projectId:code.project.id,pageId:second.id});assert.equal(detail.pageId,second.id);assert.equal(detail.diagnostics.filter(item=>item.level==='error').length,0);assert.match(detail.html,/Actual second page/);
 const exported=await call('design_code_export',{projectId:code.project.id,format:'html',pageId:second.id});const html=Buffer.from(exported.dataBase64,'base64').toString();assert.ok(html.includes('Isolated source edit'));assert.ok(html.includes('Actual second page'));assert.ok(html.includes('design-page'));assert.ok(!html.includes('data-design-source='));
 const unchanged=await call('design_code_get',{projectId:code.project.id,ifRevision:4});assert.equal(unchanged.unchanged,true);
 const guide=await call('design_get_guidance',{brief:'已有品牌的工作台只修改标题'});assert.ok(guide.directions.length>=20);assert.equal(guide.preserveExisting,true);assert.equal(guide.medium,undefined);
 await client.close();await connect();assert.equal((await call('design_code_get',{projectId:code.project.id})).project.pages.length,2);
 const undone=await call('design_code_undo',{projectId:code.project.id,expectedRevision:4});assert.equal(undone.project.pages.length,1);assert.equal(undone.project.revision,5);
 const unsupported=path.join(isolated,'data','code','code_unsupported.json');const old=JSON.stringify({current:{schemaVersion:1,id:'code_unsupported',name:'Unsupported development data'},past:[],future:[]});await writeFile(unsupported,old);
 const rejected=await client.callTool({name:'design_code_get',arguments:{projectId:'code_unsupported'}});assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.code,'UNSUPPORTED_FORMAT');assert.equal(await readFile(unsupported,'utf8'),old);
 console.log(JSON.stringify({passed:true,version:'0.4.0',isolatedPackage:true,tools:names.length,modelTurns:0,sourceOnly:true,noSceneCompatibility:true,realReactCompilation:true,realPageEntries:true,persistence:true,stableSourceComments:true,conflicts:true,unsupportedFilePreserved:true,hostModeDoesNotSpawn:true}));
}catch(error){if(errors)console.error(errors);throw error;}
finally{await client?.close();await rm(isolated,{recursive:true,force:true});}
