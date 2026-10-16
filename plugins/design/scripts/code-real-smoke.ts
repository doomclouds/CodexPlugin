import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { CodeProjectStore } from '../src/code-project.ts';
import { CodeGenerationRuntime } from '../src/code-generation.ts';
import { exportCodeProject, renderCodeProject } from '../src/code-export.ts';

if(!process.argv.includes('--real-model'))throw new Error('Pass --real-model to use locally signed-in Codex and its actual usage allowance.');
const outputIndex=process.argv.indexOf('--output');const output=outputIndex>=0?process.argv[outputIndex+1]:undefined;
if(output&&!path.isAbsolute(output))throw new Error('--output must be absolute.');
const scratch=await mkdtemp(path.join(tmpdir(),'design-code-real-'));
const store=new CodeProjectStore({dataDir:path.join(scratch,'projects')});const runtime=new CodeGenerationRuntime({timeoutMs:900000});
try{
  const original=await store.create({name:'OFFSHORE · 交互原型实测',template:'react'});
  const started=Date.now();let reported=0;
  let job=await runtime.start({project:original,prompt:'把这个React模板重新设计为虚构夜间电台OFFSHORE的完整互动首页。受众是夜间专注工作者，主要任务是发现节目并切换收听状态。视觉采用深靛蓝夜景、冰青文字、少量琥珀色频率标记；让时间、频率刻度和节目单成为内容与构图依据，避免奶油底、书卷衬线、三卡片营销模板。不要伪造外部音频资源；播放/暂停按钮只改变本地演示状态并明确标注没有接入音频流。节目选择需真实改变当前标题和时段；移动导航可开关，提供键盘focus与桌面/手机响应式。品牌和内容使用自创具体文案，不需要摄影；可用原创CSS/SVG表达波形和夜间信号。复用React状态和语义控件，实现完整可运行源码。查看你收到的真实桌面和手机截图，修正溢出、对比与排版问题。保留应用入口，不输出图层JSON。'});
  while(job.status==='running'){await new Promise(resolve=>setTimeout(resolve,1000));job=runtime.get(job.id);const elapsed=Math.floor((Date.now()-started)/30000);if(elapsed>reported){reported=elapsed;console.log(JSON.stringify({status:job.status,elapsedSeconds:Math.round((Date.now()-started)/1000),stage:job.log.at(-1),verification:job.verification}));}}
  assert.equal(job.status,'completed',job.error);assert.ok(job.changes?.files?.length);assert.equal(job.verification.compiled,true);assert.equal(job.verification.rendered,true);assert.equal(job.verification.modelReviewed,true);
  const project=await store.update(original.id,job.baseRevision,job.changes!);
  const target=output??path.join(scratch,'output');await mkdir(target,{recursive:true});
  await writeFile(path.join(target,'project.json'),JSON.stringify(project,null,2));
  const html=await exportCodeProject(project,'html');await writeFile(path.join(target,'prototype.html'),Buffer.from(html.dataBase64,'base64'));
  for(const viewport of project.viewports.slice(0,2)){const observed=await renderCodeProject(project,{viewportId:viewport.id});await writeFile(path.join(target,`${viewport.id}.png`),observed.png);await writeFile(path.join(target,`${viewport.id}.inspection.json`),JSON.stringify({...observed,png:undefined,pdf:undefined},null,2));}
  const summary={passed:true,realModel:true,elapsedMs:Date.now()-started,filesChanged:job.changes!.files!.length,revision:project.revision,verification:job.verification,log:job.log};
  await writeFile(path.join(target,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await runtime.dispose();await rm(scratch,{recursive:true,force:true});}
