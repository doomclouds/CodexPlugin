import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodeTemplate, codeFileHash } from '../src/code-project.ts';
import type { CodeProject, CodeFile } from '../src/code-project.ts';
import { anchorCodeElement, compileCodeProject, editCodeElement } from '../src/code-preview.ts';
function project(entry:string, files:Array<{path:string;content:string;encoding?:'utf8'|'base64'}>):CodeProject{
 const base=createCodeTemplate('Preview test','html');return{...base,pages:base.pages.map(page=>({...page,entry})),files:files.map(file=>({...file,encoding:file.encoding??'utf8'}))};
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCDcAAAAASUVORK5CYII=';
function noErrors(result:Awaited<ReturnType<typeof compileCodeProject>>):void{assert.deepEqual(result.diagnostics.filter(item=>item.level==='error'),[],JSON.stringify(result.diagnostics));}

test('real WebAssembly compiles HTML scripts, styles and contained image/font assets without executing code',async()=>{
 const original=project('index.html',[
  {path:'index.html',content:'<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1 style="color: red">真实标题</h1><img src="./pixel.png"><script src="./main.js"></script></body></html>'},
  {path:'styles.css',content:'@import "theme.css";@font-face{font-family:Local;src:url(./font.woff2)} h1{background-image:url(./pixel.png)}'},
  {path:'theme.css',content:'body{margin:20px;color:#123456}'},
  {path:'main.js',content:'window.__designPreviewOnly = true; document.querySelector("h1").onclick=()=>{window.__designPreviewOnly=false};'},
  {path:'pixel.png',encoding:'base64',content:png},{path:'font.woff2',encoding:'base64',content:Buffer.from('wOF2fixture').toString('base64')},
 ]);
 const result=await compileCodeProject(original);noErrors(result);
 assert.match(result.html,/data:image\/png;base64/);assert.match(result.html,/data:font\/woff2;base64/);assert.match(result.html,/__designPreviewOnly/);
 assert.equal((globalThis as any).__designPreviewOnly,undefined);assert.match(result.html,/connect-src 'none'/);assert.match(result.html,/frame-src 'none'/);
 const title=result.sources.find(item=>item.tag==='h1')!;assert.equal(title.file,'index.html');assert.equal(title.editableText,true);
 const code=original.files[0]!.content;assert.equal(code.slice(title.start,title.end),'<h1 style="color: red">真实标题</h1>');assert.equal(title.fileHash,codeFileHash(original.files[0]!));
 assert.match(result.html,new RegExp('data-design-source="'+title.id+'"'));assert.match(result.html,/design:selection/);assert.match(result.html,/design:runtime-error/);
 assert.equal(original.files[0]!.content,code);
});

test('real WASM bundles React, TypeScript, CSS and extensionless relative imports with static source spans',async()=>{
 const original=project('index.html',[
  {path:'index.html',content:'<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="./src/main.tsx"></script></body></html>'},
  {path:'src/main.tsx',content:`import React from 'react';import{createRoot}from'react-dom/client';import App from './App';createRoot(document.getElementById('root')!).render(<App/>);`},
  {path:'src/App.tsx',content:`import React,{useState}from'react';import './app.css';export default function App(){const[n,setN]=useState<number>(0);return <main><h1 style={{ color:'red',fontSize:32 }}>Hello world</h1><button onClick={()=>setN(n+1)}>{n}</button></main>;}`},
  {path:'src/app.css',content:'.work{display:grid;gap:16px}'},
 ]);
 const result=await compileCodeProject(original);noErrors(result);assert.match(result.html,/__DesignReact/);assert.match(result.html,/Hello world/);assert.match(result.html,/setN/);
 const title=result.sources.find(item=>item.tag==='h1')!;assert.equal(title.file,'src/App.tsx');assert.equal(title.editableText,true);assert.match(original.files[2]!.content.slice(title.start,title.end),/^<h1.*Hello world<\/h1>$/);
 const button=result.sources.find(item=>item.tag==='button')!;assert.equal(button.editableText,false);
 const exportResult=await compileCodeProject(original,{instrument:false});noErrors(exportResult);assert.doesNotMatch(exportResult.html,/data-design-source=/);assert.match(exportResult.html,/let mode =?"preview"|let mode="preview"/);
});

test('a default exported TSX component mounts once automatically and explicit createRoot stays explicit',async()=>{
 const original=project('App.tsx',[{path:'App.tsx',content:`export default function App(){return <h1>Default component</h1>}`}]);
 const result=await compileCodeProject(original);noErrors(result);assert.match(result.html,/Default component/);assert.match(result.html,/getElementById\("root"\)/);
 const explicit=createCodeTemplate('React template','react');const actual=await compileCodeProject(explicit);noErrors(actual);assert.match(actual.html,/Good work/);
});

test('missing dependencies and source traversal fail clearly without installing or reading host files',async()=>{
 for(const request of ['unbundled-library','node:fs','../../../../private.txt','https://cdn.invalid/runtime.js']){
  const original=project('App.tsx',[{path:'App.tsx',content:`import value from ${JSON.stringify(request)};export default function App(){return <p>{value}</p>}`}]);
  const result=await compileCodeProject(original);assert.ok(result.diagnostics.some(item=>item.level==='error'));assert.match(result.diagnostics.map(item=>item.message).join(' '),/Dependency is not bundled|inside the project|External resource/);
  assert.doesNotMatch(result.html,/unbundled-library/);
 }
});

test('external HTML resources and active embeds are blocked while the preview CSP denies network',async()=>{
 const original=project('index.html',[{path:'index.html',content:'<!doctype html><html><head><script src="https://cdn.invalid/main.js"></script><link rel="stylesheet" href="https://cdn.invalid/main.css"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><img src="https://image.invalid/x.png"><iframe src="https://frame.invalid"></iframe><h1>Contained</h1></body></html>'}]);
 const result=await compileCodeProject(original);noErrors(result);assert.ok(result.diagnostics.filter(item=>item.level==='warning').length>=4);assert.doesNotMatch(result.html,/https:\/\/(?:cdn|image|frame|bad)\.invalid/);assert.match(result.html,/default-src 'none'/);
});

test('HTML literal edits are escaped and change only the selected text and inline style',async()=>{
 const original=project('index.html',[{path:'index.html',content:'<html><body><h1 class="keep" style="color: red; margin: 8px">Old &amp; clear</h1><p>Unchanged</p></body></html>'}]);
 const result=await compileCodeProject(original);noErrors(result);const target=result.sources.find(item=>item.tag==='h1')!;
 const edited=editCodeElement(original,{sourceId:target.id,fileHash:target.fileHash!,text:'New <literal> & safe',styles:{color:'#123456',fontSize:42}});
 assert.equal(edited.expectedHash,codeFileHash(original.files[0]!));assert.equal(edited.file,'index.html');
 assert.match(edited.content,/<h1 class="keep" style="color: #123456; margin: 8px; font-size: 42px" data-design-id="design_[a-f\d]+">New &lt;literal&gt; &amp; safe<\/h1><p>Unchanged<\/p>/);
 assert.throws(()=>editCodeElement(original,{sourceId:target.id,fileHash:'0'.repeat(64),text:'Stale'}),/hash conflict/);
 assert.throws(()=>editCodeElement(original,{sourceId:target.id,fileHash:target.fileHash!,styles:{background:'url(https://bad.invalid)'}}),/unsafe/);
});

test('TSX literal edits preserve unrelated code and reject dynamic text or dynamic styles',async()=>{
 const code=`import React from 'react';const color='red';const rest={};export default function App(){const n=2;return <main><h1 style={{ color:'red',fontSize:32, }}>Hello</h1><button style={{...rest}}>{n}</button><p style={{color}}>Dynamic style</p></main>;}`;
 const original=project('App.tsx',[{path:'App.tsx',content:code}]);const result=await compileCodeProject(original);noErrors(result);const title=result.sources.find(item=>item.tag==='h1')!;
 const edited=editCodeElement(original,{sourceId:title.id,fileHash:title.fileHash!,text:'你好 <literal>',styles:{color:'#abc',lineHeight:1.5}});
 assert.match(edited.content,/<h1 style=\{\{ color:"#abc",fontSize:32, "lineHeight":1.5\}\} data-design-id="design_[a-f\d]+">\{"你好 <literal>"\}<\/h1>/);
 assert.match(edited.content,/<button style=\{\{\.\.\.rest\}\}>\{n\}<\/button><p style=\{\{color\}\}>Dynamic style<\/p>/);
 const button=result.sources.find(item=>item.tag==='button')!;assert.throws(()=>editCodeElement(original,{sourceId:button.id,fileHash:button.fileHash!,text:'New'}),/dynamic text/);
 const paragraph=result.sources.find(item=>item.tag==='p')!;assert.throws(()=>editCodeElement(original,{sourceId:paragraph.id,fileHash:paragraph.fileHash!,styles:{color:'#fff'}}),/Dynamic style/);
 const added=project('App.tsx',[{path:'App.tsx',content:'export default ()=> <h1>First</h1>'}]);const target=(await compileCodeProject(added)).sources.find(item=>item.tag==='h1')!;
 assert.match(editCodeElement(added,{sourceId:target.id,fileHash:target.fileHash!,styles:{fontSize:40}}).content,/style=\{\{"fontSize":40\}\}/);
});

test('persisted markers survive text, style and unrelated prefix changes while unmarked elements can be anchored atomically',async()=>{
 for(const [entry,content]of [['index.html','<html><body><h1 data-source-id="title">Old</h1><p data-design-id="note">Keep</p></body></html>'],['App.tsx',`export default ()=> <main><h1 data-source-id="title">Old</h1><p data-design-id="note">Keep</p></main>`]]){
  const original=project(entry!,[{path:entry!,content:content!}]);const initial=await compileCodeProject(original);noErrors(initial);const title=initial.sources.find(item=>item.tag==='h1')!,note=initial.sources.find(item=>item.tag==='p')!;assert.equal(title.identity,'stable');
  const change=editCodeElement(original,{sourceId:title.id,fileHash:title.fileHash!,text:'A substantially longer title',styles:{color:'navy'}});assert.equal(change.sourceId,title.id);original.files[0]!.content=change.content;
  const later=await compileCodeProject(original);noErrors(later);assert.equal(later.sources.find(item=>item.tag==='h1')!.id,title.id);assert.equal(later.sources.find(item=>item.tag==='p')!.id,note.id);
  original.files[0]!.content='\n\n'+original.files[0]!.content;const moved=await compileCodeProject(original);assert.equal(moved.sources.find(item=>item.tag==='h1')!.id,title.id);assert.equal(moved.sources.find(item=>item.tag==='p')!.id,note.id);
 }
 const original=project('App.tsx',[{path:'App.tsx',content:'export default ()=> <h1>Unmarked</h1>'}]);const before=await compileCodeProject(original);const selected=before.sources.find(item=>item.tag==='h1')!;assert.equal(selected.identity,'ephemeral');
 const anchor=anchorCodeElement(original,{sourceId:selected.id,fileHash:selected.fileHash!});assert.equal(anchor.expectedHash,codeFileHash(original.files[0]!));assert.match(anchor.content,/data-design-id=/);original.files[0]!.content=anchor.content;
 const after=await compileCodeProject(original);assert.equal(after.sources.find(item=>item.tag==='h1')!.id,anchor.sourceId);assert.equal(after.sources.find(item=>item.tag==='h1')!.identity,'stable');
 const edit=editCodeElement(original,{sourceId:anchor.sourceId,fileHash:after.sources.find(item=>item.tag==='h1')!.fileHash!,text:'Still anchored'});assert.equal(edit.sourceId,anchor.sourceId);
 assert.equal((edit.content.match(/data-design-id=/g)??[]).length,1);assert.match(after.html,/design:focus/);
});

test('duplicate stable markers are rejected and dynamic identity ownership is never overwritten',async()=>{
 for(const original of [project('index.html',[{path:'index.html',content:'<h1 data-source-id="same">One</h1><p data-design-id="same">Two</p>'}]),project('App.tsx',[{path:'App.tsx',content:'export default ()=> <main><h1 data-design-id="same">One</h1><p data-source-id="same">Two</p></main>'}])]){
  const result=await compileCodeProject(original);assert.ok(result.diagnostics.some(item=>item.level==='error'&&/Duplicate stable source marker/.test(item.message)));
 }
 const dynamic=project('App.tsx',[{path:'App.tsx',content:`const marker='owned';export default ()=> <h1 data-design-id={marker}>Dynamic identity</h1>`}]);const preview=await compileCodeProject(dynamic);const target=preview.sources.find(item=>item.tag==='h1')!;assert.throws(()=>anchorCodeElement(dynamic,{sourceId:target.id,fileHash:target.fileHash!}),/empty or dynamic/);
});

test('classic JavaScript keeps global source while malformed classic scripts receive actual parser diagnostics',async()=>{
 const original=project('index.html',[{path:'index.html',content:'<button onclick="greet()">Run</button><script>function greet(){window.called=true}</script><script>const broken = ;</script>'}]);
 const result=await compileCodeProject(original);assert.ok(result.diagnostics.some(item=>item.level==='error'&&/Classic script syntax error/.test(item.message)));
});

test('literal CSS editing preserves custom-property case, duplicate declarations and priority, and changes the last JSX key',async()=>{
 const original=project('index.html',[{path:'index.html',content:'<p style="--MyBrand: red; color:var(--MyBrand); padding: 4px !important; padding: 1px; font-size:18px">Brand</p>'}]);const result=await compileCodeProject(original);const target=result.sources.find(item=>item.tag==='p')!;
 const edited=editCodeElement(original,{sourceId:target.id,fileHash:target.fileHash!,styles:{fontSize:24,padding:12}});assert.match(edited.content,/--MyBrand: red; color:var\(--MyBrand\); padding: 12px !important; padding: 1px; font-size:24px/);
 const jsx=project('App.tsx',[{path:'App.tsx',content:`export default ()=> <p style={{ color:'red',color:'blue',fontSize:18 }}>Keep</p>`}]);const compiled=await compileCodeProject(jsx);const selected=compiled.sources.find(item=>item.tag==='p')!;const changed=editCodeElement(jsx,{sourceId:selected.id,fileHash:selected.fileHash!,styles:{color:'green'}});assert.match(changed.content,/color:'red',color:"green",fontSize:18/);
});
