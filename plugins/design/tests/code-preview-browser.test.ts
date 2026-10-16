import assert from 'node:assert/strict';
import test from 'node:test';
import { browserExecutable } from '../src/export.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';
import { createCodeTemplate } from '../src/code-project.ts';
import type { CodeFile, CodeProject } from '../src/code-project.ts';
import { compileCodeProject, editCodeElement } from '../src/code-preview.ts';

function project(entry:string,files:CodeFile[]):CodeProject{const base=createCodeTemplate('Runtime regression','html');return{...base,entry,files,designSystem:{...base.designSystem,components:[]}};}

test('Chromium runs real React state and contained JSX literal assets',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('App.tsx',[{path:'App.tsx',encoding:'utf8',content:`import React,{useEffect,useState}from'react';export default function App(){const[n,setN]=useState(0);useEffect(()=>{setTimeout(()=>{document.querySelector('button').click();setTimeout(()=>{const image=document.querySelector('img');if(document.querySelector('button').textContent!=='Count 1')throw Error('REACT_STATE_FAILED');if(image.naturalWidth!==2||!image.currentSrc.startsWith('data:image/svg+xml'))throw Error('LOCAL_JSX_ASSET_FAILED');document.querySelector('h1').textContent='React interaction and local asset verified'},70)},70)},[]);return <main><h1>Waiting for runtime</h1><button onClick={()=>setN(v=>v+1)}>Count {n}</button><img src="./pixel.svg" alt="local asset"/></main>}`},{path:'pixel.svg',encoding:'utf8',content:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'}]);
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/data:image\/svg\+xml;base64/);assert.match(original.files[0]!.content,/src="\.\/pixel\.svg"/);
 const result=await inspectCodeHtml(compiled.html,{width:800,height:600,fullPage:false});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('React interaction and local asset verified'));assert.equal(result.blockedRequests,0);
});

test('Chromium retains classic global script handlers and unedited custom CSS semantics',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('index.html',[{path:'index.html',encoding:'utf8',content:`<html><body><h1 id="title">Original</h1><p style="--MyBrand: red; color:var(--MyBrand); font-size:18px">Brand</p><button onclick="greet()">Call global function</button><script>function greet(){const style=getComputedStyle(document.querySelector('p'));if(style.color!=='rgb(255, 0, 0)'||style.fontSize!=='24px')throw Error('UNCHANGED_STYLE_BROKEN');document.getElementById('title').textContent='Classic global and inline CSS verified'}</script><script>setTimeout(()=>document.querySelector('button').click(),70)</script></body></html>`}]);
 const first=await compileCodeProject(original);const selected=first.sources.find(item=>item.tag==='p')!;const changed=editCodeElement(original,{sourceId:selected.id,fileHash:selected.fileHash!,styles:{fontSize:24}});original.files[0]!.content=changed.content;
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);const result=await inspectCodeHtml(compiled.html,{width:800,height:600,fullPage:false});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('Classic global and inline CSS verified'));
});


test('sandboxed local forms run submit handlers without authorizing network form actions',async(context)=>{
 if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; runtime behavior is unverified.');return;}
 const original=project('App.tsx',[{path:'App.tsx',encoding:'utf8',content:`import React,{useEffect,useState}from'react';export default function App(){const[n,setN]=useState(0);useEffect(()=>{const timer=setTimeout(()=>document.querySelector('form').requestSubmit(),80);return()=>clearTimeout(timer)},[]);useEffect(()=>{if(n===1)parent.postMessage({type:'local-form-verified'},'*')},[n]);return <form onSubmit={e=>{e.preventDefault();setN(v=>v+1)}}><button>Submit local action</button><output>{n}</output></form>}`}]);
 const compiled=await compileCodeProject(original,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/form-action 'none'/);
 const escaped=compiled.html.replaceAll('&','&amp;').replaceAll('"','&quot;');
 const wrapper=`<h1>Waiting for form</h1><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&e.data.type==='local-form-verified')document.querySelector('h1').textContent='Sandbox local form verified'})</script><iframe sandbox="allow-scripts allow-forms" srcdoc="${escaped}"></iframe>`;
 const result=await inspectCodeHtml(wrapper,{width:800,height:600,fullPage:false});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('Sandbox local form verified'));assert.equal(result.blockedRequests,0);
});
