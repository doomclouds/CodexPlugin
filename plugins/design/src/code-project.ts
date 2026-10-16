import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { assertSafeJson, DesignError, idSchema } from "./validation.ts";
import { canonicalCodeRoute, CODE_PAGE_LIMIT, UnsupportedCodeProjectFormatError } from "./code-pages.ts";

export interface CodeFile { path: string; content: string; encoding: "utf8" | "base64" }
export interface CodeFileSummary { path: string; encoding: CodeFile["encoding"]; sha256: string; bytes: number }
export interface CodePage { id:string;name:string;entry:string;route:string }
export interface CodeViewport { id:string;name:string;width:number;height:number;pageId?:string | undefined }
export interface CodeProject {
  schemaVersion: 2; id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  defaultPageId: string; pages: CodePage[]; files: CodeFile[];
  designSystem: { tokens: Record<string, string>; components: Array<{ name: string; path: string; exportName?: string | undefined; usage?: string | undefined }>; notes: string };
  comments: Array<{ id: string; file: string; sourceId?: string | undefined; text: string; status: "open" | "resolved"; createdAt: string }>;
  viewports: CodeViewport[];
}
export interface CodeFileChange { path: string; content?: string | undefined; encoding?: CodeFile["encoding"] | undefined; expectedHash: string | null }
export interface CodeProjectUpdate {
  files?: CodeFileChange[] | undefined; pages?:CodePage[] | undefined;defaultPageId?:string | undefined; name?: string | undefined;
  designSystem?: CodeProject["designSystem"] | undefined; comments?: CodeProject["comments"] | undefined; viewports?: CodeProject["viewports"] | undefined;
}
export interface CodeProjectSummary { id: string; name: string; revision: number; updatedAt: string; defaultPageId: string; pageCount:number; fileCount: number }
export interface CodeProjectListing { projects:CodeProjectSummary[];unsupported:Array<{id:string;format?:number|string;reason:string}> }
export interface CodeProjectRevision { revision: number; createdAt: string; operation: "create" | "import" | "update" | "undo" | "redo" | "restore"; restoredFrom?: number | undefined }

export const CODE_PROJECT_LIMITS = { files: 500, textBytes: 1024 * 1024, assetBytes: 8 * 1024 * 1024, projectBytes: 32 * 1024 * 1024, history: 50, storeBytes: 96 * 1024 * 1024 } as const;
const textExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".md", ".txt", ".svg"]);
const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif", ".woff", ".woff2", ".ttf", ".otf"]);
const blockedSegments = new Set([".git", ".codex", ".agents", "node_modules"]);
const exportManifestName = ".design-code-export.json";

export function validateCodePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512 || /[\\\x00-\x1f\x7f:#?%<>\x22|*]/.test(path) || path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || blockedSegments.has(part.toLowerCase()) || part.toLowerCase() === exportManifestName || part.endsWith(" ") || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) throw new DesignError("VALIDATION", "Code paths must be safe project-relative paths outside reserved directories");
  if (!textExtensions.has(extname(path).toLowerCase()) && !assetExtensions.has(extname(path).toLowerCase())) throw new DesignError("VALIDATION", `Unsupported source or asset extension: ${path}`);
  return path;
}
const pathSchema = z.string().superRefine((path, context) => { try { validateCodePath(path); } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid path" }); } });
const nameSchema = z.string().trim().min(1).max(200);
const routeSchema=z.string().superRefine((value,context)=>{try{canonicalCodeRoute(value);}catch(error){context.addIssue({code:'custom',message:error instanceof Error?error.message:'Invalid page route'});}}).transform(canonicalCodeRoute);
export const codePageSchema: z.ZodType<CodePage> = z.object({id:idSchema,name:nameSchema,entry:pathSchema,route:routeSchema}).strict();
export const codeFileSchema: z.ZodType<CodeFile> = z.object({ path: pathSchema, content: z.string().max(12 * 1024 * 1024), encoding: z.enum(["utf8", "base64"]) }).strict();
const rawProjectSchema: z.ZodType<CodeProject> = z.object({
  schemaVersion: z.literal(2), id: idSchema, name: nameSchema, revision: z.number().int().positive().safe(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  defaultPageId:idSchema,pages:z.array(codePageSchema).min(1).max(CODE_PAGE_LIMIT), files: z.array(codeFileSchema).min(1).max(CODE_PROJECT_LIMITS.files),
  designSystem: z.object({ tokens: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/), z.string().max(1000)).refine((tokens) => Object.keys(tokens).length <= 500), components: z.array(z.object({ name: nameSchema, path: pathSchema, exportName: z.string().min(1).max(200).optional(), usage: z.string().max(10_000).optional() }).strict()).max(500), notes: z.string().max(100_000) }).strict(),
  comments: z.array(z.object({ id: idSchema, file: pathSchema, sourceId: z.string().min(1).max(500).optional(), text: z.string().min(1).max(10_000), status: z.enum(["open", "resolved"]), createdAt: z.string().datetime({ offset: true }) }).strict()).max(2000),
  viewports: z.array(z.object({ id: idSchema, name: nameSchema, width: z.number().int().min(240).max(8192), height: z.number().int().min(240).max(8192),pageId:idSchema.optional() }).strict()).min(1).max(12),
}).strict();

function fileBytes(file: CodeFile): Buffer {
  if (file.encoding === "utf8") {
    if (!textExtensions.has(extname(file.path).toLowerCase()) || file.content.includes("\0") || Buffer.byteLength(file.content) > CODE_PROJECT_LIMITS.textBytes) throw new DesignError("VALIDATION", `Text file is unsupported, contains null bytes, or exceeds 1 MiB: ${file.path}`);
    return Buffer.from(file.content, "utf8");
  }
  if (!assetExtensions.has(extname(file.path).toLowerCase()) || !file.content || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new DesignError("VALIDATION", `Only supported image/font assets may use canonical base64: ${file.path}`);
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length > CODE_PROJECT_LIMITS.assetBytes || bytes.toString("base64") !== file.content) throw new DesignError("VALIDATION", `Asset is invalid or exceeds 8 MiB: ${file.path}`);
  const extension = extname(file.path).toLowerCase(); const signature = bytes.toString("latin1", 0, 12);
  const valid = extension === ".png" ? signature.startsWith("\x89PNG\r\n\x1a\n") : [".jpg", ".jpeg"].includes(extension) ? signature.startsWith("\xff\xd8\xff") : extension === ".webp" ? signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP" : extension === ".gif" ? /^GIF8[79]a/.test(signature) : extension === ".ico" ? signature.startsWith("\0\0\x01\0") : extension === ".avif" ? signature.slice(4, 8) === "ftyp" && /avi[fs]/.test(bytes.toString("ascii", 8, 64)) : extension === ".woff" ? signature.startsWith("wOFF") : extension === ".woff2" ? signature.startsWith("wOF2") : extension === ".otf" ? signature.startsWith("OTTO") : signature.startsWith("\0\x01\0\0") || signature.startsWith("true");
  if (!valid) throw new DesignError("VALIDATION", `Asset signature does not match its image/font extension: ${file.path}`);
  return bytes;
}
export const codeProjectSchema: z.ZodType<CodeProject> = z.any().superRefine((value, context) => {
  try { assertSafeJson(value); } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Unsafe document" }); }
}).pipe(rawProjectSchema).superRefine((project, context) => {
  const paths = new Set<string>(); let total = 0;
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  for (const file of project.files) {
    const key = file.path.toLowerCase(); if (paths.has(key)) fail(`Duplicate or case-colliding file path: ${file.path}`); paths.add(key);
    try { total += fileBytes(file).length; } catch (error) { fail(error instanceof Error ? error.message : "Invalid file"); }
  }
  if (total > CODE_PROJECT_LIMITS.projectBytes || Buffer.byteLength(JSON.stringify(project)) > CODE_PROJECT_LIMITS.projectBytes) fail("Project exceeds its 32 MiB budget");
  const files = new Map(project.files.map((file) => [file.path, file]));
  const pageIds=new Set(project.pages.map((page)=>page.id)),routes=new Set<string>(),entries=new Set<string>();
  if(!pageIds.has(project.defaultPageId))fail('defaultPageId must select an actual project page');
  for(const page of project.pages){if(!files.has(page.entry)||files.get(page.entry)?.encoding!=='utf8'||!['.html','.htm','.js','.mjs','.jsx','.ts','.tsx'].includes(extname(page.entry).toLowerCase()))fail('Each page entry must reference included HTML or browser source');if(routes.has(page.route)||entries.has(page.entry))fail('Pages must have unique canonical routes and actual entries');routes.add(page.route);entries.add(page.entry);}
  for(const viewport of project.viewports)if(viewport.pageId&&!pageIds.has(viewport.pageId))fail('A page-specific viewport references an unknown page');
  for(const page of project.pages)if(!project.viewports.some((viewport)=>!viewport.pageId||viewport.pageId===page.id))fail(`Page ${page.id} has no shared or page-specific viewport`);
  for (const component of project.designSystem.components) if (!files.has(component.path)) fail(`Component source is missing: ${component.path}`);
  const ids = new Set<string>();
  for (const item of [...project.comments, ...project.viewports,...project.pages]) { if (ids.has(item.id)) fail(`Duplicate metadata ID: ${item.id}`); ids.add(item.id); }
  for (const comment of project.comments) if (!files.has(comment.file)) fail(`Comment source file is missing: ${comment.file}`);
});
export function validateCodeProject(value: unknown): CodeProject {
  assertSafeJson(value);if(value&&typeof value==='object'&&'schemaVersion'in value&&value.schemaVersion!==2)throw new UnsupportedCodeProjectFormatError(typeof value.schemaVersion==='number'||typeof value.schemaVersion==='string'?value.schemaVersion:undefined);
  const result = codeProjectSchema.safeParse(value);
  if (!result.success) throw new DesignError("VALIDATION", result.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "project"}: ${issue.message}`).join("; "));
  return result.data;
}
export function codeFileHash(file: CodeFile): string { return createHash("sha256").update(fileBytes(file)).digest("hex"); }
export function summarizeCodeFiles(project: CodeProject): CodeFileSummary[] { return project.files.map((file) => ({ path: file.path, encoding: file.encoding, sha256: codeFileHash(file), bytes: fileBytes(file).length })); }

function baseProject(name: string, files: CodeFile[], entry = "index.html"): CodeProject {
  const now = new Date().toISOString();
  return { schemaVersion: 2, id: `code_${randomUUID().replaceAll("-", "")}`, name, revision: 1, createdAt: now, updatedAt: now, defaultPageId:'page_main',pages:[{id:'page_main',name:'主页面',entry,route:'/'}], files, designSystem: { tokens: { "color.paper": "#f5f1e8", "color.ink": "#242724", "color.accent": "#ea6644", "font.body": "Arial, sans-serif" }, components: [], notes: "模板示例；源码是真实设计源，可替换组件、行为和样式。" }, comments: [], viewports: [{ id: "viewport_desktop", name: "桌面", width: 1440, height: 1000 }, { id: "viewport_mobile", name: "手机", width: 390, height: 844 }] };
}
const templateCss = `:root{--paper:#f5f1e8;--ink:#242724;--accent:#ea6644;font-family:Arial,sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer}header{display:flex;justify-content:space-between;align-items:center;padding:26px 6vw;border-bottom:1px solid #24272430}.brand{font-weight:900;letter-spacing:-2px;font-size:25px}.edition{font-size:11px;letter-spacing:2px;text-transform:uppercase}main{padding:65px 6vw;max-width:1600px;margin:auto}.eyebrow{font-size:12px;letter-spacing:3px;text-transform:uppercase}h1{font-family:Georgia,serif;font-size:clamp(52px,8vw,116px);font-weight:400;letter-spacing:-5px;line-height:.97;max-width:970px;margin:28px 0}h1 em{color:var(--accent)}.intro{max-width:530px;line-height:1.75;color:#62655e}.actions{display:flex;gap:12px;margin:30px 0 60px}button{border:1px solid var(--ink);padding:13px 21px;border-radius:30px;background:transparent;color:inherit}.primary{background:var(--ink);color:var(--paper)}.grid{display:grid;grid-template-columns:1.3fr 1fr;gap:24px}.card{background:#e8e5da;border-radius:4px;padding:34px;min-height:245px;border-top:2px solid var(--ink)}.card.coral{background:var(--accent)}.card h2{font:400 34px Georgia,serif;letter-spacing:-1px;margin:15px 0}.card small{letter-spacing:2px}.row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid #24272425}.row input{accent-color:var(--ink)}.complete{text-decoration:line-through;opacity:.5}.add{display:flex;gap:8px;margin-top:20px}.add input{background:#fff8;border:0;padding:12px;min-width:0;flex:1}.add button{padding:10px 16px}.count{font:72px Georgia,serif;line-height:1;margin:24px 0}dialog{border:0;max-width:460px;padding:35px;background:var(--paper);box-shadow:0 30px 100px #0004}dialog::backdrop{background:#161b1670}footer{padding:24px 6vw;border-top:1px solid #24272430;font-size:12px;display:flex;justify-content:space-between}@media(max-width:650px){header{padding:20px}.edition{display:none}main{padding:42px 20px}h1{letter-spacing:-3px}.grid{grid-template-columns:1fr}.actions{margin-bottom:35px}footer{padding:20px}}`;
export function createCodeTemplate(name: string, template: "html" | "react"): CodeProject {
  if (template !== "html" && template !== "react") throw new DesignError("VALIDATION", "Choose the html or react template");
  const html = (body: string, script: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oblique — Independent ideas</title><link rel="stylesheet" href="styles.css"></head><body>${body}<script type="module" src="${script}"></script></body></html>`;
  const shell = `<header><span class="brand">oblique</span><span class="edition">Independent minds / Edition 026</span><button data-source-id="contact" id="contact">聊聊你的想法 ↗</button></header><main><div class="eyebrow">A little space for big ideas</div><h1 data-source-id="hero-title">Good work.<br><em>Better together.</em></h1><p class="intro">给想法一点空间。一个属于独立创作者的工作室，把正在做的事、接下来想做的事，都变成看得见的进展。</p><div class="actions"><button class="primary" id="focus" data-source-id="focus-button">开始今天的创作 ↗</button><button id="about">认识工作室</button></div><section class="grid"><article class="card"><small>01 / ON OUR DESK</small><h2>把灵感，落在今天。</h2><div id="tasks" data-source-id="task-list"></div><form class="add" id="add-task"><input id="new-task" aria-label="添加今天的计划" placeholder="一个值得开始的小目标"><button type="submit">＋</button></form></article><article class="card coral"><small>02 / KEEP MOVING</small><div class="count"><span id="done-count">0</span><span style="font-size:24px"> / 3</span></div><h2>完成一件，就更近一点。</h2><p id="status" aria-live="polite">你的创作节奏，由你决定。</p></article></section></main><footer><span>Small studio. Open possibilities.</span><span>Built with intention. © 2026</span></footer><dialog id="about-dialog"><h2>向好想法敞开。</h2><p>这是一个可运行的 HTML 模板：试着添加计划、完成任务，或继续修改真实源码。</p><button id="close-dialog">继续创作</button></dialog>`;
  if (template === "html") {
    const project = baseProject(name, [{ path: "index.html", encoding: "utf8", content: html(shell, "app.js") }, { path: "styles.css", encoding: "utf8", content: templateCss }, { path: "app.js", encoding: "utf8", content: `const tasks=[{text:'给新品牌画第一张草图',done:false},{text:'记录三个有意思的观察',done:true},{text:'把作品分享给一个朋友',done:false}];const list=document.querySelector('#tasks');function render(){list.replaceChildren(...tasks.map(task=>{const row=document.createElement('label');row.className='row'+(task.done?' complete':'');const text=document.createElement('span');text.textContent=task.text;const check=document.createElement('input');check.type='checkbox';check.checked=task.done;check.addEventListener('change',()=>{task.done=check.checked;render()});row.append(text,check);return row}));document.querySelector('#done-count').textContent=String(tasks.filter(t=>t.done).length);document.querySelector('.count span:last-child').textContent=' / '+tasks.length}document.querySelector('#add-task').addEventListener('submit',event=>{event.preventDefault();const input=document.querySelector('#new-task');if(input.value.trim()){tasks.push({text:input.value.trim(),done:false});input.value='';render()}});const dialog=document.querySelector('#about-dialog');for(const id of ['about','contact'])document.getElementById(id).addEventListener('click',()=>dialog.showModal());document.querySelector('#close-dialog').addEventListener('click',()=>dialog.close());document.querySelector('#focus').addEventListener('click',()=>document.querySelector('#new-task').focus());render();` }]);
    project.designSystem.components = [{ name: "Task list", path: "app.js", usage: "Real DOM event handlers render and update the task list." }];
    return validateCodeProject(project);
  }
  const project = baseProject(name, [{ path: "index.html", encoding: "utf8", content: html('<div id="root"></div>', "src/main.tsx") }, { path: "styles.css", encoding: "utf8", content: templateCss }, { path: "src/main.tsx", encoding: "utf8", content: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')!).render(<App/>);` }, { path: "src/App.tsx", encoding: "utf8", content: `import React,{useState} from 'react';export function ActionButton({children,onClick}:{children:React.ReactNode;onClick:()=>void}){return <button className="primary" onClick={onClick}>{children}</button>}export default function App(){const[tasks,setTasks]=useState([{id:1,text:'给新品牌画第一张草图',done:false},{id:2,text:'记录三个有意思的观察',done:true},{id:3,text:'把作品分享给一个朋友',done:false}]);const[text,setText]=useState('');const[about,setAbout]=useState(false);return <><header><span className="brand">oblique</span><span className="edition">Independent minds / Edition 026</span><button onClick={()=>setAbout(true)}>聊聊你的想法 ↗</button></header><main><div className="eyebrow">A little space for big ideas</div><h1 data-source-id="hero-title">Good work.<br/><em>Better together.</em></h1><p className="intro">给想法一点空间。用真实组件，把创作中的每一步变成看得见的进展。</p><div className="actions"><ActionButton onClick={()=>document.querySelector<HTMLInputElement>('#new-task')?.focus()}>开始今天的创作 ↗</ActionButton><button onClick={()=>setAbout(!about)}>认识工作室</button></div><section className="grid"><article className="card"><small>01 / ON OUR DESK</small><h2>把灵感，落在今天。</h2><div data-source-id="task-list">{tasks.map(task=><label className={'row'+(task.done?' complete':'')} key={task.id}><span>{task.text}</span><input type="checkbox" checked={task.done} onChange={()=>setTasks(tasks.map(t=>t.id===task.id?{...t,done:!t.done}:t))}/></label>)}</div><form className="add" onSubmit={e=>{e.preventDefault();if(text.trim()){setTasks([...tasks,{id:Date.now(),text:text.trim(),done:false}]);setText('')}}}><input id="new-task" value={text} onChange={e=>setText(e.target.value)} placeholder="一个值得开始的小目标" aria-label="添加今天的计划"/><button type="submit">＋</button></form></article><article className="card coral"><small>02 / KEEP MOVING</small><div className="count">{tasks.filter(t=>t.done).length}<span style={{fontSize:24}}> / {tasks.length}</span></div><h2>完成一件，就更近一点。</h2><p aria-live="polite">{about?'这是使用真实 React 状态与事件的模板，可继续修改源码。':'你的创作节奏，由你决定。'}</p></article></section></main><footer><span>Small studio. Open possibilities.</span><span>Built with React. © 2026</span></footer></>}` }, { path: "package.json", encoding: "utf8", content: JSON.stringify({ name: "oblique-design-template", private: true, type: "module", dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } }, null, 2) }]);
  project.designSystem.components = [{ name: "ActionButton", path: "src/App.tsx", exportName: "ActionButton", usage: "<ActionButton onClick={handler}>开始创作</ActionButton>" }];
  return validateCodeProject(project);
}

interface SourceBaseline { projectHash: string | null; directoryHash: string | null }
interface SourceStep { path: string; fromHash: string | null; toHash: string | null; projectHash: string | null; done: boolean }
export interface SourceOperation { id: string; revision: number; phase: "writing" | "partial" | "rechecked" | "completed"; createdAt: string; steps: SourceStep[]; error?: string | undefined }
interface SourceLink { id: string; directory: string; device: string; inode: string; connectedAt: string; baseline: Record<string, SourceBaseline>; ignored: Array<{ path: string; reason: string }>; operation?: SourceOperation | undefined }
export interface SourceStatus { projectId: string; revision: number; connected: boolean; linkId?: string; directory?: string; connectedAt?: string; ignored?: SourceLink["ignored"]; operation?: SourceOperation }
export interface SourceDifference { path: string; projectHash: string | null; directoryHash: string | null; baseProjectHash: string | null; baseDirectoryHash: string | null; status: "synced" | "project" | "directory" | "conflict"; issue?: string }
export interface SourceComparison extends SourceStatus { files: SourceDifference[]; checkedAt: string }
const nullableHash = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const sourceLinkSchema: z.ZodType<SourceLink> = z.object({ id: idSchema, directory: z.string().min(1).max(4096), device: z.string(), inode: z.string(), connectedAt: z.string().datetime(), baseline: z.record(pathSchema, z.object({ projectHash: nullableHash, directoryHash: nullableHash }).strict()).refine(value => Object.keys(value).length <= 1000), ignored: z.array(z.object({ path: z.string().max(512), reason: z.string().max(200) }).strict()).max(200), operation: z.object({ id: idSchema, revision: z.number().int().positive(), phase: z.enum(["writing", "partial", "rechecked", "completed"]), createdAt: z.string().datetime(), steps: z.array(z.object({ path: pathSchema, fromHash: nullableHash, toHash: nullableHash, projectHash: nullableHash, done: z.boolean() }).strict()).max(500), error: z.string().max(4000).optional() }).strict().optional() }).strict();
interface CodeRecord { version: 1; current: CodeProject; snapshots: CodeProject[]; undo: number[]; redo: number[]; history: CodeProjectRevision[]; sourceLink?: SourceLink | undefined }
const recordSchema: z.ZodType<CodeRecord> = z.object({ version: z.literal(1), current: codeProjectSchema, snapshots: z.array(codeProjectSchema).min(1).max(CODE_PROJECT_LIMITS.history), undo: z.array(z.number().int().positive()).max(50), redo: z.array(z.number().int().positive()).max(50), history: z.array(z.object({ revision: z.number().int().positive(), createdAt: z.string().datetime({ offset: true }), operation: z.enum(["create", "import", "update", "undo", "redo", "restore"]), restoredFrom: z.number().int().positive().optional() }).strict()).min(1).max(50), sourceLink: sourceLinkSchema.optional() }).strict();
const changeSchema = z.object({ path: pathSchema, content: z.string().max(12 * 1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
const updateSchema = z.object({ files: z.array(changeSchema).max(500).optional(), pages:z.array(codePageSchema).min(1).max(CODE_PAGE_LIMIT).optional(),defaultPageId:idSchema.optional(), name: nameSchema.optional(), designSystem: z.unknown().optional(), comments: z.unknown().optional(), viewports: z.unknown().optional() }).strict();

export class CodeProjectStore {
  readonly dataDir: string;
  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? join(process.env.DESIGN_DATA_DIR || join(homedir(), ".codex-design", "projects"), "code");
    if (!isAbsolute(dataDir)) throw new DesignError("VALIDATION", "The code project data directory must be absolute");
    this.dataDir = resolve(dataDir);
  }
  async list(): Promise<CodeProjectListing> {
    await this.prepare(); const files = await readdir(this.dataDir);
    const unsupported:CodeProjectListing['unsupported']=[];
    const loaded = await Promise.all(files.filter((name) => /^code_[A-Za-z0-9_-]+\.json$/.test(name)).map(async (name) => {const id=name.slice(0,-5);try{return(await this.read(id)).current;}catch(error){if(!(error instanceof UnsupportedCodeProjectFormatError))throw error;unsupported.push({id,...(error.format===undefined?{}:{format:error.format}),reason:error.message});return undefined;}}));
    const projects=loaded.filter((project):project is CodeProject=>project!==undefined).map((project) => ({ id: project.id, name: project.name, revision: project.revision, updatedAt: project.updatedAt, defaultPageId:project.defaultPageId,pageCount:project.pages.length, fileCount: project.files.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return{projects,unsupported:unsupported.sort((a,b)=>a.id.localeCompare(b.id))};
  }
  async create(input: { name: string; template: "html" | "react" }): Promise<CodeProject> { return this.insert(createCodeTemplate(input.name, input.template), "create"); }
  async get(id: string): Promise<CodeProject> { return structuredClone((await this.read(id)).current); }
  async update(id: string, expectedRevision: number, input: CodeProjectUpdate): Promise<CodeProject> {
    assertSafeJson(input); const result = updateSchema.safeParse(input);
    if (!result.success) throw new DesignError("VALIDATION", result.error.issues.map((issue) => issue.message).join("; "));
    const update = result.data;
    if (!Object.keys(update).length || Object.keys(update).every((key) => key === "files") && !update.files?.length) throw new DesignError("VALIDATION", "Provide at least one source or metadata change");
    return this.change(id, expectedRevision, "update", (record) => {
      const project = structuredClone(record.current); const files = new Map(project.files.map((file) => [file.path, file])); const touched = new Set<string>();
      for (const change of update.files ?? []) {
        if (touched.has(change.path.toLowerCase())) throw new DesignError("VALIDATION", `Each path may be changed only once in a batch: ${change.path}`); touched.add(change.path.toLowerCase());
        const current = files.get(change.path);
        if (change.expectedHash === null ? current !== undefined : current === undefined || codeFileHash(current) !== change.expectedHash) throw new DesignError("REVISION_CONFLICT", `Source hash changed or file presence differs: ${change.path}. Read the latest source before retrying.`);
        if (change.content === undefined) { if (!current || change.expectedHash === null || change.encoding !== undefined) throw new DesignError("VALIDATION", "Deletion requires an existing source hash and no encoding"); files.delete(change.path); }
        else files.set(change.path, { path: change.path, content: change.content, encoding: change.encoding ?? current?.encoding ?? "utf8" });
      }
      project.files = [...files.values()];
      for (const key of ["name", "pages","defaultPageId", "designSystem", "comments", "viewports"] as const) if (update[key] !== undefined) (project as unknown as Record<string, unknown>)[key] = update[key];
      return validateCodeProject(project);
    });
  }
  async undo(id: string, expectedRevision: number): Promise<CodeProject> { return this.change(id, expectedRevision, "undo", (record) => { const revision = record.undo.pop(); if (revision === undefined) throw new DesignError("VALIDATION", "No source change is available to undo"); record.redo.push(record.current.revision); return this.snapshot(record, revision); }, false); }
  async redo(id: string, expectedRevision: number): Promise<CodeProject> { return this.change(id, expectedRevision, "redo", (record) => { const revision = record.redo.pop(); if (revision === undefined) throw new DesignError("VALIDATION", "No source change is available to redo"); record.undo.push(record.current.revision); return this.snapshot(record, revision); }, false); }
  async history(id: string): Promise<CodeProjectRevision[]> { return structuredClone((await this.read(id)).history); }
  async restore(id: string, expectedRevision: number, revision: number): Promise<CodeProject> { return this.change(id, expectedRevision, "restore", (record) => this.snapshot(record, revision), true, revision); }

  async importDirectory(input: { name: string; directory: string; entry?: string }): Promise<CodeProject> {
    const scanned = await scanSourceDirectory(input.directory); const files = scanned.files;
    const candidates = ["index.html", "src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/index.tsx", "src/App.tsx"];
    const entry = input.entry ?? candidates.find((candidate) => files.some((file) => file.path === candidate)) ?? files.find((file) => [".html", ".htm", ".tsx", ".jsx", ".js", ".mjs", ".ts"].includes(extname(file.path).toLowerCase()))?.path;
    if (!entry) throw new DesignError("VALIDATION", "No supported HTML or browser source entry was found");
    const project = baseProject(input.name, files, entry);
    if(/\.html?$/i.test(entry))for(const file of files){if(file.path===entry||!(/\.html?$/i.test(file.path)))continue;project.pages.push({id:'page_'+sha(Buffer.from(file.path)).slice(0,20),name:file.path,entry:file.path,route:'/'+file.path});}
    project.designSystem.notes = "从明确目录只读导入；HTML 入口会同时登记目录中的其他 HTML 页面，React 入口仅登记明确选择的入口。未安装依赖、执行源代码或运行构建。预览编译器会报告缺失依赖与不支持的入口。";
    return this.insert(validateCodeProject(project), "import", makeSourceLink(project, scanned));
  }

  async exportDirectory(id: string, directory: string, options: { expectedRevision: number }): Promise<{ directory: string; revision: number; files: string[] }> {
    const project = await this.get(id); if (project.revision !== options.expectedRevision) throw new DesignError("REVISION_CONFLICT", "Read the current code revision before exporting");
    const linked = (await this.read(id)).sourceLink;
    if (linked && await sourceDirectory(directory, true) === linked.directory) {
      const comparison = await this.compareSource(id);
      if (comparison.revision !== options.expectedRevision) throw new DesignError("REVISION_CONFLICT", "The project changed before its connected-directory export");
      if (comparison.files.some(file => file.status === "directory" || file.status === "conflict")) throw new DesignError("REVISION_CONFLICT", "The connected directory has external changes. Compare and pull or explicitly resolve them before writing.");
      const paths = comparison.files.filter(file => file.status === "project").map(file => file.path);
      if (paths.length) await this.pushSource(id, options.expectedRevision, paths, undefined, Object.fromEntries(comparison.files.map(file => [file.path, file.directoryHash])));
      return { directory: linked.directory, revision: project.revision, files: project.files.map(file => file.path) };
    }
    const canonical = await sourceDirectory(directory, true); let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(join(canonical, ".design-code-export"), { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 20, minTimeout: 20, maxTimeout: 200 } });
      const manifestPath = join(canonical, exportManifestName); let old: { projectId: string; revision: number; hashes: Record<string, string> } | undefined; let oldManifestHash: string | undefined;
      try {
        const bytes = await readContainedFile(canonical, exportManifestName, 512 * 1024, true); oldManifestHash = sha(bytes);
        const parsed = z.object({ projectId: idSchema, revision: z.number().int().positive().safe(), hashes: z.record(pathSchema, z.string().regex(/^[a-f0-9]{64}$/)).refine((value) => Object.keys(value).length <= 500) }).strict().safeParse(JSON.parse(bytes.toString("utf8")));
        if (!parsed.success) throw new DesignError("VALIDATION", "Code export manifest is invalid"); old = parsed.data;
      } catch (error) { if (!missing(error)) { if (error instanceof SyntaxError) throw new DesignError("VALIDATION", "Code export manifest is not valid JSON"); throw error; } }
      if (old && (old.projectId !== id || old.revision > project.revision)) throw new DesignError("REVISION_CONFLICT", "The export directory belongs to another project or a newer revision");
      const next = new Map(project.files.map((file) => [file.path, fileBytes(file)])); const tracked = new Set([...Object.keys(old?.hashes ?? {}), ...next.keys()]);
      const check = async (name: string): Promise<void> => {
        try { const bytes = await readContainedFile(canonical, name, CODE_PROJECT_LIMITS.assetBytes); if (old?.hashes[name] !== sha(bytes)) throw new DesignError("REVISION_CONFLICT", `Source changed outside Design or is unrelated: ${name}`); }
        catch (error) { if (!missing(error)) throw error; if (old?.hashes[name] !== undefined) throw new DesignError("REVISION_CONFLICT", `Previously exported source is missing: ${name}`); }
      };
      for (const name of tracked) await check(name);
      const stage = join(canonical, `.design-code-stage-${randomUUID()}`); const written: string[] = [];
      try {
        await mkdir(stage, { mode: 0o700 });
        for (const [name, bytes] of next) { const staged = join(stage, name); await mkdir(dirname(staged), { recursive: true, mode: 0o700 }); await writeFile(staged, bytes, { flag: "wx", mode: 0o600 }); }
        const liveManifestHash = await readContainedFile(canonical, exportManifestName, 512 * 1024, true).then(sha).catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
        if (liveManifestHash !== oldManifestHash) throw new DesignError("REVISION_CONFLICT", "The source manifest changed during export");
        if ((await this.get(id)).revision !== project.revision) throw new DesignError("REVISION_CONFLICT", "The code project changed while export was being prepared");
        for (const [name] of next) { await check(name); const target = await prepareContainedTarget(canonical, name); await rename(join(stage, name), target); written.push(name); }
        for (const name of Object.keys(old?.hashes ?? {})) if (!next.has(name)) { await check(name); await unlink(join(canonical, name)); written.push(name); }
        const hashes = Object.fromEntries([...next].map(([name, bytes]) => [name, sha(bytes)]));
        await writeFile(join(stage, exportManifestName), JSON.stringify({ projectId: id, revision: project.revision, hashes }, null, 2), { flag: "wx", mode: 0o600 });
        await rename(join(stage, exportManifestName), manifestPath);
        if ((await this.get(id)).revision !== project.revision) throw new DesignError("REVISION_CONFLICT", "The canvas advanced while its source files were exported; reconcile the new revision");
        return { directory: canonical, revision: project.revision, files: [...next.keys()] };
      } catch (error) {
        if (written.length) throw Object.assign(new Error(`Code revision ${project.revision} was only partially exported: ${error instanceof Error ? error.message : "source export failed"}. Source files need reconciliation before retrying.`), { code: "EXPORT_PARTIAL", partial: true, savedRevision: project.revision, directory: canonical, filesWritten: written });
        throw error;
      } finally { await rm(stage, { recursive: true, force: true }); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new DesignError("LOCKED", "Another process is exporting to this source directory"); throw error; }
    finally { if (release) await release(); }
  }

  async sourceStatus(id: string): Promise<SourceStatus> { const record = await this.read(id); return sourceStatus(record); }
  async connectSource(id: string, expectedRevision: number, directory: string): Promise<SourceStatus> {
    return this.lock(id, async () => {
      const record = await this.read(id); assertRevision(record, expectedRevision);
      if (record.sourceLink) throw new DesignError("VALIDATION", "This project already has a source directory. Create a separate project to connect another directory.");
      const scanned = await scanSourceDirectory(directory); record.sourceLink = makeSourceLink(record.current, scanned); await this.write(record); return sourceStatus(record);
    });
  }
  async compareSource(id: string): Promise<SourceComparison> { const record = await this.read(id); const scanned = await scanLinked(record); return compareSource(record, scanned); }
  async readSourceDifference(id: string, path: string): Promise<{ projectId: string; revision: number; file: string; projectFile: unknown; directoryFile: unknown; difference: SourceDifference }> {
    validateCodePath(path); const record = await this.read(id); const scanned = await scanLinked(record);
    const difference = compareSource(record, scanned).files.find(file => file.path === path); if (!difference) throw new DesignError("NOT_FOUND", "Source path is not part of this comparison");
    const describe = (file: CodeFile | undefined) => file ? { path, encoding: file.encoding, sha256: codeFileHash(file), bytes: fileBytes(file).length, ...(file.encoding === "utf8" ? { content: file.content } : { binary: true }) } : null;
    return { projectId: id, revision: record.current.revision, file: path, projectFile: describe(record.current.files.find(file => file.path === path)), directoryFile: describe(scanned.files.find(file => file.path === path)), difference };
  }
  async pullSource(id: string, expectedRevision: number, paths: string[], resolution?: { path: string; projectHash: string | null; directoryHash: string | null }, expectedDirectoryHashes?: Record<string, string | null>): Promise<CodeProject> {
    return this.lock(id, async () => {
      const record = await this.read(id); assertRevision(record, expectedRevision); assertSourceIdle(record);
      const scanned = await scanLinked(record); const comparison = compareSource(record, scanned); const chosen = selectSourcePaths(comparison, paths, "directory", resolution);
      assertComparedHashes(chosen, expectedDirectoryHashes);
      const next = structuredClone(record.current); const files = new Map(next.files.map(file => [file.path, file]));
      for (const state of chosen) { const file = scanned.files.find(file => file.path === state.path); if (file) files.set(state.path, file); else files.delete(state.path); }
      next.files = [...files.values()]; validateCodeProject(next);
      for (const state of chosen) setSourceBaseline(record.sourceLink!, state.path, { projectHash: files.has(state.path) ? codeFileHash(files.get(state.path)!) : null, directoryHash: state.directoryHash });
      if (chosen.some(state => state.projectHash !== state.directoryHash)) await this.commitCurrent(record, next, "update"); else await this.write(record);
      return structuredClone(record.current);
    });
  }
  async pushSource(id: string, expectedRevision: number, paths: string[], resolution?: { path: string; projectHash: string | null; directoryHash: string | null }, expectedDirectoryHashes?: Record<string, string | null>): Promise<SourceStatus> {
    return this.lock(id, async () => {
      const record = await this.read(id); assertRevision(record, expectedRevision); assertSourceIdle(record);
      const link = record.sourceLink; if (!link) throw new DesignError("VALIDATION", "Connect a source directory first"); await assertLinkedIdentity(link);
      const release = await lockfile.lock(join(link.directory, ".design-code-export"), { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 20, minTimeout: 20, maxTimeout: 200 } });
      try {
      const scanned = await scanLinked(record); const comparison = compareSource(record, scanned); const chosen = selectSourcePaths(comparison, paths, "project", resolution);
      assertComparedHashes(chosen, expectedDirectoryHashes);
      const operation: SourceOperation = { id: `sync_${randomUUID().replaceAll("-", "")}`, revision: record.current.revision, phase: "writing", createdAt: new Date().toISOString(), steps: chosen.map(state => ({ path: state.path, fromHash: state.directoryHash, toHash: state.projectHash, projectHash: state.projectHash, done: false })) };
      const projected = structuredClone(link); projected.operation = structuredClone(operation);
      const recordWithoutLinkBytes = Buffer.byteLength(JSON.stringify(record)) - Buffer.byteLength(JSON.stringify(link));
      const checkCapacity = () => { if (!sourceLinkSchema.safeParse(projected).success || recordWithoutLinkBytes + Buffer.byteLength(JSON.stringify(projected)) + 32768 > CODE_PROJECT_LIMITS.storeBytes) throw new DesignError("VALIDATION", "A source journal step would exceed its private storage budget. No source files were written."); };
      checkCapacity();
      for (const step of projected.operation.steps) { setSourceBaseline(projected, step.path, { projectHash: step.projectHash, directoryHash: step.toHash }); step.done = true; checkCapacity(); }
      link.operation = operation; await this.write(record);
      const filesWritten: string[] = []; const stage = join(link.directory, `.design-code-sync-${operation.id}`);
      try {
        await mkdir(stage, { mode: 0o700 });
        for (const step of operation.steps) {
          await assertLinkedIdentity(link);
          if (await sourceHash(link.directory, step.path) !== step.fromHash) throw new DesignError("REVISION_CONFLICT", `Source changed after comparison: ${step.path}`);
          if (step.toHash === step.fromHash) { step.done = true; setSourceBaseline(link, step.path, { projectHash: step.projectHash, directoryHash: step.toHash }); continue; }
          if (step.toHash === null) await unlink(join(link.directory, step.path));
          else {
            const file = record.current.files.find(file => file.path === step.path)!; const staged = join(stage, step.path); await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
            const oldMode = await lstat(join(link.directory, step.path)).then(info => info.mode & 0o777).catch((error: unknown) => { if (missing(error)) return 0o600; throw error; });
            const handle = await open(staged, "wx", oldMode); try { await handle.writeFile(fileBytes(file)); await handle.chmod(oldMode); await handle.sync(); } finally { await handle.close(); }
            const target = await prepareContainedTarget(link.directory, step.path);
            if (await sourceHash(link.directory, step.path) !== step.fromHash) throw new DesignError("REVISION_CONFLICT", `Source changed while preparing write: ${step.path}`);
            await rename(staged, target);
          }
          filesWritten.push(step.path);
          if (await sourceHash(link.directory, step.path) !== step.toHash) throw new DesignError("REVISION_CONFLICT", `Source changed during write: ${step.path}`);
          step.done = true; setSourceBaseline(link, step.path, { projectHash: step.projectHash, directoryHash: step.toHash });
        }
        operation.phase = "completed"; await this.write(record); return sourceStatus(record);
      } catch (error) {
        operation.phase = "partial"; operation.error = (error instanceof Error ? error.message : "Source write failed").slice(0, 4000);
        await this.write(record).catch(() => { /* The persisted writing journal is sufficient for an explicit recheck. */ });
        throw Object.assign(new Error(`Source directory write stopped. Recheck the saved operation before retrying: ${operation.error}`), { code: "EXPORT_PARTIAL", partial: true, savedRevision: record.current.revision, directory: link.directory, filesWritten, pendingFiles: operation.steps.filter(step => !step.done).map(step => step.path), operationId: operation.id });
      } finally { await rm(stage, { recursive: true, force: true }); }
      } finally { await release(); }
    });
  }
  async recheckSource(id: string): Promise<SourceComparison> {
    return this.lock(id, async () => {
      const record = await this.read(id); const scanned = await scanLinked(record); const operation = record.sourceLink!.operation;
      if (operation && operation.phase !== "completed") {
        for (const step of operation.steps) { const hash = await sourceHash(record.sourceLink!.directory, step.path); step.done = hash === step.toHash; if (step.done) setSourceBaseline(record.sourceLink!, step.path, { projectHash: step.projectHash, directoryHash: step.toHash }); }
        operation.phase = "rechecked"; await this.write(record);
        const stage = join(record.sourceLink!.directory, `.design-code-sync-${operation.id}`); const info = await lstat(stage).catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
        if (info?.isDirectory() && !info.isSymbolicLink()) await rm(stage, { recursive: true, force: true });
      }
      return compareSource(record, scanned);
    });
  }

  private async insert(project: CodeProject, operation: "create" | "import", sourceLink?: SourceLink): Promise<CodeProject> {
    return this.lock(project.id, async () => {
      try { await lstat(this.filename(project.id)); throw new DesignError("REVISION_CONFLICT", "Project already exists"); } catch (error) { if (!missing(error)) throw error; }
      await this.write({ version: 1, current: project, snapshots: [project], undo: [], redo: [], history: [{ revision: 1, createdAt: project.createdAt, operation }], ...(sourceLink ? { sourceLink } : {}) }); return structuredClone(project);
    });
  }
  private snapshot(record: CodeRecord, revision: number): CodeProject { const project = record.snapshots.find((item) => item.revision === revision); if (!project) throw new DesignError("NOT_FOUND", `Code revision ${revision} is unavailable`); return structuredClone(project); }
  private async change(id: string, expectedRevision: number, operation: CodeProjectRevision["operation"], build: (record: CodeRecord) => CodeProject, addUndo = true, restoredFrom?: number): Promise<CodeProject> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new DesignError("VALIDATION", "Expected revision must be a positive safe integer");
    return this.lock(id, async () => {
      const record = await this.read(id); if (record.current.revision !== expectedRevision) throw new DesignError("REVISION_CONFLICT", `Expected code revision ${expectedRevision}, current ${record.current.revision}`);
      await this.commitCurrent(record, build(record), operation, addUndo, restoredFrom); return structuredClone(record.current);
    });
  }
  private async commitCurrent(record: CodeRecord, next: CodeProject, operation: CodeProjectRevision["operation"], addUndo = true, restoredFrom?: number): Promise<void> {
    if (addUndo) { record.undo.push(record.current.revision); record.redo = []; }
    record.current = validateCodeProject({ ...next, id: record.current.id, createdAt: record.current.createdAt, updatedAt: new Date().toISOString(), revision: record.current.revision + 1 });
    record.snapshots.push(record.current); record.history.push({ revision: record.current.revision, createdAt: record.current.updatedAt, operation, ...(restoredFrom === undefined ? {} : { restoredFrom }) });
    record.snapshots = record.snapshots.slice(-50); while (record.snapshots.length > 1 && Buffer.byteLength(JSON.stringify(record)) > CODE_PROJECT_LIMITS.storeBytes) record.snapshots.shift();
    const revisions = new Set(record.snapshots.map(item => item.revision)); record.undo = record.undo.filter(revision => revisions.has(revision)).slice(-50); record.redo = record.redo.filter(revision => revisions.has(revision)).slice(-50); record.history = record.history.filter(item => revisions.has(item.revision)).slice(-50);
    await this.write(record);
  }
  private filename(id: string): string { if (!/^code_[A-Za-z0-9_-]{1,70}$/.test(id)) throw new DesignError("VALIDATION", "Invalid code project ID"); return join(this.dataDir, `${id}.json`); }
  private async prepare(): Promise<void> { await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); }
  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    await this.prepare(); let release: (() => Promise<void>) | undefined; let compromised: Error | undefined;
    try { release = await lockfile.lock(this.filename(id), { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.2 }, onCompromised: (error) => { compromised = error; } }); if (compromised) throw new DesignError("LOCKED", "The code project lock was lost"); const result = await action(); if (compromised) throw new DesignError("LOCKED", "The code project lock was lost; read its current revision before retrying"); return result; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new DesignError("LOCKED", "Another process is updating this code project"); throw error; }
    finally { if (release) await release(); }
  }
  private async read(id: string): Promise<CodeRecord> {
    const filename = this.filename(id);
    try {
      const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > CODE_PROJECT_LIMITS.storeBytes) throw new DesignError("VALIDATION", "Stored code project must be a bounded regular file");
      const raw:unknown=JSON.parse(await readFile(filename,'utf8'));if(raw&&typeof raw==='object'&&'current'in raw&&raw.current&&typeof raw.current==='object'&&'schemaVersion'in raw.current&&raw.current.schemaVersion!==2){const format=raw.current.schemaVersion;throw new UnsupportedCodeProjectFormatError(typeof format==='number'||typeof format==='string'?format:undefined);}
      const result = recordSchema.safeParse(raw); if (!result.success) throw new DesignError("VALIDATION", "Stored code project is invalid");
      const record = result.data; const revisions = new Set(record.snapshots.map((item) => item.revision));
      if (record.current.id !== id || record.snapshots.some((item) => item.id !== id || item.createdAt !== record.current.createdAt) || revisions.size !== record.snapshots.length || !revisions.has(record.current.revision) || [...record.undo, ...record.redo, ...record.history.map((item) => item.revision)].some((revision) => !revisions.has(revision))) throw new DesignError("VALIDATION", "Stored code history is inconsistent");
      return record;
    } catch (error) { if (missing(error)) throw new DesignError("NOT_FOUND", `Code project not found: ${id}`); if (error instanceof SyntaxError) throw new DesignError("VALIDATION", "Stored code project is not valid JSON"); throw error; }
  }
  private async write(record: CodeRecord): Promise<void> {
    if (record.sourceLink && !sourceLinkSchema.safeParse(record.sourceLink).success) throw new DesignError("VALIDATION", "The private source connection is invalid or exceeds its budget; the stored project was not replaced");
    const content = JSON.stringify(record); if (Buffer.byteLength(content) > CODE_PROJECT_LIMITS.storeBytes) throw new DesignError("VALIDATION", "Code history size budget exceeded");
    const temporary = join(this.dataDir, `.${record.current.id}.${randomUUID()}.tmp`); let file: Awaited<ReturnType<typeof open>> | undefined;
    try { file = await open(temporary, "wx", 0o600); await file.writeFile(content); await file.sync(); await file.close(); file = undefined; await rename(temporary, this.filename(record.current.id)); const directory = await open(this.dataDir, "r"); try { await directory.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } finally { await directory.close(); } }
    finally { if (file) await file.close(); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  }
}
function missing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function sourceDirectory(directory: string, create = false): Promise<string> {
  if (!isAbsolute(directory)) throw new DesignError("VALIDATION", "Choose an absolute source directory");
  if (create) await mkdir(directory, { recursive: true }); const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DesignError("VALIDATION", "Source directory must not be a symlink"); return realpath(directory);
}
async function readContainedFile(directory: string, name: string, limit: number, manifest = false): Promise<Buffer> {
  if (!manifest) validateCodePath(name); else if (name !== exportManifestName) throw new DesignError("VALIDATION", "Invalid export manifest path");
  const filename = join(directory, name); const parts = name.split("/"); let parent = directory;
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new DesignError("VALIDATION", "Source parent must be a real directory"); }
  const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new DesignError("VALIDATION", `Source must be a bounded regular file: ${name}`);
  const canonical = await realpath(filename); const rel = relative(directory, canonical); if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new DesignError("VALIDATION", "Source resolves outside its directory");
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const opened = await file.stat(); if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > limit) throw new DesignError("REVISION_CONFLICT", "Source identity changed while reading"); const bytes = await file.readFile(); if (bytes.length > limit) throw new DesignError("VALIDATION", "Source size budget exceeded"); const after = await file.stat(); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size) throw new DesignError("REVISION_CONFLICT", "Source changed while its bytes were read. Compare again before applying."); return bytes; } finally { await file.close(); }
}
async function prepareContainedTarget(directory: string, name: string): Promise<string> {
  validateCodePath(name); let parent = directory;
  for (const part of name.split("/").slice(0, -1)) { parent = join(parent, part); await mkdir(parent, { recursive: true }); const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new DesignError("VALIDATION", "Export parent must not be a symlink"); }
  return join(directory, name);
}

interface SourceScan { directory: string; device: string; inode: string; files: CodeFile[]; hashes: Record<string, string>; ignored: SourceLink["ignored"]; unsafePaths: Set<string> }
async function scanSourceDirectory(input: string): Promise<SourceScan> {
  const directory = await sourceDirectory(input); const root = await lstat(directory);
  const result: SourceScan = { directory, device: String(root.dev), inode: String(root.ino), files: [], hashes: {}, ignored: [], unsafePaths: new Set() }; let total = 0; let visited = 0;
  const ignore = (path: string, reason: string) => { if (result.ignored.length < 200) result.ignored.push({ path: path.slice(0, 512), reason }); };
  const walk = async (folder: string, prefix: string): Promise<void> => {
    if (prefix.split("/").length > 24) throw new DesignError("VALIDATION", "Source directory nesting exceeds its budget");
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 20_000) throw new DesignError("VALIDATION", "Source directory entry budget exceeded");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (blockedSegments.has(entry.name.toLowerCase()) || entry.name === exportManifestName || entry.name.startsWith(".design-code-")) { ignore(name, "Reserved directory or Design synchronization metadata"); continue; }
      const filename = join(folder, entry.name); const info = await lstat(filename);
      if (info.isSymbolicLink()) { result.unsafePaths.add(name); ignore(name, "Symbolic link was not followed"); continue; }
      if (info.isDirectory()) { await walk(filename, name); continue; }
      if (!info.isFile()) { result.unsafePaths.add(name); ignore(name, "Not a regular file"); continue; }
      const extension = extname(name).toLowerCase(); if (!textExtensions.has(extension) && !assetExtensions.has(extension)) { ignore(name, "Unsupported source or asset extension; file stays outside Design"); continue; }
      validateCodePath(name); if (result.files.length >= CODE_PROJECT_LIMITS.files) throw new DesignError("VALIDATION", "Imported project exceeds 500 files");
      const binary = assetExtensions.has(extension); const bytes = await readContainedFile(directory, name, binary ? CODE_PROJECT_LIMITS.assetBytes : CODE_PROJECT_LIMITS.textBytes);
      total += bytes.length; if (total > CODE_PROJECT_LIMITS.projectBytes) throw new DesignError("VALIDATION", "Imported source exceeds 32 MiB");
      let content: string; try { content = binary ? bytes.toString("base64") : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new DesignError("VALIDATION", `Source file is not valid UTF-8: ${name}`); }
      const file: CodeFile = { path: name, content, encoding: binary ? "base64" : "utf8" }; fileBytes(file); result.files.push(file); result.hashes[name] = sha(bytes);
    }
  };
  await walk(directory, ""); const finalRoot = await lstat(directory);
  if (!finalRoot.isDirectory() || finalRoot.isSymbolicLink() || finalRoot.dev !== root.dev || finalRoot.ino !== root.ino) throw new DesignError("REVISION_CONFLICT", "Source directory identity changed while scanning");
  result.files.sort((a, b) => a.path.localeCompare(b.path)); return result;
}
function makeSourceLink(project: CodeProject, scanned: SourceScan): SourceLink {
  const baseline: Record<string, SourceBaseline> = {};
  for (const file of project.files) { const projectHash = codeFileHash(file); if (scanned.hashes[file.path] === projectHash) baseline[file.path] = { projectHash, directoryHash: projectHash }; }
  return { id: `source_${randomUUID().replaceAll("-", "")}`, directory: scanned.directory, device: scanned.device, inode: scanned.inode, connectedAt: new Date().toISOString(), baseline, ignored: scanned.ignored };
}
function sourceStatus(record: CodeRecord): SourceStatus {
  const link = record.sourceLink; return { projectId: record.current.id, revision: record.current.revision, connected: !!link, ...(link ? { linkId: link.id, directory: link.directory, connectedAt: link.connectedAt, ignored: link.ignored, ...(link.operation ? { operation: structuredClone(link.operation) } : {}) } : {}) };
}
async function assertLinkedIdentity(link: SourceLink): Promise<void> {
  const canonical = await sourceDirectory(link.directory); const info = await lstat(canonical);
  if (canonical !== link.directory || String(info.dev) !== link.device || String(info.ino) !== link.inode) throw new DesignError("REVISION_CONFLICT", "The connected directory identity changed. Its files were not written.");
}
async function scanLinked(record: CodeRecord): Promise<SourceScan> {
  if (!record.sourceLink) throw new DesignError("VALIDATION", "Connect a source directory first");
  await assertLinkedIdentity(record.sourceLink); const scanned = await scanSourceDirectory(record.sourceLink.directory); await assertLinkedIdentity(record.sourceLink); return scanned;
}
function compareSource(record: CodeRecord, scanned: SourceScan): SourceComparison {
  const link = record.sourceLink!; const files = new Map(record.current.files.map(file => [file.path, codeFileHash(file)]));
  const paths = new Set([...Object.keys(link.baseline), ...files.keys(), ...Object.keys(scanned.hashes)]);
  const states: SourceDifference[] = [...paths].sort().map(path => {
    const base = link.baseline[path] ?? { projectHash: null, directoryHash: null }; const projectHash = files.get(path) ?? null; const directoryHash = scanned.hashes[path] ?? null;
    const projectChanged = projectHash !== base.projectHash; const directoryChanged = directoryHash !== base.directoryHash;
    const issue = [...scanned.unsafePaths].some(unsafe => path === unsafe || path.startsWith(unsafe + "/")) ? "Source path is a symbolic link or is not a regular file" : undefined;
    return { path, projectHash, directoryHash, baseProjectHash: base.projectHash, baseDirectoryHash: base.directoryHash, ...(issue ? { issue } : {}), status: issue || projectChanged && directoryChanged ? "conflict" : projectChanged ? "project" : directoryChanged ? "directory" : "synced" };
  });
  return { ...sourceStatus(record), ignored: scanned.ignored, files: states, checkedAt: new Date().toISOString() };
}
function assertRevision(record: CodeRecord, expected: number): void { if (record.current.revision !== expected) throw new DesignError("REVISION_CONFLICT", `Expected code revision ${expected}, current ${record.current.revision}`); }
function assertSourceIdle(record: CodeRecord): void { if (record.sourceLink?.operation && ["writing", "partial"].includes(record.sourceLink.operation.phase)) throw new DesignError("REVISION_CONFLICT", "A source write needs an explicit recheck before another pull or push"); }
function selectSourcePaths(comparison: SourceComparison, paths: string[], direction: "project" | "directory", resolution?: { path: string; projectHash: string | null; directoryHash: string | null }): SourceDifference[] {
  if (!paths.length || paths.length > 500 || new Set(paths).size !== paths.length) throw new DesignError("VALIDATION", "Choose between 1 and 500 distinct source paths");
  return paths.map(path => {
    validateCodePath(path); const state = comparison.files.find(file => file.path === path); if (!state) throw new DesignError("NOT_FOUND", `Unknown source path: ${path}`);
    if (state.issue) throw new DesignError("VALIDATION", `Unsafe source path ${path}: ${state.issue}`);
    if (resolution && resolution.path === path) { if (paths.length !== 1 || state.projectHash !== resolution.projectHash || state.directoryHash !== resolution.directoryHash) throw new DesignError("REVISION_CONFLICT", "The inspected conflict changed. Read both sources again before resolving."); }
    else if (state.status !== direction) throw new DesignError("REVISION_CONFLICT", `Source ${path} is ${state.status}; only a one-sided ${direction} change can be applied without explicit conflict resolution`);
    return state;
  });
}
function assertComparedHashes(states: SourceDifference[], expected?: Record<string, string | null>): void {
  if (!expected) return;
  for (const state of states) if (!Object.hasOwn(expected, state.path) || expected[state.path] !== state.directoryHash) throw new DesignError("REVISION_CONFLICT", `Source changed since the inspected comparison: ${state.path}. Compare again before applying.`);
}
async function sourceHash(directory: string, path: string): Promise<string | null> { try { return sha(await readContainedFile(directory, path, CODE_PROJECT_LIMITS.assetBytes)); } catch (error) { if (missing(error)) return null; throw error; } }
function setSourceBaseline(link: SourceLink, path: string, baseline: SourceBaseline): void { if (baseline.projectHash === null && baseline.directoryHash === null) delete link.baseline[path]; else link.baseline[path] = baseline; }
