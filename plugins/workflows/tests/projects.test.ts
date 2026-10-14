import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { callerContext, CodexProjectsProvider, mapProjects } from "../src/projects.ts";

type Request = { id: string; jsonrpc: string; method: string; params?: { namespace: string; tool: string; arguments: Record<string, unknown>; callerSource: string; threadId: string; callId: string; turnId: string } };
function encode(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32LE(bytes.length, 0); bytes.copy(frame, 4);
  return frame;
}
function response(request: Request, data: unknown): Buffer { return encode({ jsonrpc: "2.0", id: request.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] } }); }
async function pipeFixture(t: TestContext, handle: (request: Request, socket: Socket) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-project-pipe-"));
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\workflow-project-pipe-${randomUUID()}` : path.join(root, "projects.sock");
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  let connections = 0, closedConnections = 0;
  const server = createServer(socket => {
    connections++; sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); closedConnections++; });
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4) {
        const length = data.readUInt32LE(0);
        if (data.length < length + 4) return;
        const request = JSON.parse(data.subarray(4, length + 4).toString("utf8")) as Request;
        data = data.subarray(length + 4); requests.push(request); handle(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, pipePath, requests, connections: () => connections, closedConnections: () => closedConnections };
}
function inventory(root: string) {
  return { schemaVersion: 2, projects: [
    { projectId: "project-a", projectKind: "local", label: " 工程 A ", path: path.join(root, "source project"), hostId: "local" },
    { projectId: "remote", projectKind: "local", label: "Remote", path: path.join(root, "remote"), hostId: "other-host" },
    { projectId: "chat", projectKind: "chatgpt", label: "Chat", hostId: null },
    { projectId: "relative", projectKind: "local", label: "Relative", path: "source", hostId: "local" },
  ] };
}
const roster = { schemaVersion: 4, pinnedThreads: [{ id: "current-thread", projectId: "project-a", hostId: "local" }], threads: [{ id: "other-thread", projectId: "remote", hostId: "other-host" }] };
const context = () => ({ meta: { threadId: "current-thread", thread_id: "current-thread" }, signal: new AbortController().signal });
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Expected owned pipe state was not observed"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("host request metadata wins and conflicting real thread identities never fall back", () => {
  assert.equal(callerContext({ threadId: "actual", thread_id: "actual", "openai/threadId": "older", "x-codex-turn-metadata": "not-json" }).threadId, "actual");
  const withTurn = callerContext({ threadId: "actual", "x-codex-turn-metadata": JSON.stringify({ thread_id: "older", turn_id: "actual-turn" }) });
  assert.equal(withTurn.threadId, "actual"); assert.equal(withTurn.turnId, "actual-turn");
  assert.throws(() => callerContext({ threadId: "actual", thread_id: "different", "openai/threadId": "actual" }), /conflicting/);
  assert.throws(() => callerContext({ threadId: null, "openai/threadId": "older" }), /invalid/);
  assert.equal(callerContext({ "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-model-thread", turn_id: "turn" }) }).threadId, "native-model-thread");
  assert.equal(callerContext({ thread: { id: "nested-thread" } }).threadId, "nested-thread");
  assert.throws(() => callerContext({}), /real thread identity/);
});

test("source projects and thread ownership are parsed once without cwd or path existence inference", () => {
  const root = path.join(tmpdir(), "uncreated-project-test");
  const mapped = mapProjects(inventory(root), roster, "current-thread");
  assert.deepEqual(mapped, { available: true, projects: [{ projectId: "project-a", label: " 工程 A ", path: path.join(root, "source project"), hostId: "local" }], currentProjectId: "project-a", contextSource: "thread" });
  const global = mapProjects(inventory(root), roster, "ephemeral-global");
  assert.equal(global.contextSource, "global-or-unassigned"); assert.equal(global.currentProjectId, undefined);
  const unknownHost = mapProjects(inventory(root), { ...roster, pinnedThreads: [{ id: "current-thread", projectId: "project-a" }] }, "current-thread");
  assert.equal(unknownHost.currentProjectId, undefined);
  assert.throws(() => mapProjects(inventory(root), { ...roster, threads: [{ id: "current-thread", projectId: null, hostId: "local" }] }, "current-thread"), /conflicting/);
});

test("real socket framing survives split headers/payload and calls only two read-only native tools", async t => {
  let root = "";
  const seenCalls = new Set<string>();
  const fixture = await pipeFixture(t, (request, socket) => {
    if (request.method !== "tools/call") return;
    const callId = request.params!.callId;
    if (seenCalls.has(callId)) { socket.write(encode({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Host already completed this tool call identity" } })); return; }
    seenCalls.add(callId);
    const bytes = response(request, request.params!.tool === "list_projects" ? inventory(root) : roster);
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => { socket.write(bytes.subarray(2, 7)); setImmediate(() => socket.write(bytes.subarray(7))); });
  });
  root = fixture.root;
  const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects(context());
  assert.equal(result.available, true);
  if (result.available) assert.equal(result.currentProjectId, "project-a");
  assert.deepEqual(fixture.requests.map(request => [request.method, request.params?.namespace, request.params?.tool, request.params?.arguments]), [["tools/call", "codex_app", "list_projects", {}], ["tools/call", "codex_app", "list_threads", { limit: 50 }]]);
  assert.ok(fixture.requests.every(request => request.params?.threadId === "current-thread" && request.params?.callerSource === "codex" && request.params.callId && request.params.turnId));
  assert.equal(new Set(fixture.requests.map(request => request.params?.callId)).size, 2);
  await waitFor(() => fixture.closedConnections() === 2);
});

test("global ephemeral caller can list projects but never receives a guessed selection", async t => {
  let root = "";
  const fixture = await pipeFixture(t, (request, socket) => { if (request.method === "tools/call") socket.write(response(request, request.params!.tool === "list_projects" ? inventory(root) : roster)); });
  root = fixture.root;
  const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects({ meta: { thread_id: "real-ephemeral" }, signal: new AbortController().signal });
  assert.equal(result.available, true);
  if (result.available) { assert.equal(result.projects.length, 1); assert.equal(result.currentProjectId, undefined); assert.equal(result.contextSource, "global-or-unassigned"); }
});

test("missing/ambiguous caller context does not borrow a shared environment identity or open a socket", async t => {
  const fixture = await pipeFixture(t, () => {});
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "must-not-be-inferred";
  try {
    const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects({ signal: new AbortController().signal });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /real thread identity/);
    assert.equal(fixture.connections(), 0);
    const noPipe = await new CodexProjectsProvider({ pipePath: "" }).getProjects(context());
    assert.equal(noPipe.available, false);
  } finally { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; }
});

test("oversized frame is rejected before payload allocation and releases its owned connection", async t => {
  const fixture = await pipeFixture(t, (_request, socket) => { const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(header); });
  const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects(context());
  assert.equal(result.available, false);
  if (!result.available) assert.match(result.reason, /8 MiB/);
  await waitFor(() => fixture.closedConnections() === 1);
});

test("cancellation and timeout wait for owned socket cleanup without querying more tools", async t => {
  const fixture = await pipeFixture(t, () => {});
  const controller = new AbortController();
  const pending = new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects({ meta: { threadId: "current-thread" }, signal: controller.signal });
  await waitFor(() => fixture.requests.some(request => request.method === "tools/call"));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.available, false);
  if (!cancelled.available) assert.match(cancelled.reason, /cancelled/);
  await waitFor(() => fixture.closedConnections() === 1);
  const timedOut = await new CodexProjectsProvider({ pipePath: fixture.pipePath, timeoutMs: 50 }).getProjects(context());
  assert.equal(timedOut.available, false);
  if (!timedOut.available) assert.match(timedOut.reason, /timed out/);
  await waitFor(() => fixture.closedConnections() === 2);
  assert.equal(fixture.requests.filter(request => request.method === "tools/call").length, 2);
});

test("invalid schema and wrong response identity return explicit unavailable status", async t => {
  const fixture = await pipeFixture(t, (request, socket) => socket.write(response({ ...request, id: "different-request" }, { projects: [] })));
  const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects(context());
  assert.equal(result.available, false);
  if (!result.available) assert.match(result.reason, /did not match/);
  assert.throws(() => mapProjects({ schemaVersion: 2, projects: [{ projectId: "bad" }] }, roster, "current-thread"));
});

test("native tool failure retains its real reason and never invents a project list", async t => {
  const fixture = await pipeFixture(t, (request, socket) => socket.write(encode({ jsonrpc: "2.0", id: request.id, result: { success: false, contentItems: [{ type: "inputText", text: "Project host is temporarily unavailable" }] } })));
  const result = await new CodexProjectsProvider({ pipePath: fixture.pipePath }).getProjects(context());
  assert.deepEqual(result, { available: false, projects: [], reason: "Codex list_projects: Project host is temporarily unavailable" });
  assert.equal(fixture.requests.filter(request => request.method === "tools/call").length, 1);
});
