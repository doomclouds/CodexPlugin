import assert from 'node:assert/strict';
import test from 'node:test';
import { browserExecutable } from '../src/browser.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';
import { createCodeTemplate } from '../src/code-project.ts';
import type { CodeFile, CodeProject } from '../src/code-project.ts';
import { compileCodeProject, editCodeElement } from '../src/code-preview.ts';

function project(entry:string,files:CodeFile[]):CodeProject{const base=createCodeTemplate('Runtime regression','html');return{...base,pages:base.pages.map(page=>({...page,entry})),files,designSystem:{...base.designSystem,components:[]}};}

test('Chromium runs real React state and contained JSX literal assets',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('App.tsx',[{path:'App.tsx',encoding:'utf8',content:`import React,{useEffect,useState}from'react';export default function App(){const[n,setN]=useState(0);useEffect(()=>{setTimeout(()=>{document.querySelector('button').click();setTimeout(()=>{const image=document.querySelector('img');if(document.querySelector('button').textContent!=='Count 1')throw Error('REACT_STATE_FAILED');if(image.naturalWidth!==2||!image.currentSrc.startsWith('data:image/svg+xml'))throw Error('LOCAL_JSX_ASSET_FAILED');document.querySelector('h1').textContent='React interaction and local asset verified'},70)},70)},[]);return <main><h1>Waiting for runtime</h1><button onClick={()=>setN(v=>v+1)}>Count {n}</button><img src="./pixel.svg" alt="local asset"/></main>}`},{path:'pixel.svg',encoding:'utf8',content:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'}]);
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/data:image\/svg\+xml;base64/);assert.match(original.files[0]!.content,/src="\.\/pixel\.svg"/);
 const result=await inspectCodeHtml(compiled.html,{width:800,height:600,fullPage:false,waitFor:{selector:'h1',text:'React interaction and local asset verified'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('React interaction and local asset verified'));assert.equal(result.blockedRequests,0);
});

test('Chromium retains classic global script handlers and unedited custom CSS semantics',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('index.html',[{path:'index.html',encoding:'utf8',content:`<html><body><h1 id="title">Original</h1><p style="--MyBrand: red; color:var(--MyBrand); font-size:18px">Brand</p><button onclick="greet()">Call global function</button><script>function greet(){const style=getComputedStyle(document.querySelector('p'));if(style.color!=='rgb(255, 0, 0)'||style.fontSize!=='24px')throw Error('UNCHANGED_STYLE_BROKEN');document.getElementById('title').textContent='Classic global and inline CSS verified'}</script><script>setTimeout(()=>document.querySelector('button').click(),70)</script></body></html>`}]);
 const first=await compileCodeProject(original);const selected=first.sources.find(item=>item.tag==='p')!;const changed=editCodeElement(original,{sourceId:selected.id,fileHash:selected.fileHash!,styles:{fontSize:24}});original.files[0]!.content=changed.content;
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);const result=await inspectCodeHtml(compiled.html,{width:800,height:600,fullPage:false,waitFor:{selector:'#title',text:'Classic global and inline CSS verified'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('Classic global and inline CSS verified'));
});


test('sandboxed local forms run submit handlers without authorizing network form actions',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('App.tsx',[{path:'App.tsx',encoding:'utf8',content:`import React,{useEffect,useState}from'react';export default function App(){const[n,setN]=useState(0);useEffect(()=>{const timer=setTimeout(()=>document.querySelector('form').requestSubmit(),80);return()=>clearTimeout(timer)},[]);useEffect(()=>{if(n===1)parent.postMessage({type:'local-form-verified'},'*')},[n]);return <form onSubmit={e=>{e.preventDefault();setN(v=>v+1)}}><button>Submit local action</button><output>{n}</output></form>}`}]);
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/form-action 'none'/);
 const escaped=compiled.html.replaceAll('&','&amp;').replaceAll('"','&quot;');
 const wrapper=`<h1>Waiting for form</h1><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&e.data.type==='local-form-verified')document.querySelector('h1').textContent='Sandbox local form verified'})</script><iframe sandbox="allow-scripts allow-forms" srcdoc="${escaped}"></iframe>`;
 const result=await inspectCodeHtml(wrapper,{width:800,height:600,fullPage:false,waitFor:{selector:'h1',text:'Sandbox local form verified'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('Sandbox local form verified'));assert.equal(result.blockedRequests,0);
});

test('comment focus and clicks require source-matching literal evidence while dynamic text and mapped ancestors remain protected',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; selection bridge behavior is unverified.');return;}
 const source=`import React,{useEffect}from'react';export default function App(){const dynamic='Generated state';useEffect(()=>{const child=document.createElement('button');child.id='runtime-child';child.textContent='Runtime child';document.getElementById('ancestor').append(child);document.getElementById('text-inserted').append(document.createTextNode('生成状态'));const receive=event=>{if(event.source===parent&&event.data?.type==='fixture:click')document.getElementById(event.data.id)?.click()};addEventListener('message',receive);parent.postMessage({type:'fixture:ready'},'*');return()=>removeEventListener('message',receive)},[]);return <main><h2 id="title" data-design-id="list-title">待处理与运行队列 &amp; 静态
 中文{"\\n尾行"}</h2><p id="dynamic" data-design-id="dynamic-text">{dynamic}</p><section id="ancestor" data-design-id="runtime-container"></section><div id="text-inserted" data-design-id="runtime-text-container"></div></main>}`;
 const original=project('index.html',[{path:'index.html',encoding:'utf8',content:'<!doctype html><html><body><h1 id="html-title" data-design-id="html-literal">HTML &amp; 中文\n换行</h1><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>'},{path:'App.tsx',encoding:'utf8',content:source},{path:'main.tsx',encoding:'utf8',content:"import React from 'react';import{createRoot}from'react-dom/client';import App from './App';createRoot(document.getElementById('root')).render(<App/>);"}]);const compiled=await compileCodeProject(original);assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);
 const title=compiled.sources.find(item=>item.tag==='h2')!,dynamic=compiled.sources.find(item=>item.tag==='p')!,ancestor=compiled.sources.find(item=>item.tag==='section')!,htmlTitle=compiled.sources.find(item=>item.tag==='h1')!,textInserted=compiled.sources.find(item=>item.tag==='div'&&item.file==='App.tsx')!;assert.equal(title.editableText,true);assert.equal(dynamic.editableText,false);assert.equal(ancestor.editableText,true);
 const steps=[
  {command:{type:'design:focus',sourceId:title.id},sourceId:title.id,literal:true,mapped:false,text:'待处理与运行队列 & 静态 中文\n尾行'},
  {command:{type:'fixture:click',id:'html-title'},sourceId:htmlTitle.id,file:'index.html',literal:true,mapped:false,text:'HTML & 中文\n换行'},
  {command:{type:'design:focus',sourceId:dynamic.id},sourceId:dynamic.id,literal:false,mapped:false,text:'Generated state'},
  {command:{type:'fixture:click',id:'runtime-child'},sourceId:ancestor.id,literal:false,mapped:true,text:'Runtime child'},
  {command:{type:'design:focus',sourceId:ancestor.id},sourceId:ancestor.id,literal:false,mapped:false,text:'Runtime child'},
  {command:{type:'design:focus',sourceId:textInserted.id},sourceId:textInserted.id,literal:false,mapped:false,text:'生成状态'},
 ];
 const identity={projectId:original.id,revision:original.revision,pageId:original.defaultPageId};
 const observer=`<h1 id="proof">Waiting for selection evidence</h1><script>const identity=${JSON.stringify(identity)},steps=${JSON.stringify(steps)};let index=0;const frame=()=>document.getElementById('prototype');const next=()=>frame().contentWindow.postMessage({...identity,...steps[index].command},'*');addEventListener('message',event=>{if(event.source!==frame()?.contentWindow)return;const data=event.data;try{if(data?.type==='fixture:ready'){next();return}if(data?.type!=='design:selection')return;const expected=steps[index];if(!expected||data.projectId!==identity.projectId||data.revision!==identity.revision||data.pageId!==identity.pageId||data.sourceId!==expected.sourceId||data.file!==(expected.file||'App.tsx')||data.text!==expected.text||data.runtimeLiteralText!==expected.literal||data.ancestorMapped!==expected.mapped||typeof data.computedStyles?.fontSize!=='string')throw Error('Selection evidence mismatch at step '+index);index++;if(index===steps.length){document.getElementById('proof').textContent='Anchor and click literal boundaries verified';document.getElementById('proof').dataset.done='yes'}else next()}catch(error){document.getElementById('proof').textContent=error.message;document.getElementById('proof').dataset.done='yes';throw error}})</script>`;
 const escaped=compiled.html.replaceAll('&','&amp;').replaceAll('"','&quot;');const wrapper=observer+`<iframe id="prototype" sandbox="allow-scripts allow-forms" srcdoc="${escaped}"></iframe>`;
 const result=await inspectCodeHtml(wrapper,{width:900,height:600,fullPage:false,timeoutMs:10000,waitFor:{selector:'#proof[data-done="yes"]'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('Anchor and click literal boundaries verified'),JSON.stringify(result.metrics));assert.equal(result.blockedRequests,0);
});
