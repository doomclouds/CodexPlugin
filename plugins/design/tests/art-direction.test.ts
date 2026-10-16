import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDesignGuidance, buildArtDirectionPrompt } from '../src/art-direction.ts';
import type { ArtDirectionOptions } from '../src/art-direction.ts';

test('direction cards offer distinct execution contracts and an immutable selected recipe',()=>{
 const catalog=getDesignGuidance();assert.equal(catalog.directions.length,20);assert.equal(new Set(catalog.directions.map(item=>item.id)).size,20);
 const cards=catalog.directions.map(item=>getDesignGuidance({directionId:item.id}).selectedDirection!);
 for(const card of cards){for(const field of ['useFor','avoidWhen','composition','typography','palette','details'] as const)assert.ok(card[field].length>15,`${card.id}.${field}`);assert.ok(card.tasks.length>0);}
 assert.equal(new Set(cards.map(card=>card.composition)).size,20);
 assert.equal(buildArtDirectionPrompt({directionId:'precision'}),getDesignGuidance({directionId:'precision'}).guidance);
 const result=getDesignGuidance({directionId:'precision'});result.selectedDirection!.tasks.push('brand');assert.ok(!getDesignGuidance({directionId:'precision'}).selectedDirection!.tasks.includes('brand'));
});

test('default and explicit direction prompts load only the needed detail and keep a bounded instruction budget',()=>{
 const catalog=getDesignGuidance();assert.equal(catalog.selectedDirection,undefined);assert.deepEqual(catalog.candidates,[]);assert.ok(catalog.guidance.length<4500);
 for(const item of catalog.directions){const selected=getDesignGuidance({directionId:item.id});assert.ok(!catalog.guidance.includes(selected.selectedDirection!.composition),`default loaded ${item.id} recipe`);assert.match(selected.guidance,/构图：/);assert.ok(selected.guidance.length<4000);for(const other of catalog.directions){if(other.id!==item.id)assert.ok(!selected.guidance.includes(getDesignGuidance({directionId:other.id}).selectedDirection!.composition),`selected ${item.id} loaded ${other.id}`);}}
 const exact='create an interface in a new free-form style 赛博水墨，不需要选择预设';const free=getDesignGuidance({brief:exact});assert.ok(free.guidance.includes(exact));assert.equal(free.selectedDirection,undefined);
 assert.throws(()=>getDesignGuidance({directionId:'made-up'}),/Unknown Design direction/);
});

test('explicit task routing wins and specialist obligations compose without replacing the main deliverable',()=>{
 const landing=getDesignGuidance({brief:'为数据分析产品创建一个落地页，复用已有组件库，并有一张真实图表'});
 assert.equal(landing.taskType,'landing');assert.deepEqual(landing.relatedTaskTypes,['data','components']);
 assert.match(landing.guidance,/数据来源、单位与读者要比较的关系/);assert.match(landing.guidance,/实际组件API、provider、依赖/);
 const explicit=getDesignGuidance({brief:'dashboard for charts',taskType:'brand'});assert.equal(explicit.taskType,'brand');assert.ok(explicit.relatedTaskTypes.includes('data'));
 for(const[brief,expected]of [['运营工作台的任务队列','workbench'],['产品设置页的权限管理','workbench'],['为传感器数据做一张趋势图表','data'],['制作一篇深度研究报告','editorial'],['建立组件库的状态与变体规范','components'],['设计一个可复用按钮组件','components'],['验证预约流程的原型','prototype'],['制作品牌识别手册','brand'],['做两个方案对比的决定表','comparison'],['解释缓存边界的机制图','diagram']] as const)assert.equal(getDesignGuidance({brief}).taskType,expected,brief);
});

test('local edits retain the existing brand and unrelated regions even when a direction card is explicitly chosen',()=>{
 const local=getDesignGuidance({brief:'只改当前工作台的按钮文案，保留品牌和其他布局',directionId:'expressive',existingSystem:'Brand uses cobalt actions and an existing Button component.'});
 assert.equal(local.scope,'local');assert.equal(local.preserveExisting,true);assert.equal(local.effort,'quick');assert.deepEqual(local.reviewBudget,{rounds:1,focus:'affected-region'});
 assert.match(local.guidance,/不授权换皮或重排全页/);assert.ok(local.guidance.includes('Brand uses cobalt actions'));assert.deepEqual(local.candidates,[]);
 const newPage=getDesignGuidance({brief:'创建一个全新页面，保留品牌和组件设计系统'});assert.equal(newPage.scope,'new');assert.equal(newPage.preserveExisting,false);assert.match(newPage.guidance,/用户明确要求与参考优先/);
 const system=getDesignGuidance({brief:'只改按钮',scope:'system',effort:'standard'});assert.equal(system.scope,'system');assert.equal(system.effort,'standard');
 const inferredSystem=getDesignGuidance({brief:'跨页面更新设计系统的语义token'});assert.equal(inferredSystem.scope,'system');assert.equal(inferredSystem.taskType,'components');assert.equal(inferredSystem.effort,'standard');
});

test('effort changes the authorized work and evidence scope rather than forcing more options or unrestricted checking',()=>{
 const polish=getDesignGuidance({brief:'对当前页面做局部精修'});assert.equal(polish.effort,'polish');assert.equal(polish.reviewBudget.rounds,2);assert.equal(polish.reviewBudget.focus,'affected-region');assert.deepEqual(polish.candidates,[]);
 const standard=getDesignGuidance({brief:'创建产品官网'});assert.equal(standard.effort,'standard');assert.equal(standard.reviewBudget.rounds,2);assert.equal(standard.reviewBudget.focus,'primary-path');
 assert.equal(getDesignGuidance({brief:'探索三个方案',effort:'quick'}).effort,'quick');
 for(const value of [polish,standard]){assert.match(value.guidance,/真实渲染/);assert.match(value.guidance,/实际操作关键动作并读回状态/);assert.match(value.guidance,/不能给未经校准的质量分数/);assert.match(value.guidance,/预算结束仍有问题就列明保留项/);}
});

test('exploration offers distinct compositions with equal content constraints and preserves an explicit direction',()=>{
 const explored=getDesignGuidance({brief:'给软件落地页探索两种构图'});assert.equal(explored.effort,'explore');assert.equal(explored.candidates.length,2);assert.equal(new Set(explored.candidates.map(item=>item.composition)).size,2);
 assert.notEqual(explored.candidates[0]!.directionId,explored.candidates[1]!.directionId);assert.equal(explored.reviewBudget.focus,'candidate-compositions');assert.match(explored.guidance,/同一内容与约束/);
 const constrained=getDesignGuidance({brief:'只改当前标题，探索三个构图',directionId:'editorial'});assert.equal(constrained.candidates.length,3);assert.ok(constrained.candidates.every(item=>item.directionId==='editorial'));assert.equal(new Set(constrained.candidates.map(item=>item.composition)).size,3);assert.equal(constrained.preserveExisting,true);assert.equal(constrained.reviewBudget.focus,'affected-region');assert.match(constrained.guidance,/局改时仅改变授权区域/);
});

test('guidance uses real code, states and responsive behavior with honest verification limits',()=>{
 const code=getDesignGuidance({brief:'做预约原型'});assert.match(code.guidance,/真实HTML\/React\/TSX\/CSS源码/);assert.match(code.guidance,/真实事件、状态与响应式CSS/);assert.doesNotMatch(code.guidance,/当前交互合同是navigate\/url\/toggle/);assert.match(code.guidance,/没有后端或共享存储就明确本地示例/);
});

test('all returned references and direction anchors are contained in the published skill and carry original, self-contained rules',async()=>{
 const main=await readFile(new URL('../skills/design/references/art-direction.md',import.meta.url),'utf8');const cards=await readFile(new URL('../skills/design/references/direction-cards.md',import.meta.url),'utf8');
 assert.match(main,/这些外部链接不是运行前置资料/);assert.match(main,/未随本技能复制其完整正文/);
 for(const item of getDesignGuidance().directions){const value=getDesignGuidance({directionId:item.id});for(const reference of value.references){assert.ok(reference.startsWith('references/'));assert.ok(!reference.includes('..'));const[file,anchor]=reference.split('#');const content=await readFile(new URL('../skills/design/'+file,import.meta.url),'utf8');if(anchor)assert.ok(content.includes(`id="${anchor}"`));}assert.ok(cards.includes(value.selectedDirection!.composition));}
 assert.doesNotMatch(main+cards,/\/Users\/|\/tmp\/|\.\.\/\.\.\/|docs\/design\//);
});

test('invalid routing and context options fail explicitly without expanding the instruction budget',()=>{
 assert.throws(()=>getDesignGuidance({brief:'x'.repeat(30001)}),/30000/);assert.throws(()=>getDesignGuidance({existingSystem:'x'.repeat(12001)}),/12000/);
 assert.throws(()=>getDesignGuidance({taskType:'__proto__'} as unknown as ArtDirectionOptions),/task type/);assert.throws(()=>getDesignGuidance({effort:'unlimited'} as unknown as ArtDirectionOptions),/effort/);assert.throws(()=>getDesignGuidance({candidateCount:10} as unknown as ArtDirectionOptions),/two or three/);
});
