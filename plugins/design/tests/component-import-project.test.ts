import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeProjectStore, codeFileHash } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { compileCodeProject } from '../src/code-preview.ts';
import { componentLibraryPaths, importComponentSystem, planComponentSystemImport } from '../src/component-import.ts';
import { DesignError } from '../src/validation.ts';

async function workspace(run:(root:string,store:CodeProjectStore,put:(path:string,text:string)=>Promise<void>)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'design-component-libraries-'));
  const store=new CodeProjectStore({dataDir:join(root,'private-store')});
  const put=async(path:string,text:string)=>{const target=join(root,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,text);};
  try{await run(root,store,put);}finally{await rm(root,{recursive:true,force:true});}
}
async function protocol(store:CodeProjectStore,run:(client:Client)=>Promise<void>){
  const {createDesignServer}=await import('../src/server.ts');
  const instance=await createDesignServer({codeStore:store,panelHtml:'<!doctype html><div>Component import protocol fixture</div>'});
  const client=new Client({name:'component-libraries-test',version:'1'});
  const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide);await client.connect(clientSide);
  try{await run(client);}finally{await client.close();await instance.dispose();}
}

test('reimport refuses an occupied component library without overwriting local edits or deleting retained files',async context=>{
  await workspace(async(root,store,put)=>{
    await put('upstream/Button.tsx',`import React from 'react';export default function Button(){return <button>UPSTREAM_ORIGINAL</button>}`);
    const original=await store.create({name:'Repeated component import',template:'react'});
    await protocol(store,async client=>{
      const first=await client.callTool({name:'design_code_import_components',arguments:{projectId:original.id,expectedRevision:original.revision,directory:join(root,'upstream'),entries:[{name:'BrandButton',path:'Button.tsx'}]}});
      assert.ok(!first.isError,JSON.stringify(first));
      const imported=first.structuredContent as unknown as {project:CodeProject;provenance:{fileMap:Record<string,string>}};
      const path=imported.provenance.fileMap['Button.tsx']!,source=imported.project.files.find(file=>file.path===path)!;
      const edited=await store.update(original.id,imported.project.revision,{files:[{path,expectedHash:codeFileHash(source),content:source.content.replace('UPSTREAM_ORIGINAL','LOCAL_HAND_EDIT')},{path:'components/design-system/local-extra.ts',expectedHash:null,content:'export const preserved = "LOCAL_EXTRA";'}]});
      const before=await readFile(join(store.dataDir,edited.id+'.json'),'utf8');
      await put('upstream/Button.tsx',`import React from 'react';export default function Button(){return <button>UPSTREAM_CHANGED</button>}`);
      const repeated=await client.callTool({name:'design_code_import_components',arguments:{projectId:edited.id,expectedRevision:edited.revision,directory:join(root,'upstream'),entries:[{name:'BrandButton',path:'Button.tsx'}]}});
      const actual=await store.get(edited.id);
      context.diagnostic(JSON.stringify({reimportRejected:Boolean(repeated.isError),localHandEditRetained:actual.files.find(file=>file.path===path)?.content.includes('LOCAL_HAND_EDIT'),extraFileRetained:actual.files.some(file=>file.path==='components/design-system/local-extra.ts'),revisionBefore:edited.revision,revisionAfter:actual.revision}));
      assert.equal(repeated.isError,true,'An occupied library must reject reimport instead of replacing user edits.');
      assert.equal(await readFile(join(store.dataDir,edited.id+'.json'),'utf8'),before,'Rejected import must leave the full private record and history unchanged.');
    });
  });
});

test('two real library namespaces accumulate editable components, resources and licenses and compile together',async()=>{
  await workspace(async(root,store,put)=>{
    const font=await readFile(new URL('./fixtures/fonts/IBMPlexMono-Regular.woff2',import.meta.url));
    const ofl=await readFile(new URL('./fixtures/fonts/IBM-Plex-OFL.txt',import.meta.url),'utf8');
    await put('brand/Button.tsx',`import React from 'react';import mark from './mark.svg';import './brand.css';export default function Button(){return <button>ORIGINAL_BRAND_BUTTON<img src={mark} alt="Brand mark"/></button>}`);
    await put('brand/brand.css','@font-face{font-family:ImportedMono;src:url(./brand.woff2)}button{font-family:ImportedMono;color:#c04c22}');
    await writeFile(join(root,'brand/brand.woff2'),font);await put('brand/OFL.txt',ofl);
    await put('brand/mark.svg','<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"><path d="M0 0h6v6z" fill="red"/></svg>');
    await put('cards/Card.tsx',`import React from 'react';import './card.css';export default function Card(){return <article><h2>SECOND_LIBRARY_CARD</h2></article>}`);
    await put('cards/card.css','article{border:2px solid #315148}');
    const cardLicense='Fixture-owned card license text. <!-- <script>must stay inert</script>';
    await put('cards/LICENSE.txt',cardLicense);await put('cards/Card.d.ts','export default function Card(): import("react").ReactNode;');
    let project=await store.create({name:'Accumulating real component libraries',template:'react'});
    project=await store.update(project.id,project.revision,{designSystem:{...project.designSystem,notes:'USER_SYSTEM_NOTES'},comments:[{id:'retained_comment',file:'src/App.tsx',text:'Preserve this existing file comment.',status:'open',createdAt:project.createdAt}]});
    await protocol(store,async client=>{
      const first=await client.callTool({name:'design_code_import_components',arguments:{projectId:project.id,expectedRevision:project.revision,directory:join(root,'brand'),entries:[{name:'BrandButton',path:'Button.tsx'}],cssFiles:['brand.css'],notes:'BRAND_LIBRARY_NOTES'}});
      assert.ok(!first.isError,JSON.stringify(first));
      const brand=first.structuredContent as unknown as {project:CodeProject;paths:ReturnType<typeof componentLibraryPaths>;provenance:{fileMap:Record<string,string>}};
      assert.deepEqual(brand.paths,componentLibraryPaths());
      const brandHashes=Object.fromEntries(brand.project.files.map(file=>[file.path,codeFileHash(file)]));
      const second=await client.callTool({name:'design_code_import_components',arguments:{projectId:project.id,expectedRevision:brand.project.revision,directory:join(root,'cards'),libraryName:'cards',entries:[{name:'Card',path:'Card.tsx'}],cssFiles:['card.css'],typeFiles:['Card.d.ts'],notes:'CARD_LIBRARY_NOTES'}});
      assert.ok(!second.isError,JSON.stringify(second));
      const card=second.structuredContent as unknown as {project:CodeProject;paths:ReturnType<typeof componentLibraryPaths>;guide:string;provenance:{fileMap:Record<string,string>;licenses:Array<{path:string;sha256:string}>}};
      assert.equal(card.guide,card.paths.guide);assert.equal(card.paths.entry,'components/cards/index.ts');
      assert.ok(Object.values(card.provenance.fileMap).every(path=>path.startsWith(card.paths.prefix)));
      for(const [path,sha]of Object.entries(brandHashes))assert.equal(codeFileHash(card.project.files.find(file=>file.path===path)!),sha,'Adding another library must not change '+path);
      assert.deepEqual(card.project.comments,project.comments);
      assert.deepEqual(card.project.designSystem.components.map(item=>item.name),['ActionButton','BrandButton','Card']);
      assert.match(card.project.designSystem.notes,/USER_SYSTEM_NOTES[\s\S]*BRAND_LIBRARY_NOTES[\s\S]*CARD_LIBRARY_NOTES/);
      const guide=card.project.files.find(file=>file.path===card.paths.guide)!;assert.ok(guide.content.includes(card.paths.entry));assert.ok(guide.content.includes(card.paths.provenance));
      assert.ok(card.project.files.some(file=>file.path===card.provenance.fileMap['Card.d.ts']));
      for(const license of card.provenance.licenses)assert.equal(codeFileHash(card.project.files.find(file=>file.path===license.path)!),license.sha256);
      const app=card.project.files.find(file=>file.path==='src/App.tsx')!;
      project=await store.update(project.id,card.project.revision,{files:[{path:app.path,expectedHash:codeFileHash(app),content:`import React from 'react';import{BrandButton}from'../${brand.paths.entry}';import{Card}from'../${card.paths.entry}';export default function App(){return <main><BrandButton/><Card/></main>}`}]});
      await rm(join(root,'brand'),{recursive:true,force:true});await rm(join(root,'cards'),{recursive:true,force:true});
      const compiled=await compileCodeProject(project,{instrument:false});assert.deepEqual(compiled.diagnostics.filter(item=>item.level==='error'),[]);
      assert.match(compiled.html,/ORIGINAL_BRAND_BUTTON/);assert.match(compiled.html,/SECOND_LIBRARY_CARD/);assert.match(compiled.html,/data:font\/woff2;base64/);assert.match(compiled.html,/data:image\/svg\+xml;base64/);
      const inert=/<script type="application\/json" id="design-component-notices">([\s\S]*?)<\/script>/.exec(compiled.html)!;
      assert.ok(inert);const notices=JSON.parse(inert[1]!) as Array<{path:string;text:string}>;
      assert.ok(notices.some(item=>item.path.startsWith(brand.paths.prefix)&&item.text===ofl));assert.ok(notices.some(item=>item.path.startsWith(card.paths.prefix)&&item.text===cardLicense));
      assert.ok(!inert[1]!.includes('<script>'),'License text must stay inert even for a custom library.');
      const bad=structuredClone(project),license=bad.files.find(file=>file.path===card.provenance.licenses[0]!.path)!;license.content+='tampered';
      const rejected=await compileCodeProject(bad);assert.ok(rejected.diagnostics.some(item=>item.level==='error'&&/component license changed/i.test(item.message)));
      const missing=structuredClone(project);missing.files=missing.files.filter(file=>file.path!==card.provenance.licenses[0]!.path);const absent=await compileCodeProject(missing);assert.ok(absent.diagnostics.some(item=>item.level==='error'&&/component license is missing/i.test(item.message)));
    });
  });
});

test('occupied output paths, namespace case aliases and component metadata names reject whole import batches',async()=>{
  await workspace(async(root,store,put)=>{
    await put('source/Card.tsx',`import React from 'react';export default function Card(){return <article>New card</article>}`);
    await protocol(store,async client=>{
      for(const path of ['components/cards/hand-made.ts','docs/cards-guide.md','docs/Cards-provenance.json']){
        let project=await store.create({name:'Occupied import destination',template:'react'});
        project=await store.update(project.id,project.revision,{files:[{path,content:'USER_RETAINED_CONTENT',expectedHash:null}]});
        const record=await readFile(join(store.dataDir,project.id+'.json'),'utf8');
        const rejected=await client.callTool({name:'design_code_import_components',arguments:{projectId:project.id,expectedRevision:project.revision,directory:join(root,'source'),libraryName:'cards',entries:[{name:'Card',path:'Card.tsx'}]}});
        assert.equal(rejected.isError,true,JSON.stringify(rejected));assert.match(JSON.stringify(rejected),/occupied/);
        assert.equal(await readFile(join(store.dataDir,project.id+'.json'),'utf8'),record);
      }
      const project=await store.create({name:'Existing component alias',template:'react'}),before=await readFile(join(store.dataDir,project.id+'.json'),'utf8');
      const alias=await client.callTool({name:'design_code_import_components',arguments:{projectId:project.id,expectedRevision:project.revision,directory:join(root,'source'),libraryName:'cards',entries:[{name:'ActionButton',path:'Card.tsx'}]}});
      assert.equal(alias.isError,true);assert.match(JSON.stringify(alias),/component name conflicts/i);assert.equal(await readFile(join(store.dataDir,project.id+'.json'),'utf8'),before);
    });
  });
});

test('library slugs are bounded safe project namespaces and invalid MCP inputs leave data untouched',async()=>{
  const invalid=['','../outside','cards/elsewhere','Cards','cards--next','cards-','cards_name','cards.name','é','x'.repeat(49),'con','constructor'];
  for(const name of invalid)assert.throws(()=>componentLibraryPaths(name));
  await workspace(async(root,store)=>{
    const project=await store.create({name:'Reject unsafe namespace',template:'html'}),before=await readFile(join(store.dataDir,project.id+'.json'),'utf8');
    await protocol(store,async client=>{
      const tools=await client.listTools();const schema=tools.tools.find(tool=>tool.name==='design_code_import_components')!.inputSchema;assert.ok('libraryName' in schema.properties!);
      for(const libraryName of invalid){const response=await client.callTool({name:'design_code_import_components',arguments:{projectId:project.id,expectedRevision:project.revision,directory:join(root,'does-not-exist'),libraryName,entries:[{name:'Card',path:'Card.tsx'}]}});assert.equal(response.isError,true);}
      assert.equal(await readFile(join(store.dataDir,project.id+'.json'),'utf8'),before);
    });
  });
});

test('a pure import plan adds only absent files and final store CAS rejects a stale batch',async()=>{
  await workspace(async(root,store,put)=>{
    await put('source/Card.tsx',`import React from 'react';export default function Card(){return <article>Card</article>}`);
    const project=await store.create({name:'Append-only import proposal',template:'react'});
    const imported=await importComponentSystem({directory:join(root,'source'),libraryName:'cards',entries:[{name:'Card',path:'Card.tsx'}]});
    const original=JSON.stringify(project),plan=planComponentSystemImport(project,imported);assert.equal(JSON.stringify(project),original);
    assert.ok(plan.changes.files!.every(file=>file.expectedHash===null&&typeof file.content==='string'));
    await store.update(project.id,project.revision,{name:'Changed while importing'});const before=await readFile(join(store.dataDir,project.id+'.json'),'utf8');
    await assert.rejects(store.update(project.id,project.revision,plan.changes),(error:unknown)=>error instanceof DesignError&&error.code==='REVISION_CONFLICT');assert.equal(await readFile(join(store.dataDir,project.id+'.json'),'utf8'),before);
  });
});

test('component license discovery depends on source namespaces rather than descriptive metadata or unrelated provenance names',async()=>{
  await workspace(async(root,store,put)=>{
    await put('source/Card.tsx',`import React from 'react';export default function Card(){return <h2>Library remains licensed</h2>}`);
    await put('source/LICENSE.txt','Actual fixture notice, retained independently of component metadata.');
    const original=await store.create({name:'Manifest discovery boundaries',template:'react'}),imported=await importComponentSystem({directory:join(root,'source'),libraryName:'cards',entries:[{name:'Card',path:'Card.tsx'}]});
    const plan=planComponentSystemImport(original,imported);let project=await store.update(original.id,original.revision,plan.changes);
    const app=project.files.find(file=>file.path==='src/App.tsx')!;
    project=await store.update(project.id,project.revision,{files:[{path:app.path,expectedHash:codeFileHash(app),content:`export{Card as default}from'../${imported.paths.entry}';`},{path:'docs/reed-refinement-provenance.json',expectedHash:null,content:'Non-library bookkeeping is not required to be parsed by the preview.'}]});
    const before=await compileCodeProject(project,{instrument:false});assert.deepEqual(before.diagnostics.filter(item=>item.level==='error'),[]);
    const metadataOnly=structuredClone(project);metadataOnly.designSystem={components:[],notes:'Descriptive registration removed; actual source and license manifest unchanged.'};
    const after=await compileCodeProject(metadataOnly,{instrument:false});assert.deepEqual(after.diagnostics.filter(item=>item.level==='error'),[]);assert.equal(after.renderIdentity,before.renderIdentity);assert.equal(after.html,before.html);assert.match(after.html,/retained independently of component metadata/);
  });
});
