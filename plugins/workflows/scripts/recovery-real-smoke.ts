import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapter.ts";
import type { WorkerEvent, WorkerResult } from "../src/adapter.ts";

if (!process.argv.includes("--real-workers")) throw new Error("This opt-in smoke requires --real-workers and calls real logged-in Codex workers.");

type Trace = Record<string, unknown>;
const object = (value: unknown): Trace => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Trace : {};
const digest = (value: string | undefined) => value === undefined ? null : createHash("sha256").update(value).digest("hex");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-recovery-real-")));
const project = path.join(root, "project"), privateHome = path.join(root, "codex-home"), traceFile = path.join(root, "protocol-metadata.jsonl");
const userHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), configFile = path.join(userHome, "config.toml");
const wrapper = path.join(root, "private-cli.mjs"), inputName = "source.txt", missingName = `missing-${randomUUID()}.txt`, marker = `recovery-probe-${randomUUID()}`;
const schema = {
  type: "object", properties: { status: { type: "string", enum: ["failed", "passed"] }, marker: { type: ["string", "null"] }, diagnosis: { type: "string" } },
  required: ["status", "marker", "diagnosis"], additionalProperties: false,
};
const accept = { type: "object", properties: { status: { const: "passed" }, marker: { const: marker } }, required: ["status", "marker"] };
let originalConfig: string | undefined, configLoaded = false, adapter: CodexAdapter | undefined;

async function userConfig(): Promise<string | undefined> {
  try { return await readFile(configFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

async function readTraces(): Promise<Trace[]> {
  try { return (await readFile(traceFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
}

function assertPermissions(traces: Trace[], turns: number): void {
  const requests = traces.filter(trace => trace.direction === "request" && ["thread/start", "turn/start"].includes(String(trace.method)));
  assert.equal(requests.filter(trace => trace.method === "thread/start").length, 1);
  assert.equal(requests.filter(trace => trace.method === "turn/start").length, turns);
  for (const request of requests) {
    assert.equal(request.approvalPolicy, "never", "Recovery must not request extra approval or a broader permission mode.");
    if (request.method === "thread/start") {
      assert.equal(request.sandbox, "read-only"); assert.equal(request.model, "gpt-6-luna");
    } else {
      assert.equal(object(request.sandbox).type, "readOnly"); assert.equal(object(request.sandbox).networkAccess, false); assert.equal(request.effort, "max");
    }
  }
  const actual = traces.find(trace => trace.direction === "response" && trace.method === "thread/start");
  assert.equal(actual?.approvalPolicy, "never"); assert.equal(object(actual?.sandbox).type, "readOnly");
  assert.equal(object(actual?.sandbox).networkAccess, false);
  assert.equal(traces.filter(trace => trace.direction === "server-request").length, 0, "No interactive approval may be synthesized by the smoke harness.");
  assert.equal(traces.filter(trace => ["fileChange", "webSearch", "mcpToolCall"].includes(String(trace.itemType))).length, 0);
}

function assertNativeEvidence(traces: Trace[], events: WorkerEvent[], result: WorkerResult): void {
  const native = traces.filter(trace => trace.direction === "notification" && ["commandExecution", "dynamicToolCall", "functionCallOutput"].includes(String(trace.itemType)));
  assert.ok(native.length > 0, "A model-only report is not native execution evidence.");
  assert.ok(native.some(trace => trace.missingInput === true), "The deliberate missing-file read must occur through a native tool.");
  assert.ok(native.some(trace => trace.correctInput === true), "The corrected read must occur through a native tool.");
  assert.ok(native.some(trace => trace.markerObserved === true), "The unknown random marker must be observed in a native tool result, not only the final answer.");
  const failureObserved = native.some(trace => trace.nonzeroExit === true || trace.missingError === true)
    || events.some(event => event.type === "log" && /No such file|ENOENT|does not exist|cannot open|Native command failed|exit(?: code)?[: ]+1/i.test(event.message));
  assert.ok(failureObserved, "The missing-file error must survive as observable native evidence.");
  assert.ok(events.some(event => event.type === "activity" && event.activity.kind === "command"));
  assert.ok(result.toolsUsed?.some(tool => /^native:(?:commandExecution|dynamicToolCall|functionCallOutput)$/.test(tool)));
  assert.ok(result.toolsUsed?.every(tool => tool.startsWith("native:") && !["native:fileChange", "native:webSearch"].includes(tool)));
  assert.equal(object(result.data).status, "passed"); assert.equal(object(result.data).marker, marker);
  assert.ok(typeof object(result.data).diagnosis === "string" && String(object(result.data).diagnosis).length > 0);
  const cumulative = traces.filter(trace => trace.method === "thread/tokenUsage/updated");
  assert.ok(cumulative.length > 0, "The native host must supply actual usage evidence.");
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    assert.equal(result.usage[key], Math.max(...cumulative.map(trace => Number(object(trace.total)[key]) || 0)), "Same-thread cumulative usage must not be double counted across recovery turns.");
  }
}

try {
  await mkdir(project); await writeFile(path.join(project, inputName), `${marker}\n`);
  await mkdir(privateHome, { mode: 0o700 }); originalConfig = await userConfig(); configLoaded = true;
  try { await copyFile(path.join(userHome, "auth.json"), path.join(privateHome, "auth.json")); await chmod(path.join(privateHome, "auth.json"), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(path.join(privateHome, "config.toml"), originalConfig ?? "", { mode: 0o600 });

  // Observe identities, effective permissions and harmless fixture evidence.
  // Never retain raw prompts, configuration responses, authentication or tool payloads.
  await writeFile(wrapper, `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
const calls=new Map(), texts=new Map();
const trace=value=>appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(value)+'\\n');
const policy=value=>({approvalPolicy:value.approvalPolicy,approvalsReviewer:value.approvalsReviewer,sandbox:value.sandbox??value.sandboxPolicy});
const evidence=value=>{const text=JSON.stringify(value);return {missingInput:text.includes(${JSON.stringify(missingName)}),correctInput:text.includes(${JSON.stringify(inputName)}),markerObserved:text.includes(${JSON.stringify(marker)}),missingError:/No such file|ENOENT|does not exist|cannot open|exit(?: code)?[: ]+1/i.test(text),nonzeroExit:typeof value.exitCode==='number'&&value.exitCode!==0};};
const child=spawn(${JSON.stringify(process.env.CODEX_CLI_PATH ?? "codex")},process.argv.slice(2),{stdio:['pipe','pipe','inherit'],env:{...process.env,CODEX_HOME:${JSON.stringify(privateHome)}}});
let incoming='',outgoing='';const incomingDecoder=new StringDecoder('utf8'),outgoingDecoder=new StringDecoder('utf8');
process.stdin.on('data',chunk=>{
 child.stdin.write(chunk);incoming+=incomingDecoder.write(chunk);let newline;
 while((newline=incoming.indexOf('\\n'))>=0){const line=incoming.slice(0,newline);incoming=incoming.slice(newline+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.id!==undefined&&message.method)calls.set(String(message.id),message.method);if(['thread/start','turn/start'].includes(message.method))trace({direction:'request',method:message.method,threadId:message.params.threadId,model:message.params.model,effort:message.params.effort,...policy(message.params)});}
});
process.stdin.on('end',()=>child.stdin.end());
child.stdout.on('data',chunk=>{
 process.stdout.write(chunk);outgoing+=outgoingDecoder.write(chunk);let newline;
 while((newline=outgoing.indexOf('\\n'))>=0){const line=outgoing.slice(0,newline);outgoing=outgoing.slice(newline+1);if(!line.trim())continue;const message=JSON.parse(line),params=message.params??{},item=params.item??{};
  if(message.method&&message.id!==undefined)trace({direction:'server-request',method:message.method});
  else if(message.id!==undefined){const method=calls.get(String(message.id));if(method==='thread/start')trace({direction:'response',method,threadId:message.result?.thread?.id,...policy(message.result??{})});calls.delete(String(message.id));}
  else if(['turn/started','turn/completed'].includes(message.method))trace({direction:'notification',method:message.method,threadId:params.threadId,turnId:params.turn?.id,status:params.turn?.status});
  else if(message.method==='thread/tokenUsage/updated')trace({direction:'notification',method:message.method,threadId:params.threadId,turnId:params.turnId,total:params.tokenUsage?.total});
  else if(message.method==='item/commandExecution/outputDelta'){const key=params.turnId+':'+params.itemId,previous=texts.get(key)??'';const text=(previous+String(params.delta??'')).slice(-65536);texts.set(key,text);trace({direction:'notification',method:message.method,threadId:params.threadId,turnId:params.turnId,itemType:'commandExecution',...evidence({output:text})});}
  else if(['item/started','item/completed'].includes(message.method)&&['commandExecution','dynamicToolCall','functionCallOutput','fileChange','webSearch','mcpToolCall'].includes(item.type))trace({direction:'notification',method:message.method,threadId:params.threadId,turnId:params.turnId,itemType:item.type,...evidence(item)});
  else if(message.method==='item/completed'&&item.type==='agentMessage'&&item.phase==='final_answer'){let data;try{data=JSON.parse(item.text)}catch{}trace({direction:'final-answer',threadId:params.threadId,turnId:params.turnId,status:data?.status,markerMatches:data?.marker===${JSON.stringify(marker)}});}
 }
});
child.stdin.on('error',()=>{});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));`);

  adapter = new CodexAdapter({ command: process.execPath, args: [wrapper, "app-server", "--stdio"], startupTimeoutMs: 60000 });
  const common = `You are executing a harmless, read-only real-worker smoke test in the current temporary project. Use only native shell tools, without network, MCP, file changes, approval requests, delegation or access outside this project. The correct input is ${inputName}; its content is a random marker unknown to this prompt. The deliberate wrong input is ${missingName}, which does not exist. Use native cat commands to read these files. If a code-mode wrapper is required, emit each actual shell result, including exit code and bounded output, immediately so tool evidence remains observable. Never invent the marker or a successful tool result. On success return exactly {\"status\":\"passed\",\"marker\":the actual marker string without newline,\"diagnosis\":\"Read the marker from source.txt.\"}.`;
  const events: WorkerEvent[] = [];
  console.log(JSON.stringify({ stage: "real-worker-result-recovery", model: "gpt-6-luna", effort: "max", maxRecoveryAttempts: 2, network: false, sandbox: "readOnly" }));
  const result = await adapter.run({
    id: "real-result-recovery", cwd: project, mode: "read", approvalMode: "never", networkAccess: false,
    model: "gpt-6-luna", reasoningEffort: "max", timeoutMs: 300000, outputSchema: schema, accept, maxRecoveryAttempts: 2,
    prompt: `${common} For this first turn only, attempt exactly one read of the wrong input and then return a truthful failed result with marker null and a concise diagnosis. Do not read the correct input or fix the error in this first turn: this deliberately tests the local result-validation recovery channel. If a later turn in this same thread asks you to recover the unmet success condition, correct the filename, read the correct input and return the observed success result. The initial missing-file failure is expected and does not cancel the user-authorized correction in that later turn.`,
  }, new AbortController().signal, event => events.push(event));
  const traces = await readTraces();
  const identities = events.filter((event): event is Extract<WorkerEvent, { type: "identity" }> => event.type === "identity");
  const threads = new Set(identities.map(event => event.threadId));
  const turns = [...new Set(identities.map(event => event.turnId).filter((id): id is string => !!id))];
  assert.equal(threads.size, 1); assert.equal(threads.has(result.threadId), true); assert.equal(turns.length, 2);
  assert.equal(result.turnId, turns.at(-1)); assert.equal(result.recoveryAttempts, 1);
  const firstAnswer = traces.find(trace => trace.direction === "final-answer" && trace.turnId === turns[0]);
  assert.equal(firstAnswer?.status, "failed"); assert.equal(firstAnswer?.markerMatches, false);
  assert.equal(traces.some(trace => trace.turnId === turns[0] && trace.correctInput === true), false);
  assert.ok(traces.some(trace => trace.turnId === turns[1] && trace.correctInput === true));
  assert.ok(events.some(event => event.type === "activity" && event.activity.id === "real-result-recovery:recovery:1" && event.activity.status === "completed"));
  assertPermissions(traces, turns.length); assertNativeEvidence(traces, events, result);
  console.log(JSON.stringify({ success: true, case: "same-thread-result-recovery", model: "gpt-6-luna", effort: "max", threadId: result.threadId, turnIds: turns, recoveryAttempts: result.recoveryAttempts, firstTurnReportedFailure: true, nativeFailureAndMarkerObserved: true, permissionsUnchanged: true, usage: result.usage, durationMs: result.durationMs }));

  if (!process.argv.includes("--recovery-only")) {
    const offset = traces.length, directEvents: WorkerEvent[] = [];
    console.log(JSON.stringify({ stage: "real-worker-same-turn-tool-correction", model: "gpt-6-luna", effort: "max" }));
    const direct = await adapter.run({
      id: "real-same-turn-correction", cwd: project, mode: "read", approvalMode: "never", networkAccess: false,
      model: "gpt-6-luna", reasoningEffort: "max", timeoutMs: 300000, outputSchema: schema, accept, maxRecoveryAttempts: 0,
      prompt: `${common} In this one native turn, first read the deliberate wrong input, observe its real error, then correct the filename and read the correct input. Recover inside this same turn and return the successful structured result. Do not stop after the expected missing-file error.`,
    }, new AbortController().signal, event => directEvents.push(event));
    const directTraces = (await readTraces()).slice(offset);
    assert.equal(direct.recoveryAttempts ?? 0, 0);
    const directTurns = new Set(directEvents.filter(event => event.type === "identity").map(event => event.turnId).filter(Boolean));
    assert.equal(directTurns.size, 1); assertPermissions(directTraces, 1); assertNativeEvidence(directTraces, directEvents, direct);
    console.log(JSON.stringify({ success: true, case: "same-turn-tool-correction", model: "gpt-6-luna", effort: "max", threadId: direct.threadId, turnId: direct.turnId, recoveryAttempts: 0, nativeFailureAndMarkerObserved: true, permissionsUnchanged: true, usage: direct.usage, durationMs: direct.durationMs }));
  }
  await adapter.close(); adapter = undefined;
  assert.deepEqual(await readdir(project), [inputName]); assert.equal(await readFile(path.join(project, inputName), "utf8"), `${marker}\n`);
  assert.equal(digest(await userConfig()), digest(originalConfig));
  assert.equal(digest(await readFile(path.join(privateHome, "config.toml"), "utf8")), digest(originalConfig ?? ""));
  console.log(JSON.stringify({ success: true, projectUnchanged: true, userConfigUnchanged: true, temporaryCredentialsRemovedOnExit: true }));
} finally {
  await adapter?.close();
  try { if (configLoaded) assert.equal(digest(await userConfig()), digest(originalConfig), "The smoke test must never change user config."); }
  finally { await rm(root, { recursive: true, force: true }); }
}
