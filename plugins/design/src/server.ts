import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { idSchema } from './validation.ts';
import { CodexModelCatalog } from './codex-session.ts';
import { browserExecutable } from './browser.ts';
import { getDesignGuidance } from './art-direction.ts';
import { CodeProjectStore } from './code-project.ts';
import { registerCodeTools } from './code-server.ts';
import { VERSION } from './version.ts';
import { CodeGenerationRuntime } from './code-generation.ts';
import { CODE_PROJECT_FORMAT } from './code-project-format.ts';
import { ExportArtifacts } from './export-artifacts.ts';
import { DESIGN_REFERENCE_IDS, DESIGN_REFERENCE_LIMITS, getDesignReferenceCatalog, loadDesignReference } from './design-references.ts';

export { VERSION };
const panelUri = 'ui://design/studio.html';
const readonly = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
function result(value:unknown) { return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value as Record<string,unknown>}; }
function failure(error:unknown) { const e=error as {code?:string;message?:string};return{content:[{type:'text' as const,text:e.message??'Design operation failed'}],structuredContent:{error:{code:e.code??'DESIGN_ERROR',message:e.message??'Design operation failed'}},isError:true}; }
export interface ServerOptions {codeStore?:CodeProjectStore;catalog?:CodexModelCatalog;codeRuntime?:CodeGenerationRuntime;exportArtifacts?:ExportArtifacts;panelHtml?:string}
export async function createDesignServer(options:ServerOptions = {}) {
  const codeStore=options.codeStore??new CodeProjectStore();
  const codeRuntime=options.codeRuntime??new CodeGenerationRuntime({checkpointDir:path.join(codeStore.dataDir,'private-generation')});
  const catalog=options.catalog??new CodexModelCatalog();
  const exportArtifacts=options.exportArtifacts??new ExportArtifacts({dataDir:codeStore.dataDir});
  const server = new McpServer({name:'design',version:VERSION});
  const panelHtml=options.panelHtml??await readFile(fileURLToPath(new URL('../runtime/panel.html',import.meta.url)),'utf8');
  function tool<S extends z.ZodRawShape>(name:string,description:string,shape:S,handler:(input:z.infer<z.ZodObject<S>>)=>Promise<unknown>,openWorld=false) {
    const inputSchema=z.object(shape).strict();
    server.registerTool<z.ZodRawShape,typeof inputSchema>(name,{description,inputSchema,annotations:{...readonly,openWorldHint:openWorld}},async input=>{try{return result(await handler(input as z.infer<z.ZodObject<S>>));}catch(error){return failure(error);}});
  }
  const editorSchema=z.object({projectId:idSchema.optional()}).strict();
  registerAppTool(server,'design_open_editor',{title:'Design',description:'Open the Design studio to edit actual HTML/React source and runnable prototypes. The active conversation model is the default.',inputSchema:editorSchema,annotations:readonly,_meta:{ui:{resourceUri:panelUri},'openai/ui':{entrypoints:[{type:'thread'}]}}},async({projectId})=>{try{return result({...(projectId?{project:await codeStore.get(projectId)}:await codeStore.list()),version:VERSION});}catch(error){return failure(error);}});
  registerAppResource(server,'Design studio',panelUri,{mimeType:RESOURCE_MIME_TYPE},async()=>({contents:[{uri:panelUri,mimeType:RESOURCE_MIME_TYPE,text:panelHtml,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline','fullscreen']}}}]}));
  tool('design_get_capabilities','Read actual Design capabilities and model modes before use.',{},async()=>({
    version:VERSION,projectFormat:CODE_PROJECT_FORMAT,editor:'source',
    designSystem:{tokens:{listTool:'design_code_list_tokens',editTool:'design_code_edit_tokens',source:'CSS custom-property declarations in local .css and HTML style blocks',referenceResolution:'syntactic-name',computedCascade:false,maxPageSize:200,maxEdits:100,maxValueCharacters:16384},components:{importTool:'design_code_import_components',namedLibraries:true,occupiedNamespace:'reject',automaticPageIntegration:false}},
    modelReads:{files:'design_code_list_files',metadata:'design_code_read_metadata',commentUpdate:'design_code_update_comment',structuredResponseBytes:65536},
    designReferences:{tool:'design_get_reference',catalog:getDesignReferenceCatalog(),limits:DESIGN_REFERENCE_LIMITS,imagesAre:'reference examples, never verified work'},
    projectArchive:{importTool:'design_code_import_project',schemaVersion:CODE_PROJECT_FORMAT,maxArchiveBytes:33554432,newProject:true,preserves:['source','pages','defaultPageId','viewports','designSystem','comments'],copiesPrivateSourceConnection:false,executesArchive:false},
    modelModes:[{id:'host',name:'当前聊天',default:true},{id:'codex',name:'独立本地 Codex',requires:'Installed Codex CLI and its existing ChatGPT login'}],
    formats:['html','zip',...(await browserExecutable()?['png','pdf']:[])],templates:['html','react'],
    workflow:'Actual HTML/React/TSX/CSS source, source hashes, revision checks, source selection, sandbox interaction, real screenshots and browser diagnostics. Use design_code_* tools.',
    sourceSync:'Connected directories use explicit hash-checked comparison, pull/push, conflict selection and journal recheck. Other directory exports use manifest protection without journal recovery.',
    credentials:'Managed by Codex. No API key, token copying or separate OAuth.',unsupported:'No scene document or older project format migration. Unsupported files are reported and never silently rewritten or deleted.'
  }));
  tool('design_get_guidance','Read task-specific art direction before generating or refining a design. Existing brand and user intent take priority. Returns a small packaged-case catalog; use design_get_reference for actual reference images and source excerpts.',{directionId:z.string().min(1).max(80).optional(),brief:z.string().max(30000).optional(),taskType:z.enum(['landing','workbench','data','editorial','brand','components','prototype','comparison','diagram','general']).optional(),effort:z.enum(['quick','standard','explore','polish']).optional(),scope:z.enum(['new','local','system']).optional(),preserveExisting:z.boolean().optional(),existingSystem:z.string().max(12000).optional(),candidateCount:z.union([z.literal(2),z.literal(3)]).optional()},async input=>({...getDesignGuidance(input),examples:getDesignReferenceCatalog(),referenceTool:'design_get_reference'}));
  const referenceSchema=z.object({referenceId:z.enum(DESIGN_REFERENCE_IDS),views:z.array(z.enum(['desktop','mobile'])).max(2).optional()}).strict();
  server.registerTool<z.ZodRawShape,typeof referenceSchema>('design_get_reference',{description:'Read one real packaged design case as bounded design rules, its authored explanation, partial source excerpts and optional desktop/mobile PNG reference images. No external browsing or filesystem access is required by the model. These are examples, never the current project or evidence that its design was reviewed.',inputSchema:referenceSchema,annotations:readonly},async input=>{
    try{
      const payload=await loadDesignReference(input);
      const data={metadata:payload.metadata,content:payload.content};
      return{structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)},...payload.images.flatMap(image=>[{type:'text' as const,text:`Design reference only: ${payload.metadata.selectedId} / ${image.view} / ${image.width}×${image.height}. This is not the user's current work.`},{type:'image' as const,mimeType:image.mimeType,data:image.dataBase64}])]};
    }catch(error){return failure(error);}
  });
  tool('design_list_models','Read the actual model catalog from locally installed Codex using its existing login. A listed model is not proof of inference entitlement.',{},async()=>catalog.listModels(),true);
  registerCodeTools(server,codeStore,codeRuntime,exportArtifacts);
  return{server,codeStore,codeRuntime,catalog,exportArtifacts,dispose:async()=>{exportArtifacts.dispose();await Promise.all([catalog.dispose(),codeRuntime.dispose()]);await server.close();}};
}
