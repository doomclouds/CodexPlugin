import assert from 'node:assert/strict';
import test from 'node:test';
import { browserExecutable } from '../src/browser.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';
import { exportCodeProject, renderCodeProject } from '../src/code-export.ts';
import { createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { injectCodePageRuntimeLocation } from '../src/code-pages.ts';
import { compileCodeProject } from '../src/code-preview.ts';

function interactivePages():CodeProject{
  const base=createCodeTemplate('Pages </script><script>throw Error("PAYLOAD_ESCAPE")</script>','html');
  return validateCodeProject({...base,files:[
    {path:'home.html',encoding:'utf8',content:`<!doctype html><html><body><h1>Actual HTML home</h1><button onclick="increment()">Increment</button><a href="/details?from=home#content">Details</a><script>var initialSearch=designLocation.search;var counter=0;function increment(){counter++;document.querySelector('button').textContent='HTML count '+counter}setTimeout(()=>{let isolated=false;try{parent.document.body}catch{isolated=true}if(!isolated)throw Error('FRAME_MUST_BE_ISOLATED');if(designLocation.search==='?returned=1'){if(counter!==0)throw Error('HTML_DOCUMENT_DID_NOT_RESET');if(initialSearch!=='?returned=1')throw Error('HTML_INITIAL_ROUTE_DETAILS_LOST');parent.postMessage({type:'proof',value:'home-reset'},'*');return}document.querySelector('button').click();if(counter!==1)throw Error('HTML_HANDLER_FAILED');parent.postMessage({type:'proof',value:'html-state'},'*');document.querySelector('a').click()},20)</script></body></html>`},
    {path:'src/Details.tsx',encoding:'utf8',content:`import React,{useEffect,useState}from'react';const initialLocation={...designLocation};export default function Details(){const[n,setN]=useState(0);useEffect(()=>{const timer=setTimeout(()=>document.querySelector('button').click(),20);return()=>clearTimeout(timer)},[]);useEffect(()=>{if(n===1){if('$&'.replace(/./g,'$&')!=='$&')throw Error('REPLACEMENT_STRING_CORRUPTED');if(designLocation.search!=='?from=home'||designLocation.hash!=='#content')throw Error('ROUTE_DETAILS_LOST');if(initialLocation.search!=='?from=home'||initialLocation.hash!=='#content')throw Error('INITIAL_ROUTE_DETAILS_LOST');parent.postMessage({type:'proof',value:'react-state'},'*');document.querySelector('a').click()}},[n]);return <main id="content"><h1>Actual React details</h1><button onClick={()=>setN(v=>v+1)}>React count {n}</button><a href="/?returned=1#end">Back</a></main>}`}
  ],pages:[{id:'page_home',name:'Home',entry:'home.html',route:'/'},{id:'page_details',name:'Details',entry:'src/Details.tsx',route:'/details'}],defaultPageId:'page_home',designSystem:{tokens:{},components:[],notes:''},viewports:[{id:'desktop',name:'Shared desktop',width:900,height:600},{id:'details_mobile',name:'Details mobile',width:390,height:844,pageId:'page_details'}]});
}

test('standalone export executes HTML and React state, follows actual project routes and returns to a fresh isolated document',async(context)=>{
  if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; cross-page runtime behavior is unverified.');return;}
  const original=interactivePages();const exported=await exportCodeProject(original,'html');let html=Buffer.from(exported.dataBase64,'base64').toString();
  const observer=`<h1 id="proof" style="position:fixed;z-index:10;background:white">Waiting for actual navigation</h1><script>const steps=[];addEventListener('message',event=>{if(event.source!==document.getElementById('design-page').contentWindow||event.data?.type!=='proof')return;steps.push(event.data.value);document.getElementById('proof').textContent=steps.join(' → ');if(steps.join(',')==='html-state,react-state,home-reset')document.getElementById('proof').textContent='HTML React routing and fresh document verified'});dispatchEvent(new MessageEvent('message',{source:window,data:{type:'design:navigate',projectId:${JSON.stringify(original.id)},revision:${original.revision},pageId:'page_home',targetPageId:'page_details'}}));</script>`;
  html=html.replace('</body>',()=>observer+'</body>');
  const result=await inspectCodeHtml(html,{width:900,height:600,fullPage:false,waitFor:{selector:'#proof',text:'HTML React routing and fresh document verified'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('HTML React routing and fresh document verified'),JSON.stringify(result.metrics));assert.equal(result.blockedRequests,0);
});

test('page-specific Chromium render inspects the actual chosen page rather than the exported router shell',async(context)=>{
  if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; page rendering is unverified.');return;}
  const original=interactivePages();original.files[1]!.content=`import React,{useState}from'react';export default function Details(){const[n,setN]=useState(0);return <main><h1>Selected React page only</h1><button onClick={()=>setN(n+1)}>Count {n}</button></main>}`;
  const rendered=await renderCodeProject(original,{viewportId:'details_mobile',fullPage:false});assert.equal(rendered.width,390);assert.equal(rendered.height,844);assert.deepEqual(rendered.errors,[]);assert.ok(rendered.metrics.headings.includes('Selected React page only'));assert.ok(!rendered.metrics.headings.includes('Actual HTML home'));assert.ok(rendered.metrics.controls>0);
});

test('editor-style sandbox srcdoc exposes query and hash during the first React module evaluation',async(context)=>{
  if(!await browserExecutable()){context.skip('A local Chromium browser is unavailable; initial module navigation context is unverified.');return;}
  const original=interactivePages();original.files[1]!.content=`import React from'react';const initial={...designLocation};if(initial.search!=='?first=ui'||initial.hash!=='#module')throw Error('UI_INITIAL_MODULE_LOCATION_MISSING');parent.postMessage({type:'initial-module-proof'},'*');export default function Details(){return <main><h1>Actual first React render</h1></main>}`;
  const compiled=await compileCodeProject(original,{pageId:'page_details',instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);
  const initial=injectCodePageRuntimeLocation(compiled.html,{projectId:original.id,revision:original.revision,pageId:'page_details',search:'?first=ui',hash:'#module'});
  const html=`<h1 id="proof">Waiting for the first module</h1><script>addEventListener('message',event=>{if(event.source===document.getElementById('target')?.contentWindow&&event.data?.type==='initial-module-proof')document.getElementById('proof').textContent='UI initial module location verified'});const frame=document.createElement('iframe');frame.id='target';frame.setAttribute('sandbox','allow-scripts allow-forms');frame.srcdoc=${JSON.stringify(initial).replace(/</g,'\\u003c')};document.body.append(frame)</script>`;
  const result=await inspectCodeHtml(html,{width:900,height:600,fullPage:false,waitFor:{selector:'#proof',text:'UI initial module location verified'}});assert.deepEqual(result.errors,[]);assert.ok(result.metrics.headings.includes('UI initial module location verified'));assert.equal(result.blockedRequests,0);
});
