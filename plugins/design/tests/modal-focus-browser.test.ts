import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { browserExecutable } from "../src/browser.ts";
import { inspectCodeHtml } from "../src/code-browser.ts";
import { CodeProjectStore, summarizeCodeFiles } from "../src/code-project.ts";
import { compileCodeProject } from "../src/code-preview.ts";

test("editor dialogs preserve async source-comparison focus and return to stable current-project triggers", async context => {
  if (!await browserExecutable()) { context.skip("A local Chromium browser is unavailable; dialog focus behavior remains unverified."); return; }
  const directory = await mkdtemp(join(tmpdir(), "design-dialog-focus-"));
  try {
    const source = join(directory, "source"); await mkdir(source);
    const original = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Actual local focus fixture</h1>${Array.from({ length: 100 }, (_, index) => `\n<!-- Source line ${index} -->`).join("")}</body></html>`;
    await writeFile(join(source, "index.html"), original);
    const store = new CodeProjectStore({ dataDir: join(directory, "data") });
    const project = await store.importDirectory({ name: "Dialog focus fixture", directory: source, entry: "index.html" });
    await writeFile(join(source, "index.html"), original.replace("Actual local focus fixture", "Actual directory revision one"));
    const comparison = await store.compareSource(project.id), difference = await store.readSourceDifference(project.id, "index.html");
    await writeFile(join(source, "index.html"), original.replace("Actual local focus fixture", "Actual directory revision two"));
    const reread = await store.readSourceDifference(project.id, "index.html");
    const data = { project, files: summarizeCodeFiles(project), history: await store.history(project.id), status: await store.sourceStatus(project.id), comparison, difference, reread, preview: await compileCodeProject(project) };
    const harness = `import{mountCodeEditor}from'./ui/code-editor.ts';const data=${JSON.stringify(data)},calls=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let reads=0,finishRead;
const expect=(value,message)=>{if(!value)throw Error(message)},wait=async test=>{const deadline=Date.now()+10000;while(!test()){if(Date.now()>deadline)throw Error('UI condition was not observed');await delay(10)}};
const app=mountCodeEditor(document.getElementById('editor'),{async callTool(name,args){calls.push(name);if(name==='design_code_list')return{projects:[data.project],unsupported:[]};if(name==='design_code_get')return{project:data.project,files:data.files};if(name==='design_code_history')return data.history;if(name==='design_get_guidance')return{directions:[]};if(name==='design_code_preview')return data.preview;if(name==='design_code_source_status')return data.status;if(name==='design_code_compare_source')return data.comparison;if(name==='design_code_read_source_difference'){if(++reads===1)return data.difference;return new Promise(resolve=>{finishRead=()=>resolve(data.reread)})}throw Error('Unexpected tool '+name)},async prompt(){return{status:'not-sent'}}});
const click=selector=>{const target=document.querySelector(selector);expect(target,'Missing '+selector);target.focus();target.click();return target};
const key=(name,extra={})=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...extra}));
const run=async()=>{
 await app.connected();await wait(()=>document.querySelector('.dc-frame iframe'));const frame=document.querySelector('.dc-frame iframe');
 click('[data-file="index.html"]');const sourceInput=document.querySelector('[data-source-input]');sourceInput.value+='\\n<!-- unsaved local draft -->';sourceInput.dispatchEvent(new Event('input',{bubbles:true}));click('[data-view="design"]');
 click('[data-left-tab="source"]');await wait(()=>document.querySelector('[data-action="source-compare"]'));click('[data-action="source-compare"]');await wait(()=>document.querySelector('[data-source-diff="index.html"]'));
 click('[data-source-diff="index.html"]');await wait(()=>document.querySelector('.dc-modal textarea'));expect(document.activeElement.matches('[data-modal-key="项目版本"]'),'Opening comparison must enter its first real control');
 expect(document.querySelector('.dc-header').inert&&document.querySelector('.dc-stage').inert,'Background controls and preview must be inert');
 click('[data-action="source-refresh-difference"]');expect(document.querySelector('[data-action="source-refresh-difference"]').disabled,'Reread control must become disabled while pending');expect(document.activeElement.matches('.dc-modal'),'Disabled current action must retain focus in the dialog');
 click('.dc-modal [data-action="close-modal"]');expect(!document.querySelector('.dc-modal'),'Closing a pending read must dismiss the modal');expect(document.activeElement.matches('[data-source-diff="index.html"]'),'Closing must return to the real source-comparison entry');finishRead();await delay(30);expect(!document.querySelector('.dc-modal'),'An obsolete read must not reopen the dialog');
 click('[data-source-diff="index.html"]');await wait(()=>finishRead&&reads===3);finishRead();await wait(()=>document.querySelector('.dc-modal textarea'));
 click('[data-action="source-refresh-difference"]');const close=document.querySelector('.dc-modal [data-action="close-modal"]');close.focus();key('Tab');expect(document.activeElement.matches('[data-modal-key="项目版本"]'),'Tab wrap must skip disabled busy controls');
 let input=document.querySelector('[data-modal-key="项目版本"]');input.focus();input.setSelectionRange(7,23,'backward');input.scrollTop=140;const top=input.scrollTop;document.querySelector('.dc-modal').scrollTop=65;const modalTop=document.querySelector('.dc-modal').scrollTop;expect(top>0&&modalTop>0,'The test must exercise actual control and dialog scrolling');
 document.querySelector('.dc-header [data-action="new"]').click();key('s',{ctrlKey:true});expect(document.querySelector('.dc-modal').getAttribute('aria-label')==='源码对照','Background button must not replace the modal');expect(!calls.includes('design_code_update'),'Modal keyboard shortcuts must not save background drafts');
 finishRead();await wait(()=>!document.querySelector('[data-action="source-refresh-difference"]').disabled);input=document.querySelector('[data-modal-key="项目版本"]');expect(document.activeElement===input,'Async reread must preserve the currently focused source side');expect(input.selectionStart===7&&input.selectionEnd===23&&input.selectionDirection==='backward','Async reread must preserve source selection');const dialog=document.querySelector('.dc-modal'),expectedModalTop=Math.min(modalTop,dialog.scrollHeight-dialog.clientHeight);expect(input.scrollTop===top&&dialog.scrollTop===expectedModalTop,'Async reread must preserve control scroll and the nearest available dialog scroll position');
 expect(document.querySelector('.dc-frame iframe')===frame,'Modal updates must preserve the existing live iframe');expect(document.querySelector('[data-source-input]')===sourceInput&&sourceInput.value.includes('unsaved local draft'),'Background source DOM and draft must be preserved while modal is open');
 key('Escape');expect(!document.querySelector('.dc-modal'),'Escape must dismiss comparison');expect(document.activeElement.matches('[data-source-diff="index.html"]'),'Escape must focus the rebuilt semantic trigger');expect(!document.querySelector('.dc-header').inert&&!document.querySelector('.dc-stage').inert,'Closing must re-enable the background');
 click('.dc-header [data-action="new"]');expect(document.activeElement.matches('[data-new-name]'),'New-project dialog must enter its name input');const name=document.querySelector('[data-new-name]');name.value='Retained project name';name.dispatchEvent(new Event('input',{bubbles:true}));click('[data-template="html"]');expect(document.activeElement.matches('[data-template="html"]'),'Template selection rerender must retain the activated button');expect(document.querySelector('[data-new-name]').value==='Retained project name','Modal rerender must retain the typed project name');key('Escape');expect(document.activeElement.matches('.dc-header [data-action="new"]'),'New-project Escape must restore the current header trigger');
 await app.teardown();document.getElementById('proof').textContent='Modal focus lifecycle verified';document.getElementById('proof').dataset.done='true';
};run().catch(async error=>{document.getElementById('proof').textContent='FAILED: '+error.message;document.getElementById('proof').dataset.done='true';await app.teardown();throw error});`;
    // The bridge replays real local store/compiler results; it creates no host messages or model activity.
    const bundled = await build({ stdin: { contents: harness, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "dialog-focus-harness.js" }, bundle: true, platform: "browser", format: "iife", target: "es2022", write: false, outfile: "dialog-focus.js", logLevel: "silent" });
    const js = bundled.outputFiles.find(file => file.path.endsWith(".js"))!.text.replace(/<\/script/gi, "<\\/script"), css = bundled.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    const html = `<!doctype html><html><head><style>html,body,#editor{margin:0;height:100%}${css}#proof{position:fixed;bottom:0;left:0;z-index:100;color:black;background:white;font:12px sans-serif}</style></head><body><div id="editor"></div><h1 id="proof">Waiting for editor focus</h1><script>${js}</script></body></html>`;
    const result = await inspectCodeHtml(html, { width: 1440, height: 600, fullPage: false, waitFor: { selector: "#proof[data-done]" } });
    assert.deepEqual(result.errors, []); assert.ok(result.metrics.headings.includes("Modal focus lifecycle verified"), JSON.stringify(result.metrics)); assert.equal(result.blockedRequests, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
