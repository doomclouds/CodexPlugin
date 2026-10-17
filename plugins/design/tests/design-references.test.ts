import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DESIGN_REFERENCE_IDS, DESIGN_REFERENCE_LIMITS, DESIGN_REFERENCE_VERSION, getDesignReferenceCatalog, loadDesignReference, validateDesignReferenceSnapshot } from '../src/design-references.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function isolated(run: (root: string, casePath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'design-reference-package-')), path = join(directory, 'skills/design/assets/examples/typographic-event');
  try { await cp(join(packageRoot, 'skills/design/assets/examples/typographic-event'), path, { recursive: true }); await run(directory, path); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('catalog identifies relationships without loading case bytes or pretending to close the visual space', () => {
  const catalog = getDesignReferenceCatalog(); assert.deepEqual(catalog.map(item => item.id), DESIGN_REFERENCE_IDS); assert.equal(new Set(catalog.map(item => item.relation)).size, DESIGN_REFERENCE_IDS.length);
  assert.ok(catalog.every(item => !JSON.stringify(item).includes('dataBase64'))); catalog[0]!.title = 'Changed detached catalog' as any; assert.notEqual(getDesignReferenceCatalog()[0]!.title, 'Changed detached catalog');
});

test('reference contracts retain one case and bounded text while allowing high-quality photographic screenshots',async()=>{
 assert.equal(DESIGN_REFERENCE_LIMITS.imageBytes,2*1024*1024);assert.equal(DESIGN_REFERENCE_LIMITS.totalImageBytes,3*1024*1024);assert.equal(DESIGN_REFERENCE_LIMITS.wireBytes,5*1024*1024);assert.equal(DESIGN_REFERENCE_LIMITS.textCharacters,14000);assert.equal(DESIGN_REFERENCE_LIMITS.sourceCharacters,6000);assert.equal(DESIGN_REFERENCE_LIMITS.sourceFileBytes,128*1024);assert.equal(DESIGN_REFERENCE_LIMITS.images,2);
 for(const referenceId of ['quiet-hospitality','material-catalog'] as const){const payload=await loadDesignReference({referenceId});assert.equal(payload.images.length,2);assert.equal(payload.metadata.assets.filter(asset=>asset.kind==='source').length,1);assert.ok(payload.images.some(image=>image.bytes>512*1024),'The actual photographic case must exercise the former 512 KiB boundary, without discarding either viewport');assert.ok(payload.metadata.budget.imageBytes<=DESIGN_REFERENCE_LIMITS.totalImageBytes);assert.ok(payload.metadata.budget.wireBytes<=DESIGN_REFERENCE_LIMITS.wireBytes);assert.match(payload.content.rules,/哲学立场/);assert.match(payload.content.rules,/实现机制/);assert.match(payload.content.rules,/制作前固定/);assert.match(payload.content.rules,/命中红线回到设计/);assert.ok(!JSON.stringify({metadata:payload.metadata,content:payload.content}).includes('dataBase64'));}
});

test('new service references remain single, task-specific and subordinate to explicit choices or existing systems',async()=>{
 assert.equal((await loadDesignReference({brief:'为博物馆创作展品导览与参观路线',views:[]})).metadata.selectedId,'museum-journey');
 assert.equal((await loadDesignReference({brief:'创建酒店的住宿预约页面',views:[]})).metadata.selectedId,'quiet-hospitality');
 const mixed=await loadDesignReference({brief:'新建一个博物馆导览与酒店住宿预约的组合页面，暂时没有主次',views:[]});assert.equal(mixed.metadata.selectedId,null);assert.match(mixed.metadata.reason,/Multiple task/);
 const negated=await loadDesignReference({brief:'这是博物馆参观导览，不是酒店官网，不要住宿预约风格',views:[]});assert.equal(negated.metadata.selectedId,null);assert.match(negated.metadata.reason,/Negated or conflicting/);
 for(const brief of ['修复酒店预订日期 Bug，其他内容不动','创建酒店新页，保留当前品牌和组件','博物馆藏品管理后台'])assert.equal((await loadDesignReference({brief,views:[]})).metadata.selectedId,null);
 const explicit=await loadDesignReference({referenceId:'typographic-event',brief:'新的operations console，明确借活动页的时间分组',views:[]});assert.equal(explicit.metadata.selectedId,'typographic-event');assert.equal(explicit.metadata.assets.length,2);
 const none=await loadDesignReference({referenceId:'none',brief:'创建博物馆的展品导览',views:[]});assert.equal(none.metadata.selectedId,null);assert.equal(none.content.snippets.length,0);
});

test('the ten-case catalog routes concrete tasks singly and keeps repairs, mixed exploration and existing operations distinct',async()=>{
 const tasks:[string,typeof DESIGN_REFERENCE_IDS[number]|null][]=[
  ['做一个材料目录：展示本地示例材质、剖面、规格和对象选择，支持同尺度对照。','material-catalog'],
  ['做一个公共导向页面，访客在服务中心按无台阶需求选择参观路线，明确地点与路径都是本地示意。','civic-wayfinding'],
  ['为原创声音作品做一个声音工作室探索页面，用本地演示的音色与作品列表组织选择，不接外部音乐服务。','audio-studio'],
  ['设计独立文化档案索引，支持按标签筛选记录、展开条目和返回索引；所有内容都是原创示例。','independent-archive'],
  ['创建运营工作台，管理博物馆导览与酒店订单；主要任务是二十列表格、搜索、失败与恢复，界面为本地样例。','operations-console'],
  ['只修复现有文化档案的标签筛选Bug，保留品牌与其他组件，不要整体重做，也不要新建页面。',null],
  ['我要比较材料目录、公共导向和声音作品三种独立构图，目前未选主方向，先分别探索；不要把它们拼成一页。',null],
 ];
 assert.equal(DESIGN_REFERENCE_IDS.length,10);
 for(const [brief,expected] of tasks){const first=await loadDesignReference({brief,views:[]}),again=await loadDesignReference({brief,views:[]});assert.equal(first.metadata.selectedId,expected,brief);assert.deepEqual(first,again,'Selection and material identity should be deterministic.');assert.equal(first.metadata.assets.filter(asset=>asset.kind==='source').length,expected?1:0);}
 for(const referenceId of ['material-catalog','civic-wayfinding','audio-studio','independent-archive'] as const){
  const explicit=await loadDesignReference({referenceId,brief:tasks[4]![0],views:[]});assert.equal(explicit.metadata.selectedId,referenceId);assert.equal(explicit.metadata.assets.length,2);
  assert.equal((await loadDesignReference({referenceId:'none',brief:getDesignReferenceCatalog().find(item=>item.id===referenceId)!.task,views:[]})).metadata.selectedId,null);
  assert.equal((await loadDesignReference({brief:`创建新页但保留现有品牌和组件。主任务是${getDesignReferenceCatalog().find(item=>item.id===referenceId)!.task}`,views:[]})).metadata.selectedId,null);
 }
 const mixed=await loadDesignReference({brief:tasks[6]![0],views:[]});assert.match(mixed.metadata.reason,/Multiple task/);
 const unknown=await loadDesignReference({brief:'给一个未定义的新项目探索自由表达，尚未确认主要关系',views:[]});assert.equal(unknown.metadata.selectedId,null);assert.match(unknown.metadata.reason,/No specific task/);
});

test('obsolete reference snapshots are explicitly unsupported without a migration path',async()=>{
 const current=await loadDesignReference({referenceId:'none'});assert.equal(current.metadata.version,DESIGN_REFERENCE_VERSION);for(const version of [1,2]){const old=structuredClone(current);(old.metadata as {version:number}).version=version;assert.throws(()=>validateDesignReferenceSnapshot(old),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='DESIGN_REFERENCE_FORMAT'&&'format'in error&&error.format===version&&error instanceof Error&&/not migrated, rewritten or deleted/.test(error.message));assert.equal(old.metadata.version,version);}
});

test('automatic choice uses one clear task relationship, permits none and respects local changes and user freedom', async () => {
  const noResources = { packageRoot: join(tmpdir(), 'nonexistent-design-reference-root') };
  for (const brief of ['Create something expressive and unfamiliar', '只改设计活动页的按钮文案，其他不动', '仅调整交互产品页面的字号', 'Create an event page and an operations console']) {
    const payload = await loadDesignReference({ brief }, noResources); assert.equal(payload.metadata.selectedId, null, brief); assert.ok(payload.metadata.reason); assert.equal(payload.images.length, 0);
  }
  assert.equal((await loadDesignReference({ referenceId: 'none', brief: '设计活动页' }, noResources)).metadata.selectedId, null);
  assert.equal((await loadDesignReference({ brief: '为一个设计活动页创作新的视觉方向', views: [] })).metadata.selectedId, 'typographic-event');
  assert.equal((await loadDesignReference({ referenceId: 'interactive-product', brief: '保留已有品牌，只调整一个参数演示', views: [] })).metadata.selectedId, 'interactive-product');
  await assert.rejects(loadDesignReference({ referenceId: '../private' as any }), /unknown referenceId/);
  await assert.rejects(loadDesignReference({ referenceId: 'typographic-event', views: ['desktop', 'desktop'] }), /at most one desktop/);
});

for (const referenceId of DESIGN_REFERENCE_IDS) test(`packaged ${referenceId} delivers exact screenshot bytes and bounded attributable source excerpts`, async () => {
  const payload = await loadDesignReference({ referenceId }), prefix = 'skills/design/assets/examples/' + referenceId + '/';
  assert.equal(payload.metadata.selectedId, referenceId); assert.equal(payload.images.length, 2); assert.match(payload.content.rules, /不是本次作品/); assert.equal(payload.content.snippets.length, 3);
  const source = await readFile(join(packageRoot, prefix + 'index.html'), 'utf8'), readme = await readFile(join(packageRoot, prefix + 'README.md'), 'utf8');
  assert.equal(payload.content.readme, readme); assert.ok(payload.content.snippets.reduce((sum, snippet) => sum + snippet.text.length, 0) < source.length, 'The worker should receive excerpts, not the whole example source');
  for (const snippet of payload.content.snippets) { assert.equal(source.slice(snippet.start, snippet.end), snippet.text); assert.equal(snippet.sha256, digest(snippet.text)); assert.ok(snippet.partial); assert.equal(snippet.path, prefix + 'index.html'); }
  for (const image of payload.images) { const actual = await readFile(join(packageRoot, image.path)); assert.deepEqual(Buffer.from(image.dataBase64, 'base64'), actual); assert.equal(image.sha256, digest(actual)); assert.equal(image.role, 'design-reference'); assert.equal(image.bytes, actual.length); }
  assert.ok(payload.metadata.budget.textCharacters <= DESIGN_REFERENCE_LIMITS.textCharacters); assert.ok(payload.metadata.budget.imageBytes <= DESIGN_REFERENCE_LIMITS.totalImageBytes); assert.equal(payload.metadata.budget.wireBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(JSON.stringify({ metadata: payload.metadata, content: payload.content }).includes('dataBase64'), false, 'MCP and worker text must not duplicate encoded image bytes');
  assert.deepEqual(validateDesignReferenceSnapshot(payload), payload); assert.doesNotMatch(JSON.stringify(payload.metadata), /\/Users\/|\/tmp\/|https?:\/\//);
});

test('view selection sends only requested real screenshot bytes and remains independent from cwd', async () => {
  const payload = await loadDesignReference({ referenceId: 'interactive-product', views: ['mobile'] }); assert.deepEqual(payload.metadata.views, ['mobile']); assert.equal(payload.images.length, 1); assert.equal(payload.images[0]!.width, 390); assert.equal(payload.images[0]!.height, 844);
  await isolated(async (root, path) => { const fromPackage = await loadDesignReference({ referenceId: 'typographic-event', views: ['desktop'] }, { packageRoot: root }); assert.equal(fromPackage.metadata.assets.length, 3); assert.deepEqual(Buffer.from(fromPackage.images[0]!.dataBase64, 'base64'), await readFile(join(path, 'desktop.png'))); const module = new URL('../src/design-references.ts', import.meta.url).href; const child = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const{loadDesignReference}=await import(${JSON.stringify(module)});const pack=await loadDesignReference({referenceId:'typographic-event',views:['desktop']});console.log(JSON.stringify({id:pack.metadata.selectedId,digest:pack.metadata.digest}))`], { cwd: root }); assert.deepEqual(JSON.parse(child.stdout), { id: 'typographic-event', digest: fromPackage.metadata.digest }); });
});

test('missing files, symlinked files and symlinked case parents fail without silently dropping the requested reference', async () => {
  await isolated(async (root, path) => { await unlink(join(path, 'mobile.png')); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /required packaged resource is missing/); });
  await isolated(async (root, path) => { const actual = join(root, 'outside-readme'); await writeFile(actual, 'Outside package case'); await unlink(join(path, 'README.md')); await symlink(actual, join(path, 'README.md')); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /symlinked packaged/); });
  const root = await mkdtemp(join(tmpdir(), 'design-reference-symlink-parent-'));
  try { await cp(join(packageRoot, 'skills'), join(root, 'skills'), { recursive: true }); const path = join(root, 'skills/design/assets/examples/typographic-event'); await rm(path, { recursive: true }); await symlink(join(packageRoot, 'skills/design/assets/examples/typographic-event'), path, 'dir'); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /symlinked packaged/); } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversized resources, invalid PNGs and external references are explicit diagnostics before inference', async () => {
  await isolated(async (root, path) => { await writeFile(join(path, 'README.md'), 'x'.repeat(DESIGN_REFERENCE_LIMITS.readmeCharacters + 1)); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /README exceeds/); });
  await isolated(async (root, path) => { await writeFile(join(path, 'desktop.png'), Buffer.alloc(DESIGN_REFERENCE_LIMITS.imageBytes + 1)); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /byte budget/); });
  await isolated(async (root, path) => { await writeFile(join(path, 'desktop.png'), 'This is not image data'); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /complete PNG/); });
  await isolated(async (root, path) => { await writeFile(join(path, 'README.md'), 'Read https://outside.invalid/private instead'); await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /external link/); });
});

test('standard SVG namespace declarations are syntax, while identical real links and arbitrary namespaces remain forbidden',async()=>{
 await isolated(async(root,path)=>{
  const source=await readFile(join(path,'index.html'),'utf8');
  await writeFile(join(path,'index.html'),source+'\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink=\'http://www.w3.org/1999/xlink\'><path d="M0 0h1"/></svg>');
  assert.equal((await loadDesignReference({referenceId:'typographic-event',views:[]},{packageRoot:root})).metadata.selectedId,'typographic-event');
  for(const invalid of ['<svg><a href="http://www.w3.org/2000/svg">Linked</a></svg>','<svg xmlns="http://outside.invalid/namespace"></svg>','<svg data-xmlns="http://www.w3.org/2000/svg"></svg>','Namespace documentation: http://www.w3.org/2000/svg']){
   await writeFile(join(path,'index.html'),source+'\n'+invalid);await assert.rejects(loadDesignReference({referenceId:'typographic-event',views:[]},{packageRoot:root}),/external link/);
  }
 });
});

test('persisted snapshots validate resources and exact view identity, not only a caller-supplied digest', async () => {
  const payload = await loadDesignReference({ referenceId: 'typographic-event' });
  for (const mutate of [
    (value: typeof payload) => { value.metadata.assets = value.metadata.assets.filter(asset => asset.kind !== 'readme'); },
    (value: typeof payload) => { value.metadata.assets.push({ ...value.metadata.assets[0]! }); },
    (value: typeof payload) => { value.content.readme += 'Changed text'; },
    (value: typeof payload) => { value.content.snippets = []; },
    (value: typeof payload) => { value.images[1] = { ...value.images[0]! }; },
    (value: typeof payload) => { value.images[0]!.dataBase64 = value.images[0]!.dataBase64.slice(0, -4) + 'AAAA'; },
    (value: typeof payload) => { value.metadata.budget.wireBytes = 0; }
  ]) { const changed = structuredClone(payload); mutate(changed); assert.throws(() => validateDesignReferenceSnapshot(changed), /Design reference:/); }
  const none = await loadDesignReference({ referenceId: 'none' }); none.metadata.title = 'A fabricated case'; assert.throws(() => validateDesignReferenceSnapshot(none), /none selection/);
});

test('two individually permitted PNGs still obey the aggregate reference budget', async () => {
  await isolated(async (root, path) => {
    for (const view of ['desktop', 'mobile']) {
      const png = await readFile(join(path, view + '.png'));let padded=png;
      if(png.length<Math.ceil(1.6*1024*1024)){
        const text = Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(Math.ceil(1.6 * 1024 * 1024) - png.length, 97)]), type = Buffer.from('tEXt'), chunk = Buffer.alloc(text.length + 12);
        chunk.writeUInt32BE(text.length, 0); type.copy(chunk, 4); text.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([type, text])), text.length + 8);
        padded = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
      }
      assert.ok(padded.length <= DESIGN_REFERENCE_LIMITS.imageBytes); await writeFile(join(path, view + '.png'), padded);
    }
    await assert.rejects(loadDesignReference({ referenceId: 'typographic-event' }, { packageRoot: root }), /reference payload exceeds its total budget/);
  });
});
