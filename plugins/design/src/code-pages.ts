import type { CodePage, CodeProject, CodeViewport } from './code-project.ts';

export const CODE_PAGE_LIMIT = 32;
export class UnsupportedCodeProjectFormatError extends Error {
  readonly code = 'UNSUPPORTED_FORMAT';
  readonly format?:number|string;
  constructor(format?:number|string) { super('This code project uses an unsupported format. Code projects now require schemaVersion 2 with real pages and a defaultPageId. The original file was not modified or deleted.'); this.name = 'UnsupportedCodeProjectFormatError';this.format=format; }
}

export function canonicalCodeRoute(route: string): string {
  if (typeof route !== 'string' || route.length > 512 || !route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x20\x7f:?#<>]/.test(route) || /%(?:2f|5c)/i.test(route)) throw new Error('A page route must be a safe project-root-relative path, without a scheme, query or fragment.');
  let decoded: string;
  try { decoded = decodeURIComponent(route); } catch { throw new Error('Page route encoding is invalid.'); }
  if (/[\\%\x00-\x20\x7f:?#<>]/.test(decoded) || decoded.split('/').some((part,index,parts) => part === '.' || part === '..' || !part && index !== 0 && index !== parts.length-1)) throw new Error('Page routes cannot contain traversal, repeated separators or ambiguous encoding.');
  return new URL(decoded,'https://design.invalid').pathname;
}

export function getCodePages(project: CodeProject): CodePage[] {
  if (project.schemaVersion !== 2 || !Array.isArray(project.pages) || !project.pages.length) throw new UnsupportedCodeProjectFormatError();
  return project.pages.map((page)=>({...page}));
}
export function resolveCodePage(project: CodeProject, pageId?: string): CodePage {
  const page=getCodePages(project).find((item)=>item.id===(pageId??project.defaultPageId));
  if(!page)throw new Error('Code page not found. Select an actual page ID from the current project.');
  return page;
}
export function resolveCodePageViewport(project: CodeProject, options:{pageId?:string;viewportId?:string} = {}):{page:CodePage;viewport:CodeViewport} {
  const requested=options.viewportId?project.viewports.find((item)=>item.id===options.viewportId):undefined;
  if(options.viewportId&&!requested)throw new Error('Viewport not found.');
  const page=resolveCodePage(project,options.pageId??requested?.pageId);
  if(requested?.pageId&&requested.pageId!==page.id)throw new Error('The requested viewport belongs to another page. Choose a shared viewport or the matching page.');
  const viewport=requested??project.viewports.find((item)=>item.pageId===page.id)??project.viewports.find((item)=>item.pageId===undefined);
  if(!viewport)throw new Error('This page has no matching viewport. Add a shared viewport or one assigned to the page.');
  return{page,viewport};
}

export interface CodeNavigationTarget { pageId:string;targetPageId:string;href:string;hash:string;search:string }
export function resolveCodeNavigation(project:CodeProject,pageId:string,href:string):CodeNavigationTarget|undefined {
  const page=resolveCodePage(project,pageId);
  if(typeof href!=='string'||href.length>2048||href.includes('\\')||/[\x00-\x1f]/.test(href)||/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))return undefined;
  try {
    const url=new URL(href,'https://design.invalid'+canonicalCodeRoute(page.route));
    if(url.origin!=='https://design.invalid')return undefined;
    const route=canonicalCodeRoute(url.pathname);
    const entryUrl=new URL(href,'https://design.invalid/'+page.entry);
    const pages=getCodePages(project);
    const target=pages.find((item)=>canonicalCodeRoute(item.route)===route)??pages.find((item)=>{const pathname=new URL('/'+item.entry,'https://design.invalid').pathname;return pathname===route||pathname===entryUrl.pathname;});
    return target?{pageId,targetPageId:target.id,href:url.pathname+url.search+url.hash,hash:url.hash,search:url.search}:undefined;
  }catch{return undefined;}
}

export interface CompiledCodePage { page:CodePage;html:string }
const inlineJson=(value:unknown):string=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
const htmlEscape=(value:string):string=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const pageContextStart='<script id="design-page-context" type="application/json">';
export function codePageRuntimeContext(project:CodeProject,page:CodePage):string{
  return pageContextStart+inlineJson({projectId:project.id,revision:project.revision,pageId:page.id,search:'',hash:''})+'</script>';
}
export interface CodePageRuntimeLocation {projectId:string;revision:number;pageId:string;search?:string;hash?:string}
export function injectCodePageRuntimeLocation(html:string,location:CodePageRuntimeLocation):string{
  // Keep this helper self-contained: the standalone router embeds its trusted compiled implementation.
  const marker='<script id="design-page-context" type="application/json">';
  const start=html.indexOf(marker),contentStart=start+marker.length,end=html.indexOf('<'+'/script>',contentStart);
  if(start<0||end<contentStart)throw new Error('Compiled prototype page context is missing.');
  let previous;try{previous=JSON.parse(html.slice(contentStart,end));}catch{throw new Error('Compiled prototype page context is invalid.');}
  if(!previous||previous.projectId!==location.projectId||previous.revision!==location.revision||previous.pageId!==location.pageId)throw new Error('Compiled prototype page context does not match the selected project, revision or page.');
  if(typeof location.search!=='undefined'&&(typeof location.search!=='string'||location.search.length>2048||location.search!==''&&!location.search.startsWith('?'))||typeof location.hash!=='undefined'&&(typeof location.hash!=='string'||location.hash.length>2048||location.hash!==''&&!location.hash.startsWith('#')))throw new Error('Prototype query and fragment must be bounded local URL components.');
  const context=JSON.stringify({projectId:location.projectId,revision:location.revision,pageId:location.pageId,search:location.search??'',hash:location.hash??''}).replaceAll('<',String.fromCharCode(92)+'u003c');
  return html.slice(0,contentStart)+context+html.slice(end);
}

export function createCodePageRouter(project:CodeProject,pages:CompiledCodePage[],initialPageId?:string):string {
  const initial=resolveCodePage(project,initialPageId);const byId=new Map(pages.map((item)=>[item.page.id,item]));
  if(getCodePages(project).some((page)=>!byId.has(page.id)))throw new Error('All declared pages must have actual compiled HTML before exporting a routed prototype.');
  const payload={projectId:project.id,revision:project.revision,initialPageId:initial.id,pages:pages.map((item)=>({id:item.page.id,name:item.page.name,html:item.html}))};
  const injectSource=injectCodePageRuntimeLocation.toString().replace(/<\/script/gi,'<\\/script');
  const script=`(()=>{const data=${inlineJson(payload)},frame=document.getElementById('design-page'),index=new Map(data.pages.map(p=>[p.id,p])),inject=${injectSource};let current='',navigation;const open=(id,detail)=>{const page=index.get(id);if(!page)throw Error('Unknown prototype page');const html=inject(page.html,{projectId:data.projectId,revision:data.revision,pageId:id,search:detail?.search||'',hash:detail?.hash||''});current=id;navigation=detail;frame.dataset.pageId=id;frame.title=page.name;frame.srcdoc=html;};frame.addEventListener('load',()=>{frame.contentWindow.postMessage({type:'design:mode',projectId:data.projectId,revision:data.revision,mode:'preview'},'*');if(navigation)frame.contentWindow.postMessage({type:'design:location',projectId:data.projectId,revision:data.revision,pageId:current,href:navigation.href,hash:navigation.hash,search:navigation.search},'*');});addEventListener('message',event=>{const message=event.data;if(event.source!==frame.contentWindow||!message||message.projectId!==data.projectId||message.revision!==data.revision||message.pageId!==current)return;if(message.type==='design:navigate'&&index.has(message.targetPageId)){open(message.targetPageId,message);return;}if(message.type==='design:runtime-error'){const error=document.createElement('p');error.setAttribute('role','alert');error.textContent=String(message.message).slice(0,1000);document.getElementById('design-errors').append(error);} });open(data.initialPageId);})();`;
  const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about: 'self'; connect-src 'none'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${htmlEscape(project.name)}</title><style>html,body{height:100%;margin:0}#design-page{display:block;border:0;width:100%;height:100%}#design-errors{position:fixed;inset:auto 0 0;background:#fff0ed;color:#742c22;font:12px system-ui}#design-errors:empty{display:none}</style></head><body><iframe id="design-page" title="${htmlEscape(initial.name)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><aside id="design-errors" aria-live="polite"></aside><script>${script}</script></body></html>`;
}
