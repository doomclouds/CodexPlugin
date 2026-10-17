import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJavaScript } from '@babel/parser';
import { parseFragment } from 'parse5';
import type * as ESBuild from 'esbuild-wasm';
import { CODE_PROJECT_LIMITS, validateCodePath, validateCodeProject } from './code-project.ts';
import type { CodeFile, CodeProject, CodeProjectUpdate } from './code-project.ts';
import type { PreviewDiagnostic } from './code-preview.ts';

export interface ComponentSystemInput {
  directory: string;
  libraryName?: string;
  entries: Array<{ name: string; path: string; exportName?: string; usage?: string }>;
  cssFiles?: string[];
  typeFiles?: string[];
  notes?: string;
}
export interface ComponentLibraryPaths {
  libraryName: string;
  prefix: string;
  entry: string;
  guide: string;
  provenance: string;
}
export interface ComponentSystemImportResult {
  paths: ComponentLibraryPaths;
  files: CodeFile[];
  components: CodeProject['designSystem']['components'];
  notes: string;
  provenance: { sourceHashes: Record<string, string>; fileMap: Record<string, string>; licenses: Array<{ sourcePath: string; path: string; sha256: string }>; packages?: Array<{ name: string; version?: string; path: string }> };
  diagnostics: PreviewDiagnostic[];
}
export interface ComponentSystemImportPlan {
  changes: CodeProjectUpdate;
  paths: ComponentLibraryPaths;
  provenance: ComponentSystemImportResult['provenance'];
  diagnostics: PreviewDiagnostic[];
  requiresIntegration: true;
  guide: string;
}
export const COMPONENT_IMPORT_LIMITS = { files: 128, inputBytes: 32 * 1024 * 1024, inputFileBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, entries: 64 } as const;
const reactModules = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
const loaders: Record<string, ESBuild.Loader> = { '.js':'js', '.mjs':'js', '.cjs':'js', '.jsx':'jsx', '.ts':'ts', '.tsx':'tsx', '.css':'css', '.json':'json' };
const media: Record<string, string> = { '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf' };
const untrackedCssResourceFunctions=new Set(['image-set','-webkit-image-set','image','src']);
const reserved = new Set(['await','break','case','catch','class','const','continue','debugger','default','delete','do','else','enum','export','extends','false','finally','for','function','if','implements','import','in','instanceof','interface','let','new','null','package','private','protected','public','return','static','super','switch','this','throw','true','try','typeof','var','void','while','with','yield']);
const identifier = (name: string): boolean => /^[$A-Z_a-z][$\w]*$/.test(name) && !reserved.has(name);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
export const COMPONENT_SOURCE_PREFIX = 'components/design-system/';
export const COMPONENT_SOURCE_ENTRY = COMPONENT_SOURCE_PREFIX+'index.ts';
export const COMPONENT_LIBRARY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export function componentLibraryPaths(libraryName = 'design-system'): ComponentLibraryPaths {
  if (typeof libraryName !== 'string' || libraryName.length > 48 || !COMPONENT_LIBRARY_NAME_PATTERN.test(libraryName)) throw new Error('libraryName must be a lowercase ASCII library slug of 1–48 characters, separated by single hyphens.');
  const prefix = `components/${libraryName}/`;
  const paths = { libraryName, prefix, entry:prefix+'index.ts', guide:`docs/${libraryName}-guide.md`, provenance:`docs/${libraryName}-provenance.json` };
  for (const path of [paths.entry, paths.guide, paths.provenance]) validateCodePath(path);
  return paths;
}

// Plan an append-only batch. The store still performs the final revision/hash CAS.
export function planComponentSystemImport(project: CodeProject, imported: ComponentSystemImportResult): ComponentSystemImportPlan {
  const paths = componentLibraryPaths(imported.paths.libraryName);
  if (Object.entries(paths).some(([key,value]) => imported.paths[key as keyof ComponentLibraryPaths] !== value)) throw new Error('Component import output paths do not match their library namespace.');
  const occupied = project.files.find(file => file.path.toLowerCase().startsWith(paths.prefix.toLowerCase()) || [paths.guide, paths.provenance].some(path => path.toLowerCase() === file.path.toLowerCase()));
  if (occupied) throw new Error(`Component library namespace is already occupied: ${paths.libraryName}. Choose a new libraryName; existing source is never replaced or removed by import.`);
  const names = new Set(project.designSystem.components.map(component => component.name));
  if (imported.components.some(component => names.has(component.name))) throw new Error('A component name conflicts with an existing design-system entry. Choose a distinct alias.');
  const outputs = new Set<string>();
  for (const file of imported.files) {
    validateCodePath(file.path);
    if (!file.path.startsWith(paths.prefix) && file.path !== paths.guide && file.path !== paths.provenance) throw new Error('A component import output is outside its library namespace.');
    const folded = file.path.toLowerCase();
    if (outputs.has(folded) || project.files.some(existing => existing.path.toLowerCase() === folded)) throw new Error(`Component import output path is already occupied: ${file.path}`);
    outputs.add(folded);
  }
  if (!outputs.has(paths.entry) || !outputs.has(paths.guide) || !outputs.has(paths.provenance) || imported.components.some(component => component.path !== paths.entry)) throw new Error('A component library must retain its real entry, guide and provenance.');
  const designSystem = {...project.designSystem, components:[...project.designSystem.components,...imported.components], notes:[project.designSystem.notes,imported.notes].filter(Boolean).join('\n\n')};
  validateCodeProject({...project,files:[...project.files,...imported.files],designSystem});
  return {changes:{files:imported.files.map(file=>({...file,expectedHash:null})),designSystem},paths,provenance:imported.provenance,diagnostics:imported.diagnostics,requiresIntegration:true,guide:paths.guide};
}
let engine: typeof ESBuild | undefined;
function compiler(): typeof ESBuild {
  if (engine) return engine;
  try { engine = require(fileURLToPath(new URL('../runtime/vendor/esbuild-wasm/lib/main.js', import.meta.url))) as typeof ESBuild; }
  catch { if (!fileURLToPath(import.meta.url).endsWith('/src/component-import.ts')) throw new Error('The packaged component compiler is missing. Rebuild the Design plugin.'); engine = require('esbuild-wasm') as typeof ESBuild; }
  return engine;
}
function safeRelative(path: string): string {
  if (!path || path.length > 512 || isAbsolute(path) || /[\\\x00-\x1f:#?%]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || ['.git','.codex','.agents'].includes(part.toLowerCase()))) throw new Error('Choose a contained project-relative component, CSS or API path.');
  return path;
}
function walk(node: unknown, callback: (node: Record<string, any>, parent?: Record<string,any>, key?: string) => void, parent?: Record<string,any>, key?:string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child,callback,parent,key); return; }
  const value = node as Record<string,any>;
  if (typeof value.type === 'string') callback(value,parent,key);
  for (const [childKey,child] of Object.entries(value)) if (!['loc','start','end','comments','tokens','extra'].includes(childKey)) walk(child,callback,value,childKey);
}

interface SourceReference { start: number; end: number; request: string; kind: ESBuild.ImportKind; typeOnly?: boolean }
interface SourceEdge { target: string; suffix: string }
const referenceKey=(reference:Pick<SourceReference,'kind'|'request'|'typeOnly'>)=>`${reference.kind}\0${reference.request}\0${reference.typeOnly?'type':'value'}`;
const unwrap = (node: Record<string,any>):Record<string,any> => { while (node && ['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','TSTypeAssertion','TSInstantiationExpression','ParenthesizedExpression'].includes(node.type)) node=node.expression; return node; };
function jsReferences(content: string, warn:(message:string)=>void): SourceReference[] {
  const ast=parseJavaScript(content,{sourceType:'unambiguous',plugins:['jsx','typescript'],createImportExpressions:true}); const references:SourceReference[]=[];
  const importedAssets=new Set<string>(),literalBindings=new Set<string>(),assetHrefs=new Set<object>(),staticRequireIdentifiers=new Set<object>();walk(ast,node=>{if(node.type==='ImportDeclaration'&&media[extname(node.source.value.split(/[?#]/)[0]).toLowerCase()])for(const item of node.specifiers)importedAssets.add(item.local.name);if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&unwrap(node.init)?.type==='StringLiteral')literalBindings.add(node.id.name);if(node.type==='JSXOpeningElement'&&['image','use'].includes(node.name?.name))for(const attr of node.attributes)if(['href','xlinkHref'].includes(attr.name?.name))assetHrefs.add(attr);if(node.type==='CallExpression'&&unwrap(node.callee)?.type==='Identifier'&&unwrap(node.callee).name==='require')staticRequireIdentifiers.add(unwrap(node.callee));});
  const add=(value:Record<string,any>,kind:ESBuild.ImportKind,typeOnly=false)=>{const node=unwrap(value);const request=node?.type==='StringLiteral'?node.value:node?.type==='TemplateLiteral'&&node.expressions.length===0?node.quasis[0]?.value.cooked:undefined;if(typeof request!=='string')throw new Error('Dynamic component dependency expressions cannot be made self-contained. Select an explicit static dependency surface.');references.push({start:node.start,end:node.end,request,kind,...(typeOnly?{typeOnly:true}:{})});};
  walk(ast,(node,parent,key)=>{
    if(node.type==='Identifier'&&node.name==='require'&&!staticRequireIdentifiers.has(node)){
      const propertyName=key==='property'&&parent?.type==='MemberExpression'&&!parent.computed||key==='key'&&parent?.type==='ObjectProperty'&&!parent.computed&&!parent.shorthand||parent?.type==='TSTypeQuery';
      if(!propertyName)throw new Error('A require value escapes its static call. Aliased require helpers cannot be closed as editable source.');
    }
    if(node.type==='MemberExpression'&&['module','globalThis','window','global','self'].includes(unwrap(node.object)?.name)&&(node.property?.name??node.property?.value)==='require')throw new Error('Global/module require helpers cannot be closed as editable browser source.');
    const literal=node.type==='StringLiteral'?node.value:node.type==='DirectiveLiteral'?node.extra?.expressionValue??node.value:node.type==='TemplateElement'?node.value.cooked:undefined;
    if(typeof literal==='string'&&/(?:^|[^\w])\/(?:Users|home)\/[^/\s"'`]+|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+|\/(?:private\/)?var\/folders\//.test(literal.replace(/https?:\/\/[^\s"'`<>]+/g,'')))throw new Error('Component source contains a nonportable personal path literal. Supply portable source before importing.');
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)add(node.source,'import-statement',node.importKind==='type'||node.exportKind==='type'||node.type==='ImportDeclaration'&&node.specifiers.length>0&&node.specifiers.every((item:Record<string,any>)=>item.importKind==='type'));
    if(node.type==='TSImportType')add(node.argument,'import-statement',true);
    if(node.type==='TSImportEqualsDeclaration'&&node.moduleReference?.type==='TSExternalModuleReference')add(node.moduleReference.expression,'require-call',node.importKind==='type');
    if(node.type==='ImportExpression')add(node.source,'dynamic-import');
    const callee=unwrap(node.callee);
    if(node.type==='CallExpression'&&callee?.type==='Identifier'&&callee.name==='require')add(node.arguments[0],'require-call');
    if(node.type==='CallExpression'&&callee?.type==='MemberExpression'&&unwrap(callee.object)?.name==='require')throw new Error('require.resolve and computed require helpers cannot be closed as editable browser source.');
    if(node.type==='CallExpression'&&callee?.type==='MemberExpression'&&unwrap(callee.object)?.name==='module'&&(callee.property?.name??callee.property?.value)==='require')throw new Error('module.require cannot be closed as editable browser source.');
    if(node.type==='OptionalCallExpression'&&(callee?.name==='require'||['require','module'].includes(unwrap(callee?.object)?.name)))throw new Error('Optional require helpers cannot be closed as editable browser source.');
    if(node.type==='NewExpression'&&['URL','Worker','SharedWorker'].includes(callee?.name))throw new Error('new URL and worker resources cannot be closed as editable component source. Use explicit static asset imports.');
    if(node.type==='MetaProperty'&&node.meta?.name==='import')throw new Error('import.meta resources require an unsupported project transform. Use explicit static imports.');
    if(node.type==='JSXAttribute') {
      const name=node.name?.name;if(!['src','poster','srcSet','href','xlinkHref'].includes(name))return;
      const value=node.value?.type==='JSXExpressionContainer'?unwrap(node.value.expression):node.value;
      if(value?.type!=='StringLiteral'){if(['src','poster','srcSet'].includes(name)&&value){if(value.type==='Identifier'&&literalBindings.has(value.name)&&!importedAssets.has(value.name))throw new Error('A JSX asset path stored in a local string is not closed. Use an explicit static image import.');if(value.type!=='Identifier'||!importedAssets.has(value.name))warn('动态 JSX 资源输入未由静态资产导入确认；接入页面时须提供项目内真实资源，并实际检查。');}return;}
      if(name==='srcSet'&&!value.value.startsWith('data:'))throw new Error('Static srcSet lists require explicit imported asset expressions; this importer does not guess resource candidates.');
      if(['src','poster'].includes(name)||assetHrefs.has(node))references.push({start:value.start,end:value.end,request:value.value,kind:'url-token'});
    }
    if(node.type==='ObjectProperty'&&['background','backgroundImage','maskImage'].includes(node.key?.name??node.key?.value)&&node.value?.type==='StringLiteral'&&/url\s*\(\s*['"]?(?!data:|#)[^\s'"\)]+/i.test(node.value.value))throw new Error('A CSS-in-JS resource path is not closed. Use an explicit asset import or a real CSS file.');
    if(node.type==='TaggedTemplateExpression'&&node.quasi.quasis.some((part:Record<string,any>)=>/url\s*\(/i.test(part.value.raw)))warn('CSS-in-JS 模板中的资源表达式未作为 CSS 文件闭包验证；须使用明确的静态资产导入并实际检查。');
  });
  return references;
}
function cssReferences(content: string): SourceReference[] {
  const references:SourceReference[]=[];let cursor=0;
  const skip=()=>{while(cursor<content.length){if(/\s/.test(content[cursor]!)){cursor++;continue;}if(content.startsWith('/*',cursor)){const end=content.indexOf('*/',cursor+2);if(end<0)throw new Error('Unterminated CSS comment.');cursor=end+2;continue;}break;}};
  const decode=(raw:string)=>raw.replace(/\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|\r?\n|([^\r\n]))/gi,(_all,hex:string,plain:string)=>hex?String.fromCodePoint(parseInt(hex,16)||0xfffd):plain??'');
  const quoted=()=>{const start=cursor,quote=content[cursor++]!;while(cursor<content.length&&content[cursor]!==quote){if(content[cursor]==='\\')cursor++;cursor++;}if(cursor>=content.length)throw new Error('Unterminated CSS resource string.');cursor++;return{start,end:cursor,request:decode(content.slice(start+1,cursor-1))};};
  const url=(kind:ESBuild.ImportKind)=>{cursor+=3;skip();if(content[cursor++]!=='(')throw new Error('Invalid CSS url token.');skip();let value:{start:number;end:number;request:string};if(['"',"'"].includes(content[cursor]!))value=quoted();else{const start=cursor;while(cursor<content.length&&content[cursor]!==')'){if(content[cursor]==='\\')cursor++;cursor++;}let end=cursor;while(end>start&&/\s/.test(content[end-1]!))end--;value={start,end,request:decode(content.slice(start,end))};}skip();if(content[cursor++]!==')')throw new Error('Invalid CSS url resource.');references.push({...value,kind});};
  while(cursor<content.length){skip();if(cursor>=content.length)break;if(content[cursor]==='"'||content[cursor]==="'"){quoted();continue;}if(/^@import\b/i.test(content.slice(cursor))){cursor+=7;skip();if(/^url\s*\(/i.test(content.slice(cursor)))url('import-rule');else if(['"',"'"].includes(content[cursor]!))references.push({...quoted(),kind:'import-rule'});else throw new Error('Unsupported CSS @import dependency.');continue;}if(/^url\s*\(/i.test(content.slice(cursor))&&(cursor===0||!/[\w-]/.test(content[cursor-1]!))){url('url-token');continue;}const identifier=content.slice(cursor).match(/^[-_a-zA-Z][-_a-zA-Z0-9]*/)?.[0];if(identifier){if(content[cursor+identifier.length]==='('&&untrackedCssResourceFunctions.has(identifier.toLowerCase()))throw new Error(`CSS resource function ${identifier} is unsupported in the editable asset closure. Use explicit url() references.`);cursor+=identifier.length;continue;}cursor++;}
  return references;
}
async function normalizedCss(source:string,label:string):Promise<string>{
  // The CSS parser decodes identifier escapes; keep every declaration so an
  // overridden resource cannot disappear before closure validation.
  let normalized:ESBuild.TransformResult;
  try{normalized=await compiler().transform(source,{loader:'css',logLevel:'silent',minify:false,legalComments:'none'});}catch{throw new Error(`${label} resources cannot be verified because their syntax is unsupported.`);}
  if(normalized.warnings.length)throw new Error(`${label} resources cannot be verified because their syntax is unsupported.`);
  return normalized.code;
}
function rewriteReferences(content:string,references:SourceReference[],edges:Map<string,SourceEdge>,output:string,mapping:Map<string,string>):string{
  let result=content;for(const reference of [...references].sort((a,b)=>b.start-a.start)){const edge=edges.get(referenceKey(reference));if(!edge)continue;const target=mapping.get(edge.target);if(!target)throw new Error('A resolved source dependency was not copied into the project.');let request=posix.relative(posix.dirname(output),target);if(!request.startsWith('.'))request='./'+request;result=result.slice(0,reference.start)+JSON.stringify(request+edge.suffix)+result.slice(reference.end);}return result;
}
async function assertSelfContainedSvg(content:string):Promise<void>{
  if(/<!ENTITY|<!DOCTYPE[^>]+(?:SYSTEM|PUBLIC)|<\?xml-stylesheet/i.test(content))throw new Error('SVG external declarations and stylesheets are not a closed asset.');
  const accept=(request:string)=>!request||request.startsWith('#')||request.startsWith('data:');
  const css:string[]=[];
  const presentationProperties=new Set(['fill','stroke','filter','clip-path','mask','marker','marker-start','marker-mid','marker-end','cursor','color-profile']);
  const visit=(node:any)=>{if(node.tagName==='script')throw new Error('SVG scripts are not a closed image asset.');for(const attr of node.attrs??[]){if(['href','src','srcset'].includes(attr.name)&&!accept(attr.value))throw new Error('SVG nested resources must be embedded or local fragments; relative and external SVG resources are unsupported.');if(attr.name==='style')css.push(`svg{${attr.value}}`);else if(presentationProperties.has(attr.name))css.push(`svg{${attr.name}:${attr.value}}`);}if(node.tagName==='style')css.push((node.childNodes??[]).map((child:any)=>child.value??'').join(''));for(const child of node.childNodes??[])visit(child);};
  visit(parseFragment(content));
  if(css.length&&cssReferences(await normalizedCss(css.join('\n'),'SVG CSS')).some(reference=>!accept(reference.request)))throw new Error('SVG CSS resources are not self-contained.');
}

export async function importComponentSystem(input: ComponentSystemInput): Promise<ComponentSystemImportResult> {
  const paths = componentLibraryPaths(input.libraryName);
  if (!isAbsolute(input.directory)) throw new Error('Choose an absolute component-system source directory.');
  const rootInfo=await lstat(input.directory);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('The component source root must be a real directory.');
  const root=await realpath(input.directory);
  if(!Array.isArray(input.entries)||!input.entries.length||input.entries.length>COMPONENT_IMPORT_LIMITS.entries)throw new Error('Choose 1 to 64 real component entries.');
  const names=new Set<string>();for(const entry of input.entries){if(!identifier(entry.name)||names.has(entry.name))throw new Error('Component names must be unique, non-reserved JavaScript identifiers.');names.add(entry.name);safeRelative(entry.path);if(entry.exportName!==undefined&&entry.exportName!=='default'&&!identifier(entry.exportName))throw new Error('Component exportName must be default or a named JavaScript export.');if(entry.usage!==undefined&&(typeof entry.usage!=='string'||entry.usage.length>10000))throw new Error('A component usage note is limited to 10000 characters.');}
  if((input.cssFiles?.length??0)>32||(input.typeFiles?.length??0)>32||(input.notes?.length??0)>100000)throw new Error('Component CSS, API or notes budget exceeded.');
  for(const path of [...input.cssFiles??[],...input.typeFiles??[]])safeRelative(path);
  for(const path of input.cssFiles??[])if(extname(path).toLowerCase()!=='.css')throw new Error('cssFiles must select real CSS files.');
  for(const path of input.typeFiles??[])if(!/\.d\.ts$/i.test(path))throw new Error('typeFiles must select supported .d.ts declaration source.');
  const diagnostics:PreviewDiagnostic[]=[];const hashes:Record<string,string>=Object.create(null) as Record<string,string>;
  const cache=new Map<string,Buffer>(),pending=new Map<string,Promise<{path:string;bytes:Buffer}>>(),packages=new Map<string,{name:string;version?:string;path:string}>();
  const references=new Map<string,SourceReference[]>(),edges=new Map<string,Map<string,SourceEdge>>(),visited=new Set<string>(),licenseSources=new Set<string>();let inputBytes=0;
  const portable=(path:string)=>relative(root,path).split(sep).join('/');
  const sanitize=(value:string)=>value.replaceAll(root,'<source-root>').replaceAll(input.directory,'<source-root>');
  const contained=async(path:string)=>{const canonical=await realpath(path),rel=relative(root,canonical);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('A component dependency resolves outside the selected source root. Select a root containing the complete workspace.');if(rel.split(sep).some(part=>['.git','.codex','.agents'].includes(part.toLowerCase())))throw new Error('Component imports cannot read reserved configuration directories.');return canonical;};
  const read=async(path:string):Promise<{path:string;bytes:Buffer}>=>{const canonical=await contained(path);const cached=cache.get(canonical);if(cached)return{path:canonical,bytes:cached};const acquisition=pending.get(canonical);if(acquisition)return acquisition;if(cache.size+pending.size>=COMPONENT_IMPORT_LIMITS.files)throw new Error('Component import exceeds 128 source/resource files. Narrow the selected surface.');const task=(async()=>{const handle=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const info=await handle.stat();if(!info.isFile()||info.size>COMPONENT_IMPORT_LIMITS.inputFileBytes)throw new Error('A component resource is not a regular file or exceeds 8 MiB.');const bytes=await handle.readFile(),after=await handle.stat();if(after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||bytes.length!==info.size)throw new Error('Component source changed while reading; inspect the source and retry explicitly.');if(bytes.length>COMPONENT_IMPORT_LIMITS.inputFileBytes||inputBytes+bytes.length>COMPONENT_IMPORT_LIMITS.inputBytes)throw new Error('Component source/resource input budget exceeded.');inputBytes+=bytes.length;cache.set(canonical,bytes);hashes[portable(canonical)]=digest(bytes);return{path:canonical,bytes};}finally{await handle.close();}})();pending.set(canonical,task);try{return await task;}finally{pending.delete(canonical);}};
  const recordPackage=async(path:string)=>{const segments=portable(path).split('/'),last=segments.lastIndexOf('node_modules');if(last<0)return;const count=segments[last+1]?.startsWith('@')?3:2,packagePath=segments.slice(0,last+count).join('/')+'/package.json';if(packages.has(packagePath))return;try{const raw=await read(join(root,packagePath)),value:unknown=JSON.parse(raw.bytes.toString('utf8'));if(value&&typeof value==='object'&&'name'in value&&typeof value.name==='string'&&/^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(value.name)){const version='version'in value&&typeof value.version==='string'&&/^[\w.+-]{1,100}$/.test(value.version)?value.version:undefined;packages.set(packagePath,{name:value.name,...(version?{version}:{}),path:packagePath});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
  const text=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const warn=(path:string,message:string)=>{if(!diagnostics.some(item=>item.file===portable(path)&&item.message===message))diagnostics.push({level:'warning',file:portable(path),message});};
  const resolveReference=async(build:ESBuild.PluginBuild,from:string,reference:SourceReference):Promise<SourceEdge|undefined>=>{
    if(reactModules.has(reference.request))return undefined;
    if(reference.kind==='url-token'&&(!reference.request||reference.request.startsWith('data:')||reference.request.startsWith('#')))return undefined;
    if(/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(reference.request))throw new Error('External URLs and native-module dependencies are not supported by the contained component source.');
    let resolution=await build.resolve(reference.request,{resolveDir:dirname(from),kind:reference.kind,pluginData:{designResolutionBypass:true}});
    if(reference.typeOnly&&(resolution.errors.length||!resolution.path)&&reference.request.startsWith('.')){
      const candidate=resolve(dirname(from),reference.request);for(const fallback of [candidate+'.d.ts',join(candidate,'index.d.ts')])try{const path=await contained(fallback);resolution={...resolution,errors:[],path,external:false,suffix:''};break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(resolution.errors.length||!resolution.path||resolution.external)throw new Error(`Dependency is missing or unsupported: ${sanitize(reference.request)}. Install nothing automatically; select a root containing its existing source or node_modules.`);
    const canonical=await contained(resolution.path);await recordPackage(canonical);
    if(reference.typeOnly&&!reference.request.startsWith('.')){
      const segments=portable(canonical).split('/'),last=segments.lastIndexOf('node_modules');if(last>=0){const count=segments[last+1]?.startsWith('@')?3:2,packageRoot=join(root,...segments.slice(0,last+count)),metadata=JSON.parse((await read(join(packageRoot,'package.json'))).bytes.toString('utf8')) as Record<string,unknown>;const declared=metadata.types??metadata.typings;if(typeof declared==='string'&&!reference.request.slice(reference.request.startsWith('@')?reference.request.indexOf('/')+1:0).includes('/')){const path=await contained(resolve(packageRoot,declared));return{target:path,suffix:''};}if(!/\.[jt]sx?$/.test(canonical)||/\.js$/.test(canonical))throw new Error('A type-only package dependency has no supported explicit declaration entry. Select a portable relative declaration surface.');}
    }
    const suffix=resolution.suffix??'';if(suffix&&(reference.kind!=='url-token'||suffix.startsWith('?')))throw new Error('Query-based module transforms and module resource fragments are unsupported. Use explicit source/assets; CSS/JSX asset fragments are supported.');
    return{target:canonical,suffix};
  };
  let acquireGraph:(path:string,build:ESBuild.PluginBuild)=>Promise<void>;
  acquireGraph=async(path,build)=>{const raw=await read(path);if(visited.has(raw.path))return;visited.add(raw.path);await recordPackage(raw.path);const extension=extname(raw.path).toLowerCase();if(media[extension]){if(extension==='.svg')await assertSelfContainedSvg(text(raw.bytes));return;}const loader=loaders[extension];if(!loader)throw new Error('Unsupported component source extension: '+extension);const content=text(raw.bytes);if(extension==='.css')cssReferences(await normalizedCss(content,'Component CSS'));const refs=extension==='.css'?cssReferences(content):extension==='.json'?[]:jsReferences(content,message=>warn(raw.path,message));references.set(raw.path,refs);const fileEdges=new Map<string,SourceEdge>();edges.set(raw.path,fileEdges);for(const reference of refs){const edge=await resolveReference(build,raw.path,reference);if(edge){fileEdges.set(referenceKey(reference),edge);await acquireGraph(edge.target,build);}}};
  const imports=[...input.entries.map(entry=>`export {${entry.exportName??'default'} as ${entry.name}} from ${JSON.stringify('./'+entry.path)};`),...(input.cssFiles??[]).map(path=>`import ${JSON.stringify('./'+path)};`),...(input.typeFiles??[]).map(path=>`import ${JSON.stringify('./'+path)};`)].join('\n');
  const plugin:ESBuild.Plugin={name:'design-editable-component-source',setup(build){
    build.onResolve({filter:/.*/},async args=>{if(args.pluginData?.designResolutionBypass)return undefined;if(reactModules.has(args.path))return{path:args.path,external:true};if(args.kind==='url-token'&&(args.path.startsWith('data:')||args.path.startsWith('#')))return{path:args.path,external:true};try{const from=args.importer?resolve(root,args.importer):join(root,'design-system-entry.js');const reference:SourceReference={start:0,end:0,request:args.path,kind:args.kind};const edge=await resolveReference(build,from,reference);if(!edge)throw new Error('Unexpected external component reference.');if(cache.has(from)&&!references.get(from)?.some(item=>referenceKey(item)===referenceKey(reference)))throw new Error('A resource syntax resolved by the compiler has no safe editable-source mapping.');const raw=await read(edge.target);if(args.kind==='url-token')return{path:`data:${media[extname(raw.path).toLowerCase()]};base64,${raw.bytes.toString('base64')}`+edge.suffix,external:true};return{path:portable(raw.path),namespace:'component-source',sideEffects:extname(raw.path).toLowerCase()==='.css'?true:undefined,pluginData:{canonical:raw.path}};}catch(error){return{errors:[{text:sanitize(error instanceof Error?error.message:'Component dependency resolution failed.')}]};}});
    build.onLoad({filter:/.*/,namespace:'component-source'},async args=>{try{const raw=await read(args.pluginData?.canonical??join(root,args.path));await acquireGraph(raw.path,build);const extension=extname(raw.path).toLowerCase();if(media[extension])return{contents:`export default ${JSON.stringify(`data:${media[extension]};base64,${raw.bytes.toString('base64')}`)}`,loader:'js'};return{contents:text(raw.bytes),loader:loaders[extension]!,resolveDir:dirname(raw.path)};}catch(error){return{errors:[{text:sanitize(error instanceof Error?error.message:'Component source acquisition failed.')}]};}});
  }};
  let built:ESBuild.BuildResult;try{built=await compiler().build({stdin:{contents:imports,resolveDir:root,sourcefile:'design-system-entry.js',loader:'js'},bundle:true,write:false,outdir:join(root,'.design-component-validation'),entryNames:'validation',format:'esm',platform:'browser',target:['es2022'],jsx:'automatic',jsxImportSource:'react',plugins:[plugin],logLevel:'silent',minify:false,legalComments:'inline',metafile:true,define:{'process.env.NODE_ENV':'"production"'}});}catch(error){const issues=(error as{errors?:Array<{text:string}>}).errors;throw new Error('Real component source validation failed: '+sanitize(issues?.slice(0,8).map(item=>item.text).join('; ')||(error instanceof Error?error.message:'unknown compiler failure')));}
  for(const warning of built.warnings)diagnostics.push({level:'warning',message:sanitize(warning.text)});
  const exported=new Set(Object.entries(built.metafile?.outputs??{}).filter(([path])=>path.endsWith('.js')).flatMap(([,output])=>output.exports));for(const entry of input.entries)if(!exported.has(entry.name))throw new Error(`Requested component export does not exist: ${entry.name}`);
  // Keep actual license/notice text near every acquired source and package root.
  const checkedDirectories=new Set<string>();for(const file of [...cache.keys()]){let folder=dirname(file);while(folder===root||folder.startsWith(root+sep)){if(!checkedDirectories.has(folder)){checkedDirectories.add(folder);for(const entry of await readdir(folder,{withFileTypes:true})){if(!entry.isFile()||!/(?:^|[-_.])(?:licen[cs]e|notice|copying|ofl)(?:$|[-_.])/i.test(entry.name))continue;const raw=await read(join(folder,entry.name));licenseSources.add(raw.path);}}if(folder===root)break;folder=dirname(folder);}}
  for(const item of packages.values()){const packageRoot=dirname(join(root,item.path));if(![...licenseSources].some(path=>path.startsWith(packageRoot+sep)))warn(join(root,item.path),'此依赖未发现实际 LICENSE/NOTICE/OFL 文本；保留了包元数据，交付前须核对许可，不能把包名称当作授权证明。');}
  const mapping=new Map<string,string>(),outputs=new Map<string,string>();
  for(const canonical of [...cache.keys()].sort()){const rel=portable(canonical),segments=rel.split('/'),last=segments.lastIndexOf('node_modules');let output:string;if(last>=0){const count=segments[last+1]?.startsWith('@')?3:2,packageRoot=segments.slice(0,last+count).join('/'),packageName=segments.slice(last+1,last+count).join('-').replace(/[^A-Za-z0-9._-]/g,'-');output=paths.prefix+'dependencies/'+packageName+'-'+digest(Buffer.from(packageRoot)).slice(0,12)+'/'+segments.slice(last+count).join('/');}else output=paths.prefix+'source/'+rel;if(licenseSources.has(canonical)&&!['.txt','.md','.json','.html'].includes(extname(output).toLowerCase()))output+='.txt';validateCodePath(output);const collision=outputs.get(output.toLowerCase());if(collision&&collision!==canonical)throw new Error('Component source paths collide after portable mapping. Rename the conflicting source before importing.');outputs.set(output.toLowerCase(),canonical);mapping.set(canonical,output);}
  const files:CodeFile[]=[];
  for(const[canonical,bytes]of cache){const output=mapping.get(canonical)!;const extension=extname(canonical).toLowerCase();if(media[extension]&&extension!=='.svg'){files.push({path:output,content:bytes.toString('base64'),encoding:'base64'});continue;}let content=text(bytes);if(!licenseSources.has(canonical))content=rewriteReferences(content,references.get(canonical)??[],edges.get(canonical)??new Map(),output,mapping);if(content.includes(root)||content.includes(input.directory)||/(?:^|[^\w])\/(?:Users|home)\/[^/\s"'`]+|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/.test(content.replace(/https?:\/\/[^\s"'`<>]+/g,'')))throw new Error('A selected source or license embeds a nonportable personal/source-root path. Supply portable source before importing.');files.push({path:output,content,encoding:'utf8'});}
  const relativeEntry=(target:string)=>{let path=posix.relative(posix.dirname(paths.entry),target);return path.startsWith('.')?path:'./'+path;};
  const entrySources:Record<string,string>={};const entryLines:string[]=[];for(const entry of input.entries){const canonical=await contained(resolve(root,entry.path)),target=mapping.get(canonical);if(!target)throw new Error('Selected component source was not included.');entrySources[entry.name]=target;entryLines.push(`export { ${entry.exportName??'default'} as ${entry.name} } from ${JSON.stringify(relativeEntry(target))};`);}for(const path of input.cssFiles??[]){const canonical=await contained(resolve(root,path));entryLines.push(`import ${JSON.stringify(relativeEntry(mapping.get(canonical)!))};`);}
  files.push({path:paths.entry,content:entryLines.join('\n')+'\n',encoding:'utf8'});
  const components=input.entries.map(entry=>({name:entry.name,path:paths.entry,exportName:entry.name,usage:entry.usage??`import { ${entry.name} } from './${paths.entry}';`}));
  const notes=[input.notes??'','已保存可编辑原组件、传递模块、CSS、真实图片/字体和发现的许可文本；仅静态编译验证，不执行项目脚本或安装依赖。React / React DOM 使用 Design 内置运行时。','入口真实引用这些源码。直接修改组件 TSX/JS/CSS 后，预览会重新编译；无需重建组件 bundle。类型源码已保留，但本导入不代替完整 TypeScript 类型检查。','导入不等于已接入页面或完成视觉/交互验证。动态资源输入等诊断仍需按具体页面处理。'].filter(Boolean).join('\n\n');
  const apiPaths=(await Promise.all((input.typeFiles??[]).map(async path=>mapping.get(await contained(resolve(root,path)))))).filter((path):path is string=>!!path);
  const guide=['# 可编辑组件设计系统','',notes,'','## 真实入口','','路径从代码项目根目录解析；从当前页面目录计算相对导入路径。','','```tsx',`import { ${components.map(component=>component.name).join(', ')} } from './${paths.entry}';`,'```','','入口已经引用明确选择的 CSS，组件自身的 CSS import 也保持真实关系；不要引用旧的编译 bundle。','','## 可编辑组件源文件','',...components.map(component=>`- ${component.name}: ${entrySources[component.name]}`),'','## 用户提供的用法','',...components.flatMap(component=>[`### ${component.name}`,'',component.usage,'']),'## 类型资料','',...(apiPaths.length?apiPaths.map(path=>`- ${path}`):['用户未选择类型声明文件；本次未推测或生成组件 props/API。']),'','## 许可与来源','',`实际文件映射与原始 hash 见 ${paths.provenance}；许可文件属于真实源文件闭包，须随工程保留。未找到许可时按诊断核对，不能声称授权完整。`,'','请接入真实页面，再检查编译、实际运行、目标视口与关键交互。'].join('\n');files.push({path:paths.guide,content:guide,encoding:'utf8'});
  const provenance = {sourceHashes:Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b))),fileMap:Object.fromEntries([...mapping].map(([path,output])=>[portable(path),output]).sort(([a],[b])=>a!.localeCompare(b!))),licenses:[...licenseSources].sort().map(path=>({sourcePath:portable(path),path:mapping.get(path)!,sha256:hashes[portable(path)]!})),...(packages.size?{packages:[...packages.values()]}:{})};
  files.push({path:paths.provenance,encoding:'utf8',content:JSON.stringify({schemaVersion:1,libraryName:paths.libraryName,...provenance},null,2)+'\n'});
  const assertPortable=(value:unknown):void=>{if(typeof value==='string'){const masked=value.replace(/https?:\/\/[^\s"'`<>]+/g,'');if(value.includes(root)||value.includes(input.directory)||/(?:^|[^\w])\/(?:Users|home)\/[^/\s"'`]+|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+|\/(?:private\/)?var\/folders\//.test(masked))throw new Error('Imported source or generated metadata contains a nonportable personal/source-root path. Supply portable inputs.');}else if(Array.isArray(value)){for(const item of value)assertPortable(item);}else if(value&&typeof value==='object'){for(const item of Object.values(value))assertPortable(item);}};
  for(const file of files)if(file.encoding==='utf8'){assertPortable(file.content);if(file.path.endsWith('.json'))assertPortable(JSON.parse(file.content));}
  assertPortable({notes,components,diagnostics});
  let outputBytes=0;for(const file of files){validateCodePath(file.path);const size=Buffer.byteLength(file.content,file.encoding==='base64'?'base64':'utf8');outputBytes+=size;if(size>(file.encoding==='base64'?CODE_PROJECT_LIMITS.assetBytes:CODE_PROJECT_LIMITS.textBytes))throw new Error(`Imported file exceeds the code project budget: ${file.path}. Narrow the selected components/resources.`);}if(outputBytes>COMPONENT_IMPORT_LIMITS.outputBytes||files.length>CODE_PROJECT_LIMITS.files)throw new Error('Component source import exceeds its output budget.');
  const finalRoot=await lstat(root);if(!finalRoot.isDirectory()||finalRoot.isSymbolicLink()||finalRoot.dev!==rootInfo.dev||finalRoot.ino!==rootInfo.ino)throw new Error('The selected component root changed identity during import. Inspect it and retry explicitly.');
  return{paths,files,components,notes,provenance,diagnostics};
}
