import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserExecutable } from './browser.ts';

export interface BrowserInspection {
  png: Buffer;
  pdf?: Buffer;
  width: number;
  height: number;
  metrics: { title: string; textLength: number; headings: string[]; controls: number; horizontalOverflow: boolean; overflowCandidates: Array<{ tag: string; text: string; sourceId?: string }> };
  errors: string[];
  blockedRequests: number;
}
export interface BrowserReadyCondition {
  selector:string;
  /** Exact trimmed text of a visible matching DOM element; no page or host code is accepted. */
  text?:string;
}
export interface BrowserInspectionOptions {
  width:number;height:number;pdf?:boolean;fullPage?:boolean;timeoutMs?:number;waitFor?:BrowserReadyCondition;
}

class CdpConnection {
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private next=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  onEvent:(method:string,params:any)=>void=()=>{};
  constructor(url:string){
    this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{this.socket.addEventListener('open',()=>resolve(),{once:true});this.socket.addEventListener('error',()=>reject(new Error('Browser debugging connection failed.')),{once:true});});
    this.socket.addEventListener('message',event=>{let message:any;try{message=JSON.parse(String(event.data));}catch{return;}if(message.id){const entry=this.pending.get(message.id);if(entry){this.pending.delete(message.id);message.error?entry.reject(new Error('Browser inspection command failed.')):entry.resolve(message.result);}}else if(message.method)this.onEvent(message.method,message.params);});
    this.socket.addEventListener('close',()=>{for(const entry of this.pending.values())entry.reject(new Error('Browser inspection connection closed.'));this.pending.clear();});
  }
  async call(method:string,params:unknown={}):Promise<any>{await this.ready;const id=++this.next;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  close():void{this.socket.close();}
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function terminate(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),1500);try{await closed;}finally{clearTimeout(force);}
}
const inspectionScript=`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};const all=[...document.body.querySelectorAll('*')];return{title:document.title,textLength:(document.body.innerText||'').trim().length,headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,20).map(e=>(e.innerText||'').slice(0,150)),controls:[...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')].filter(visible).length,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+2,overflowCandidates:all.filter(e=>visible(e)&&e.clientWidth>0&&e.scrollWidth>e.clientWidth+3&&!['auto','scroll'].includes(getComputedStyle(e).overflowX)&&getComputedStyle(e).textOverflow!=='ellipsis').slice(0,30).map(e=>({tag:e.tagName,text:(e.innerText||'').slice(0,80),...(e.dataset.designSource?{sourceId:e.dataset.designSource}:{})}))}})()`;

export async function inspectCodeHtml(html:string,options:BrowserInspectionOptions):Promise<BrowserInspection>{
  const started=Date.now(),timeoutMs=options.timeoutMs??30000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>900000)throw new Error('Browser inspection timeout must be between 10 and 900000 milliseconds.');
  if(!Number.isInteger(options.width)||!Number.isInteger(options.height)||options.width<240||options.width>8192||options.height<200||options.height>8192)throw new Error('Choose a viewport between 240–8192px wide and 200–8192px high.');
  if(Buffer.byteLength(html)>32*1024*1024)throw new Error('Preview exceeds the browser input budget.');
  if(options.waitFor&&(typeof options.waitFor.selector!=='string'||!options.waitFor.selector.trim()||options.waitFor.selector.length>512||options.waitFor.text!==undefined&&(typeof options.waitFor.text!=='string'||options.waitFor.text.length>2000)))throw new Error('A DOM ready condition requires a selector of 1–512 characters and optional exact text of at most 2000 characters.');
  const executable=await browserExecutable();if(!executable)throw new Error('Visual validation requires an installed Chromium browser. Set DESIGN_BROWSER to its executable.');
  const directory=await mkdtemp(path.join(tmpdir(),'design-code-browser-'));
  let child:ChildProcess|undefined,connection:CdpConnection|undefined;let timedOut=false,awaitingCondition=Boolean(options.waitFor);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const input=path.join(directory,'preview.html');await writeFile(input,html,{mode:0o600});const inputUrl=pathToFileURL(input).href;
    child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${path.join(directory,'profile')}`,'about:blank'],{stdio:'ignore',windowsHide:true});
    const processFailure=new Promise<never>((_,reject)=>{child!.once('error',()=>reject(new Error('Could not start Chromium for visual validation.')));});
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;connection?.close();void(child&&terminate(child));reject(new Error(awaitingCondition?'Browser visual validation timed out before the requested DOM ready condition was observed.':'Browser visual validation timed out.'));},Math.max(1,timeoutMs-(Date.now()-started)));});
    const work=async():Promise<BrowserInspection>=>{
      let port='';while(!port){if(timedOut)throw new Error('Browser visual validation timed out.');try{port=(await readFile(path.join(directory,'profile/DevToolsActivePort'),'utf8')).split('\n')[0]!;}catch{if(child!.exitCode!==null)throw new Error('Chromium exited before visual validation started.');await sleep(50);}}
      if(!/^\d+$/.test(port))throw new Error('Chromium did not expose a local inspection endpoint.');
      const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()) as Array<{type:string;webSocketDebuggerUrl:string}>;
      const target=targets.find(t=>t.type==='page');if(!target)throw new Error('Chromium inspection page is missing.');
      const cdp=new CdpConnection(target.webSocketDebuggerUrl);connection=cdp;await cdp.ready;
      const errors:string[]=[];let blockedRequests=0;
      cdp.onEvent=(method,params)=>{
        if(method==='Fetch.requestPaused'){
          const url=String(params.request?.url??'');const allowed=url===inputUrl||url==='about:blank'||url.startsWith('data:')||url.startsWith('blob:');
          if(!allowed)blockedRequests++;
          void cdp.call(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:params.requestId}:{requestId:params.requestId,errorReason:'BlockedByClient'}).catch(()=>{});
        }else if(method==='Runtime.exceptionThrown'&&errors.length<20){const detail=params.exceptionDetails;errors.push(String(detail?.exception?.description??detail?.text??'Browser runtime exception').slice(0,1000));}
      };
      await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
      await cdp.call('Emulation.setDeviceMetricsOverride',{width:options.width,height:options.height,deviceScaleFactor:1,mobile:false});
      await cdp.call('Page.navigate',{url:inputUrl});
      while(true){const ready=await cdp.call('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});if(ready.result?.value==='complete')break;if(timedOut)throw new Error('Browser visual validation timed out.');await sleep(50);}
      await cdp.call('Runtime.evaluate',{expression:'Promise.race([document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))),new Promise(r=>setTimeout(r,1500))])',awaitPromise:true});
      if(options.waitFor){
        const selector=JSON.stringify(options.waitFor.selector),text=JSON.stringify(options.waitFor.text??null);
        const expression=`(()=>{let matches;try{matches=document.querySelectorAll(${selector})}catch{return{invalidSelector:true}}const expected=${text};return{ready:[...matches].some(element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&(expected===null||(element.textContent||'').trim()===expected)})}})()`;
        while(true){
          const observed=await cdp.call('Runtime.evaluate',{expression,returnByValue:true});
          if(observed.result?.value?.invalidSelector)throw new Error('The requested DOM ready condition contains an invalid CSS selector.');
          if(observed.exceptionDetails)throw new Error('The requested DOM ready condition could not be observed in the browser.');
          if(observed.result?.value?.ready){awaitingCondition=false;break;}
          if(timedOut)throw new Error('Browser visual validation timed out before the requested DOM ready condition was observed.');await sleep(25);
        }
      }else await sleep(150);
      const observed=await cdp.call('Runtime.evaluate',{expression:inspectionScript,returnByValue:true});
      if(!observed.result?.value)throw new Error('The prototype did not expose a readable document.');
      const layout=await cdp.call('Page.getLayoutMetrics');
      const width=options.width;const contentHeight=Math.ceil(layout.cssContentSize?.height??layout.contentSize?.height??options.height);
      const height=options.fullPage===false?options.height:Math.max(options.height,contentHeight);
      if(height>20000||width*height>32_000_000)throw new Error('Full-page rendering exceeds the 32 megapixel or 20000px height budget.');
      const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height,scale:1}});
      let pdf:Buffer|undefined;
      if(options.pdf){const printed=await cdp.call('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,paperWidth:width/96,paperHeight:options.height/96,marginTop:0,marginBottom:0,marginLeft:0,marginRight:0});pdf=Buffer.from(printed.data,'base64');}
      return{png:Buffer.from(shot.data,'base64'),...(pdf?{pdf}:{}),width,height,metrics:observed.result.value,errors,blockedRequests};
    };
    return await Promise.race([work(),deadline,processFailure]);
  }finally{if(timer)clearTimeout(timer);connection?.close();if(child)await terminate(child);await rm(directory,{recursive:true,force:true});}
}
