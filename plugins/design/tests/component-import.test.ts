import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { importComponentSystem, COMPONENT_SOURCE_ENTRY } from '../src/component-import.ts';
import { CodeProjectStore, codeFileHash, createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import { compileCodeProject } from '../src/code-preview.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';
import { browserExecutable } from '../src/browser.ts';

async function workspace(run:(directory:string,put:(path:string,text:string)=>Promise<void>)=>Promise<void>):Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'design-real-components-'));
 const put=async(path:string,text:string)=>{const target=join(directory,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,text);};
 try{await run(directory,put);}finally{await rm(directory,{recursive:true,force:true});}
}

test('real React components, existing package dependencies, CSS closure and selected API docs produce a detached editable source project',async()=>{
 await workspace(async(directory,put)=>{
  await put('src/Button.tsx',`import React,{useState}from'react';import{label}from'tiny-kit';import './button.css';globalThis.__componentImportMustNotRun=true;export default function RealButton(){const[n,setN]=useState(0);return <button className="real-button" onClick={()=>setN(n+1)}>{label}: {n}<span>source-edit-before</span></button>}`);
  await put('src/button.css','@import "./tokens.css";@font-face{font-family:LocalBrand;src:url(../assets/brand.woff2)}.real-button{background-image:url(../assets/mark.svg);color:var(--brand);font-family:LocalBrand}');
  await put('src/tokens.css',':root{--brand:#d34c35}');await put('assets/mark.svg','<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  await put('assets/brand.woff2','wOF2-binary-resource-fixture');
  await put('api/Button.d.ts','export interface RealButtonProps { disabled?: boolean; }\nexport default function RealButton(props: RealButtonProps): import("react").ReactNode;');
  await put('node_modules/tiny-kit/package.json',JSON.stringify({name:'tiny-kit',version:'1.2.3',exports:{'.':{browser:'./browser.js',default:'./server.js'}}}));
  await put('node_modules/tiny-kit/LICENSE','Fixture package license text, preserved verbatim.');
  await put('node_modules/tiny-kit/browser.js','export const label="Customer real component";');await put('node_modules/tiny-kit/server.js','throw new Error("The browser condition was not honored");export const label="Wrong server entry";');
  const result=await importComponentSystem({directory,entries:[{name:'BrandButton',path:'src/Button.tsx',usage:'<BrandButton /> — uses the customer component and its actual state.'}],typeFiles:['api/Button.d.ts'],notes:'保留客户组件，不改写外观。'});
  assert.equal((globalThis as Record<string,unknown>).__componentImportMustNotRun,undefined);
  assert.equal(result.components[0]!.path,COMPONENT_SOURCE_ENTRY);assert.equal(result.components[0]!.exportName,'BrandButton');
  const sourcePath=result.provenance.fileMap['src/Button.tsx']!,cssPath=result.provenance.fileMap['src/button.css']!;
  const js=result.files.find(file=>file.path===sourcePath)!.content,css=result.files.find(file=>file.path===cssPath)!.content;
  assert.match(js,/useState/);assert.match(js,/source-edit-before/);assert.match(js,/dependencies\//);assert.match(js,/react/);
  const dependency=result.files.find(file=>file.path===result.provenance.fileMap['node_modules/tiny-kit/browser.js']);assert.match(dependency!.content,/Customer real component/);assert.ok(!result.files.some(file=>file.content.includes('Wrong server entry')));
  assert.doesNotMatch(css,/data:/);assert.match(css,/brand\.woff2/);assert.ok(result.files.some(file=>file.path===result.provenance.fileMap['assets/brand.woff2']&&file.encoding==='base64'));assert.ok(result.files.some(file=>file.path===result.provenance.fileMap['src/tokens.css']));
  assert.ok(result.provenance.licenses.some(license=>license.path.endsWith('/LICENSE.txt')));
  assert.equal(result.provenance.packages?.[0]!.name,'tiny-kit');assert.equal(result.provenance.packages?.[0]!.version,'1.2.3');
  for(const path of ['src/Button.tsx','src/button.css','src/tokens.css','assets/mark.svg','assets/brand.woff2','api/Button.d.ts','node_modules/tiny-kit/browser.js'])assert.match(result.provenance.sourceHashes[path]!,/^[a-f0-9]{64}$/);
  const api=result.files.find(file=>file.path===result.provenance.fileMap['api/Button.d.ts'])!;assert.match(api.content,/RealButtonProps/);
  assert.ok(result.files.every(file=>!file.content.includes(directory)));assert.ok(Object.keys(result.provenance.sourceHashes).every(path=>!path.startsWith('/')));
  const original=await readFile(join(directory,'src/Button.tsx'),'utf8');assert.ok(original.includes("import './button.css'"));
  const project=createCodeTemplate('Imported design system','react');project.files=project.files.filter(file=>file.path!=='src/App.tsx');
  project.files.push(...result.files,{path:'src/App.tsx',encoding:'utf8',content:`import React from 'react';import{BrandButton}from'../${COMPONENT_SOURCE_ENTRY}';export default function App(){return <main><h1>Detached component preview</h1><BrandButton/></main>}`});project.designSystem.components=result.components;
  validateCodeProject(project);
  await rm(directory,{recursive:true,force:true});
  const compiled=await compileCodeProject(project);assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/Customer real component/);assert.match(compiled.html,/data:font\/woff2;base64/);
  const editable=project.files.find(file=>file.path===sourcePath)!;editable.content=editable.content.replace('source-edit-before','source-edit-after');
  const edited=await compileCodeProject(project);assert.deepEqual(edited.diagnostics.filter(item=>item.level==='error'),[]);assert.match(edited.html,/source-edit-after/);assert.doesNotMatch(edited.html,/source-edit-before/);
 });
});

test('named exports and explicit CSS inputs are real while unknown exports fail instead of inventing a component',async()=>{
 await workspace(async(directory,put)=>{
  await put('Card.tsx',`import React from'react';export function ActualCard(){return <article>Actual named export</article>}`);await put('brand.css','article{padding:24px;background:#efe9dc}');
  const bundled=await importComponentSystem({directory,entries:[{name:'Card',path:'Card.tsx',exportName:'ActualCard'}],cssFiles:['brand.css']});
  assert.match(bundled.files.find(file=>file.path===bundled.provenance.fileMap['Card.tsx'])!.content,/Actual named export/);assert.match(bundled.files.find(file=>file.path===COMPONENT_SOURCE_ENTRY)!.content,/brand\.css/);assert.ok(!bundled.files.some(file=>file.path.startsWith('vendor/')));
  assert.match(bundled.files.find(file=>file.path==='docs/design-system-guide.md')!.content,/未推测或生成组件 props\/API/);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Missing',path:'Card.tsx',exportName:'DoesNotExist'}]}),/No matching export|not found|does not exist/);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'class',path:'Card.tsx'}]}),/JavaScript identifiers/);
 });
});

test('missing packages, external dependencies and dynamic dependency expressions stop the bundle without backend execution',async()=>{
 await workspace(async(directory,put)=>{
  for(const request of ['missing-customer-package','node:fs','https://cdn.invalid/component.js']){
   await put('Entry.tsx',`import React from'react';import dependency from ${JSON.stringify(request)};globalThis.__componentImportMustNotRun=true;export default function Entry(){return <p>{dependency}</p>}`);
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/missing or unsupported|External URLs|native-module/);
  }
  await put('Entry.tsx',`const name='./unknown.js';export default async function Entry(){return import(name)}`);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/Dynamic component dependency/);
  assert.equal((globalThis as Record<string,unknown>).__componentImportMustNotRun,undefined);
 });
});

test('component entry, transitive symlink and package symlink boundaries are enforced before loading outside code',async()=>{
 const outside=await mkdtemp(join(tmpdir(),'design-components-outside-'));
 try{
  await writeFile(join(outside,'secret.tsx'),'throw Error("outside canary");export default()=>null');
  await workspace(async(directory,put)=>{
   await put('Entry.tsx',`export {default} from './link.tsx'`);await symlink(join(outside,'secret.tsx'),join(directory,'link.tsx'));
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),(error:unknown)=>error instanceof Error&&/outside the selected/.test(error.message)&&!error.message.includes('outside canary'));
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'../secret.tsx'}]}),/contained project-relative/);
   await mkdir(join(directory,'node_modules'));await symlink(outside,join(directory,'node_modules','outside-kit'),'dir');await writeFile(join(outside,'package.json'),JSON.stringify({name:'outside-kit',main:'secret.tsx'}));await put('Entry.tsx',`export{default}from'outside-kit'`);
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/outside the selected/);
  });
 }finally{await rm(outside,{recursive:true,force:true});}
});

test('conditional package exports preserve distinct import and require targets in editable source',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from 'react';import {esm} from 'dual';const {cjs}=require('dual');export default function Entry(){return <h2>{esm} / {cjs}</h2>}`);
  await put('node_modules/dual/package.json',JSON.stringify({name:'dual',exports:{import:'./esm.js',require:'./cjs.cjs'}}));
  await put('node_modules/dual/esm.js','export const esm="IMPORT_BRANCH";');await put('node_modules/dual/cjs.cjs','exports.cjs="REQUIRE_BRANCH";');
  const imported=await importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]});const source=imported.files.find(file=>file.path===imported.provenance.fileMap['Entry.tsx'])!.content;
  assert.match(source,/esm\.js/);assert.match(source,/cjs\.cjs/);assert.ok(imported.files.every(file=>!file.path.split('/').includes('node_modules')));
  const project=createCodeTemplate('Conditional source','react');project.files=project.files.filter(file=>file.path!=='src/App.tsx');project.files.push(...imported.files,{path:'src/App.tsx',encoding:'utf8',content:`export {Entry as default} from '../${COMPONENT_SOURCE_ENTRY}';`});project.designSystem.components=imported.components;
  await rm(directory,{recursive:true,force:true});const preview=await compileCodeProject(validateCodeProject(project));assert.deepEqual(preview.diagnostics.filter(item=>item.level==='error'),[]);assert.match(preview.html,/IMPORT_BRANCH/);assert.match(preview.html,/REQUIRE_BRANCH/);
 });
});

test('type-only relative references and CSS import ranges retain real source, comments, suffixes and license text',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from 'react';import type {Label} from './types';import './style.css';// Preserve this comment.\nexport default function Entry({label}:{label:Label}){return <h2>{label}</h2>}`);
  await put('types.d.ts','export type Label = string;');await put('style.css','/* url(must-not-resolve.png) */ @import url("./tokens.css") screen; .icon{mask:url("./icon.svg#shape")}');await put('tokens.css',':root{--tone:red}');await put('icon.svg','<svg xmlns="http://www.w3.org/2000/svg"><path id="shape" d="M0 0h4v4z"/></svg>');await put('OFL.txt','Actual selected fixture license text.');
  const imported=await importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]});
  const source=imported.files.find(file=>file.path===imported.provenance.fileMap['Entry.tsx'])!.content;assert.match(source,/Preserve this comment/);assert.match(source,/types\.d\.ts/);assert.match(source,/label:Label/);
  const css=imported.files.find(file=>file.path===imported.provenance.fileMap['style.css'])!.content;assert.match(css,/url\(must-not-resolve\.png\)/);assert.match(css,/@import url\("\.\/tokens\.css"\) screen/);assert.match(css,/icon\.svg#shape/);
  const license=imported.provenance.licenses.find(item=>item.sourcePath==='OFL.txt')!;assert.equal(imported.files.find(file=>file.path===license.path)!.content,'Actual selected fixture license text.');assert.match(license.sha256,/^[a-f0-9]{64}$/);
 });
});

test('unclosed dependency and nested SVG resources fail explicitly instead of publishing unused or broken source',async()=>{
 await workspace(async(directory,put)=>{
  for(const code of [
   `export default()=>require?.('missing-package')`,
   `export default()=>require?.resolve('./missing.svg')`,
   `export default()=>module['require']('missing-package')`,
   `const r=require;export default()=>r('missing-package')`,
   `export default()=>new URL('./missing.svg',import.meta.url)`,
   `import React from'react';const logo='./missing.svg';export default()=> <img src={logo}/>` ,
   `import React from'react';export default()=> <div style={{backgroundImage:"url('./missing.svg')"}}/>`,
  ]){await put('Entry.tsx',code);await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/cannot be closed|not closed/);}
  await put('Entry.tsx',`import React from'react';import icon from './icon.svg';export default()=> <img src={icon}/>`);
  for(const svg of ['<svg xmlns="http://www.w3.org/2000/svg"><image href="./raster.png"/></svg>','<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:url(https://outside.invalid/paint.svg)}</style></svg>']){await put('icon.svg',svg);await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/SVG .*resources/);}
  const escapedPath=['','home','other-author','private'].join('/').replaceAll('/',String.raw`\x2f`);
  await put('Entry.tsx',`const local="${escapedPath}";export default()=>local;`);await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/personal path/);
 });
});

test('generated usage/notes and decoded JSON metadata cannot leak source-root or personal paths',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from'react';export default()=> <h2>Portable</h2>`);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}],notes:'Source provenance '+directory}),/nonportable/);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx',usage:'Read '+directory}]}),/nonportable/);
  await put('Entry.tsx',`import React from'react';import {label}from'tiny-kit';export default()=> <h2>{label}</h2>`);
  const escapedOwner=['','Users','review-fixture','private-project'].join('/').replaceAll('/',String.raw`\u002f`);
  await put('node_modules/tiny-kit/package.json',`{"name":"tiny-kit","main":"index.js","owner":"${escapedOwner}"}`);await put('node_modules/tiny-kit/index.js','export const label="Value";');
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/nonportable/);
 });
});

test('actual CSS normalization rejects escaped SVG resource functions and import rules',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from'react';import icon from './icon.svg';export default()=> <img src={icon}/>`);
  const payloads=[
   String.raw`<style>rect{fill:u\72l("https://outside.invalid/paint.svg#x")}</style>`,
   String.raw`<style>rect{fill:u\72l("./paint.svg#x");fill:red}</style>`,
   String.raw`<style>@\69mport "https://outside.invalid/paint.css";rect{fill:red}</style>`,
   String.raw`<style>@\000069mport u\72l("./paint.css");rect{fill:red}</style>`,
   String.raw`<style>:root{--paint:u\72l("https://outside.invalid/paint.svg#x")}rect{fill:var(--paint)}</style>`,
   String.raw`<rect style="fill:u\000072l('https://outside.invalid/paint.svg#x')"/>`,
   String.raw`<rect fill="u\72l('https://outside.invalid/paint.svg#x')"/>`,
  ];
  for(const payload of payloads){await put('icon.svg',`<svg xmlns="http://www.w3.org/2000/svg">${payload}</svg>`);await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/SVG CSS resources/);}
 });
});

test('legal SVG CSS without secondary resources remains unchanged after closure verification',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from'react';import icon from './icon.svg';export default()=> <img src={icon}/>`);
  const assets=[
   String.raw`<svg xmlns="http://www.w3.org/2000/svg"><style>.p\61int{fill:rgb(25 30 50);stroke:#123}</style><rect class="paint" width="8" height="8"/></svg>`,
   String.raw`<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tone"/></defs><style>rect{fill:u\72l("#tone")}</style><rect style="stroke:rgb(20 40 60)" width="8" height="8"/></svg>`,
   String.raw`<svg xmlns="http://www.w3.org/2000/svg"><style>/* image-set("https://outside.invalid/comment.png") */rect{fill:red}text{font-family:"image-set(ordinary-text)"}</style><rect width="8" height="8"/></svg>`,
  ];
  for(const svg of assets){await put('icon.svg',svg);const imported=await importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]});assert.equal(imported.files.find(file=>file.path===imported.provenance.fileMap['icon.svg'])!.content,svg);assert.equal(imported.diagnostics.length,0);}
 });
});

test('unsupported CSS image resource functions fail in SVG and imported stylesheets after identifier normalization',async()=>{
 await workspace(async(directory,put)=>{
  const values=[
   'image-set("https://outside.invalid/image.png" 1x)',
   '-webkit-image-set("./missing.png" 1x)',
   String.raw`i\6d age-set("https://outside.invalid/image.png" 1x)`,
   String.raw`-webkit-i\6d age-set("./missing.png" 1x)`,
   'image("./missing.png", red)',
   'src("./missing.png")',
  ];
  for(const value of values){
   await put('Entry.tsx',`import React from'react';import icon from'./icon.svg';export default()=> <img src={icon}/>`);
   await put('icon.svg',`<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background-image:${value}}</style><rect width="8" height="8"/></svg>`);
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/CSS resource function .*unsupported/);
   await put('Entry.tsx',`import React from'react';import './style.css';export default()=> <h2>CSS resource</h2>`);await put('style.css',`h2{background-image:${value}}`);
   await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/CSS resource function .*unsupported/);
  }
 });
});

test('ordinary CSS strings and comments are not resource function tokens and real url assets remain mapped',async()=>{
 await workspace(async(directory,put)=>{
  await put('Entry.tsx',`import React from'react';import './style.css';export default()=> <h2>Allowed CSS</h2>`);
  const css='/* image-set("https://outside.invalid/comment.png") */h2::after{content:"image-set(ordinary text)"}h2{background-image:url("./icon.svg");clip-path:url(#shape)}';
  await put('style.css',css);await put('icon.svg','<svg xmlns="http://www.w3.org/2000/svg"><path id="shape" d="M0 0h8v8z"/></svg>');
  const imported=await importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]});const saved=imported.files.find(file=>file.path===imported.provenance.fileMap['style.css'])!.content;
  assert.match(saved,/image-set\(ordinary text\)/);assert.match(saved,/image-set\("https:\/\/outside.invalid\/comment.png"\)/);assert.match(saved,/url\(#shape\)/);assert.ok(imported.files.some(file=>file.path===imported.provenance.fileMap['icon.svg']));assert.equal(imported.diagnostics.length,0);
 });
});

test('portable source/license mapping collisions are rejected instead of silently replacing a file',async()=>{
 await workspace(async(directory,put)=>{
  await put('LICENSE','Original license');await put('LICENSE.txt','Different license');
  await put('Entry.tsx',`import React from'react';export default()=> <h2>Collision</h2>`);
  await assert.rejects(importComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/paths collide/);
 });
});

test('editing the imported TSX changes actual detached Chromium DOM while preserving component state handlers and assets',async context=>{
 if(!await browserExecutable()){context.skip('A Chromium browser is unavailable; live component-source editing is unverified.');return;}
 await workspace(async(directory,put)=>{
  await put('src/Panel.tsx',`import React,{useEffect,useState}from'react';import './panel.css';export default function Panel(){const[n,setN]=useState(0);useEffect(()=>{const timer=setTimeout(()=>document.querySelector('button')?.click(),20);return()=>clearTimeout(timer)},[]);return <section><h2>{n?'SOURCE_BEFORE clicked':'SOURCE_BEFORE'}</h2><button onClick={()=>setN(n+1)}>Count {n}</button><img src="../assets/icon.svg"/><svg width="8" height="8"><use href="../assets/icon.svg#shape"/></svg></section>}`);
  await put('src/panel.css','h2{color:#224433}');await put('assets/icon.svg','<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path id="shape" fill="red" d="M0 0h8v8z"/></svg>');
  const imported=await importComponentSystem({directory,entries:[{name:'Panel',path:'src/Panel.tsx'}]});const storeDirectory=await mkdtemp(join(tmpdir(),'design-detached-source-'));const store=new CodeProjectStore({dataDir:storeDirectory});
  try{
   const original=await store.create({name:'Detached editable component',template:'react'});const app=original.files.find(file=>file.path==='src/App.tsx')!;
   let project=await store.update(original.id,original.revision,{files:[...imported.files.map(file=>({...file,expectedHash:null})),{path:app.path,expectedHash:codeFileHash(app),content:`export {Panel as default} from '../${COMPONENT_SOURCE_ENTRY}';`}],designSystem:{...original.designSystem,components:imported.components}});
   await rm(directory,{recursive:true,force:true});const preview=await compileCodeProject(project,{instrument:false});assert.deepEqual(preview.diagnostics.filter(item=>item.level==='error'),[]);
   const before=await inspectCodeHtml(preview.html,{width:800,height:600,waitFor:{selector:'h2',text:'SOURCE_BEFORE clicked'}});assert.deepEqual(before.errors,[]);assert.ok(before.metrics.headings.includes('SOURCE_BEFORE clicked'));assert.equal(before.blockedRequests,0);
   const component=project.files.find(file=>file.path===imported.provenance.fileMap['src/Panel.tsx'])!;project=await store.update(project.id,project.revision,{files:[{path:component.path,expectedHash:codeFileHash(component),content:component.content.replaceAll('SOURCE_BEFORE','SOURCE_AFTER')}]});
   const edited=await compileCodeProject(project,{instrument:false});const after=await inspectCodeHtml(edited.html,{width:800,height:600,waitFor:{selector:'h2',text:'SOURCE_AFTER clicked'}});assert.deepEqual(after.errors,[]);assert.ok(after.metrics.headings.includes('SOURCE_AFTER clicked'));assert.equal(after.blockedRequests,0);
  }finally{await rm(storeDirectory,{recursive:true,force:true});}
 });
});
