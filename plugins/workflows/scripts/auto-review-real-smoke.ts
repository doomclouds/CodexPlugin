import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapter.ts";

if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and calls a real logged-in Codex worker and native approval reviewer.");

type Trace = Record<string, unknown>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const configDigest = (text: string | undefined) => text === undefined ? null : digest(text);
const object = (value: unknown): Trace => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Trace : {};
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-auto-review-real-")));
const project = path.join(root, "project"), callsFile = path.join(root, "tool-calls.jsonl"), tracesFile = path.join(root, "protocol-metadata.jsonl");
const privateHome = path.join(root, "codex-home"), userHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
const configFile = path.join(userHome, "config.toml"), fixture = path.join(root, "approval-probe.mjs"), wrapper = path.join(root, "private-cli.mjs");
const marker = `auto-review-probe-${randomUUID()}`;
let adapter: CodexAdapter | undefined;
let originalConfig: string | undefined;
let configLoaded = false;

async function userConfig(): Promise<string | undefined> {
  try { return await readFile(configFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

try {
  await mkdir(project); await writeFile(path.join(project, "input.txt"), "preserve-project\n");
  await mkdir(privateHome, { mode: 0o700 });
  originalConfig = await userConfig(); configLoaded = true;
  try { await copyFile(path.join(userHome, "auth.json"), path.join(privateHome, "auth.json")); await chmod(path.join(privateHome, "auth.json"), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  // The actual default reviewer policy is inherited unchanged. This fixture
  // grants no permanent approval and has no access to user projects or services.
  await writeFile(fixture, `import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const tool={name:'emit_marker',description:'Emit exactly one harmless test marker into the private smoke-test call ledger. Does not access or modify project files, run commands, use the network, or access real accounts. Requires native approval because this test intentionally declares a non-read-only destructive hint.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}};
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);if(message.id===undefined)return;let result={};
  if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,serverInfo:{name:'auto-review-smoke-fixture',version:'1'},capabilities:{tools:{}}};
  else if(message.method==='tools/list')result={tools:[tool]};
  else if(message.method==='tools/call'){
    if(message.params.name!=='emit_marker'){send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unrequested tool'}});return;}
    appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({tool:'emit_marker',atMs:Date.now()})+'\\n');
    result={content:[{type:'text',text:JSON.stringify({marker:${JSON.stringify(marker)}})}]};
  }
  send({jsonrpc:'2.0',id:message.id,result});
});`);
  await writeFile(path.join(privateHome, "config.toml"), `${originalConfig ?? ""}\n[mcp_servers.auto_review_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture])}\nstartup_timeout_sec = 30\n[mcp_servers.auto_review_probe.tools.emit_marker]\napproval_mode = "prompt"\n`, { mode: 0o600 });

  // Record only permission metadata and reviewer outcomes. Never record raw
  // config/read responses, authentication, prompts, commands, or MCP payloads.
  await writeFile(wrapper, `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
const calls=new Map();
const trace=value=>appendFileSync(${JSON.stringify(tracesFile)},JSON.stringify({...value,observedAtMs:Date.now()})+'\\n');
const policy=value=>({approvalPolicy:value.approvalPolicy,approvalsReviewer:value.approvalsReviewer,sandbox:value.sandbox??value.sandboxPolicy});
const child=spawn(${JSON.stringify(process.env.CODEX_CLI_PATH ?? "codex")},process.argv.slice(2),{stdio:['pipe','pipe','inherit'],env:{...process.env,CODEX_HOME:${JSON.stringify(privateHome)}}});
let incoming='',outgoing='';const incomingDecoder=new StringDecoder('utf8'),outgoingDecoder=new StringDecoder('utf8');
process.stdin.on('data',chunk=>{
  child.stdin.write(chunk);incoming+=incomingDecoder.write(chunk);let newline;
  while((newline=incoming.indexOf('\\n'))>=0){const line=incoming.slice(0,newline);incoming=incoming.slice(newline+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.id!==undefined&&message.method)calls.set(String(message.id),message.method);if(['thread/start','turn/start'].includes(message.method))trace({direction:'request',method:message.method,...policy(message.params)});}
});
process.stdin.on('end',()=>child.stdin.end());
child.stdout.on('data',chunk=>{
  process.stdout.write(chunk);outgoing+=outgoingDecoder.write(chunk);let newline;
  while((newline=outgoing.indexOf('\\n'))>=0){const line=outgoing.slice(0,newline);outgoing=outgoing.slice(newline+1);if(!line.trim())continue;const message=JSON.parse(line),params=message.params??{};
    if(message.method&&message.id!==undefined)trace({direction:'server-request',method:message.method});
    else if(message.id!==undefined){const method=calls.get(String(message.id));if(method==='thread/start')trace({direction:'response',method,...policy(message.result??{})});calls.delete(String(message.id));}
    else if(['item/autoApprovalReview/started','item/autoApprovalReview/completed'].includes(message.method))trace({direction:'notification',method:message.method,reviewId:params.reviewId,startedAtMs:params.startedAtMs,completedAtMs:params.completedAtMs,decisionSource:params.decisionSource,review:params.review,action:{type:params.action?.type,server:params.action?.server,toolName:params.action?.toolName}});
    else if(message.method==='item/started'&&['commandExecution','fileChange'].includes(params.item?.type))trace({direction:'notification',method:message.method,itemType:params.item.type});
  }
});
child.stdin.on('error',()=>{});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));`);

  adapter = new CodexAdapter({ command: process.execPath, args: [wrapper, "app-server", "--stdio"], startupTimeoutMs: 60000 });
  console.log(JSON.stringify({ stage: "real-native-auto-review", model: "gpt-6-luna", effort: "max", reviewerPolicy: "unchanged", persistentApproval: false }));
  const result = await adapter.run({
    id: "native-auto-review-probe", cwd: project, mode: "write", approvalMode: "auto-review", networkAccess: false,
    model: "gpt-6-luna", reasoningEffort: "max", timeoutMs: 300000,
    mcpServers: ["auto_review_probe"], mcpTools: { auto_review_probe: ["emit_marker"] },
    prompt: "Run the user-authorized harmless native approval smoke test. Call only auto_review_probe emit_marker exactly once with no arguments, after the native approval reviewer permits it. The tool writes only one marker to the private test harness ledger; it never changes project files or accesses real services. Do not run native commands, edit files, browse, request extra permissions, or call other tools. If approval is denied or unavailable, stop and report that failure without retrying or bypassing it. Return the actual marker from the tool, never an invented one.",
    outputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
  }, new AbortController().signal, () => {});
  await adapter.close(); adapter = undefined;
  assert.deepEqual(result.data, { marker });
  assert.deepEqual(result.toolsUsed, ["mcp:auto_review_probe/emit_marker"]);
  const traces = (await readFile(tracesFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Trace);
  const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Trace);
  for (const method of ["thread/start", "turn/start"]) {
    const request = traces.find(trace => trace.direction === "request" && trace.method === method);
    assert.equal(request?.approvalPolicy, "on-request"); assert.equal(request?.approvalsReviewer, "auto_review");
  }
  const response = traces.find(trace => trace.direction === "response" && trace.method === "thread/start");
  assert.equal(response?.approvalPolicy, "on-request"); assert.equal(response?.approvalsReviewer, "auto_review");
  const sandbox = object(response?.sandbox);
  assert.equal(sandbox.type, "workspaceWrite"); assert.equal(sandbox.networkAccess, false);
  assert.equal(sandbox.excludeTmpdirEnvVar, true); assert.equal(sandbox.excludeSlashTmp, true);
  assert.ok(Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every(value => value === project));
  assert.equal(traces.filter(trace => trace.direction === "server-request").length, 0, "The real native reviewer must not require or receive synthetic client approval.");
  assert.equal(traces.filter(trace => ["commandExecution", "fileChange"].includes(String(trace.itemType))).length, 0);
  const reviews = traces.filter(trace => trace.method === "item/autoApprovalReview/completed");
  assert.equal(reviews.length, 1, "Exactly one native review must precede the single fixture call.");
  const approved = reviews[0]!;
  assert.equal(object(approved.review).status, "approved"); assert.equal(approved.decisionSource, "agent");
  assert.deepEqual(approved.action, { type: "mcpToolCall", server: "auto_review_probe", toolName: "emit_marker" });
  const started = traces.find(trace => trace.method === "item/autoApprovalReview/started" && trace.reviewId === approved.reviewId);
  assert.ok(started); assert.equal(calls.length, 1); assert.equal(calls[0]?.tool, "emit_marker");
  assert.ok(typeof approved.completedAtMs === "number" && typeof calls[0]?.atMs === "number" && approved.completedAtMs <= calls[0].atMs, "The fixture must execute only after the native reviewer completes approval.");
  assert.deepEqual(await readdir(project), ["input.txt"]); assert.equal(await readFile(path.join(project, "input.txt"), "utf8"), "preserve-project\n");
  assert.equal(digest(await readFile(path.join(privateHome, "config.toml"), "utf8")), digest(`${originalConfig ?? ""}\n[mcp_servers.auto_review_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture])}\nstartup_timeout_sec = 30\n[mcp_servers.auto_review_probe.tools.emit_marker]\napproval_mode = "prompt"\n`));
  assert.equal(configDigest(await userConfig()), configDigest(originalConfig));
  console.log(JSON.stringify({ success: true, realWorkers: 1, model: "gpt-6-luna", effort: "max", nativeReview: approved.review, actualReviewBeforeExecution: true, toolCalls: calls.length, projectUnchanged: true, userConfigUnchanged: true, persistentApproval: false }));
} finally {
  await adapter?.close();
  try { if (configLoaded) assert.equal(configDigest(await userConfig()), configDigest(originalConfig), "The smoke test must never change user config."); }
  finally { await rm(root, { recursive: true, force: true }); }
}
