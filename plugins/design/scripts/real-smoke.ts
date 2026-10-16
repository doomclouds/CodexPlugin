import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexDesignRuntime } from '../src/codex.ts';
import { createTemplate } from '../src/templates.ts';
import { applyPatches } from '../src/operations.ts';
import { exportDesign, browserExecutable } from '../src/export.ts';

if(!process.argv.includes('--real-model'))throw new Error('Pass --real-model to use the locally signed-in Codex and its actual usage allowance.');
const outputIndex=process.argv.indexOf('--output');
const outputDirectory=outputIndex>=0?process.argv[outputIndex+1]:undefined;
if(outputDirectory&&!path.isAbsolute(outputDirectory))throw new Error('--output must be an absolute directory.');
const runtime=new CodexDesignRuntime({timeoutMs:600000});
const scratch=await mkdtemp(path.join(tmpdir(),'design-real-model-'));
try{
 const doc=createTemplate('潮汐书局 · 首页设计','blank');
 const started=Date.now();
 const initial=await runtime.start({projectId:doc.id,document:doc,prompt:'为上海独立书店“潮汐书局”设计一张1440宽、1100高的中文首页画板。受众是爱阅读、希望参加线下读书会的成年读者，主要行动是预约本周读书会。选择具有纸本阅读质感的编辑式艺术方向，纸白与深海蓝为主，克制的朱红点缀，中文衬线大标题与清晰的阅读层级。版式要有鲜明主次与有意留白，包含品牌导航、主视觉标题和介绍、真实的活动信息及预约CTA、两本精选书籍。使用自创的具体中文文案，不填lorem ipsum，不用三张同构卡片凑版面。不使用外部图片或链接。请创建至少10个有内容的可编辑节点，复用设计令牌，可用文字与几何构图表达海潮意象。只修改当前设计文档。'});
 let job=initial;let reported=0;
 while(job.status==='running'){await new Promise(resolve=>setTimeout(resolve,500));job=runtime.get(job.id);const elapsed=Math.floor((Date.now()-started)/20000);if(elapsed>reported){reported=elapsed;console.log(JSON.stringify({status:job.status,elapsedSeconds:Math.round((Date.now()-started)/1000),stage:job.log.at(-1)}));}}
 assert.equal(job.status,'completed',job.error);assert.ok(job.output?.length);
 const generated=applyPatches(doc,job.output!);
 const count=(nodes:any[]):number=>nodes.reduce((n,node)=>n+1+count(node.children),0);
 const nodes=generated.artboards.reduce((n,board)=>n+count(board.nodes),0);assert.ok(nodes>=10,'Real generation must create substantive editable nodes.');
 const target=outputDirectory??scratch;
 await writeFile(path.join(target,'design-real-sample.json'),JSON.stringify(generated,null,2));
 for(const format of ['html',...(await browserExecutable()?['png']:[])] as const){const file=await exportDesign(generated,format as 'html'|'png');await writeFile(path.join(target,`design-real-sample.${format}`),Buffer.from(file.dataBase64,'base64'));}
 console.log(JSON.stringify({passed:true,realModel:true,elapsedMs:Date.now()-started,artboards:generated.artboards.length,nodes,patches:job.output!.length,...(outputDirectory?{outputDirectory}:{})}));
}finally{await runtime.dispose();await rm(scratch,{recursive:true,force:true});}
