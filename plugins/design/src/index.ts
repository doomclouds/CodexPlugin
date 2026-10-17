import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDesignServer } from './server.ts';

const instance=await createDesignServer();
// A 32 MiB archive is about 43 MiB in base64, before JSON-RPC framing.
await instance.server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: 48 * 1024 * 1024 }));
let closing=false;
async function close():Promise<void>{if(closing)return;closing=true;await instance.dispose();}
process.once('SIGTERM',()=>{void close().finally(()=>process.exit());});
process.once('SIGINT',()=>{void close().finally(()=>process.exit());});
process.stdin.once('end',()=>{void close();});
