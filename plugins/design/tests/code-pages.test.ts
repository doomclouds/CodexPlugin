import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseJavaScript } from '@babel/parser';
import { CodeProjectStore, codeFileHash, createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { canonicalCodeRoute, injectCodePageRuntimeLocation, resolveCodeNavigation, resolveCodePage, resolveCodePageViewport } from '../src/code-pages.ts';
import { compileCodeProject, editCodeElement } from '../src/code-preview.ts';
import { exportCodeProject } from '../src/code-export.ts';

function project():CodeProject {
  const base=createCodeTemplate('Real pages','html');
  return validateCodeProject({...base,files:[{path:'index.html',encoding:'utf8',content:'<h1 data-design-id="home-title">Home source</h1><a href="./settings.html">Settings</a>'},{path:'settings.html',encoding:'utf8',content:'<h1 data-design-id="settings-title">Settings source</h1>'},{path:'src/Details.tsx',encoding:'utf8',content:'export default function Details(){return <h1 data-design-id="details-title">React details source</h1>}'}],pages:[{id:'page_home',name:'Home',entry:'index.html',route:'/'},{id:'page_settings',name:'Settings',entry:'settings.html',route:'/settings'},{id:'page_details',name:'Details',entry:'src/Details.tsx',route:'/details'}],defaultPageId:'page_home',designSystem:{components:[],notes:'Actual sources'},viewports:[{id:'shared_desktop',name:'Desktop',width:1280,height:900},{id:'details_phone',name:'Details phone',width:390,height:844,pageId:'page_details'}]});
}

test('current pages select real HTML or React sources with shared and page-specific viewports',async()=>{
  const original=project();assert.equal(original.schemaVersion,3);assert.ok(!Object.hasOwn(original,'entry'));
  assert.equal(resolveCodePage(original).id,'page_home');
  assert.equal(resolveCodePageViewport(original,{viewportId:'details_phone'}).page.id,'page_details');
  assert.equal(resolveCodePageViewport(original,{pageId:'page_settings'}).viewport.id,'shared_desktop');
  assert.throws(()=>resolveCodePageViewport(original,{pageId:'page_home',viewportId:'details_phone'}),/another page/);
  assert.throws(()=>resolveCodePage(original,'missing'),/not found/);
  const home=await compileCodeProject(original);const details=await compileCodeProject(original,{viewportId:'details_phone'});
  assert.deepEqual(home.diagnostics.filter(item=>item.level==='error'),[]);assert.deepEqual(details.diagnostics.filter(item=>item.level==='error'),[]);
  assert.equal(home.pageId,'page_home');assert.equal(details.pageId,'page_details');assert.deepEqual(details.pages,original.pages);
  assert.equal(home.sources.find(item=>item.tag==='h1')!.file,'index.html');assert.equal(details.sources.find(item=>item.tag==='h1')!.file,'src/Details.tsx');
  const selected=details.sources.find(item=>item.tag==='h1')!;const edited=editCodeElement(original,{sourceId:selected.id,fileHash:selected.fileHash!,text:'Changed details only'});
  assert.equal(edited.file,'src/Details.tsx');assert.match(edited.content,/Changed details only/);assert.match(original.files[0]!.content,/Home source/);
  await assert.rejects(exportCodeProject(original,'html','details_phone','page_home'),/another page/);
  await assert.rejects(exportCodeProject(original,'zip','details_phone','page_home'),/another page/);
  await assert.rejects(exportCodeProject(original,'html',undefined,'missing'),/not found/);
  const exported=await exportCodeProject(original,'html',undefined,'page_settings');const html=Buffer.from(exported.dataBase64,'base64').toString();
  assert.match(html,/"initialPageId":"page_settings"/);assert.match(html,/sandbox="allow-scripts allow-forms"/);assert.doesNotMatch(html,/allow-same-origin/);
});

test('canonical project routes, actual entries and metadata references reject ambiguous or unusable pages',()=>{
  assert.equal(canonicalCodeRoute('/caf%C3%A9'),'/caf%C3%A9');
  for(const route of ['https://outside.invalid','//outside.invalid','relative','/../secret','/%2e%2e/secret','/a//b','/a\\b','/%2fsecret','/%255csecret','/a?x=1','/a#section','/a b'])assert.throws(()=>canonicalCodeRoute(route));
  const original=project();
  assert.throws(()=>validateCodeProject({...original,designSystem:{...original.designSystem,tokens:{ink:'#18231d'}}}),/tokens|Unrecognized key/,'Removed metadata tokens must not enter the current project format.');
  for(const update of [
    {pages:[...original.pages,{id:'page_duplicate',name:'Duplicate',entry:'settings.html',route:'/different'}]},
    {pages:original.pages.map(page=>({...page,route:'/same'}))},
    {pages:original.pages.map(page=>({...page,entry:page.id==='page_home'?'missing.html':page.entry}))},
    {defaultPageId:'missing'},
    {viewports:[{...original.viewports[0]!,pageId:'missing'}]},
    {viewports:[original.viewports[1]!]}
  ])assert.throws(()=>validateCodeProject({...original,...update}));
  const canonicalCollision={...original,pages:original.pages.map((page,index)=>({...page,route:index===0?'/caf%C3%A9':index===1?'/café':page.route}))};assert.throws(()=>validateCodeProject(canonicalCollision),/unique canonical/);
  assert.deepEqual(resolveCodeNavigation(original,'page_home','./settings.html?tab=team#members'),{pageId:'page_home',targetPageId:'page_settings',href:'/settings.html?tab=team#members',hash:'#members',search:'?tab=team'});
  assert.equal(resolveCodeNavigation(original,'page_settings','/details')!.targetPageId,'page_details');
  assert.equal(resolveCodeNavigation(original,'page_home','https://outside.invalid/settings'),undefined);
  assert.equal(resolveCodeNavigation(original,'page_home','javascript:alert(1)'),undefined);
});

test('initial runtime locations replace only the compiled context and reject stale project or page identities',async()=>{
  const original=project(),compiled=await compileCodeProject(original,{pageId:'page_details',instrument:false});
  const location={projectId:original.id,revision:original.revision,pageId:'page_details',search:'?next=</script><script>throw Error("ESCAPE")</script>',hash:'#content'};
  const html=injectCodePageRuntimeLocation(compiled.html,location),marker='<script id="design-page-context" type="application/json">',start=html.indexOf(marker)+marker.length,end=html.indexOf('</script>',start);
  assert.deepEqual(JSON.parse(html.slice(start,end)),location);assert.doesNotMatch(html.slice(start,end),/<script|<\/script/);assert.notEqual(html,compiled.html);
  for(const change of [{projectId:'different'},{revision:original.revision+1},{pageId:'page_home'}])assert.throws(()=>injectCodePageRuntimeLocation(compiled.html,{...location,...change}),/does not match/);
  assert.throws(()=>injectCodePageRuntimeLocation(compiled.html,{...location,search:'not-a-query'}),/bounded local URL/);
});

test('editor srcdoc assignment prepares matching initial runtime context before browser execution',async()=>{
  const source=await readFile(new URL('../ui/code-editor.ts',import.meta.url),'utf8');const ast=parseJavaScript(source,{sourceType:'module',plugins:['typescript']});
  const assignments:any[]=[];const visit=(value:any,callback:(node:any)=>void):void=>{if(!value||typeof value!=='object')return;if(typeof value.type==='string')callback(value);for(const child of Object.values(value))if(Array.isArray(child))for(const item of child)visit(item,callback);else if(child&&typeof child==='object')visit(child,callback);};
  visit(ast,node=>{if(node.type==='AssignmentExpression'&&node.left?.type==='MemberExpression'&&node.left.object?.name==='iframe'&&node.left.property?.name==='srcdoc')assignments.push(node);});
  assert.equal(assignments.length,1);let preparesContext=false;visit(assignments[0].right,node=>{if(node.type==='CallExpression'&&node.callee?.name==='injectCodePageRuntimeLocation')preparesContext=true;});assert.equal(preparesContext,true,'Normal iframe srcdoc must pass through the identity-checked context injector before assignment.');
});

test('page, viewport and file changes persist atomically with history; unsupported versions remain untouched and separately reported',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'design-pages-'));
  try{
    const store=new CodeProjectStore({dataDir:join(directory,'data')});const first=await store.create({name:'Pages',template:'html'});
    const added={id:'page_details',name:'Details',entry:'src/Details.tsx',route:'/details'};
    const second=await store.update(first.id,1,{files:[{path:added.entry,content:'export default ()=> <h1>Details</h1>',expectedHash:null}],pages:[...first.pages,added],defaultPageId:added.id,viewports:[...first.viewports,{id:'details_phone',name:'Phone',width:390,height:844,pageId:added.id}]});
    assert.equal(second.revision,2);assert.equal(resolveCodePage(second).entry,added.entry);
    await assert.rejects(store.update(first.id,2,{files:[{path:added.entry,content:'overwritten',expectedHash:'0'.repeat(64)}],pages:second.pages.filter(page=>page.id!==added.id)}),/hash changed/);
    assert.deepEqual(await store.get(first.id),second);
    const third=await store.undo(first.id,2);assert.deepEqual(third.pages,first.pages);assert.equal(third.defaultPageId,first.defaultPageId);
    const fourth=await new CodeProjectStore({dataDir:store.dataDir}).redo(first.id,3);assert.deepEqual(fourth.pages,second.pages);assert.equal(codeFileHash(fourth.files.at(-1)!),codeFileHash(second.files.at(-1)!));
    const restored=await store.restore(first.id,4,1);assert.deepEqual(restored.pages,first.pages);assert.equal(restored.revision,5);
    const unsupportedFiles=[];
    for(const format of [1,2]){
      const legacyId=`code_unsupported_fixture_${format}`,legacy=JSON.stringify({version:1,current:{...first,schemaVersion:format,id:legacyId,designSystem:{tokens:{ink:'#18231d'},components:[],notes:'never return this source'}}});const filename=join(store.dataDir,legacyId+'.json');await writeFile(filename,legacy);unsupportedFiles.push({id:legacyId,format,filename,legacy});
      await assert.rejects(store.get(legacyId),(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='UNSUPPORTED_FORMAT');
    }
    const listing=await store.list();assert.equal(listing.projects.length,1);assert.equal(listing.unsupported.length,2);assert.doesNotMatch(JSON.stringify(listing),/never return this source|#18231d/);
    for(const item of unsupportedFiles){assert.equal(listing.unsupported.find(entry=>entry.id===item.id)!.format,item.format);assert.equal(await readFile(item.filename,'utf8'),item.legacy);}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('read-only HTML directory import registers separate source pages and keeps the explicitly selected default',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'design-import-pages-'));
  try{
    const source=join(directory,'source');await mkdir(join(source,'account'),{recursive:true});await writeFile(join(source,'index.html'),'<h1>Home</h1>');await writeFile(join(source,'account','settings.html'),'<h1>Settings</h1>');
    const store=new CodeProjectStore({dataDir:join(directory,'data')});const imported=await store.importDirectory({name:'Imported pages',directory:source,entry:'account/settings.html'});
    assert.equal(imported.pages.length,2);assert.equal(resolveCodePage(imported).entry,'account/settings.html');assert.equal(imported.pages.find(page=>page.entry==='index.html')!.route,'/index.html');assert.equal((await store.history(imported.id)).versions[0]!.operation,'import');
  }finally{await rm(directory,{recursive:true,force:true});}
});
