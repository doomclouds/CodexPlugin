import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { bundleComponentSystem } from '../src/component-import.ts';
import { createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import { compileCodeProject } from '../src/code-preview.ts';

async function workspace(run:(directory:string,put:(path:string,text:string)=>Promise<void>)=>Promise<void>):Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'design-real-components-'));
 const put=async(path:string,text:string)=>{const target=join(directory,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,text);};
 try{await run(directory,put);}finally{await rm(directory,{recursive:true,force:true});}
}

test('real React components, existing package dependencies, CSS closure and selected API docs produce a detached self-contained bundle',async()=>{
 await workspace(async(directory,put)=>{
  await put('src/Button.tsx',`import React,{useState}from'react';import{label}from'tiny-kit';import './button.css';globalThis.__componentImportMustNotRun=true;export default function RealButton(){const[n,setN]=useState(0);return <button className="real-button" onClick={()=>setN(n+1)}>{label}: {n}</button>}`);
  await put('src/button.css','@import "./tokens.css";@font-face{font-family:LocalBrand;src:url(../assets/brand.woff2)}.real-button{background-image:url(../assets/mark.svg);color:var(--brand);font-family:LocalBrand}');
  await put('src/tokens.css',':root{--brand:#d34c35}');await put('assets/mark.svg','<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  await put('assets/brand.woff2','wOF2-binary-resource-fixture');
  await put('api/Button.d.ts','export interface RealButtonProps { disabled?: boolean; }\nexport default function RealButton(props: RealButtonProps): import("react").ReactNode;');
  await put('node_modules/tiny-kit/package.json',JSON.stringify({name:'tiny-kit',version:'1.2.3',exports:{'.':{browser:'./browser.js',default:'./server.js'}}}));
  await put('node_modules/tiny-kit/browser.js','export const label="Customer real component";');await put('node_modules/tiny-kit/server.js','throw new Error("The browser condition was not honored");export const label="Wrong server entry";');
  const result=await bundleComponentSystem({directory,entries:[{name:'BrandButton',path:'src/Button.tsx',usage:'<BrandButton /> — uses the customer component and its actual state.'}],typeFiles:['api/Button.d.ts'],notes:'保留客户组件，不改写外观。'});
  assert.equal((globalThis as Record<string,unknown>).__componentImportMustNotRun,undefined);
  assert.equal(result.components[0]!.path,'vendor/design-system.js');assert.equal(result.components[0]!.exportName,'BrandButton');
  const js=result.files.find(file=>file.path==='vendor/design-system.js')!.content,css=result.files.find(file=>file.path==='vendor/design-system.css')!.content;
  assert.match(js,/Customer real component/);assert.doesNotMatch(js,/Wrong server entry/);assert.match(js,/react/);
  assert.match(css,/data:font\/woff2;base64/);assert.match(css,/data:image\/svg\+xml;base64/);assert.match(css,/--brand/);
  assert.equal(result.provenance.packages?.[0]!.name,'tiny-kit');assert.equal(result.provenance.packages?.[0]!.version,'1.2.3');
  for(const path of ['src/Button.tsx','src/button.css','src/tokens.css','assets/mark.svg','assets/brand.woff2','api/Button.d.ts','node_modules/tiny-kit/browser.js'])assert.match(result.provenance.sourceHashes[path]!,/^[a-f0-9]{64}$/);
  const api=result.files.find(file=>file.path.startsWith('docs/design-system-api/'))!;assert.match(api.content,/RealButtonProps/);
  assert.ok(result.files.every(file=>!file.content.includes(directory)));assert.ok(Object.keys(result.provenance.sourceHashes).every(path=>!path.startsWith('/')));
  const original=await readFile(join(directory,'src/Button.tsx'),'utf8');assert.ok(original.includes("import './button.css'"));
  const project=createCodeTemplate('Imported design system','react');project.files=project.files.filter(file=>file.path!=='src/App.tsx');
  project.files.push(...result.files,{path:'src/App.tsx',encoding:'utf8',content:`import React from 'react';import{BrandButton}from'../vendor/design-system.js';import'../vendor/design-system.css';export default function App(){return <main><h1>Detached component preview</h1><BrandButton/></main>}`});project.designSystem.components=result.components;
  validateCodeProject(project);
  await rm(directory,{recursive:true,force:true});
  const compiled=await compileCodeProject(project);assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);assert.match(compiled.html,/Customer real component/);assert.match(compiled.html,/data:font\/woff2;base64/);
 });
});

test('named exports and explicit CSS inputs are real while unknown exports fail instead of inventing a component',async()=>{
 await workspace(async(directory,put)=>{
  await put('Card.tsx',`import React from'react';export function ActualCard(){return <article>Actual named export</article>}`);await put('brand.css','article{padding:24px;background:#efe9dc}');
  const bundled=await bundleComponentSystem({directory,entries:[{name:'Card',path:'Card.tsx',exportName:'ActualCard'}],cssFiles:['brand.css']});
  assert.match(bundled.files.find(file=>file.path==='vendor/design-system.js')!.content,/Actual named export/);assert.ok(bundled.files.some(file=>file.path==='vendor/design-system.css'));
  assert.match(bundled.files.find(file=>file.path==='docs/design-system-guide.md')!.content,/未推测或生成组件 props\/API/);
  await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Missing',path:'Card.tsx',exportName:'DoesNotExist'}]}),/No matching export|not found|does not exist/);
  await assert.rejects(bundleComponentSystem({directory,entries:[{name:'class',path:'Card.tsx'}]}),/JavaScript identifiers/);
 });
});

test('missing packages, external dependencies and dynamic dependency expressions stop the bundle without backend execution',async()=>{
 await workspace(async(directory,put)=>{
  for(const request of ['missing-customer-package','node:fs','https://cdn.invalid/component.js']){
   await put('Entry.tsx',`import React from'react';import dependency from ${JSON.stringify(request)};globalThis.__componentImportMustNotRun=true;export default function Entry(){return <p>{dependency}</p>}`);
   await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/missing or unsupported|External URLs|native-module/);
  }
  await put('Entry.tsx',`const name='./unknown.js';export default async function Entry(){return import(name)}`);
  await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/Dynamic component dependency/);
  assert.equal((globalThis as Record<string,unknown>).__componentImportMustNotRun,undefined);
 });
});

test('component entry, transitive symlink and package symlink boundaries are enforced before loading outside code',async()=>{
 const outside=await mkdtemp(join(tmpdir(),'design-components-outside-'));
 try{
  await writeFile(join(outside,'secret.tsx'),'throw Error("outside canary");export default()=>null');
  await workspace(async(directory,put)=>{
   await put('Entry.tsx',`export {default} from './link.tsx'`);await symlink(join(outside,'secret.tsx'),join(directory,'link.tsx'));
   await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),(error:unknown)=>error instanceof Error&&/outside the selected/.test(error.message)&&!error.message.includes('outside canary'));
   await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Entry',path:'../secret.tsx'}]}),/contained project-relative/);
   await mkdir(join(directory,'node_modules'));await symlink(outside,join(directory,'node_modules','outside-kit'),'dir');await writeFile(join(outside,'package.json'),JSON.stringify({name:'outside-kit',main:'secret.tsx'}));await put('Entry.tsx',`export{default}from'outside-kit'`);
   await assert.rejects(bundleComponentSystem({directory,entries:[{name:'Entry',path:'Entry.tsx'}]}),/outside the selected/);
  });
 }finally{await rm(outside,{recursive:true,force:true});}
});
