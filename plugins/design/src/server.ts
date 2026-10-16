import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DesignStore } from './store.ts';
import { designDocumentSchema, idSchema, validateDocument } from './model.ts';
import { patchSchema } from './operations.ts';
import { CodexDesignRuntime } from './codex.ts';
import { browserExecutable, exportDesign, importHtml } from './export.ts';
import { importProject, readProject, writeProjectLocked } from './sync.ts';
import { getDesignGuidance } from './art-direction.ts';

export const VERSION = '0.1.1';
const panelUri = 'ui://design/studio.html';
const readonly = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const mutating = {readOnlyHint:false,destructiveHint:false,openWorldHint:false};
const projectInput = {projectId:idSchema};
const revisionInput = {...projectInput,expectedRevision:z.number().int().positive()};
function result(value:unknown) { return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value as Record<string,unknown>}; }
function failure(error:unknown) { const e=error as {code?:string;message?:string;partial?:boolean;savedRevision?:number;directory?:string};return{content:[{type:'text' as const,text:e.message??'Design operation failed'}],structuredContent:{error:{code:e.code??'DESIGN_ERROR',message:e.message??'Design operation failed',...(e.partial?{partial:true,savedRevision:e.savedRevision,directory:e.directory}:{})}},isError:true}; }
export interface ServerOptions {store?:DesignStore;runtime?:CodexDesignRuntime;panelHtml?:string}
export async function createDesignServer(options:ServerOptions = {}) {
  const store=options.store??new DesignStore({}); const runtime=options.runtime??new CodexDesignRuntime();
  const server = new McpServer({name:'design',version:VERSION});
  const panelHtml=options.panelHtml??await readFile(fileURLToPath(new URL('../runtime/panel.html',import.meta.url)),'utf8');
  const methods = new Map<string,(input:any)=>Promise<unknown>>();
  function tool<S extends z.ZodRawShape>(name:string,description:string,schema:S,handler:(input:z.infer<z.ZodObject<S>>)=>Promise<unknown>,writes=false) {
    const inputSchema=z.object(schema).strict();
    methods.set(name,async input=>handler(inputSchema.parse(input) as z.infer<z.ZodObject<S>>));
    server.registerTool<z.ZodRawShape,typeof inputSchema>(name,{title:name.replaceAll('_',' '),description,inputSchema,annotations:writes?mutating:readonly},async input=>{try{return result(await handler(input as z.infer<z.ZodObject<S>>));}catch(error){return failure(error);}});
  }
  registerAppTool(server,'design_open_editor',{title:'Design',description:'Open the local editable Design studio. Use the current conversation model by default; no API key or extra login is needed.',inputSchema:{projectId:idSchema.optional()},annotations:readonly,_meta:{ui:{resourceUri:panelUri},'openai/ui':{entrypoints:[{type:'thread'}]}}},async({projectId})=>{try{return result(projectId?{document:await store.get(projectId)}:{projects:await store.list(),version:VERSION});}catch(error){return failure(error);}});
  registerAppResource(server,'Design studio',panelUri,{mimeType:RESOURCE_MIME_TYPE},async()=>({contents:[{uri:panelUri,mimeType:RESOURCE_MIME_TYPE,text:panelHtml,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline','fullscreen']}}}]}));
  tool('design_get_capabilities','Read actual Design capabilities and model modes before use.',{},async()=>({version:VERSION,modelModes:[{id:'host',name:'当前聊天',default:true},{id:'codex',name:'独立本地 Codex',requires:'Installed Codex CLI and its existing login'}],formats:['html','svg','json','zip',...(await browserExecutable()?['png','pdf']:[])],svgFormat:'HTML foreignObject; use an HTML-capable SVG viewer',templates:['blank','landing','dashboard','mobile'],workflow:'Read the document, then apply one atomic JSON Patch batch with expectedRevision. UI edits and model edits share the same document.',sourceSync:'Design JSON and generated interchange HTML; arbitrary framework code is handled by the current Codex conversation.',credentials:'Managed by Codex. No API key, token copying or separate OAuth.',hostVerified:false}));
  tool('design_get_schema','Read the Design document JSON schema. Runtime also checks unique IDs, token and component references, cycles and size budgets.',{},async()=>({schema:z.toJSONSchema(designDocumentSchema,{unrepresentable:'any'})}));
  tool('design_get_guidance','Read actionable art direction before generating a new design: audience, visual concept, typography, palette, composition, imagery, interaction and visual review. Existing brand and user intent take priority.',{directionId:z.string().min(1).max(80).optional(),brief:z.string().max(30000).optional()},async input=>getDesignGuidance(input));
  tool('design_list_projects','List saved local Design projects.',{},async()=>({projects:await store.list()}));
  tool('design_create_project','Create a local editable project. Templates are explicit starting documents, not AI-generated results.',{name:z.string().min(1).max(200),template:z.enum(['blank','landing','dashboard','mobile']).optional()},async input=>({document:await store.create(input)}),true);
  tool('design_get_project','Read the latest complete Design document, stable node IDs and revision.',projectInput,async({projectId})=>({document:await store.get(projectId)}));
  tool('design_apply_changes','Atomically apply RFC6901 add/replace/remove JSON patches. Read latest revision first; conflicts require rereading and reconciling, never blind retry.',{...revisionInput,patches:z.array(patchSchema).min(1).max(500)},async({projectId,expectedRevision,patches})=>({document:await store.apply(projectId,expectedRevision,patches)}),true);
  tool('design_replace_document','Replace editable document content after schema validation and revision checking. Retains project identity and server revision metadata.',{...revisionInput,document:z.unknown()},async({projectId,expectedRevision,document})=>({document:await store.replace(projectId,expectedRevision,validateDocument(document))}),true);
  tool('design_undo','Undo the most recent change, preserving concurrent revision checks.',revisionInput,async({projectId,expectedRevision})=>({document:await store.undo(projectId,expectedRevision)}),true);
  tool('design_redo','Redo the most recent undone change.',revisionInput,async({projectId,expectedRevision})=>({document:await store.redo(projectId,expectedRevision)}),true);
  tool('design_history','List retained project revisions.',projectInput,async({projectId})=>({versions:await store.history(projectId)}));
  tool('design_restore_version','Restore a retained revision as a new current revision.',{...revisionInput,revision:z.number().int().positive()},async({projectId,expectedRevision,revision})=>({document:await store.restore(projectId,expectedRevision,revision)}),true);
  tool('design_import_system','Import design tokens and components as JSON or CSS custom properties. Content is validated and never executed.',{...revisionInput,format:z.enum(['json','css']),content:z.string().max(4*1024*1024)},async({projectId,expectedRevision,format,content})=>{
    const current=await store.get(projectId);
    let system:DesignDocumentSystem;
    if(format==='json'){const value=JSON.parse(content);system=value.designSystem??value;}
    else {const tokens:Record<string,string>={...current.designSystem.tokens};for(const match of content.matchAll(/--([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^;{}]+)[;}]/g)){tokens[match[1]!]=match[2]!.trim();}if(!/--[A-Za-z]/.test(content)||JSON.stringify(tokens)===JSON.stringify(current.designSystem.tokens))throw new Error('No new CSS custom properties found.');system={...current.designSystem,tokens};}
    return{document:await store.apply(projectId,expectedRevision,[{op:'replace',path:'/designSystem',value:system}])};
  },true);
  tool('design_export','Export a real file from the current document. PNG/PDF require a local Chromium browser; all other formats are self-contained.',{...projectInput,format:z.enum(['html','svg','json','png','pdf','zip']),artboardId:idSchema.optional()},async({projectId,format,artboardId})=>exportDesign(await store.get(projectId),format,artboardId));
  tool('design_save_export','Save a real export in this plugin\'s local data directory when the host does not support file downloads. Returns the actual saved path.',{...projectInput,format:z.enum(['html','svg','json','png','pdf','zip']),artboardId:idSchema.optional()},async({projectId,format,artboardId})=>{const file=await exportDesign(await store.get(projectId),format,artboardId);const directory=path.join(store.dataDir,'exports',projectId);await mkdir(directory,{recursive:true,mode:0o700});const target=path.join(directory,`${randomUUID()}-${file.filename}`);await writeFile(target,Buffer.from(file.dataBase64,'base64'),{flag:'wx',mode:0o600});return{path:target,filename:file.filename,mimeType:file.mimeType};},true);
  tool('design_write_project','Write editable design.json, interactive index.html and a synchronization manifest into an explicit local directory. Refuses to overwrite unrelated or externally changed files.',{...projectInput,directory:z.string().min(1).max(4096)},async({projectId,directory})=>writeProjectLocked(await store.get(projectId),directory),true);
  tool('design_project_sync_status','Inspect external changes and revision conflicts in an explicitly selected Design project directory.',{...projectInput,directory:z.string().min(1).max(4096)},async input=>readProject(store,input));
  tool('design_import_project','Reconcile explicit external edits from Design JSON or generated interchange HTML, then synchronize the new revision back to its project. If both sources changed, choose the authoritative source explicitly.',{...revisionInput,directory:z.string().min(1).max(4096),source:z.enum(['html','json']).optional()},async input=>importProject(store,input),true);
  tool('design_import_source','Import Design JSON or generated interchange HTML from content. HTML scripts are parsed as inert data, never executed. Source revision must match the project.',{...revisionInput,format:z.enum(['json','html']),content:z.string().max(32*1024*1024)},async({projectId,expectedRevision,format,content})=>{const current=await store.get(projectId);const incoming=format==='html'?importHtml(content,current):validateDocument(JSON.parse(content));if(incoming.id!==projectId||incoming.revision!==expectedRevision)throw new Error('Source project or revision does not match.');return{document:await store.replace(projectId,expectedRevision,incoming)};},true);
  tool('design_read_source_file','Read an explicitly selected Design JSON/interchange HTML file for reconciliation. Does not execute scripts or change the project.',{file:z.string().min(1).max(4096)},async({file})=>{if(!path.isAbsolute(file)||!['.json','.html','.htm'].includes(path.extname(file).toLowerCase()))throw new Error('Choose an absolute Design JSON or HTML file.');const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error('Source must be a regular file no larger than 32 MiB.');return{content:await readFile(file,'utf8')};});
  tool('design_list_models','Read the real model catalog from locally installed Codex using its existing login. A listed model is not proof of inference entitlement.',{},async()=>runtime.listModels());
  tool('design_request_generation','Prepare a prompt for the current host conversation (default), or start an explicit independent local Codex generation job. A completed proposal is not applied until design_apply_generation.',{...projectInput,prompt:z.string().min(1).max(30000),mode:z.enum(['host','codex']).default('host'),model:z.string().min(1).max(200).optional()},async({projectId,prompt,mode,model})=>{
    const document=await store.get(projectId);
    if(mode==='host')return{mode,prompt:`Use the Design tools to update project ${projectId}. Read design_get_project and design_get_schema as needed. User request: ${prompt}.\n\n${getDesignGuidance({brief:prompt}).guidance}\n\nApply validated changes with expectedRevision; retain unaffected nodes and existing design tokens. Do not claim a visual review until you inspect a real render.`,context:{projectId,revision:document.revision,name:document.name}};
    return{mode,job:await runtime.start({projectId,prompt,document,...(model?{model}:{})})};
  },true);
  tool('design_get_generation','Read a local generation job. Only completed means the proposal is ready, not applied.',{jobId:idSchema},async({jobId})=>({job:runtime.get(jobId)}));
  tool('design_cancel_generation','Cancel a local Codex generation and wait for its actual exit.',{jobId:idSchema},async({jobId})=>({job:await runtime.cancel(jobId)}),true);
  tool('design_apply_generation','Apply a completed Codex proposal to its original base revision. Rejects stale or non-completed jobs.',{jobId:idSchema,expectedRevision:z.number().int().positive()},async({jobId,expectedRevision})=>{const job=runtime.get(jobId);if(job.status!=='completed'||!job.output)throw new Error('Generation has no completed proposal.');if(job.baseRevision!==expectedRevision)throw new Error('Generation base revision is stale. Reconcile with the latest design.');return{document:await store.apply(job.projectId,expectedRevision,job.output)};},true);
  return{server,store,runtime,methods,dispose:async()=>{await runtime.dispose();await server.close();}};
}
type DesignDocumentSystem = ReturnType<typeof validateDocument>['designSystem'];
