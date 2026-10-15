import assert from "node:assert/strict";
import test from "node:test";
import { NodeProcessReader } from "../prototypes/panel.ts";
import type { NodeProcess, NodeProcessDetail, NodeProcessTarget } from "../prototypes/panel.ts";

const settle = () => new Promise<void>(resolve => { setImmediate(resolve); });
function fixture() {
  let active = 0, maximumActive = 0;
  const requests: Array<{ target: NodeProcessTarget; detail: NodeProcessDetail; reply: (process: NodeProcess) => void; fail: (error: Error) => void }> = [];
  const visible: Array<{ target: NodeProcessTarget; detail: NodeProcessDetail; label: string }> = [];
  const errors: Array<{ target: NodeProcessTarget; detail: NodeProcessDetail; error: unknown }> = [];
  const events: string[] = [];
  const reader = new NodeProcessReader(async (target, detail) => {
    active++; maximumActive = Math.max(maximumActive, active);
    events.push(`read:${target.taskId}:${detail}`);
    try { return await new Promise<NodeProcess>((reply, fail) => { requests.push({ target, detail, reply, fail }); }); }
    finally { active--; }
  }, (target, detail, process) => { visible.push({ target, detail, label: process.label }); events.push(`visible:${process.label}`); }, (target, detail, error) => { errors.push({ target, detail, error }); });
  return {
    reader, requests, visible, errors, events, maximumActive: () => maximumActive,
    reply(index: number, label: string) { requests[index]!.reply({ id: requests[index]!.target.id, label, status: "running", summary: `Result ${label}`, activities: [] }); },
  };
}

test("slow brief reads publish before a newer progress refresh instead of being discarded every polling interval", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("brief", "progress-1");
  for (let sequence = 2; sequence <= 20; sequence++) f.reader.request("brief", `progress-${sequence}`);
  assert.equal(f.requests.length, 1, "Twenty progress updates during one slow read must share one transport request.");
  f.reply(0, "first actual process"); await settle();
  assert.deepEqual(f.visible.map(item => item.label), ["first actual process"]);
  assert.equal(f.requests.length, 2, "Only one latest refresh should follow the visible first result.");
  assert.ok(f.events.indexOf("visible:first actual process") < f.events.lastIndexOf("read:task-a:brief"));
  f.reply(1, "latest actual process"); await settle();
  assert.deepEqual(f.visible.map(item => item.label), ["first actual process", "latest actual process"]);
  f.reader.request("brief", "progress-20");
  assert.equal(f.requests.length, 2, "Rendering the already-read progress cannot fetch it again.");
  assert.equal(f.maximumActive(), 1);
  f.reader.close();
});

test("developer logs queue after brief data and remain fair when both channels receive repeated progress", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("brief", "1");
  f.reader.request("developer", "1");
  for (let sequence = 2; sequence <= 15; sequence++) { f.reader.request("brief", String(sequence)); f.reader.request("developer", String(sequence)); }
  assert.equal(f.requests.length, 1);
  f.reply(0, "brief visible"); await settle();
  assert.equal(f.visible[0]?.detail, "brief");
  assert.equal(f.requests[1]?.detail, "developer", "Brief refresh traffic cannot starve the already-requested developer logs.");
  for (let sequence = 16; sequence <= 30; sequence++) { f.reader.request("brief", String(sequence)); f.reader.request("developer", String(sequence)); }
  f.reply(1, "developer visible"); await settle();
  assert.deepEqual(f.visible.map(item => item.detail), ["brief", "developer"]);
  assert.equal(f.requests[2]?.detail, "brief");
  f.reply(2, "brief latest"); await settle();
  assert.equal(f.requests[3]?.detail, "developer");
  f.reply(3, "developer latest"); await settle();
  assert.equal(f.requests.length, 4);
  assert.equal(f.errors.length, 0);
  assert.equal(f.maximumActive(), 1);
  f.reader.close();
});

test("switching nodes invalidates old results and old cleanup cannot clear or duplicate the new node request", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("brief", "1");
  f.reader.open({ id: "run", taskId: "task-b" });
  f.reader.request("brief", "2");
  f.reader.request("brief", "3");
  assert.equal(f.requests.length, 1, "The old uninterruptible MCP call still owns the one transport slot.");
  f.reply(0, "old node result"); await settle();
  assert.equal(f.visible.length, 0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]?.target.taskId, "task-b");
  f.reader.request("brief", "3");
  assert.equal(f.requests.length, 2);
  f.reply(1, "new node result"); await settle();
  assert.deepEqual(f.visible.map(item => [item.target.taskId, item.label]), [["task-b", "new node result"]]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.maximumActive(), 1);
  f.reader.close();
});

test("closing and reopening the same node starts a new session without accepting the previous session's late error", async () => {
  const f = fixture();
  const target = { id: "run", taskId: "task-a" };
  f.reader.open(target); f.reader.request("brief", "1");
  f.reader.close(); f.reader.open(target); f.reader.request("brief", "1");
  f.requests[0]!.fail(new Error("Late failure from closed dialog")); await settle();
  assert.equal(f.errors.length, 0);
  assert.equal(f.visible.length, 0);
  assert.equal(f.requests.length, 2);
  f.reply(1, "reopened result"); await settle();
  assert.equal(f.visible[0]?.label, "reopened result");
  f.reader.close();
  assert.equal(f.maximumActive(), 1);
});

test("read errors stop queued automatic retries while an explicit retry recovers independently of the other channel", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("brief", "1"); f.reader.request("brief", "2"); f.reader.request("developer", "2");
  f.requests[0]!.fail(new Error("Node process unavailable")); await settle();
  assert.equal(f.errors.length, 1);
  assert.equal((f.errors[0]?.error as Error).message, "Node process unavailable");
  assert.equal(f.requests[1]?.detail, "developer", "The separate developer channel remains usable after a brief failure.");
  for (let sequence = 3; sequence <= 12; sequence++) f.reader.request("brief", String(sequence));
  assert.equal(f.requests.length, 2);
  f.reply(1, "available developer log"); await settle();
  assert.equal(f.requests.length, 2, "Progress cannot silently retry the failed read.");
  f.reader.request("brief", "12", true);
  assert.equal(f.requests[2]?.detail, "brief");
  f.reply(2, "retried process"); await settle();
  assert.equal(f.visible.at(-1)?.label, "retried process");
  assert.equal(f.errors.length, 1);
  assert.equal(f.maximumActive(), 1);
  f.reader.close();
});

test("collapsing developer logs removes only queued developer work while retaining brief refreshes", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("brief", "1"); f.reader.request("developer", "1"); f.reader.request("brief", "2");
  f.reader.cancel("developer");
  f.reply(0, "brief first"); await settle();
  assert.equal(f.requests[1]?.detail, "brief");
  f.reply(1, "brief latest"); await settle();
  assert.equal(f.requests.length, 2);
  f.reader.request("developer", "2");
  assert.equal(f.requests[2]?.detail, "developer");
  f.reply(2, "expanded developer log"); await settle();
  assert.equal(f.visible.at(-1)?.detail, "developer");
  assert.equal(f.maximumActive(), 1);
  f.reader.close();
});

test("a closed process reader ignores late data and errors and never dispatches its abandoned refreshes", async () => {
  const f = fixture();
  f.reader.open({ id: "run", taskId: "task-a" });
  f.reader.request("developer", "1"); f.reader.request("brief", "2");
  f.reader.close();
  f.reply(0, "closed result"); await settle();
  assert.equal(f.visible.length, 0);
  assert.equal(f.errors.length, 0);
  assert.equal(f.requests.length, 1);
  f.reader.request("brief", "3");
  assert.equal(f.requests.length, 1);
  assert.equal(f.maximumActive(), 1);
});
