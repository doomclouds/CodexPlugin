import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const client=new Client({name:'design-development-preview',version:'0.4.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'runtime/index.js')],env:Object.fromEntries(Object.entries(process.env).filter(([,v])=>v!==undefined))}));
const token=randomBytes(24).toString('hex');
const html=(await readFile(path.join(root,'runtime/panel.html'),'utf8')).replace('<head>',`<head><script>globalThis.__DESIGN_PREVIEW_TOKEN__=${JSON.stringify(token)}</script>`);
let origin='';
const server=createServer(async(req,res)=>{
 try{
  res.setHeader('cache-control','no-store');
  const requestUrl=new URL(req.url,origin||'http://localhost');
  if(req.method==='GET'&&requestUrl.pathname==='/'){const theme=requestUrl.searchParams.get('theme');res.setHeader('content-type','text/html;charset=utf-8');res.end(['light','dark'].includes(theme)?html.replace(/<html\b/,'<html data-host-theme=\"'+theme+'\"'):html);return;}
  const header=String(req.headers['x-design-preview']??'');
  if(req.method!=='POST'||req.url!=='/tool'||header.length!==token.length||!timingSafeEqual(Buffer.from(header),Buffer.from(token))||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);res.end('Forbidden');return;}
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32*1024*1024)throw new Error('Request too large');}
  const input=JSON.parse(body);const result=await client.callTool(input);res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(error){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({isError:true,content:[{type:'text',text:error.message}]}));}
});
await new Promise(resolve=>server.listen(Number(process.env.DESIGN_PREVIEW_PORT??0),'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;console.log(`Design development preview: ${origin}`);
async function close(){server.close();await client.close();process.exit();}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
