import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { mountCodeEditor, type CodeEditorBridge } from './code-editor.ts';
import { VERSION } from '../src/version.ts';
import { deliverHostPrompt, requestHostDisplayMode } from './host-delivery.ts';
import './code-editor.css';
import './studio.css';

const root=document.getElementById('design-editor');
if(!root)throw new Error('Design editor root is missing.');
function unpack(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object')throw new Error('MCP 服务返回了无效结果。');
  const result=value as Record<string,unknown>;
  const content=Array.isArray(result.content)?result.content as {type?:string;text?:string}[]:[];
  if(result.isError){const details=result.structuredContent&&typeof result.structuredContent==='object'?(result.structuredContent as Record<string,unknown>).error:undefined;throw Object.assign(new Error(content.filter(block=>block.type==='text').map(block=>block.text).join('\n')||'MCP 工具调用失败。'),{details});}
  if(result.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent as Record<string,unknown>;
  for(const block of content)if(block.type==='text'&&block.text){try{const data:unknown=JSON.parse(block.text);if(data&&typeof data==='object')return data as Record<string,unknown>;}catch{}}
  return result;
}
function mountStudio(bridge:CodeEditorBridge){
  const container=root!;
  const toolbar=document.createElement('div');toolbar.className='design-host-toolbar';toolbar.setAttribute('aria-label','宿主显示');toolbar.hidden=true;
  toolbar.innerHTML='<button class="design-expand" type="button">展开工作区</button>';
  container.before(toolbar);
  const editor=mountCodeEditor(container,bridge);
  return{
    toolbar,
    connecting(){editor.connecting();},
    async connected(){await editor.connected();},
    disconnected(error:unknown){editor.disconnected(error);},
    async receive(result:unknown){editor.receive(result);},
    async setProjectId(projectId:string){await editor.setProjectId(projectId);},
    async teardown(){await editor.teardown();toolbar.remove();},
  };
}
const previewToken=(globalThis as typeof globalThis&{__DESIGN_PREVIEW_TOKEN__?:string}).__DESIGN_PREVIEW_TOKEN__;
if(window.parent===window&&previewToken){
  const studio=mountStudio({
    async callTool(name,args){const response=await fetch('/tool',{method:'POST',headers:{'content-type':'application/json','x-design-preview':previewToken},body:JSON.stringify({name,arguments:args})});const data:unknown=await response.json();if(!response.ok)throw new Error(`本地预览请求失败：${response.status}`);return unpack(data);},
    async prompt(){return{status:'not-sent',reason:'这是开发预览，没有当前聊天宿主。完整需求已保留，可复制回 Codex，再通过真实 Design 工具继续。'};},
    async download(file){const bytes=file.dataBase64!==undefined?Uint8Array.from(atob(file.dataBase64),char=>char.charCodeAt(0)):file.text??'';const url=URL.createObjectURL(new Blob([bytes],{type:file.mimeType}));const anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);return{saved:true};},
    async openLink(url){const anchor=document.createElement('a');anchor.href=url;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.click();return{opened:true};},
  });
  void studio.connected();window.addEventListener('pagehide',()=>void studio.teardown());
}else{
  const app=new App({name:'Design',version:VERSION},{availableDisplayModes:['inline','fullscreen']},{autoResize:true});
  let active=true;
  const studio=mountStudio({
    async callTool(name,args){return unpack(await app.callServerTool({name,arguments:args},{timeout:name==='design_list_models'?30000:120000}));},
    async prompt(text,_context,intent){return deliverHostPrompt(app,text,{isCurrent:()=>active&&(intent?.isCurrent()??true)});},
    async download(file){if(!app.getHostCapabilities()?.downloadFile)return{saved:false,unsupported:true};try{const resource={uri:`file:///${encodeURIComponent(file.filename)}`,mimeType:file.mimeType,...(file.dataBase64!==undefined?{blob:file.dataBase64}:{text:file.text??''})};const result=await app.downloadFile({contents:[{type:'resource',resource}]});return result.isError?{saved:false,reason:'下载未完成，可能已取消。'}:{saved:true};}catch(error){return{saved:false,reason:`下载失败：${error instanceof Error?error.message:String(error)}`};}},
    async openLink(url){if(!app.getHostCapabilities()?.openLinks)return{opened:false,reason:'当前宿主未提供打开外链的能力。'};try{const result=await app.openLink({url});return result.isError?{opened:false,reason:'宿主未打开链接。'}:{opened:true};}catch(error){return{opened:false,reason:String(error)};}},
  });
  let pendingProject='';
  let currentHostContext:Record<string,unknown>={};
  const expand=studio.toolbar.querySelector<HTMLButtonElement>('.design-expand')!;
  const displayStatus=document.createElement('span');displayStatus.setAttribute('role','status');displayStatus.hidden=true;studio.toolbar.prepend(displayStatus);studio.toolbar.style.gap='12px';
  let displayPending=false;
  expand.addEventListener('click',()=>{
    if(!active||displayPending)return;
    const context=currentHostContext,mode=context.displayMode==='fullscreen'?'inline':'fullscreen';
    if(!Array.isArray(context.availableDisplayModes)||!context.availableDisplayModes.includes(mode))return;
    displayPending=true;expand.disabled=true;displayStatus.hidden=true;
    void requestHostDisplayMode(app,mode,{isCurrent:()=>active}).then(result=>{
      if(!active)return;
      displayPending=false;
      if(result.reason){displayStatus.textContent=result.reason;displayStatus.hidden=false;}
      hostContext(result.mode?{displayMode:result.mode}:{});
    }).catch(error=>{if(active){displayPending=false;expand.disabled=false;displayStatus.textContent=`显示控制未完成：${error instanceof Error?error.message:String(error)}。可继续使用当前工作区。`;displayStatus.hidden=false;}});
  });
  function hostContext(update:Record<string,unknown>){
    if(!active)return;
    currentHostContext={...currentHostContext,...update};const context=currentHostContext;
    if(context.theme==='light'||context.theme==='dark'){applyDocumentTheme(context.theme);document.documentElement.dataset.hostTheme=context.theme;}
    const styles=context.styles as {variables?:Parameters<typeof applyHostStyleVariables>[0];css?:{fonts?:string}}|undefined;
    if(styles?.variables)applyHostStyleVariables(styles.variables);if(styles?.css?.fonts)applyHostFonts(styles.css.fonts);
    const displayModes=Array.isArray(context.availableDisplayModes)?context.availableDisplayModes:[];
    studio.toolbar.hidden=!displayModes.includes('fullscreen')&&context.displayMode!=='fullscreen';
    expand.disabled=displayPending||!displayModes.includes(context.displayMode==='fullscreen'?'inline':'fullscreen');
    expand.textContent=context.displayMode==='fullscreen'?'返回聊天':'展开工作区';
  }
  app.onhostcontextchanged=hostContext;
  app.ontoolinput=input=>{if(active&&typeof input.arguments?.projectId==='string'){pendingProject=input.arguments.projectId;void studio.setProjectId(pendingProject);}};
  app.ontoolresult=result=>{if(active)void studio.receive(result).catch(error=>studio.disconnected(error));};
  app.onteardown=async()=>{active=false;await studio.teardown();return{};};window.addEventListener('pagehide',()=>{active=false;void studio.teardown().catch(()=>{});});
  if(window.parent!==window){studio.connecting();app.connect().then(async()=>{if(!active)return;const context=app.getHostContext();if(context)hostContext(context);document.documentElement.dataset.designHostConnected='true';await studio.connected();if(active&&pendingProject)await studio.setProjectId(pendingProject);}).catch(error=>{if(active)studio.disconnected(error);});}
}
