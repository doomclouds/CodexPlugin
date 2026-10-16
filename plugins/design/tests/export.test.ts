import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTemplate } from '../src/templates.ts';
import { renderDocument, renderArtboard } from '../src/render.ts';
import { browserExecutable, exportDesign, importHtml, writeProject } from '../src/export.ts';

test('HTML export escapes content, retains editable source and enables only owned prototype actions',()=>{
 const doc=createTemplate('Test','landing');const node=doc.artboards[0]!.nodes.find(n=>n.type==='text')!;
 assert.ok(node);node.text='<script>alert(1)</script>';
 const html=renderDocument(doc,{interactive:true});assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));
 assert.ok(html.includes('application/json'));assert.ok(html.includes('data-node-id'));assert.ok(!html.includes('https://cdn'));
 const imported=importHtml(html,doc);assert.equal(imported.artboards[0]!.nodes.find(n=>n.id===node.id)!.text,node.text);
});
test('interchange HTML accepts text and coordinate edits and rejects stale or unrelated source',()=>{
 const doc=createTemplate('Roundtrip','blank');
 doc.artboards[0]!.nodes.push({id:'title',name:'Title',type:'text',x:12,y:30,width:200,height:40,text:'Before',style:{fill:'transparent',fontSize:24},children:[]});
 const html=renderDocument(doc).replace('left:12px','left:64px').replace('>Before<','>After<');
 const imported=importHtml(html,doc);assert.equal(imported.artboards[0]!.nodes[0]!.text,'After');assert.equal(imported.artboards[0]!.nodes[0]!.x,64);
 assert.throws(()=>importHtml(html,{...doc,revision:2}),/stale/);assert.throws(()=>importHtml('<script>bad()</script>',doc),/no Design document/);
});
test('unchanged source roundtrip preserves tokens and component instances',()=>{
 const doc=createTemplate('Components','landing');
 const imported=importHtml(renderDocument(doc),doc);
 assert.deepEqual(imported,doc);
 const html=renderDocument(doc);const ids=[...html.matchAll(/data-node-id="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
});
test('source synchronization refuses to overwrite external edits and unrelated files',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'design-sync-test-'));
 try{const doc=createTemplate('Sync','mobile');const first=await writeProject(doc,directory);assert.equal(first.files.length,3);
 await writeProject(doc,directory);await writeFile(path.join(directory,'index.html'),'external edit');
 await assert.rejects(writeProject(doc,directory),/Source changed/);assert.equal(await readFile(path.join(directory,'index.html'),'utf8'),'external edit');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('JSON/ZIP/SVG exports contain real deliverables',async()=>{
 const doc=createTemplate('Export','dashboard');
 for(const format of ['json','zip','svg'] as const){const result=await exportDesign(doc,format);const bytes=Buffer.from(result.dataBase64,'base64');assert.ok(bytes.length>100);if(format==='zip')assert.equal(bytes.readUInt32LE(0),0x04034b50);if(format==='json')assert.equal(JSON.parse(bytes.toString()).id,doc.id);if(format==='svg')assert.match(bytes.toString(),/<foreignObject/);}
 assert.match(renderArtboard(doc,doc.artboards[0]!.id),/data-artboard-id/);
});
test('installed Chromium renders an actual PNG and PDF',{timeout:70000},async t=>{
 if(!await browserExecutable()){t.skip('No Chromium browser available');return;}
 const doc=createTemplate('浏览器导出','mobile');
 const png=Buffer.from((await exportDesign(doc,'png')).dataBase64,'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),doc.artboards[0]!.width);assert.equal(png.readUInt32BE(20),doc.artboards[0]!.height);
 const pdf=Buffer.from((await exportDesign(doc,'pdf')).dataBase64,'base64');assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});
