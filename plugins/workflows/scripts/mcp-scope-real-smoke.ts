import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapter.ts";
import { WorkflowEngine } from "../src/engine.ts";
import { RunStore } from "../src/store.ts";

if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and calls real logged-in Codex workers.");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-mcp-scope-real-")));
const project = path.join(root, "project"), callsFile = path.join(root, "tool-calls.txt"), fixture = path.join(root, "scope-probe.mjs");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
let engine: WorkflowEngine | undefined;
try {
  await mkdir(project); await writeFile(path.join(project, "input.txt"), "native-inspection-marker\n");
  await writeFile(fixture, `import {appendFileSync} from 'node:fs';import{createInterface}from'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const tools=[{name:'read_marker',description:'Read the immutable fixture marker',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},{name:'session_probe',description:'Run the explicitly authorized session probe',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},{name:'ungranted_write',description:'Must remain unavailable',inputSchema:{type:'object'},annotations:{readOnlyHint:false,destructiveHint:true}}];
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,serverInfo:{name:'scope-probe',version:'1'},capabilities:{tools:{}}};else if(m.method==='tools/list')result={tools};else if(m.method==='tools/call'){if(!['read_marker','session_probe'].includes(m.params.name)){send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unrequested tool'}});return;}appendFileSync(${JSON.stringify(callsFile)},m.params.name+'\\n');result={content:[{type:'text',text:JSON.stringify({marker:m.params.name==='read_marker'?'readonly-probe-ok':'session-probe-ok'})}]};}send({jsonrpc:'2.0',id:m.id,result});});`);
  const privateHome = path.join(root, "codex-home"), userHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  await mkdir(privateHome, { mode: 0o700 });
  let originalConfig = "";
  try { originalConfig = await readFile(path.join(userHome, "config.toml"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await copyFile(path.join(userHome, "auth.json"), path.join(privateHome, "auth.json")); await chmod(path.join(privateHome, "auth.json"), 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const scopedConfig = `${originalConfig}\n[mcp_servers.scope_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture])}\nstartup_timeout_sec = 30\n`;
  await writeFile(path.join(privateHome, "config.toml"), scopedConfig, { mode: 0o600 });
  const wrapper = path.join(root, "private-cli.mjs");
  await writeFile(wrapper, `import{spawn}from'node:child_process';const child=spawn(${JSON.stringify(process.env.CODEX_CLI_PATH ?? "codex")},process.argv.slice(2),{stdio:'inherit',env:{...process.env,CODEX_HOME:${JSON.stringify(privateHome)}}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));`);
  const adapter = new CodexAdapter({ command: process.execPath, args: [wrapper, "app-server", "--stdio"] });
  engine = new WorkflowEngine({ store: new RunStore(path.join(root, "state")), adapter });
  const nativeCode = 'const wf_fs=require("node:fs");process.stdout.write(wf_fs.readFileSync("input.txt","utf8"));';
  const nativeCommand = `${quote(process.execPath)} -e ${quote(nativeCode)}`;
  const firstScript = 'export const meta={name:"scope-native-and-session",description:"Inspect the local fixture read-only then invoke only its authorized session probe"}; const inspected=await agent(args.inspect,{model:"gpt-6-luna",reasoningEffort:"max",schema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}); if(inspected.text!=="native-inspection-marker")throw new Error("Native inspection did not read the actual fixture"); return await agent(args.probe,{mode:"write",model:"gpt-6-luna",reasoningEffort:"max",schema:{type:"object",properties:{marker:{type:"string"}},required:["marker"],additionalProperties:false}});';
  const input = { projectPath: project, workspaceMode: "local" as const, allowWrite: true, allowedMcpServers: ["scope_probe"], allowedMcpTools: { scope_probe: ["session_probe"] }, limits: { maxCalls: 3, maxReadWorkers: 1, timeoutMs: 600000 } };
  const first = await engine.preview({ ...input, script: firstScript, args: { inspect: `Execute exactly this native command once: ${nativeCommand}\nReturn the text read with trailing newline removed. Do not use here-documents, here-strings or temporary files; do not change files or call external MCP tools.`, probe: "Call the authorized scope_probe session_probe MCP tool once with no arguments. Return its actual marker. Do not change project files, call other MCP tools or use network services." } });
  console.log(JSON.stringify({ stage: "real-native-read-then-session-probe", model: "gpt-6-luna", effort: "max" }));
  await engine.start({ id: first.id, revision: first.revision }); const done = await engine.wait(first.id);
  assert.equal(done.execution, "completed", done.error); assert.deepEqual(done.result, { marker: "session-probe-ok" });
  assert.deepEqual(done.tasks.map(task => task.mode), ["read", "write"]);
  assert.ok(done.tasks[0]?.attempts.at(-1)?.toolsUsed?.includes("native:commandExecution"));
  assert.ok(!done.tasks[0]?.attempts.at(-1)?.toolsUsed?.some(tool => tool.startsWith("mcp:")));
  assert.ok(done.tasks[1]?.attempts.at(-1)?.toolsUsed?.includes("mcp:scope_probe/session_probe"));
  assert.equal(await readFile(callsFile, "utf8"), "session_probe\n");
  const second = await engine.preview({ ...input, allowedMcpTools: { scope_probe: ["read_marker", "session_probe"] }, script: 'export const meta={name:"scope-mixed-readonly",description:"Use only the safe read-only intersection of a mixed workflow MCP grant"}; return await agent("Call scope_probe read_marker once with no arguments and return the actual marker. Do not change files or use any other MCP tools.",{model:"gpt-6-luna",reasoningEffort:"max",schema:{type:"object",properties:{marker:{type:"string"}},required:["marker"],additionalProperties:false}});' });
  console.log(JSON.stringify({ stage: "real-readonly-mixed-grant" }));
  await engine.start({ id: second.id, revision: second.revision }); const readonly = await engine.wait(second.id);
  assert.equal(readonly.execution, "completed", readonly.error); assert.deepEqual(readonly.result, { marker: "readonly-probe-ok" });
  assert.ok(readonly.tasks[0]?.attempts.at(-1)?.toolsUsed?.includes("mcp:scope_probe/read_marker"));
  assert.equal(await readFile(callsFile, "utf8"), "session_probe\nread_marker\n");
  assert.deepEqual(await readdir(project), ["input.txt"]); assert.equal(await readFile(path.join(project, "input.txt"), "utf8"), "native-inspection-marker\n");
  console.log(JSON.stringify({ success: true, realWorkers: 3, model: "gpt-6-luna", effort: "max", readonlyNativeWithoutUnsafeMcp: true, explicitNonReadonlyMcp: true, readonlyMixedGrant: true, projectUnchanged: true, userConfigUnchanged: true }));
} finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
