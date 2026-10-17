import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
 for(const file of ['runtime','skills','plugin.json','mcp.json','package.json','README.md','LICENSE'])await cp(path.join(root,file),path.join(isolated,file),{recursive:true});
 await connect();assert.equal(client.getServerVersion().version,'0.5.0');
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('design_code_update'));assert.ok(names.includes('design_code_request_generation'));
 for(const obsolete of ['design_apply_changes','design_get_schema','design_create_project','design_replace_document','design_request_generation','design_export'])assert.ok(!names.includes(obsolete),`Obsolete tool still published: ${obsolete}`);
 const panel=(await client.readResource({uri:'ui://design/studio.html'})).contents[0];assert.match(panel.text,/design-editor/);assert.ok(!panel.text.includes('{{SCRIPT}}'));assert.ok(!panel.text.includes('图层设计'));
 const capabilities=await call('design_get_capabilities');assert.equal(capabilities.modelModes[0].id,'host');assert.equal(capabilities.editor,'source');assert.equal(capabilities.projectFormat,3);assert.ok(!capabilities.formats.includes('svg'));
 assert.equal(capabilities.designSystem.tokens.source.includes('CSS custom-property'),true);assert.equal(capabilities.designSystem.tokens.maxEdits,100);
 assert.ok(names.includes('design_code_list_tokens'));assert.ok(names.includes('design_code_edit_tokens'));
 for(const name of ['design_get_reference','design_code_read_metadata','design_code_update_comment'])assert.ok(names.includes(name));
 assert.equal(capabilities.modelReads.structuredResponseBytes,65536);
 const packagedCases=(await readdir(path.join(isolated,'skills/design/assets/examples'),{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 assert.deepEqual(capabilities.designReferences.catalog.map(item=>item.id).sort(),packagedCases);
 const tokenProject=(await call('design_code_create',{name:'Actual CSS token source',template:'html'})).project;
 const tokenHtml=tokenProject.files.find(file=>file.path==='index.html');
 const tokenCss='/* exact source */\r\n:root { --ink: #18231d; --space: 12px; }\r\n[data-theme="night"] { --ink: #f9f6ef; }\r\n.card{color:var(--ink);padding:var(--space)}';
 const tokenReady=(await call('design_code_update',{projectId:tokenProject.id,expectedRevision:1,changes:{files:[{path:'index.html',encoding:'utf8',expectedHash:createHash('sha256').update(tokenHtml.content).digest('hex'),content:'<!doctype html><link rel="stylesheet" href="tokens.css"><div class="card">Actual tokens</div>'},{path:'tokens.css',encoding:'utf8',expectedHash:null,content:tokenCss}]}})).project;
 const tokens=await call('design_code_list_tokens',{projectId:tokenProject.id,file:'tokens.css'});assert.equal(tokens.revision,2);assert.equal(tokens.definitions.length,3);assert.equal(tokens.referenceResolution,'syntactic-name');assert.equal(tokens.definitions[2].selector,'[data-theme="night"]');
 const tokenEdits=tokens.definitions.slice(0,2).map((definition,index)=>({sourceId:definition.sourceId,file:definition.file,fileHash:definition.fileHash,value:index===0?'#bb472c':'24px'}));
 const savedTokens=await call('design_code_edit_tokens',{projectId:tokenProject.id,expectedRevision:2,edits:tokenEdits});assert.equal(savedTokens.project.revision,3);assert.equal(savedTokens.changes.length,2);assert.equal(savedTokens.unchanged,false);assert.equal(savedTokens.project.files.find(file=>file.path==='tokens.css').content,tokenCss.replace('#18231d','#bb472c').replace('12px','24px'));assert.equal(Object.hasOwn(savedTokens.project.designSystem,'tokens'),false);
 const staleTokens=await client.callTool({name:'design_code_edit_tokens',arguments:{projectId:tokenProject.id,expectedRevision:3,edits:tokenEdits}});assert.equal(staleTokens.isError,true);assert.equal(staleTokens.structuredContent.error.code,'REVISION_CONFLICT');
 assert.deepEqual((await call('design_code_get',{projectId:tokenProject.id})).project,savedTokens.project);
 const freshTokens=await call('design_code_list_tokens',{projectId:tokenProject.id,file:'tokens.css'}),firstToken=freshTokens.definitions[0];
 const sameTokens=await call('design_code_edit_tokens',{projectId:tokenProject.id,expectedRevision:3,edits:[{sourceId:firstToken.sourceId,file:firstToken.file,fileHash:firstToken.fileHash,value:firstToken.value}]});assert.equal(sameTokens.unchanged,true);assert.equal(sameTokens.project.revision,3);
 const undoneTokens=await call('design_code_undo',{projectId:tokenProject.id,expectedRevision:3});assert.equal(undoneTokens.project.files.find(file=>file.path==='tokens.css').content,tokenCss);assert.equal(undoneTokens.project.revision,4);assert.equal(tokenReady.revision,2);
 const tokenArtifact=await call('design_code_export',{projectId:tokenProject.id,expectedRevision:4,format:'html'});assert.equal(tokenArtifact.revision,4);assert.equal(tokenArtifact.sha256,createHash('sha256').update(Buffer.from(tokenArtifact.dataBase64,'base64')).digest('hex'));
 await call('design_code_update',{projectId:tokenProject.id,expectedRevision:4,changes:{files:[{path:'tokens.css',encoding:'utf8',expectedHash:createHash('sha256').update(tokenCss).digest('hex'),content:tokenCss.replace('12px','13px')}]}});
 const savedArtifact=await call('design_code_save_export',{artifactId:tokenArtifact.artifactId});assert.equal(savedArtifact.revision,4);assert.equal(savedArtifact.sha256,tokenArtifact.sha256);assert.deepEqual(await readFile(savedArtifact.path),Buffer.from(tokenArtifact.dataBase64,'base64'));
 const obsoleteSave=await client.callTool({name:'design_code_save_export',arguments:{projectId:tokenProject.id,format:'html'}});assert.equal(obsoleteSave.isError,true);
 const staleExport=await client.callTool({name:'design_code_export',arguments:{projectId:tokenProject.id,expectedRevision:4,format:'html'}});assert.equal(staleExport.isError,true);assert.equal(staleExport.structuredContent.error.code,'REVISION_CONFLICT');
 for(const example of packagedCases){
  const directory=path.join(isolated,'skills/design/assets/examples',example);assert.ok((await readFile(path.join(directory,'README.md'),'utf8')).includes('index.html'));assert.match(await readFile(path.join(directory,'index.html'),'utf8'),/<html\b/i);
  const response=await client.callTool({name:'design_get_reference',arguments:{referenceId:example,views:['desktop','mobile']}});assert.notEqual(response.isError,true,`${example}: ${JSON.stringify(response.content).slice(0,500)}`);
  const reference=response.structuredContent,images=response.content.filter(block=>block.type==='image');assert.equal(reference.metadata.selectedId,example);assert.equal(images.length,2);assert.equal(JSON.stringify(reference).includes('dataBase64'),false);
  for(const [index,file,width,height] of [[0,'desktop.png',1440,1000],[1,'mobile.png',390,844]]){const png=await readFile(path.join(directory,file));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),width);assert.equal(png.readUInt32BE(20),height);assert.deepEqual(Buffer.from(images[index].data,'base64'),png);}
 }
 const code=await call('design_code_create',{name:'Isolated React design',template:'react'});assert.equal(code.project.schemaVersion,3);assert.equal(code.project.pages.length,1);assert.equal(code.project.defaultPageId,code.project.pages[0].id);assert.equal(code.project.entry,undefined);
 const filesPage=await call('design_code_list_files',{projectId:code.project.id,limit:1});assert.equal(filesPage.returned,1);assert.equal(filesPage.nextOffset,1);assert.equal(filesPage.project.pageCount,1);assert.equal(filesPage.project.comments,undefined);assert.equal(filesPage.project.designSystem,undefined);assert.ok(Buffer.byteLength(JSON.stringify(filesPage))<=65536);
 const nextFiles=await call('design_code_list_files',{projectId:code.project.id,offset:filesPage.nextOffset,limit:1,expectedRevision:filesPage.revision});assert.equal(nextFiles.files[0].path,code.project.files[1].path);
 const pageMetadata=await call('design_code_read_metadata',{projectId:code.project.id,section:'pages',key:code.project.defaultPageId,expectedRevision:1});assert.deepEqual(pageMetadata.items,[code.project.pages[0]]);
 const preview=await call('design_code_preview',{projectId:code.project.id});assert.equal(preview.diagnostics.filter(item=>item.level==='error').length,0);assert.match(preview.html,/__DesignReact/);assert.match(preview.html,/Permission is hereby granted, free of charge/);assert.match(preview.html,/THE SOFTWARE IS PROVIDED "AS IS"/);assert.equal(preview.pageId,code.project.defaultPageId);
 const heading=preview.sources.find(item=>item.file==='src/App.tsx'&&item.tag==='h2'&&item.editableText);assert.ok(heading);
 const edited=await call('design_code_edit_element',{projectId:code.project.id,expectedRevision:1,sourceId:heading.id,fileHash:heading.fileHash,text:'Isolated source edit'});assert.equal(edited.project.revision,2);
 const editedPreview=await call('design_code_preview',{projectId:code.project.id});const stable=editedPreview.sources.find(item=>item.tag==='h2'&&item.identity==='stable');assert.ok(stable);
 const comment=await call('design_code_add_comment',{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Verify stable source anchor'});assert.equal(comment.project.revision,3);assert.ok(comment.comment.sourceId);
 const conflict=await client.callTool({name:'design_code_edit_element',arguments:{projectId:code.project.id,expectedRevision:2,sourceId:stable.id,fileHash:stable.fileHash,text:'Must not apply'}});assert.equal(conflict.isError,true);
 const host=await call('design_code_guidance',{projectId:code.project.id,prompt:'Keep the brand; shorten this heading'});assert.equal(host.mode,'host');assert.equal(host.job,undefined);assert.match(host.prompt,/design_code_update/);assert.equal(host.context.pageCount,1);
 const second={id:'page_details',name:'Details',entry:'details.html',route:'/details'};
 await call('design_code_update',{projectId:code.project.id,expectedRevision:3,changes:{pages:[...code.project.pages,second],files:[{path:second.entry,encoding:'utf8',expectedHash:null,content:'<!doctype html><html><body><h1>Actual second page</h1><a href="/">Back home</a></body></html>'}]}});
 const detail=await call('design_code_preview',{projectId:code.project.id,pageId:second.id});assert.equal(detail.pageId,second.id);assert.equal(detail.diagnostics.filter(item=>item.level==='error').length,0);assert.match(detail.html,/Actual second page/);
 const exported=await call('design_code_export',{projectId:code.project.id,format:'html',pageId:second.id});const html=Buffer.from(exported.dataBase64,'base64').toString();assert.ok(html.includes('Isolated source edit'));assert.ok(html.includes('Actual second page'));assert.ok(html.includes('design-page'));assert.ok(!html.includes('data-design-source='));
 const original=(await call('design_code_get',{projectId:code.project.id})).project;
 const archive=await call('design_code_export',{projectId:code.project.id,format:'zip'}), archiveSha256=createHash('sha256').update(Buffer.from(archive.dataBase64,'base64')).digest('hex');
 assert.ok(names.includes('design_code_import_project'));assert.equal(capabilities.projectArchive.importTool,'design_code_import_project');
 const copy=await call('design_code_import_project',{dataBase64:archive.dataBase64,expectedSha256:archiveSha256,name:'Opened from isolated ZIP'});
 assert.notEqual(copy.project.id,original.id);assert.equal(copy.project.revision,1);assert.equal(copy.archiveSha256,archiveSha256);assert.deepEqual(copy.importedFrom,{projectId:original.id,revision:original.revision});
 for(const key of ['files','pages','defaultPageId','viewports','designSystem','comments'])assert.deepEqual(copy.project[key],original[key]);
 const copyHistory=await call('design_code_history',{projectId:copy.project.id});assert.equal(copyHistory.versions.length,1);assert.equal(copyHistory.versions[0].operation,'import');assert.equal(copyHistory.canUndo,false);
 const copySource=await call('design_code_source_status',{projectId:copy.project.id});assert.equal(copySource.connected,false);
 const copyComment=copy.project.comments[0];assert.ok(copyComment);
 const oneComment=await call('design_code_update_comment',{projectId:copy.project.id,expectedRevision:1,commentId:copyComment.id,changes:{status:'resolved'}});assert.equal(oneComment.revision,2);assert.equal(oneComment.comment.status,'resolved');assert.equal(oneComment.project,undefined);
 const commentMetadata=await call('design_code_read_metadata',{projectId:copy.project.id,section:'comments',key:copyComment.id,expectedRevision:2});assert.deepEqual(commentMetadata.items,[oneComment.comment]);
 const changedCopy=(await call('design_code_get',{projectId:copy.project.id})).project;assert.deepEqual(changedCopy.files,copy.project.files);assert.equal(changedCopy.comments.length,copy.project.comments.length);
 const copiedPreview=await call('design_code_preview',{projectId:copy.project.id,pageId:second.id});assert.equal(copiedPreview.diagnostics.filter(item=>item.level==='error').length,0);assert.match(copiedPreview.html,/Actual second page/);
 assert.deepEqual((await call('design_code_get',{projectId:code.project.id})).project,original);
 const unchanged=await call('design_code_get',{projectId:code.project.id,ifRevision:4});assert.equal(unchanged.unchanged,true);
 const guide=await call('design_get_guidance',{brief:'已有品牌的工作台只修改标题'});assert.ok(guide.directions.length>=20);assert.equal(guide.preserveExisting,true);assert.equal(guide.medium,undefined);
 await client.close();await connect();assert.equal((await call('design_code_get',{projectId:code.project.id})).project.pages.length,2);
 const undone=await call('design_code_undo',{projectId:code.project.id,expectedRevision:4});assert.equal(undone.project.pages.length,1);assert.equal(undone.project.revision,5);
 for(const format of [1,2]){
  const unsupportedId=`code_unsupported_${format}`,unsupported=path.join(isolated,'data','code',unsupportedId);const filename=unsupported+'.json';const old=JSON.stringify({current:{schemaVersion:format,id:unsupportedId,name:'Unsupported development data'},past:[],future:[]});await writeFile(filename,old);
  const rejected=await client.callTool({name:'design_code_get',arguments:{projectId:unsupportedId}});assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.code,'UNSUPPORTED_FORMAT');assert.equal(await readFile(filename,'utf8'),old);
 }
 console.log(JSON.stringify({passed:true,version:'0.5.0',isolatedPackage:true,tools:names.length,modelTurns:0,sourceOnly:true,localCaseAssets:packagedCases.length,referenceToolReturnsActualPng:true,boundedMetadataReads:true,singleCommentUpdatePreservesSource:true,immutableExportFallback:true,cssTokensEditRealSource:true,tokenConflictsPreserveSource:true,unchangedTokenKeepsRevision:true,noSceneCompatibility:true,realReactCompilation:true,realPageEntries:true,projectArchiveReopens:true,archiveMetadataPreserved:true,archiveIsNewUnconnectedCopy:true,persistence:true,stableSourceComments:true,conflicts:true,unsupportedFilePreserved:true,hostModeDoesNotSpawn:true}));
}catch(error){if(errors)console.error(errors);throw error;}
finally{await client?.close();await rm(isolated,{recursive:true,force:true});}
