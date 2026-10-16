import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { mountEditor, type EditorBridge } from './editor.ts';
import { mountCodeEditor } from './code-editor.ts';
import { VERSION } from '../src/version.ts';
import './editor.css';
import './code-editor.css';
import './studio.css';

const root=document.getElementById('design-editor');
if(!root)throw new Error('Design editor root is missing.');
function unpack(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object')throw new Error('MCP 服务返回了无效结果。');
  const result=value as Record<string,unknown>;
  const content=Array.isArray(result.content)?result.content as {type?:string;text?:string}[]:[];
  if(result.isError)throw new Error(content.filter(block=>block.type==='text').map(block=>block.text).join('\n')||'MCP 工具调用失败。');
  if(result.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent as Record<string,unknown>;
  for(const block of content)if(block.type==='text'&&block.text){try{const data:unknown=JSON.parse(block.text);if(data&&typeof data==='object')return data as Record<string,unknown>;}catch{}}
  return result;
}
type Mode='code'|'layers';
type Controller=ReturnType<typeof mountEditor>|ReturnType<typeof mountCodeEditor>;
function mountStudio(bridge:EditorBridge){
  const container=root!;
  const navigation=document.createElement('nav');navigation.className='design-studio-modes';navigation.setAttribute('aria-label','设计工作区');
  navigation.innerHTML='<span class="design-studio-wordmark">DESIGN</span><button data-mode="code">代码设计</button><button data-mode="layers">图层设计</button><button class="design-expand" hidden>展开画布</button>';
  container.before(navigation);
  let mode:Mode='code';let editor:Controller=mountCodeEditor(container,bridge);let connected=false;let disposed=false;let switching=Promise.resolve();
  const update=()=>{for(const button of navigation.querySelectorAll<HTMLButtonElement>('[data-mode]'))button.setAttribute('aria-pressed',String(button.dataset.mode===mode));};update();
  function select(next:Mode,projectId?:string):Promise<void>{
    switching=switching.then(async()=>{if(disposed)return;if(next!==mode){await editor.teardown();mode=next;container.replaceChildren();editor=mode==='code'?mountCodeEditor(container,bridge):mountEditor(container,bridge);update();if(connected)await editor.connected();}if(projectId)await editor.setProjectId(projectId);});return switching;
  }
  navigation.addEventListener('click',event=>{const target=(event.target as Element).closest<HTMLButtonElement>('[data-mode]');if(target?.dataset.mode)void select(target.dataset.mode as Mode);});
  return{
    navigation,
    connecting(){editor.connecting();},
    async connected(){connected=true;await editor.connected();},
    disconnected(error:unknown){connected=false;editor.disconnected(error);},
    async receive(result:unknown){const data=unpack(result);const next=data.mode==='layers'||data.document?'layers':data.mode==='code'||data.project?'code':mode;await select(next);editor.receive(result);},
    async setProjectId(projectId:string,next?:Mode){await select(next??(projectId.startsWith('design_')?'layers':'code'),projectId);},
    async teardown(){disposed=true;await switching;await editor.teardown();navigation.remove();},
  };
}
const previewToken=(globalThis as typeof globalThis&{__DESIGN_PREVIEW_TOKEN__?:string}).__DESIGN_PREVIEW_TOKEN__;
if(window.parent===window&&previewToken){
  const studio=mountStudio({
    async callTool(name,args){const response=await fetch('/tool',{method:'POST',headers:{'content-type':'application/json','x-design-preview':previewToken},body:JSON.stringify({name,arguments:args})});const data:unknown=await response.json();if(!response.ok)throw new Error(`本地预览请求失败：${response.status}`);return unpack(data);},
    async prompt(){return{sent:false,reason:'这是开发预览，没有当前聊天宿主。请复制完整需求回到 Codex，再通过真实 Design 工具继续。'};},
    async download(file){const bytes=file.dataBase64!==undefined?Uint8Array.from(atob(file.dataBase64),char=>char.charCodeAt(0)):file.text??'';const url=URL.createObjectURL(new Blob([bytes],{type:file.mimeType}));const anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);return{saved:true};},
    async openLink(url){const anchor=document.createElement('a');anchor.href=url;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.click();return{opened:true};},
  });
  void studio.connected();window.addEventListener('pagehide',()=>void studio.teardown());
}else{
  const app=new App({name:'Design',version:VERSION},{availableDisplayModes:['inline','fullscreen']},{autoResize:true});
  const studio=mountStudio({
    async callTool(name,args){return unpack(await app.callServerTool({name,arguments:args},{timeout:name==='design_list_models'?30000:120000}));},
    async prompt(text,context){
      const capabilities=app.getHostCapabilities();
      if(!capabilities?.message?.text)return{sent:false,reason:'当前宿主未声明发送聊天消息的能力。请复制完整需求回到当前聊天。'};
      try{
        if(capabilities.updateModelContext?.text&&context!==undefined)await app.updateModelContext({content:[{type:'text',text:`当前 Design 上下文：\n${JSON.stringify(context,null,2)}`}]});
        const result=await app.sendMessage({role:'user',content:[{type:'text',text:context!==undefined&&!capabilities.updateModelContext?.text?`${text}\n\nDesign 上下文：\n${JSON.stringify(context,null,2)}`:text}]});
        return result.isError?{sent:false,reason:'宿主未发送需求。请复制提示词回到当前聊天。'}:{sent:true};
      }catch(error){return{sent:false,reason:`未能发送需求：${error instanceof Error?error.message:String(error)}`};}
    },
    async download(file){if(!app.getHostCapabilities()?.downloadFile)return{saved:false,unsupported:true};try{const resource={uri:`file:///${encodeURIComponent(file.filename)}`,mimeType:file.mimeType,...(file.dataBase64!==undefined?{blob:file.dataBase64}:{text:file.text??''})};const result=await app.downloadFile({contents:[{type:'resource',resource}]});return result.isError?{saved:false,reason:'下载未完成，可能已取消。'}:{saved:true};}catch(error){return{saved:false,reason:`下载失败：${error instanceof Error?error.message:String(error)}`};}},
    async openLink(url){if(!app.getHostCapabilities()?.openLinks)return{opened:false,reason:'当前宿主未提供打开外链的能力。'};try{const result=await app.openLink({url});return result.isError?{opened:false,reason:'宿主未打开链接。'}:{opened:true};}catch(error){return{opened:false,reason:String(error)};}},
  });
  let pendingProject='';let pendingMode:Mode|undefined;
  const expand=studio.navigation.querySelector<HTMLButtonElement>('.design-expand')!;
  expand.addEventListener('click',()=>{const context=app.getHostContext();const mode=context?.displayMode==='fullscreen'?'inline':'fullscreen';if(context?.availableDisplayModes?.includes(mode))void app.requestDisplayMode({mode});});
  function hostContext(context:Record<string,unknown>){
    if(context.theme==='light'||context.theme==='dark'){applyDocumentTheme(context.theme);document.documentElement.dataset.hostTheme=context.theme;}
    const styles=context.styles as {variables?:Parameters<typeof applyHostStyleVariables>[0];css?:{fonts?:string}}|undefined;
    if(styles?.variables)applyHostStyleVariables(styles.variables);if(styles?.css?.fonts)applyHostFonts(styles.css.fonts);
    expand.hidden=!Array.isArray(context.availableDisplayModes)||!context.availableDisplayModes.includes('fullscreen');expand.textContent=context.displayMode==='fullscreen'?'返回聊天':'展开画布';
  }
  app.onhostcontextchanged=hostContext;
  app.ontoolinput=input=>{if(input.arguments?.mode==='code'||input.arguments?.mode==='layers')pendingMode=input.arguments.mode;if(typeof input.arguments?.projectId==='string'){pendingProject=input.arguments.projectId;void studio.setProjectId(pendingProject,pendingMode);}};
  app.ontoolresult=result=>void studio.receive(result).catch(error=>studio.disconnected(error));
  app.onteardown=async()=>{await studio.teardown();return{};};window.addEventListener('pagehide',()=>void studio.teardown());
  if(window.parent!==window){studio.connecting();app.connect().then(async()=>{const context=app.getHostContext();if(context)hostContext(context);document.documentElement.dataset.designHostConnected='true';await studio.connected();if(pendingProject)await studio.setProjectId(pendingProject,pendingMode);}).catch(error=>studio.disconnected(error));}
}
