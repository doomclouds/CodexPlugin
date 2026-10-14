import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "workflows-real-protocol-"));
const project = path.join(root, "project");
const upstream = path.join(root, "upstream.git");
const seed = path.join(root, "seed");
const codexHome = path.join(root, "codex-home");
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
const pluginRoot = path.resolve(process.env.WORKFLOWS_PLUGIN_ROOT ?? path.join(import.meta.dirname, ".."));
const pluginVersion = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")).version as string;
const git = (cwd: string, args: string[]) => exec("git", ["-c", "user.name=Workflow Smoke", "-c", "user.email=workflow-smoke@example.invalid", ...args], { cwd, timeout: 30000 });
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "[url]").replace(/((?:token|secret|password|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]").slice(0, 1200);

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  if (result.isError) throw new Error(`${name}: ${(result.content as Array<{text?: string}>).map(item => item.text ?? "").join(" ")}`);
  return result.structuredContent as Record<string, any>;
}
async function finish(id: string) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const { run } = await call("workflow_get_run", { id });
    if (!["preparing", "running", "stopping"].includes(run.execution)) return run;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Real workflow timed out");
}
async function connect() {
  client = new Client({ name: "workflows-real-protocol-smoke", version: pluginVersion });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, "runtime", "index.js")], cwd: tmpdir(), env: { ...process.env, CODEX_HOME: codexHome, WORKFLOWS_DATA_DIR: path.join(root, "state") } as Record<string, string>, stderr: "pipe" });
  // Raw diagnostics are deliberately not copied into the test report.
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  assert.equal((await call("workflow_get_capabilities")).version, pluginVersion);
}
async function main() {
  if (!process.argv.includes("--real-workers")) throw new Error("Pass --real-workers to opt in to real model calls and temporary configuration tests");
  await mkdir(seed); await mkdir(codexHome, { mode: 0o700 });
  const activeHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  // Credentials stay in a private disposable runtime directory and never enter reports or the package.
  try { await copyFile(path.join(activeHome, "auth.json"), path.join(codexHome, "auth.json")); await chmod(path.join(codexHome, "auth.json"), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let originalConfig = "";
  try { originalConfig = await readFile(path.join(activeHome, "config.toml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assert.ok(!originalConfig.includes("[mcp_servers.workflow_fixture]"));
  const mcpSource = `import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,serverInfo:{name:'workflow-fixture',version:'1.0.0'},capabilities:{tools:{}}};
else if(m.method==='tools/list')result={tools:[{name:'read_marker',description:'Read an immutable smoke marker',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},{name:'forbidden_write',description:'Must not be granted by this test',inputSchema:{type:'object'},annotations:{readOnlyHint:false,destructiveHint:true}}]};
else if(m.method==='tools/call'){appendFileSync(${JSON.stringify(path.join(root, "mcp-calls.log"))},m.params.name+'\\n');if(m.params.name!=='read_marker'){send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Disallowed fixture tool'}});return;}result={content:[{type:'text',text:JSON.stringify({marker:'native-plus-mcp'})}]};}
send({jsonrpc:'2.0',id:m.id,result});});`;
  await writeFile(path.join(root, "fixture-mcp.mjs"), mcpSource);
  const serverArgs = [path.join(root, "fixture-mcp.mjs")];
  const config = `${originalConfig}\n[mcp_servers.workflow_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(serverArgs)}\nstartup_timeout_sec = 30\n[mcp_servers.workflow_fixture.env]\nKEEP_SETTING = "retained"\n`;
  await writeFile(path.join(codexHome, "config.toml"), config, { mode: 0o600 });
  await git(seed, ["init", "--quiet", "-b", "main"]);
  await writeFile(path.join(seed, ".gitignore"), "node_modules/\n.npm-cache/\ndist/\n");
  await writeFile(path.join(seed, "sum.mjs"), "export const add = (a, b) => a - b;\n");
  await writeFile(path.join(seed, "sum.test.mjs"), "import assert from 'node:assert/strict';import test from 'node:test';import {add} from './sum.mjs';test('sum values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n");
  await writeFile(path.join(seed, "package.json"), JSON.stringify({name:"workflow-real-fixture",version:"1.0.0",private:true,scripts:{test:"node --test sum.test.mjs",build:"node build.mjs"},dependencies:{"is-number":"7.0.0"}},null,2));
  await writeFile(path.join(seed, "build.mjs"), "import {mkdir,copyFile} from 'node:fs/promises';await mkdir('dist',{recursive:true});await copyFile('sum.mjs','dist/sum.mjs');\n");
  await exec("npm", ["install", "--package-lock-only", "--ignore-scripts", "--cache", path.join(root,"fixture-npm-cache")], {cwd:seed,timeout:60000});
  await git(seed, ["add", "-A"]);await git(seed, ["commit", "--quiet", "-m", "Add failing maintenance fixture"]);
  await git(root, ["clone", "--bare", "--quiet", seed, upstream]);await git(root, ["clone", "--quiet", upstream, project]);
  const base = (await git(project, ["rev-parse", "HEAD"])).stdout.trim();
  await git(seed, ["remote", "add", "origin", upstream]);
  await writeFile(path.join(seed, "upstream-note.txt"), "New verified upstream revision\n");
  await git(seed, ["add", "upstream-note.txt"]);await git(seed, ["commit", "--quiet", "-m", "Advance upstream fixture"]);await git(seed, ["push", "--quiet", "origin", "main"]);
  let baselineFailed = false;try {await exec(process.execPath,["--test","sum.test.mjs"],{cwd:project});}catch{baselineFailed=true;}assert.ok(baselineFailed);
  console.error("Real fixture prepared; connecting to the product MCP runtime.");
  await connect();
  const script = `export const meta = {name:"real-maintenance-protocol",description:"Pull, install, native repair, scoped MCP verification, build and reviewed apply",phases:[{title:"Prepare"},{title:"Repair"},{title:"Verify"}]};
phase("Prepare");await operation("pull");await operation("install");
phase("Repair");const report = await agent("Fix only sum.mjs so the existing sum.test.mjs passes. Use your native file and command tools; run npm test and return its actual result. Call the authorized workflow_fixture read_marker MCP tool and include its exact marker. Do not change tests or package files, and do not commit; a declared operation will commit after verification.",{mode:"write",schema:{type:"object",properties:{testPassed:{type:"boolean"},marker:{type:"string"}},required:["testPassed","marker"],additionalProperties:false}});
if(!report.testPassed || report.marker!=="native-plus-mcp")throw new Error("Actual worker evidence did not match");
phase("Verify");await operation("test");await operation("build");await operation("stage");await operation("commit");return report;`;
  const input = {projectPath:project,script,allowWrite:true,networkAccess:true,workspaceMode:"git-worktree",allowedMcpServers:["workflow_fixture"],allowedMcpTools:{workflow_fixture:["read_marker"]},limits:{maxCalls:12,maxReadWorkers:1,timeoutMs:300000},maintenance:{steps:[
    {id:"pull",command:["git","pull","--ff-only"],networkAccess:true,retries:0},
    {id:"install",command:["npm","ci","--ignore-scripts","--cache",".npm-cache"],networkAccess:true,retries:2,idempotent:true},
    {id:"test",command:["npm","test"]},{id:"build",command:["npm","run","build"]},{id:"stage",command:["git","add","--","sum.mjs"]},
    {id:"commit",command:["git","-c","user.name=Workflow Smoke","-c","user.email=workflow-smoke@example.invalid","commit","-m","Fix sum after actual worker verification"]},
  ]}};
  const {template} = await call("workflow_save_template",{...input,projectPath:undefined});assert.equal(template.workspaceMode,"git-worktree");
  const {run:draft}=await call("workflow_preview",input);assert.equal(draft.execution,"draft");
  await call("workflow_start",{id:draft.id,revision:draft.revision});
  console.error("Real maintenance workflow started through workflow_start.");
  const complete=await finish(draft.id);assert.equal(complete.execution,"completed",complete.error);assert.equal(complete.review,"ready");assert.equal(complete.result.marker,"native-plus-mcp");
  assert.equal((await git(project,["rev-parse","HEAD"])).stdout.trim(),base);assert.match(await readFile(path.join(project,"sum.mjs"),"utf8"),/a - b/);
  assert.ok(complete.tasks.every((task:any)=>task.status==="completed"));assert.ok(complete.maintenanceReview.artifacts.some((file:any)=>file.path==="dist/sum.mjs"));
  const mcpCalls=await readFile(path.join(root,"mcp-calls.log"),"utf8");assert.match(mcpCalls,/read_marker/);assert.doesNotMatch(mcpCalls,/forbidden_write/);
  await client!.close();await transport!.close();await connect();
  console.error("Real worker, MCP, install, tests and build completed; checking persistence and stop/resume.");
  const retained=(await call("workflow_get_run",{id:draft.id})).run;assert.equal(retained.execution,"completed");
  const stopScript = `export const meta = {name:"real-stop-resume",description:"Real command interruption and disk replay"}; await operation("identity"); await operation("wait"); return "resumed";`;
  const stoppingInput = {projectPath:project,script:stopScript,allowWrite:true,workspaceMode:"git-worktree",maintenance:{steps:[{id:"identity",command:["git","rev-parse","HEAD"],idempotent:true},{id:"wait",command:["node","-e","setTimeout(()=>console.log('done'),6000)"],idempotent:true}]},limits:{timeoutMs:30000,maxCalls:3}};
  const stoppedDraft=(await call("workflow_preview",stoppingInput)).run;
  await call("workflow_start",{id:stoppedDraft.id,revision:stoppedDraft.revision});
  const activeDeadline=Date.now()+30000;
  while(Date.now()<activeDeadline){const current=(await call("workflow_get_run",{id:stoppedDraft.id})).run;if(current.tasks[1]?.status==="running")break;await new Promise(resolve=>setTimeout(resolve,100));}
  const stopped=(await call("workflow_stop",{id:stoppedDraft.id})).run;assert.equal(stopped.execution,"stopped");assert.equal(stopped.tasks[0]?.status,"completed");assert.equal(stopped.tasks[1]?.status,"interrupted");
  await client!.close();await transport!.close();await connect();
  const beforeResume=(await call("workflow_get_run",{id:stopped.id})).run;assert.equal(beforeResume.execution,"stopped");
  await call("workflow_resume",{id:stopped.id,revision:beforeResume.revision});const resumed=await finish(stopped.id);assert.equal(resumed.execution,"completed",resumed.error);assert.equal(resumed.result,"resumed");assert.equal(resumed.tasks[0]?.cached,true);assert.equal(resumed.tasks[1]?.attempts.length,2);
  const latest=(await call("workflow_get_run",{id:retained.id})).run;
  const applied=(await call("workflow_apply",{id:latest.id,revision:latest.revision})).run;assert.equal(applied.application,"applied",applied.error);
  assert.equal((await git(project,["rev-parse","HEAD"])).stdout.trim(),complete.maintenanceReview.target);
  await exec("npm",["test"],{cwd:project,timeout:30000});
  console.log(JSON.stringify({test:"real-MCP-workflow-protocol",success:true,version:pluginVersion,baselineFailed,toolCreated:true,chatStartWithoutLease:true,nativeWorker:true,mcpCalled:true,scopedMcpTools:true,gitPull:true,networkInstall:true,buildArtifactsRetained:true,originalUntouchedBeforeApply:true,persistence:true,realStopWaited:true,resumeFromDisk:true,completedStepCached:true,appliedGitTarget:true,independentTestsPassed:true,tasks:complete.tasks.length,toolsUsed:complete.tasks.find((task:any)=>task.mode==="write"&&!task.options.operation)?.attempts.at(-1)?.toolsUsed,usage:complete.tasks.find((task:any)=>!task.options.operation)?.attempts.at(-1)?.usage}));
}
try {await main();}catch(error){console.error(JSON.stringify({test:"real-MCP-workflow-protocol",success:false,error:safeError(error)}));process.exitCode=1;}
finally {await client?.close();await transport?.close();await rm(root,{recursive:true,force:true});}
