import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitAwareContextDigest } from "../src/submodules.ts";

const option = (name: string) => {const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const project=option("--project");
if(!project || !process.argv.includes("--real-commands"))throw new Error("Pass --project with an explicit repository and --real-commands to opt in. No pull, install, apply or configuration update is performed.");
const pluginRoot=path.resolve(process.env.WORKFLOWS_PLUGIN_ROOT ?? path.join(import.meta.dirname,".."));
const version=JSON.parse(await readFile(path.join(pluginRoot,"plugin.json"),"utf8")).version;
const root=await mkdtemp(path.join(tmpdir(),"workflows-repository-prepare-"));
const before=await gitAwareContextDigest(project);
const nodeCommand=option("--node") ?? process.execPath;
const npmCli=option("--npm-cli");
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(pluginRoot,"runtime/index.js")],cwd:tmpdir(),env:{...process.env,WORKFLOWS_DATA_DIR:path.join(root,"state")} as Record<string,string>,stderr:"pipe"});
const client=new Client({name:"workflows-repository-prepare",version});
transport.stderr?.on("data",()=>{});
async function call(name:string,args:Record<string,unknown>={}){
 const result=await client.callTool({name,arguments:args},undefined,{timeout:300000});
 if(result.isError)throw new Error(`${name}: ${(result.content as Array<{text?:string}>).map(c=>c.text??"").join(" ")}`);
 return result.structuredContent as Record<string,any>;
}
try{
 await client.connect(transport);
 assert.equal((await call("workflow_get_capabilities")).version,version);
 const preview=(await call("workflow_preview",{projectPath:project,allowWrite:true,networkAccess:false,workspaceMode:"git-worktree",limits:{timeoutMs:300000,maxCalls:3,maxReadWorkers:1},maintenance:{steps:[
  {id:"status",command:["git","status","--porcelain=v1","--ignore-submodules=none"],idempotent:true},
  {id:"node-version",command:[nodeCommand,"--version"],idempotent:true},
  {id:"npm-version",command:npmCli?[nodeCommand,npmCli,"--version"]:["npm","--version"],idempotent:true},
 ]},script:'export const meta={name:"repository-preparation-smoke",description:"Real repository isolation and read-only toolchain verification"}; return {status:await operation("status"),node:await operation("node-version"),npm:await operation("npm-version")};'})).run;
 await call("workflow_start",{id:preview.id,revision:preview.revision});
 let run;const deadline=Date.now()+300000;
 while(Date.now()<deadline){run=(await call("workflow_get_run",{id:preview.id})).run;if(!["running","stopping"].includes(run.execution))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(run.execution,"completed",run.error);assert.equal(run.review,"ready");assert.equal(run.result.status.stdout.trim(),"");
 assert.ok(run.tasks.every((task:any)=>task.status==="completed"));assert.equal(run.application,"none");assert.equal(run.diff.files.length,0);
 assert.equal(await gitAwareContextDigest(project),before,"Original repository and submodule state must remain unchanged");
 console.log(JSON.stringify({test:"real-repository-preparation",success:true,version,sourceUnchanged:true,gitlinks:run.maintenanceReview.submodules,node:run.result.node.stdout.trim(),npm:run.result.npm.stdout.trim(),tasks:run.tasks.length,diffFiles:0,originalContextFingerprint:createHash("sha256").update(before).digest("hex")}));
}catch(error){console.error(JSON.stringify({test:"real-repository-preparation",success:false,error:(error instanceof Error?error.message:String(error)).replace(/https?:\/\/\S+/g,"[url]").slice(0,1600)}));process.exitCode=1;}
finally{await client.close();await transport.close();await rm(root,{recursive:true,force:true});}
