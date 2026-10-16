import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'parse5';
import { validateDocument, type DesignDocument } from './model.ts';
import { renderDocument, renderSvg, interactionScript } from './render.ts';

const exec = promisify(execFile);
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const exportLimit = 24 * 1024 * 1024;
export async function browserExecutable(): Promise<string | undefined> {
  const candidates = [process.env.DESIGN_BROWSER,
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
    ...(process.platform === 'win32' ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')] : []),
    ...((process.env.PATH ?? '').split(path.delimiter).flatMap(directory => ['chromium','chromium-browser','google-chrome','microsoft-edge'].map(name => path.join(directory,name))))];
  for (const candidate of candidates) if (candidate) { try { if ((await lstat(candidate)).isFile()) { await access(candidate); return candidate; } } catch {} }
  return undefined;
}
export async function rasterExport(document: DesignDocument, format: 'png' | 'pdf', artboardId?: string): Promise<Buffer> {
  const browser = await browserExecutable();
  if (!browser) throw new Error('PNG/PDF export requires an installed Chromium browser. Set DESIGN_BROWSER to its executable. HTML, SVG, JSON and ZIP exports need no browser.');
  const board = document.artboards.find(a => a.id === (artboardId ?? document.artboards[0]?.id));
  if (!board) throw new Error('Artboard not found');
  if (format === 'png' && (board.width > 8192 || board.height > 8192 || board.width * board.height > 24_000_000)) throw new Error('PNG export exceeds the 24 megapixel/8192px budget.');
  const directory = await mkdtemp(path.join(tmpdir(),'codex-design-render-'));
  try {
    const input = path.join(directory,'design.html'), output = path.join(directory,`design.${format}`);
    const selected = format === 'png' ? board.id : artboardId;
    let html = renderDocument(document,{...(selected ? {artboardId:selected} : {})});
    const boards = selected ? [board] : document.artboards;
    html = html.replace('</style>',`${boards.map((b,i) => `@page design${i}{size:${b.width}px ${b.height}px;margin:0}section:nth-of-type(${i+1}){page:design${i}}`).join('')}</style>`);
    await writeFile(input,html,{mode:0o600});
    const flags = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${path.join(directory,'browser')}`, '--virtual-time-budget=1200', ...(format === 'png' ? [`--screenshot=${output}`,`--window-size=${Math.ceil(board.width)},${Math.ceil(board.height)}`] : [`--print-to-pdf=${output}`, '--no-pdf-header-footer']), pathToFileURL(input).href];
    try { await exec(browser,flags,{timeout:30000,maxBuffer:1024*1024,windowsHide:true}); }
    catch { throw new Error('Chromium export failed or timed out. Check DESIGN_BROWSER; no design was changed.'); }
    const bytes = await readFile(output);
    if (bytes.length > exportLimit) throw new Error('Export exceeds the 24 MiB transfer limit.');
    if (format === 'png' ? bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' : bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('Browser did not produce the requested file.');
    return bytes;
  } finally { await rm(directory,{recursive:true,force:true}); }
}
function crc32(data: Buffer): number { let crc=0xffffffff; for(const byte of data) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }
export function zipFiles(files: Array<{name:string;data:Buffer}>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset=0;
  for(const file of files) {
    const name=Buffer.from(file.name), crc=crc32(file.data), head=Buffer.alloc(30), entry=Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt32LE(crc,14);head.writeUInt32LE(file.data.length,18);head.writeUInt32LE(file.data.length,22);head.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.data.length,20);entry.writeUInt32LE(file.data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    local.push(head,name,file.data); central.push(entry,name); offset+=head.length+name.length+file.data.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export async function exportDesign(doc: DesignDocument, format: 'html'|'svg'|'json'|'png'|'pdf'|'zip', artboardId?: string): Promise<{filename:string;mimeType:string;dataBase64:string}> {
  validateDocument(doc);
  const board=doc.artboards.find(b=>b.id===(artboardId??doc.artboards[0]?.id));
  if (artboardId && !board) throw new Error('Artboard not found');
  let data:Buffer; const mimeType={html:'text/html',svg:'image/svg+xml',json:'application/json',png:'image/png',pdf:'application/pdf',zip:'application/zip'}[format];
  if (format==='html') data=Buffer.from(renderDocument(doc,{interactive:true,...(artboardId?{artboardId}:{})}));
  else if(format==='json')data=Buffer.from(JSON.stringify(doc,null,2));
  else if(format==='svg'){if(!board)throw new Error('Artboard not found');data=Buffer.from(renderSvg(doc,board));}
  else if(format==='png'||format==='pdf')data=await rasterExport(doc,format,artboardId);
  else data=zipFiles([{name:'design.json',data:Buffer.from(JSON.stringify(doc,null,2))},{name:'index.html',data:Buffer.from(renderDocument(doc,{interactive:true}))},{name:'README.txt',data:Buffer.from('Open index.html for the interactive prototype. design.json is the editable source. SVG export uses HTML foreignObject and requires an HTML-capable SVG viewer.\n')}]);
  if(data.length>exportLimit)throw new Error('Export exceeds the 24 MiB transfer limit.');
  return{filename:`${doc.name.replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,80)||'design'}.${format}`,mimeType,dataBase64:data.toString('base64')};
}

// Sync only the explicit Design interchange format; arbitrary scripts are inert.
export function importHtml(content: string, current: DesignDocument): DesignDocument {
  if(Buffer.byteLength(content)>16*1024*1024)throw new Error('HTML import exceeds 16 MiB.');
  const tree=parse(content); const elements:any[]=[]; let embedded:string|undefined;
  function walk(node:any):void {const attrs=Object.fromEntries((node.attrs??[]).map((a:any)=>[a.name,a.value]));if(attrs.id==='design-document'&&node.tagName==='script')embedded=(node.childNodes??[]).map((n:any)=>n.value??'').join('');if(attrs['data-node-id'])elements.push({node,attrs});for(const child of node.childNodes??[])walk(child);}
  walk(tree); if(!embedded)throw new Error('This HTML has no Design document. Import the generated interchange HTML or use Codex to map an external project.');
  let doc:DesignDocument;
  try{doc=validateDocument(JSON.parse(embedded));}catch{throw new Error('Invalid embedded Design document. No source was changed.');}
  if(doc.id!==current.id)throw new Error('HTML belongs to a different project.');
  if(doc.revision!==current.revision)throw new Error('HTML source revision is stale. Export the current project before synchronizing.');
  if(JSON.stringify(doc)!==JSON.stringify(current))throw new Error('Embedded document edits are ambiguous. Use design.json for structural changes, or edit supported HTML text and style properties.');
  const baseline=new Map<string,Record<string,string>>();
  const parseStyles=(value:string):Record<string,string>=>Object.fromEntries(value.split(';').map(s=>{const i=s.indexOf(':');return[s.slice(0,i).trim(),s.slice(i+1).trim()];}).filter(([k])=>k));
  function originalStyles(node:any):void{const attrs=Object.fromEntries((node.attrs??[]).map((a:any)=>[a.name,a.value]));if(attrs['data-node-id'])baseline.set(attrs['data-node-id'],parseStyles(attrs.style??''));for(const child of node.childNodes??[])originalStyles(child);}
  originalStyles(parse(renderDocument(doc)));
  const supportedStyles=new Set(['left','top','width','height','background','color','font-family','box-shadow','text-align','font-size','font-weight','line-height','opacity','border-radius']);
  function signature(node:any):unknown{
    if(node.nodeName==='#text')return ['text',node.value];
    const attrs:Record<string,string>=Object.fromEntries((node.attrs??[]).map((a:any)=>[a.name,a.value]));
    const owned=!!attrs['data-node-id'];
    if(owned&&attrs.style)attrs.style=Object.entries(parseStyles(attrs.style)).filter(([key])=>!supportedStyles.has(key)).sort(([a],[b])=>a!.localeCompare(b!)).map(([k,v])=>`${k}:${v}`).join(';');
    const textEditable=owned&&['text','button'].includes(attrs['data-node-type']??'');
    return[node.nodeName,Object.entries(attrs).sort(([a],[b])=>a.localeCompare(b)),(node.childNodes??[]).map((child:any)=>textEditable&&child.nodeName==='#text'?['text','editable']:signature(child))];
  }
  function sections(node:any):any[]{return(node.childNodes??[]).flatMap((child:any)=>child.tagName==='section'?[child]:sections(child));}
  const originalTree=parse(renderDocument(doc,{interactive:content.includes(interactionScript)}));
  // Compare the complete inert DOM except the generated interaction script and editable metadata.
  function structural(node:any):unknown{
    if(node.tagName==='script'){
      const attrs=Object.fromEntries((node.attrs??[]).map((a:any)=>[a.name,a.value]));
      const text=(node.childNodes??[]).map((c:any)=>c.value??'').join('');
      if(attrs.id==='design-document')return['document'];
      if(text===interactionScript)return['prototype-script'];
      return['unsupported-script',text];
    }
    if(node.tagName==='section'){
      const attrs=(node.attrs??[]).filter((a:any)=>a.name!=='hidden');
      return signature({...node,attrs});
    }
    if(node.nodeName==='#text'&&!String(node.value??'').trim())return null;
    return[node.nodeName,(node.attrs??[]).map((a:any)=>[a.name,a.value]),(node.childNodes??[]).map(structural).filter((v:unknown)=>v!==null)];
  }
  if(sections(tree).length!==sections(originalTree).length||JSON.stringify(structural(tree))!==JSON.stringify(structural(originalTree)))throw new Error('HTML contains structural, script or unsupported style changes. Source was preserved; use design.json or Codex to reconcile these edits.');
  const nodes=new Map<string,any>(); function index(node:any):void{nodes.set(node.id,node);for(const c of node.children)index(c);}for(const b of doc.artboards)for(const n of b.nodes)index(n);
  const seen=new Set();
  for(const {node:element,attrs}of elements){const node=nodes.get(attrs['data-node-id']);if(!node)continue;if(seen.has(node.id))throw new Error('Duplicate source element ID.');seen.add(node.id);
    const styles=Object.fromEntries(Object.entries(parseStyles(String(attrs.style??''))).filter(([key,value])=>baseline.get(node.id)?.[key]!==value));
    for(const [css,key]of [['left','x'],['top','y'],['width','width'],['height','height']] as const){if(/^[-\d.]+px$/.test(styles[css]??''))node[key]=Number(styles[css]!.slice(0,-2));}
    for(const [css,key]of [['background','fill'],['color','color'],['font-family','fontFamily'],['box-shadow','shadow'],['text-align','textAlign']] as const)if(styles[css])node.style[key]=styles[css];
    for(const [css,key]of [['font-size','fontSize'],['font-weight','fontWeight'],['line-height','lineHeight'],['opacity','opacity'],['border-radius','radius']] as const)if(/^[-\d.]+(?:px)?$/.test(styles[css]??''))node.style[key]=Number(styles[css]!.replace(/px$/,''));
    if(['text','button'].includes(attrs['data-node-type'])){node.text=(element.childNodes??[]).filter((n:any)=>n.nodeName==='#text').map((n:any)=>n.value).join('');}
  }
  return validateDocument(doc);
}
export async function writeProject(doc: DesignDocument, directory: string): Promise<{directory:string;files:string[];revision:number}> {
  if(!path.isAbsolute(directory))throw new Error('Choose an absolute target directory.');
  await mkdir(directory,{recursive:true}); const canonical=await realpath(directory);
  if((await lstat(directory)).isSymbolicLink())throw new Error('The target directory must not be a symlink.');
  const names=['design.json','index.html','design-export.json'];
  for(const name of names){try{const info=await lstat(path.join(canonical,name));if(!info.isFile()||info.isSymbolicLink()||info.size>(name==='design-export.json'?16384:32*1024*1024))throw new Error('Sync targets must be regular bounded files, not symlinks.');}catch(error:any){if(error.code!=='ENOENT')throw error;}}
  const rawManifest=await readFile(path.join(canonical,'design-export.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  let old:any; if(rawManifest!==undefined){try{old=JSON.parse(rawManifest);}catch{throw new Error('Invalid synchronization manifest. No project source was changed.');}}
  if(old&&old.projectId!==doc.id)throw new Error('Target directory belongs to another Design project.');
  for(const name of names){const file=path.join(canonical,name);try{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink())throw new Error('Sync targets must be regular files.');const bytes=await readFile(file);if(!old || name!=='design-export.json'&&old.hashes?.[name]!==hash(bytes))throw new Error(`Source changed: ${name}. Import or reconcile it before exporting.`);}catch(error:any){if(error.code!=='ENOENT')throw error;}}
  const files:Record<string,string>={'design.json':JSON.stringify(doc,null,2),'index.html':renderDocument(doc,{interactive:true})};
  files['design-export.json']=JSON.stringify({projectId:doc.id,revision:doc.revision,hashes:Object.fromEntries(Object.entries(files).map(([name,data])=>[name,hash(data)]))},null,2);
  const temporary:string[]=[];
  try{for(const name of names){const temp=path.join(canonical,`.design-${randomUUID()}.tmp`);temporary.push(temp);await writeFile(temp,files[name]!,{flag:'wx',mode:0o600});}for(let i=0;i<names.length;i++)await rename(temporary[i]!,path.join(canonical,names[i]!));}
  finally{await Promise.all(temporary.map(file=>rm(file,{force:true})));}
  return{directory:canonical,files:names,revision:doc.revision};
}
