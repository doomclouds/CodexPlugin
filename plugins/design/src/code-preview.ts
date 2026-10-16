import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'parse5';
import { parse as parseJavaScript } from '@babel/parser';
import type * as ESBuild from 'esbuild-wasm';
import type { CodeProject, CodeFile, CodePage } from './code-project.ts';
import { codePageRuntimeContext, getCodePages, resolveCodePage, resolveCodePageViewport } from './code-pages.ts';

export interface SourceElement { id: string; file: string; start: number; end: number; tag: string; editableText: boolean; fileHash?: string; identity?: 'stable' | 'ephemeral' }
export interface PreviewDiagnostic { level: 'error' | 'warning'; message: string; file?: string; line?: number }
export interface CodePreview { projectId: string; revision: number; pageId:string;pages:CodePage[];html: string; diagnostics: PreviewDiagnostic[]; sources: SourceElement[] }
type AnyNode = Record<string, any>;
type Edit = { start: number; end: number; text: string };
type ElementRecord = { source: SourceElement; node: AnyNode; language: 'html' | 'jsx' };
const require = createRequire(import.meta.url);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const htmlEscape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scriptSafe = (text: string): string => text.replace(/<\/script/gi, '<\\/script');
const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
const sourceTagsExcluded = new Set(['html', 'head', 'meta', 'link', 'base', 'script', 'style', 'title']);
const styleProperties = new Set(['color','background','backgroundColor','fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textAlign','textDecoration','opacity','border','borderColor','borderWidth','borderStyle','borderRadius','boxShadow','width','height','minWidth','maxWidth','minHeight','maxHeight','padding','paddingTop','paddingRight','paddingBottom','paddingLeft','margin','marginTop','marginRight','marginBottom','marginLeft','gap','rowGap','columnGap','display','flexDirection','alignItems','justifyContent']);
let compiler: typeof ESBuild | undefined;
function esbuild(): typeof ESBuild {
  if (compiler) return compiler;
  const packaged = fileURLToPath(new URL('../runtime/vendor/esbuild-wasm/lib/main.js', import.meta.url));
  try { compiler = require(packaged) as typeof ESBuild; }
  catch (error) {
    if (!fileURLToPath(import.meta.url).endsWith('/src/code-preview.ts')) throw new Error('The packaged WebAssembly compiler is missing. Rebuild the Design plugin.');
    compiler = require('esbuild-wasm') as typeof ESBuild;
  }
  return compiler;
}
function editsApplied(content: string, edits: Edit[]): string {
  let result = content; let previous = content.length + 1;
  for (const edit of edits.sort((a,b) => b.start-a.start || b.end-a.end)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > content.length || edit.end > previous) throw new Error('Overlapping source edits are not supported.');
    result = result.slice(0,edit.start)+edit.text+result.slice(edit.end); previous = edit.start;
  }
  return result;
}
function stableId(file: string, marker: string): string { return 'source_'+hash(`${file}\0anchor:${marker}`).slice(0,24); }
function markerOf(node: AnyNode, jsx = false): string | undefined {
  for (const name of ['data-design-id','data-source-id']) {
    const attr = jsx ? node.openingElement.attributes.find((item: AnyNode) => item.type === 'JSXAttribute' && item.name?.name === name) : (node.attrs ?? []).find((item: AnyNode) => item.name === name);
    const value = jsx ? attr?.value?.type === 'StringLiteral' ? attr.value.value : attr?.value?.type === 'JSXExpressionContainer' && attr.value.expression?.type === 'StringLiteral' ? attr.value.expression.value : undefined : attr?.value;
    if (typeof value === 'string' && value.length > 0 && value.length <= 500) return value;
  }
  return undefined;
}
function source(file: CodeFile, start: number, end: number, tag: string, editableText: boolean, marker?: string): SourceElement {
  return { id: marker === undefined ? 'source_'+hash(`${file.path}\0${start}\0${end}\0${tag}`).slice(0,24) : stableId(file.path,marker), file:file.path, start,end,tag,editableText,fileHash:hash(file.content),identity:marker === undefined ? 'ephemeral' : 'stable' };
}
function uniqueMarkers(records: ElementRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) if (record.source.identity === 'stable') {
    if (seen.has(record.source.id)) throw new Error(`Duplicate stable source marker in ${record.source.file}; remove or rename the duplicate before selecting or editing.`);
    seen.add(record.source.id);
  }
}
function visit(node: AnyNode, fn: (node: AnyNode) => void): void {
  fn(node);
  for (const child of node.childNodes ?? []) visit(child,fn);
  if (node.content) visit(node.content,fn);
}
function walkAst(node: unknown, fn: (node: AnyNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walkAst(child,fn); return; }
  const value = node as AnyNode;
  if (typeof value.type === 'string') fn(value);
  for (const [key,child] of Object.entries(value)) if (!['loc','start','end','comments','tokens','extra'].includes(key)) walkAst(child,fn);
}
function parseJs(file: CodeFile): AnyNode {
  return parseJavaScript(file.content,{sourceType:'unambiguous',plugins:['jsx','typescript'],allowReturnOutsideFunction:false}) as unknown as AnyNode;
}
function htmlRecords(file: CodeFile): { tree: AnyNode; records: ElementRecord[] } {
  const tree = parseHtml(file.content,{sourceCodeLocationInfo:true}) as AnyNode;
  const records: ElementRecord[] = [];
  visit(tree,node => {
    const location = node.sourceCodeLocation;
    if (!node.tagName || sourceTagsExcluded.has(node.tagName) || !location?.startTag) return;
    const editable = Boolean(location.endTag) && (node.childNodes ?? []).every((child: AnyNode) => child.nodeName === '#text' || child.nodeName === '#comment');
    records.push({source:source(file,location.startOffset,location.endOffset,node.tagName,editable,markerOf(node)),node,language:'html'});
  });
  uniqueMarkers(records); return {tree,records};
}
function jsxRecords(file: CodeFile): { ast: AnyNode; records: ElementRecord[] } {
  const ast = parseJs(file); const records: ElementRecord[] = [];
  walkAst(ast,node => {
    if (node.type !== 'JSXElement') return;
    const opening = node.openingElement; const tag = opening.name?.type === 'JSXIdentifier' ? opening.name.name : '';
    if (!/^[a-z][\w-]*$/.test(tag)) return;
    const editable = Boolean(node.closingElement) && node.children.every((child: AnyNode) => child.type === 'JSXText' || child.type === 'JSXExpressionContainer' && child.expression.type === 'StringLiteral');
    records.push({source:source(file,node.start,node.end,tag,editable,markerOf(node,true)),node,language:'jsx'});
  });
  uniqueMarkers(records); return {ast,records};
}
function confirmedLiteralText(record:ElementRecord):string|undefined{
  if(!record.source.editableText)return undefined;
  if(record.language==='html')return(record.node.childNodes??[]).filter((child:AnyNode)=>child.nodeName==='#text').map((child:AnyNode)=>child.value??'').join('');
  return record.node.children.map((child:AnyNode)=>{
    if(child.type==='JSXExpressionContainer')return child.expression.value;
    // JSX removes indentation around source newlines while preserving explicit string literals.
    const lines=String(child.value).split(/\r\n|\n|\r/);let lastNonEmpty=0;
    for(let index=0;index<lines.length;index++)if(/[^ \t]/.test(lines[index]!))lastNonEmpty=index;
    return lines.map((line,index)=>{let text=line.replace(/\t/g,' ');if(index!==0)text=text.replace(/^ +/,'');if(index!==lines.length-1)text=text.replace(/ +$/,'');return text+(text&&index!==lastNonEmpty?' ':'');}).join('');
  }).join('');
}
function insertionPoint(content: string, openingEnd: number): number {
  let index = openingEnd-1;
  while (index>0 && /\s/.test(content[index-1]!)) index--;
  return content[index-1] === '/' ? index-1 : openingEnd-1;
}
function instrumentJs(file: CodeFile, records: ElementRecord[], instrument: boolean, assetReference: (request: string, importer: string) => string): string {
  const edits: Edit[] = [];
  for (const record of records) {
    const opening = record.node.openingElement;
    for (const attr of opening.attributes) {
      if (attr.type !== 'JSXAttribute') continue;
      const name = attr.name?.name;
      if (instrument && name === 'data-design-source') edits.push({start:attr.start,end:attr.end,text:''});
      const value = attr.value?.type === 'StringLiteral' ? attr.value.value : attr.value?.type === 'JSXExpressionContainer' && attr.value.expression?.type === 'StringLiteral' ? attr.value.expression.value : undefined;
      if (typeof value !== 'string') continue;
      if (['src','poster'].includes(name) || ['href','xlinkHref'].includes(name) && ['image','use'].includes(record.source.tag)) edits.push({start:attr.value.start,end:attr.value.end,text:`{${JSON.stringify(assetReference(value,file.path))}}`});
      else if (name === 'srcSet' && !value.startsWith('data:')) edits.push({start:attr.value.start,end:attr.value.end,text:`{${JSON.stringify(value.split(',').map((part:string) => { const bits=part.trim().split(/\s+/);return assetReference(bits[0]!,file.path)+(bits[1]?' '+bits[1]:''); }).join(', '))}}`});
    }
    if (instrument) { const at = insertionPoint(file.content,opening.end); edits.push({start:at,end:at,text:` data-design-source="${record.source.id}"`}); }
  }
  return editsApplied(file.content,edits);
}
function vfsFiles(project: CodeProject): Map<string, CodeFile> {
  const files = new Map<string, CodeFile>();
  for (const file of project.files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => part==='..'||part==='.'||!part) || files.has(file.path)) throw new Error('Project file paths must be unique relative paths contained in the project.');
    files.set(file.path,file);
  }
  return files;
}
function resolveFile(files: Map<string, CodeFile>, importer: string, request: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(request.split(/[?#]/)[0]!); } catch { throw new Error('Invalid resource path encoding.'); }
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)||decoded.startsWith('//')||decoded.includes('\\')||decoded.includes('\0')) throw new Error('External resource references are blocked.');
  const resolved = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(importer),decoded));
  if (resolved==='..'||resolved.startsWith('../')) throw new Error('Resource references must remain inside the project.');
  for (const candidate of [resolved,...['.tsx','.ts','.jsx','.js','.mjs','.json','.css'].map(ext=>resolved+ext),...['index.tsx','index.ts','index.jsx','index.js'].map(name=>posix.join(resolved,name))]) if(files.has(candidate)) return candidate;
  throw new Error(`Project resource not found: ${resolved.slice(0,300)}`);
}
function dataUrl(file: CodeFile): string {
  const mime = mimeTypes[posix.extname(file.path).toLowerCase()];
  if (!mime) throw new Error('Unsupported preview asset type: '+posix.extname(file.path));
  return `data:${mime};base64,${file.encoding==='base64'?file.content:Buffer.from(file.content).toString('base64')}`;
}
const reactShims: Record<string,string> = {
  react: `const r=globalThis.__DesignReact;export default r;export const {Children,Component,Fragment,PureComponent,StrictMode,Suspense,Activity,ViewTransition,cache,cacheSignal,captureOwnerStack,cloneElement,createContext,createElement,createRef,forwardRef,isValidElement,lazy,memo,startTransition,use,useActionState,useCallback,useContext,useDebugValue,useDeferredValue,useEffect,useEffectEvent,useId,useImperativeHandle,useInsertionEffect,useLayoutEffect,useMemo,useOptimistic,useReducer,useRef,useState,useSyncExternalStore,useTransition,version}=r;`,
  'react-dom/client': `const r=globalThis.__DesignReactDOMClient;export const {createRoot,hydrateRoot,version}=r;export default r;`,
  'react-dom': `const r=globalThis.__DesignReactDOM;export const {createPortal,flushSync,preconnect,prefetchDNS,preinit,preinitModule,preload,preloadModule,requestFormReset,useFormState,useFormStatus,version}=r;export default r;`,
  'react/jsx-runtime': `const r=globalThis.__DesignJSXRuntime;export const {Fragment,jsx,jsxs}=r;`,
  'react/jsx-dev-runtime': `const r=globalThis.__DesignJSXDevRuntime;export const {Fragment,jsxDEV}=r;`,
};
function bridge(project: CodeProject, page:CodePage, select: boolean, sources: SourceElement[], literalTexts:Record<string,string>): string {
  const sourceFiles = Object.fromEntries(sources.map(source=>[source.id,source.file]));
  const literalSources = Object.fromEntries(sources.map(source=>[source.id,source.editableText]));
  return String.raw`(function(){
const projectId=${JSON.stringify(project.id)},revision=${JSON.stringify(project.revision)},page=${JSON.stringify(page)},pages=${JSON.stringify(getCodePages(project))},sourceFiles=${JSON.stringify(sourceFiles)},literalSources=${JSON.stringify(literalSources)},literalTexts=${JSON.stringify(literalTexts)};
const pageId=page.id;let mode=${JSON.stringify(select?'select':'preview')};
const post=x=>parent.postMessage(Object.assign({projectId,revision,pageId},x),'*');
const selectElement=(el,target=el)=>{
  const sourceId=el.getAttribute('data-design-source');if(!sourceFiles[sourceId])return;
  const s=getComputedStyle(el),computedStyles={};for(const k of ['color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','padding','borderRadius','width','height'])computedStyles[k]=s[k];
  const normalize=text=>text.replace(/\r\n?/g,'\n');
  const runtimeLiteralText=literalSources[sourceId]===true&&typeof literalTexts[sourceId]==='string'&&[...el.childNodes].every(n=>n.nodeType===3||n.nodeType===8)&&normalize(el.textContent||'')===normalize(literalTexts[sourceId]);
  post({type:'design:selection',sourceId,file:sourceFiles[sourceId],text:el.textContent,computedStyles,runtimeLiteralText,ancestorMapped:el!==target});
};
const scroll=hash=>{if(hash){try{document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({block:'start'});}catch{}}};
let initialLocation;try{initialLocation=JSON.parse(document.getElementById('design-page-context')?.textContent||'null')}catch{}
const validInitial=initialLocation?.projectId===projectId&&initialLocation?.revision===revision&&initialLocation?.pageId===pageId;
globalThis.designLocation={pageId,pathname:page.route,search:validInitial&&typeof initialLocation.search==='string'?initialLocation.search:'',hash:validInitial&&typeof initialLocation.hash==='string'?initialLocation.hash:''};
const navigate=(target,details={})=>{if(!pages.some(p=>p.id===target))throw Error('Unknown project page');if(target===pageId&&details.hash&&(details.search||'')===designLocation.search){designLocation.hash=details.hash;scroll(details.hash);dispatchEvent(new CustomEvent('design:location',{detail:designLocation}));return;}post(Object.assign({type:'design:navigate',targetPageId:target,href:pages.find(p=>p.id===target).route,hash:'',search:''},details));};
globalThis.designNavigate=target=>navigate(target);
const linkTarget=href=>{
  if(typeof href!=='string'||href.length>2048||href.includes('\\')||/[\x00-\x1f]/.test(href)||/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))return;
  try{
    const url=new URL(href,'https://design.invalid'+page.route),entryUrl=new URL(href,'https://design.invalid/'+page.entry);
    if(url.origin!=='https://design.invalid')return;
    const target=pages.find(p=>p.route===url.pathname)??pages.find(p=>{const pathname=new URL('/'+p.entry,'https://design.invalid').pathname;return pathname===url.pathname||pathname===entryUrl.pathname;});
    return target?{targetPageId:target.id,href:url.pathname+url.search+url.hash,hash:url.hash,search:url.search}:undefined;
  }catch{return;}
};
addEventListener('message',e=>{
  if(e.source!==parent||!e.data||e.data.projectId!==undefined&&e.data.projectId!==projectId||e.data.revision!==undefined&&e.data.revision!==revision||e.data.pageId!==undefined&&e.data.pageId!==pageId)return;
  if(e.data.type==='design:mode'&&['select','preview'].includes(e.data.mode))mode=e.data.mode;
  if(e.data.type==='design:location'){globalThis.designLocation={pageId,pathname:page.route,search:e.data.search||'',hash:e.data.hash||''};scroll(e.data.hash);dispatchEvent(new CustomEvent('design:location',{detail:globalThis.designLocation}));}
  if(e.data.type==='design:focus'&&sourceFiles[e.data.sourceId]){const el=[...document.querySelectorAll('[data-design-source]')].find(x=>x.getAttribute('data-design-source')===e.data.sourceId);if(el){el.scrollIntoView({block:'center',inline:'nearest'});el.animate&&el.animate([{outline:'3px solid #ea6644',outlineOffset:'3px'},{outline:'3px solid transparent',outlineOffset:'8px'}],{duration:1300});selectElement(el);}}
});
addEventListener('click',e=>{
  if(mode!=='select')return;
  e.preventDefault();e.stopImmediatePropagation();const el=e.target.closest&&e.target.closest('[data-design-source]');if(!el)return;
  selectElement(el,e.target);
},true);
addEventListener('click',e=>{if(mode==='select'||e.defaultPrevented)return;const link=e.target.closest&&e.target.closest('a[href]');if(!link)return;e.preventDefault();const target=linkTarget(link.getAttribute('href'));if(target)navigate(target.targetPageId,target);});
addEventListener('error',e=>post({type:'design:runtime-error',message:String(e.message||'Runtime error').slice(0,1000),line:e.lineno}));
addEventListener('unhandledrejection',e=>post({type:'design:runtime-error',message:String(e.reason&&e.reason.message||'Unhandled promise rejection').slice(0,1000)}));
})();`;

}

export async function compileCodeProject(project: CodeProject, options: { instrument?: boolean;pageId?:string;viewportId?:string } = {}): Promise<CodePreview> {
  const diagnostics: PreviewDiagnostic[] = []; const sources: SourceElement[] = []; const instrument = options.instrument !== false;
  const literalTexts:Record<string,string>={};const collect=(records:ElementRecord[]):void=>{for(const record of records){sources.push(record.source);const text=confirmedLiteralText(record);if(text!==undefined)literalTexts[record.source.id]=text;}};
  const result: CodePreview = {projectId:project.id,revision:project.revision,pageId:options.pageId??project.defaultPageId,pages:[],html:'',diagnostics,sources};
  try {
    const page=options.viewportId?resolveCodePageViewport(project,options).page:resolveCodePage(project,options.pageId);result.pageId=page.id;result.pages=getCodePages(project);
    const files = vfsFiles(project); const entry = files.get(page.entry);if(!entry)throw new Error('The selected page entry file does not exist.');
    const virtual = new Map(files); let needReact = false;
    const scriptEntries: string[] = []; const cssEntries: string[] = []; const deferredClassic: string[] = []; let html = '';
    const warn = (message: string, file=entry.path): void => {diagnostics.push({level:'warning',message,file});};
    const assetReference = (request: string, importer: string): string => {
      if (request.startsWith('data:') || request.startsWith('#')) return request;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(request)) { warn('External network resource was blocked.',importer); return ''; }
      const fragment = request.includes('#') ? request.slice(request.indexOf('#')) : '';
      return dataUrl(files.get(resolveFile(files,importer,request))!)+fragment;
    };
    const rewriteCssUrls = (css: string, importer: string): string => css.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi,(_all,_quote,request:string)=>`url("${assetReference(request.trim(),importer)}")`);
    const plugin: ESBuild.Plugin = {name:'design-contained-vfs',setup(build){
      build.onResolve({filter:/.*/},args=>{
        if(Object.hasOwn(reactShims,args.path)){needReact=true;return{path:args.path,namespace:'react-builtin'};}
        if(args.kind==='url-token'&&(args.path.startsWith('data:')||args.path.startsWith('#')))return{path:args.path,external:true};
        if(args.kind==='entry-point')return{path:args.path,namespace:'design-project'};
        if(!args.path.startsWith('.')&&!args.path.startsWith('/')&&!['import-rule','url-token'].includes(args.kind))return{errors:[{text:`Dependency is not bundled: ${args.path.slice(0,200)}. Add its source files explicitly; preview never installs packages.`}]};
        try{return{path:resolveFile(virtual,args.importer,args.path),namespace:'design-project'};}catch(error){return{errors:[{text:error instanceof Error?error.message:'Unable to resolve project import.'}]};}
      });
      build.onLoad({filter:/.*/,namespace:'react-builtin'},args=>({contents:reactShims[args.path]!,loader:'js'}));
      build.onLoad({filter:/.*/,namespace:'design-project'},args=>{
        const file=virtual.get(args.path);if(!file)return{errors:[{text:'Project file does not exist.'}]};
        const extension=posix.extname(file.path).toLowerCase();
        if(mimeTypes[extension])return{contents:`export default ${JSON.stringify(dataUrl(file))}`,loader:'js'};
        if(file.encoding!=='utf8')return{errors:[{text:'Code files must use UTF-8 encoding.'}]};
        if(extension==='.css')return{contents:rewriteCssUrls(file.content,file.path),loader:'css'};
        const loader=extension==='.tsx'?'tsx':extension==='.ts'?'ts':extension==='.jsx'?'jsx':extension==='.json'?'json':'js';
        if(['tsx','jsx'].includes(loader)){
          const collected=jsxRecords(file);collect(collected.records);
          return{contents:instrumentJs(file,collected.records,instrument,assetReference),loader:loader as ESBuild.Loader};
        }
        return{contents:file.content,loader:loader as ESBuild.Loader};
      });
    }};
    if(/\.html?$/i.test(entry.path)){
      if(entry.encoding!=='utf8')throw new Error('HTML entry must use UTF-8 encoding.');
      const collected=htmlRecords(entry);collect(collected.records);const edits:Edit[]=[];let index=0;
      visit(collected.tree,node=>{
        const location=node.sourceCodeLocation;if(!node.tagName||!location?.startTag)return;
        const attrs=new Map<string,string>((node.attrs??[]).map((attr:AnyNode)=>[attr.name,attr.value]));
        if(['iframe','object','embed','base'].includes(node.tagName)||node.tagName==='meta'&&attrs.has('http-equiv')){edits.push({start:location.startOffset,end:location.endOffset,text:''});warn('Embedded frames, objects, base URLs and HTTP-equiv metadata are disabled.');return;}
        if(node.tagName==='script'){
          const src=attrs.get('src');let script:string|undefined;
          const type=attrs.get('type')??'';
          if(type!== 'module' && ['', 'text/javascript', 'application/javascript'].includes(type)) {
            let code=(node.childNodes??[]).map((child:AnyNode)=>child.value??'').join('');
            if(src){if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)){warn('External script was blocked.');code='';}else{const file=files.get(resolveFile(files,entry.path,src))!;if(file.encoding!=='utf8')throw new Error('Classic scripts must use UTF-8 source.');code=file.content;}}
            if(code)try{parseJavaScript(code,{sourceType:'script'});}catch(error){throw new Error(`Classic script syntax error in ${src??entry.path}: ${error instanceof Error?error.message:'invalid JavaScript'}`);}
            const rendered=code?`<script>${scriptSafe(code)}</script>`:'';
            if(src&&attrs.has('defer')){deferredClassic.push(rendered);edits.push({start:location.startOffset,end:location.endOffset,text:''});}
            else edits.push({start:location.startOffset,end:location.endOffset,text:rendered});
            return;
          }
          if(src){if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src))warn('External script was blocked.');else script=resolveFile(files,entry.path,src);}
          else if(!attrs.has('type')||['module','text/javascript','application/javascript'].includes(attrs.get('type')!)){
            script=posix.join(posix.dirname(entry.path),`__design_inline_${index++}.js`);virtual.set(script,{path:script,encoding:'utf8',content:(node.childNodes??[]).map((child:AnyNode)=>child.value??'').join('')});
          }
          if(script)scriptEntries.push(script);
          if(script||src)edits.push({start:location.startOffset,end:location.endOffset,text:''});
          return;
        }
        if(node.tagName==='style'){
          const key=posix.join(posix.dirname(entry.path),`__design_style_${index++}.css`);virtual.set(key,{path:key,encoding:'utf8',content:(node.childNodes??[]).map((child:AnyNode)=>child.value??'').join('')});cssEntries.push(key);edits.push({start:location.startOffset,end:location.endOffset,text:''});return;
        }
        if(node.tagName==='link'&&attrs.get('rel')==='stylesheet'){
          const href=attrs.get('href')??'';if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))warn('External stylesheet was blocked.');else cssEntries.push(resolveFile(files,entry.path,href));edits.push({start:location.startOffset,end:location.endOffset,text:''});return;
        }
        for(const [name,value]of attrs){
          if(name==='data-design-source'||/^on/i.test(name))continue;
          const attrLocation=location.attrs?.[name];if(!attrLocation)continue;
          if(['src','poster'].includes(name)||name==='href'&&['image','use','link'].includes(node.tagName))edits.push({start:attrLocation.startOffset,end:attrLocation.endOffset,text:`${name}="${htmlEscape(assetReference(value,entry.path))}"`});
          else if(name==='srcset'){const rewritten=value.split(',').map(item=>{const bits=item.trim().split(/\s+/);return assetReference(bits[0]!,entry.path)+(bits[1]?' '+bits[1]:'');}).join(', ');edits.push({start:attrLocation.startOffset,end:attrLocation.endOffset,text:`srcset="${htmlEscape(rewritten)}"`});}
          else if(name==='style'&&/url\(/i.test(value))edits.push({start:attrLocation.startOffset,end:attrLocation.endOffset,text:`style="${htmlEscape(rewriteCssUrls(value,entry.path))}"`});
        }
      });
      if(instrument)for(const record of collected.records){if(edits.some(edit=>edit.text===''&&edit.start<=record.source.start&&edit.end>=record.source.end))continue;const location=record.node.sourceCodeLocation;const attr=location.attrs?.['data-design-source'];if(attr)edits.push({start:attr.startOffset,end:attr.endOffset,text:''});const at=insertionPoint(entry.content,location.startTag.endOffset);edits.push({start:at,end:at,text:` data-design-source="${record.source.id}"`});}
      html=editsApplied(entry.content,edits);
    }else{
      if(!/\.[cm]?[jt]sx?$/i.test(entry.path))throw new Error('Entry must be an HTML, JavaScript or TypeScript file.');
      const ast=parseJs(entry);let mounts=false,hasDefault=false;
      walkAst(ast,node=>{if(node.type==='ExportDefaultDeclaration')hasDefault=true;if(node.type==='CallExpression'&&(node.callee?.name==='createRoot'||node.callee?.property?.name==='createRoot'))mounts=true;});
      if(mounts)scriptEntries.push(entry.path);
      else if(hasDefault){const key='__design_mount__.tsx';virtual.set(key,{path:key,encoding:'utf8',content:`import Component from ${JSON.stringify('./'+entry.path)};import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(React.createElement(Component));`});scriptEntries.push(key);}
      else throw new Error('A JavaScript/TSX entry must mount with createRoot or export a default component.');
      html='<!doctype html><html><head></head><body><div id="root"></div></body></html>';
    }
    const scripts:string[]=[];const styles:string[]=[];
    for(const script of [...scriptEntries,...cssEntries]){
      const built=await esbuild().build({entryPoints:[script],bundle:true,write:false,outdir:'/design-preview-output',format:'iife',platform:'browser',target:['es2022'],jsx:'automatic',jsxImportSource:'react',plugins:[plugin],logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},legalComments:'none'});
      for(const warning of built.warnings)diagnostics.push({level:'warning',message:warning.text,...(warning.location?{file:warning.location.file.replace(/^design-project:/,''),line:warning.location.line}:{})});
      for(const output of built.outputFiles??[]){if(output.path.endsWith('.css'))styles.push(output.text);else if(output.path.endsWith('.js'))scripts.push(output.text);}
    }
    const vendor=needReact?await readFile(fileURLToPath(new URL('../runtime/react-vendor.js',import.meta.url)),'utf8'):'';
    const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    const head=`<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${codePageRuntimeContext(project,page)}<script>${scriptSafe(bridge(project,page,instrument,sources,literalTexts))}</script><style>${styles.join('\n').replace(/<\/style/gi,'<\\/style')}</style>`;
    const runtime=`${vendor?`<script>${scriptSafe(vendor)}</script>`:''}${deferredClassic.join('')}${scripts.map(script=>`<script>${scriptSafe(script)}</script>`).join('')}`;
    // Content is executed only by the caller's sandbox iframe. The backend only parses and compiles it.
    html=/<head(?:\s[^>]*)?>/i.test(html)?html.replace(/<head(?:\s[^>]*)?>/i,match=>match+head):head+html;
    result.html=/<\/body\s*>/i.test(html)?html.replace(/<\/body\s*>/i,()=>runtime+'</body>'):html+runtime;
    result.sources=[...new Map(sources.map(item=>[item.id,item])).values()];
  }catch(error){
    const errors=(error as {errors?:Array<{text:string;location?:{file:string;line:number}}>}).errors;
    if(Array.isArray(errors))for(const item of errors.slice(0,20))diagnostics.push({level:'error',message:item.text,...(item.location?{file:item.location.file.replace(/^design-project:/,''),line:item.location.line}:{})});
    else diagnostics.push({level:'error',message:error instanceof Error?error.message:'Preview compilation failed.'});
    result.html='<!doctype html><meta charset="utf-8"><title>Design compilation error</title><p>Preview compilation failed. Read the diagnostics and correct the source.</p>';
  }
  return result;
}

function validatedStyles(input: Record<string,string|number>): Array<[string,string|number]> {
  const entries=Object.entries(input);if(entries.length>40)throw new Error('Too many style edits.');
  return entries.map(([key,value])=>{
    const camel=key.replace(/-([a-z])/g,(_all,letter:string)=>letter.toUpperCase());
    if(!styleProperties.has(camel)||typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isFinite(value)||String(value).length>500||/[;{}<>\\\x00-\x1f]/.test(String(value))||/(?:url\s*\(|expression\s*\(|javascript:|@import)/i.test(String(value)))throw new Error('Unsupported or unsafe inline style edit.');
    return[camel,value];
  });
}
function cssDeclarations(style:string):Array<{name:string;start:number;end:number;important:boolean}>{
  const declarations:Array<{name:string;start:number;end:number;important:boolean}>=[];let beginning=0,quote='',depth=0,comment=false;
  const consume=(end:number):void=>{const current=style.slice(beginning,end);const colon=current.indexOf(':');if(colon>0){const name=current.slice(0,colon).replace(/\/\*[\s\S]*?\*\//g,'').trim();let start=beginning+colon+1;while(start<end&&/\s/.test(style[start]!))start++;let tail=end;while(tail>start&&/\s/.test(style[tail-1]!))tail--;declarations.push({name:name.startsWith('--')?name:name.toLowerCase(),start,end:tail,important:/!\s*important\s*$/i.test(style.slice(start,tail).replace(/\/\*[\s\S]*?\*\//g,''))});}beginning=end+1;};
  for(let index=0;index<style.length;index++){const char=style[index]!;if(comment){if(char==='*'&&style[index+1]==='/'){comment=false;index++;}continue;}if(quote){if(char==='\\'){index++;continue;}if(char===quote)quote='';continue;}if(char==='/'&&style[index+1]==='*'){comment=true;index++;}else if(char==='"'||char==="'")quote=char;else if(char==='(')depth++;else if(char===')')depth=Math.max(0,depth-1);else if(char===';'&&depth===0)consume(index);}consume(style.length);return declarations;
}
function locateElement(project: CodeProject, input:{sourceId:string;fileHash:string}):{selected:ElementRecord;file:CodeFile}{
  const files=vfsFiles(project);let selected:ElementRecord|undefined;let file:CodeFile|undefined;
  for(const candidate of files.values()){
    if(candidate.encoding!=='utf8')continue;
    const records=/\.html?$/i.test(candidate.path)?htmlRecords(candidate).records:/\.[jt]sx$/i.test(candidate.path)?jsxRecords(candidate).records:[];
    const found=records.find(record=>record.source.id===input.sourceId);if(found){selected=found;file=candidate;break;}
  }
  if(!selected||!file)throw new Error('The selected source element no longer exists. Recompile and select it again.');
  if(!input.fileHash||input.fileHash!==hash(file.content))throw new Error('Source hash conflict. Reread and reconcile the changed file.');
  return{selected,file};
}
function anchorEdit(file:CodeFile,selected:ElementRecord):{edit?:Edit;sourceId:string}{
  if(selected.source.identity==='stable')return{sourceId:selected.source.id};
  const existing=selected.language==='html'?(selected.node.attrs??[]).some((attr:AnyNode)=>attr.name==='data-design-id'):selected.node.openingElement.attributes.some((attr:AnyNode)=>attr.type==='JSXAttribute'&&attr.name?.name==='data-design-id');
  if(existing)throw new Error('The existing data-design-id is empty or dynamic. Give it a unique literal value before anchoring this element.');
  const marker='design_'+randomUUID().replaceAll('-','');
  const end=selected.language==='html'?selected.node.sourceCodeLocation.startTag.endOffset:selected.node.openingElement.end;
  const at=insertionPoint(file.content,end);
  return{sourceId:stableId(file.path,marker),edit:{start:at,end:at,text:` data-design-id="${marker}"`}};
}
export function anchorCodeElement(project:CodeProject,input:{sourceId:string;fileHash:string}):{file:string;content:string;expectedHash:string;sourceId:string}{
  const{file,selected}=locateElement(project,input);const anchor=anchorEdit(file,selected);
  return{file:file.path,content:anchor.edit?editsApplied(file.content,[anchor.edit]):file.content,expectedHash:hash(file.content),sourceId:anchor.sourceId};
}
export function editCodeElement(project: CodeProject, input: {sourceId:string;fileHash:string;text?:string;styles?:Record<string,string|number>}):{file:string;content:string;expectedHash:string;sourceId:string}{
  const{file,selected}=locateElement(project,input);
  if(input.text===undefined&&input.styles===undefined)throw new Error('Provide a literal text or inline style edit.');
  const edits:Edit[]=[];const anchor=anchorEdit(file,selected);if(anchor.edit)edits.push(anchor.edit);
  if(input.text!==undefined){
    if(typeof input.text!=='string'||input.text.length>100000)throw new Error('Text edit exceeds its limit.');
    if(!selected.source.editableText)throw new Error('This element has child elements or dynamic text. Ask the current model to edit its source.');
    if(selected.language==='html'){const location=selected.node.sourceCodeLocation;edits.push({start:location.startTag.endOffset,end:location.endTag.startOffset,text:htmlEscape(input.text)});}
    else edits.push({start:selected.node.openingElement.end,end:selected.node.closingElement.start,text:`{${JSON.stringify(input.text)}}`});
  }
  if(input.styles!==undefined){
    const entries=validatedStyles(input.styles);
    if(selected.language==='html'){
      const location=selected.node.sourceCodeLocation;const original=(selected.node.attrs??[]).find((attr:AnyNode)=>attr.name==='style');const originalValue=original?.value??'';const declarations=cssDeclarations(originalValue);const cssEdits:Edit[]=[];const additions:string[]=[];
      for(const[key,value]of entries){const css=key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase());const unit=typeof value==='number'&&!['opacity','fontWeight','lineHeight'].includes(key)&&value!==0?'px':'';const matches=declarations.filter(item=>item.name===css);const winning=matches.filter(item=>item.important).at(-1)??matches.at(-1);const text=String(value)+unit+(winning?.important&&!/!\s*important\s*$/i.test(String(value))?' !important':'');if(winning)cssEdits.push({start:winning.start,end:winning.end,text});else additions.push(`${css}: ${text}`);}
      let value=editsApplied(originalValue,cssEdits);if(additions.length)value+=(value&&!value.trimEnd().endsWith(';')?'; ':'')+additions.join('; ');
      const style=`style="${htmlEscape(value)}"`;
      if(location.attrs?.style)edits.push({start:location.attrs.style.startOffset,end:location.attrs.style.endOffset,text:style});else{const at=insertionPoint(file.content,location.startTag.endOffset);edits.push({start:at,end:at,text:' '+style});}
    }else{
      const opening=selected.node.openingElement;const style=opening.attributes.find((attr:AnyNode)=>attr.type==='JSXAttribute'&&attr.name?.name==='style');
      if(opening.attributes.some((attr:AnyNode)=>attr.type==='JSXSpreadAttribute'))throw new Error('Spread attributes make style ownership dynamic. Ask the current model to edit the source.');
      if(!style){const at=insertionPoint(file.content,opening.end);edits.push({start:at,end:at,text:` style={{${entries.map(([key,value])=>`${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}}`});}
      else{
        const expression=style.value?.type==='JSXExpressionContainer'?style.value.expression:undefined;
        if(expression?.type!=='ObjectExpression'||expression.properties.some((property:AnyNode)=>property.type!=='ObjectProperty'||property.computed||!['Identifier','StringLiteral'].includes(property.key.type)||!['StringLiteral','NumericLiteral'].includes(property.value.type)&&!(property.value.type==='UnaryExpression'&&['-','+'].includes(property.value.operator)&&property.value.argument.type==='NumericLiteral')))throw new Error('Dynamic style expressions cannot be edited directly. Ask the current model to edit the source.');
        const added:Array<[string,string|number]>=[];
        for(const[key,value]of entries){const property=expression.properties.filter((property:AnyNode)=>(property.key.name??property.key.value)===key).at(-1);if(property)edits.push({start:property.value.start,end:property.value.end,text:JSON.stringify(value)});else added.push([key,value]);}
        if(added.length){const last=expression.properties.at(-1);const trailing=last?file.content.slice(last.end,expression.end-1).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,'').includes(','):false;edits.push({start:expression.end-1,end:expression.end-1,text:(last&&!trailing?',':'')+added.map(([key,value])=>`${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')});}
      }
    }
  }
  return{file:file.path,content:editsApplied(file.content,edits),expectedHash:hash(file.content),sourceId:anchor.sourceId};
}
