import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { browserExecutable } from "../src/browser.ts";
import { inspectCodeHtml } from "../src/code-browser.ts";
import { createCodeTemplate } from "../src/code-project.ts";
import { compileCodeProject } from "../src/code-preview.ts";

test("editor keeps comment identity states and real page choices without recompiling each comment or resetting the live iframe", async context => {
  if (!await browserExecutable()) { context.skip("A local Chromium browser is unavailable; editor interaction remains unverified."); return; }
  const project = createCodeTemplate("Comment page verification", "react");
  project.files = [
    { path: "src/Card.tsx", encoding: "utf8", content: 'export function Card(){return <article data-design-id="shared-card"><h2>Real shared source</h2></article>}' },
    { path: "src/First.tsx", encoding: "utf8", content: 'import {Card} from "./Card";export default function First(){return <main><h1>First actual page</h1><Card/><Card/></main>}' },
    { path: "src/Second.tsx", encoding: "utf8", content: 'import {Card} from "./Card";export default function Second(){const visible=false;return <main><h1>Second actual page</h1>{visible&&<Card/>}</main>}' },
    { path: "other.html", encoding: "utf8", content: '<main><h1 data-design-id="other-title">Actual third page</h1></main>' },
  ];
  project.pages = [{ id: "first", name: "第一页面", entry: "src/First.tsx", route: "/" }, { id: "second", name: "第二页面", entry: "src/Second.tsx", route: "/second" }, { id: "other", name: "第三页面", entry: "other.html", route: "/other" }]; project.defaultPageId = "first";
  project.viewports = [{ id: "desktop", name: "Shared", width: 900, height: 600 }];
  const initial = await Promise.all(project.pages.map(page => compileCodeProject(project, { pageId: page.id })));
  const shared = initial[0]!.sources.find(source => source.identity === "stable" && source.file === "src/Card.tsx")!;
  const other = initial[2]!.sources.find(source => source.identity === "stable")!;
  assert.ok(shared); assert.ok(other);
  project.comments = [{ id: "shared_comment", file: shared.file, sourceId: shared.id, text: "A real shared source anchor", status: "open", createdAt: project.createdAt }, { id: "other_comment", file: other.file, sourceId: other.id, text: "A separate real entry", status: "open", createdAt: project.createdAt }];
  const changed = structuredClone(project); changed.revision++;
  changed.files[0]!.content = changed.files[0]!.content.replace(' data-design-id="shared-card"', "");
  const afterRemoval = await Promise.all(changed.pages.map(page => compileCodeProject(changed, { pageId: page.id })));
  const summary = (value: typeof project) => value.files.map(file => ({ path: file.path, sha256: createHash("sha256").update(file.content).digest("hex"), encoding: file.encoding }));
  const data = { project, changed, summaries: { 1: summary(project), 2: summary(changed) }, previews: { 1: Object.fromEntries(initial.map(preview => [preview.pageId, preview])), 2: Object.fromEntries(afterRemoval.map(preview => [preview.pageId, preview])) } };
  const harness = `import {mountCodeEditor} from './ui/code-editor.ts';
const data=${JSON.stringify(data)},calls=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let current=data.project,releaseHistory;
const wait=async test=>{const deadline=Date.now()+10000;while(!test()){if(Date.now()>deadline)throw Error('UI condition was not observed');await delay(10)}};
const expect=(value,message)=>{if(!value)throw Error(message)};
const summary=()=>data.summaries[current.revision];
const app=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){calls.push([name,current.revision,args.pageId]);if(name==='design_code_list')return{projects:[current],unsupported:[]};if(name==='design_code_get')return{project:current,files:summary()};if(name==='design_get_guidance')return{directions:[]};if(name==='design_code_history'){const revision=current.revision;if(revision===1)return new Promise(resolve=>{releaseHistory=()=>resolve({revision:1,versions:[],canUndo:false,canRedo:false})});return{revision,versions:[],canUndo:true,canRedo:false}}if(name==='design_code_preview'){const revision=current.revision;await delay(args.pageId==='first'?10:35);return data.previews[revision][args.pageId]}throw Error('Unexpected tool '+name)},async prompt(){return{status:'not-sent'}}});
const click=selector=>{const button=document.querySelector(selector);expect(button,'Missing control '+selector);button.click()};
const run=async()=>{
 await app.connected();click('[data-right-tab="comments"]');click('[data-action="check-comment-anchors"]');
 expect(document.querySelector('[data-action="undo"]').disabled,'Unknown history must be disabled');
 expect(document.querySelector('[data-comment-location="shared_comment"]').dataset.anchorState==='checking','Initial state must be checking');
 await wait(()=>document.querySelectorAll('[data-comment-page="shared_comment"]').length===2&&document.querySelector('[data-comment-page="other_comment"]'));
 expect(document.querySelector('[data-comment-location="shared_comment"]').dataset.anchorState==='live','Shared source anchor must be live');
 expect(document.querySelector('[data-comment-location="shared_comment"]').textContent.includes('不能区分运行实例'),'Runtime identity limitation must remain visible');
 const frame=document.querySelector('.dc-frame:not([hidden]) iframe');expect(frame,'A real preview iframe is required');
 const draft=document.querySelector('[data-comment-draft]');draft.focus();draft.value='Keep this comment draft';draft.dispatchEvent(new Event('input',{bubbles:true}));
 click('[data-action="check-comment-anchors"]');await delay(3200);
 expect(document.querySelector('.dc-frame:not([hidden]) iframe')===frame,'Registry checks must preserve the live iframe');
 expect(document.querySelector('[data-comment-draft]')===draft&&draft.value==='Keep this comment draft','Registry checks must preserve draft focus and contents');
 expect(calls.filter(call=>call[0]==='design_code_preview').length===3,'Compile once per page, not per comment or retry of already checked pages');
 click('[data-comment-page="shared_comment"][data-page-id="second"]');
 await wait(()=>document.querySelector('.dc-frame:not([hidden])')?.dataset.pageId==='second'&&document.querySelector('.dc-frame:not([hidden]) iframe'));
 expect(document.querySelector('[data-setting="page"]').value==='second','Shared comment page choice must use the requested real page');
 expect(calls.filter(call=>call[0]==='design_code_preview').length===4,'A registry-only page must load its real HTML once when first displayed');
 click('[data-comment-page="other_comment"][data-page-id="other"]');
 await wait(()=>document.querySelector('.dc-frame:not([hidden])')?.dataset.pageId==='other'&&document.querySelector('.dc-frame:not([hidden]) iframe'));
 expect(document.querySelector('[data-setting="page"]').value==='other','Separate-entry comment must navigate to its actual page');
 current=data.changed;app.receive({project:current,files:summary()});click('[data-right-tab="comments"]');click('[data-action="check-comment-anchors"]');
 await wait(()=>document.querySelector('[data-comment-location="shared_comment"]')?.dataset.anchorState==='missing');
 await wait(()=>!document.querySelector('[data-action="undo"]').disabled);
 releaseHistory();await delay(60);
 expect(!document.querySelector('[data-action="undo"]').disabled,'An obsolete history response must not overwrite current availability');
 expect(document.querySelector('[data-action="redo"]').disabled,'Redo must reflect its real empty stack');
 expect(document.querySelectorAll('[data-comment-page="shared_comment"]').length===0,'Removed markers must not offer guessed pages');
 const savedFrame=document.querySelector('.dc-frame:not([hidden]) iframe');click('[data-action="check-comment-anchors"]');await delay(30);
 expect(document.querySelector('[data-comment-location="shared_comment"]').dataset.anchorState==='missing','Missing state must persist before clicking the comment');
 expect(document.querySelector('.dc-frame:not([hidden]) iframe')===savedFrame,'Checking missing comments must not reload the iframe');
 expect(calls.filter(call=>call[0]==='design_code_preview'&&call[1]===2).length===3,'A source revision must check each page once');
 click('[data-comment-anchor="shared_comment"]');
 expect(document.querySelector('[data-source-input]').getAttribute('aria-label').startsWith('src/Card.tsx'),'A missing anchor must retain the exact source-file path');
 expect(document.querySelector('[data-source-input]').value===current.files[0].content,'The source fallback must preserve actual content');
 await app.teardown();document.getElementById('proof').textContent='Comment identity and page navigation verified';document.getElementById('proof').dataset.testDone='true';
};run().catch(async error=>{document.getElementById('proof').textContent='FAILED: '+error.message;document.getElementById('proof').dataset.testDone='true';await app.teardown();throw error});`;
  // Bundle only this test page in memory; never write or refresh the plugin runtime.
  const bundled = await build({ stdin: { contents: harness, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "comment-editor-harness.js" }, bundle: true, platform: "browser", format: "iife", target: "es2022", write: false, outfile: "comment-editor.js", logLevel: "silent" });
  const js = bundled.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script");
  const css = bundled.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  const html = `<!doctype html><html><head><style>html,body,#editor{margin:0;height:100%}${css}#proof{position:fixed;bottom:0;left:0;z-index:100;background:white;color:black;font:12px sans-serif}</style></head><body><div id="editor"></div><h1 id="proof">Waiting for actual editor behavior</h1><script>${js}</script></body></html>`;
  const result = await inspectCodeHtml(html, { width: 1440, height: 1000, fullPage: false, waitFor: { selector: "#proof[data-test-done]" } });
  assert.deepEqual(result.errors, []);
  assert.ok(result.metrics.headings.includes("Comment identity and page navigation verified"), JSON.stringify(result.metrics));
  assert.equal(result.blockedRequests, 0);
});
