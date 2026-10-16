import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDesignServer } from './server.ts';

const instance=await createDesignServer();
await instance.server.connect(new StdioServerTransport());
let closing=false;
async function close():Promise<void>{if(closing)return;closing=true;await instance.dispose();}
process.once('SIGTERM',()=>{void close().finally(()=>process.exit());});
process.once('SIGINT',()=>{void close().finally(()=>process.exit());});
process.stdin.once('end',()=>{void close();});
