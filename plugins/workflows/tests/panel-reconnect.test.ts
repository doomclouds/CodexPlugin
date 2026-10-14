import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPanelController } from "../prototypes/panel.ts";
import type { ToolResponse, WorkflowRun } from "../prototypes/panel.ts";

function fixture() {
  let clock = 1000, lease = "lease-old", unavailable = false, expired = false, listFails = false, projectFails = false;
  let freshReply: Promise<ToolResponse> | undefined;
  let run: WorkflowRun = { id: "real-run", revision: 4, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", meta: { name: "fixture", description: "Fixture" }, script: "return args", args: {}, projectPath: "/fixture-project", allowWrite: false, execution: "running", review: "unavailable", application: "none", tasks: [], logs: [], limits: { maxReadWorkers: 1, maxCalls: 2, timeoutMs: 10000, maxTokens: 0 } };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (unavailable) throw new Error("transport disconnected");
    if (name === "workflow_panel_lease") {
      if (args.release) return { structuredContent: { leaseId: args.leaseId } };
      if (args.leaseId && (args.leaseId !== lease || expired && args.leaseId === "lease-old")) return { isError: true, content: [{ type: "text", text: "Panel lease is unknown or expired; reconnect the panel" }] };
      if (!args.leaseId && freshReply) return freshReply;
      if (!args.leaseId && expired) lease = "lease-new";
      return { structuredContent: { leaseId: lease } };
    }
    if (name === "workflow_get_projects") {
      if (projectFails) throw new Error("project pipe ended before a complete response");
      return { structuredContent: { available: true, contextSource: "thread", currentProjectId: "fixed-project", projects: [{ projectId: "fixed-project", label: "Fixture", path: run.projectPath, hostId: "local" }] } };
    }
    if (name === "workflow_list_runs") {
      if (listFails) throw new Error("run read unavailable");
      return { structuredContent: { runs: [run] } };
    }
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { isError: true, content: [{ type: "text", text: "Model catalogue is outside this fixture" }] };
    throw new Error(`Unexpected workflow mutation: ${name}`);
  }, () => {}, callback => { timers.push(callback); return () => {}; }, () => clock);
  return { panel, calls, timers, advance: (milliseconds: number) => { clock += milliseconds; }, expire: () => { expired = true; run = { ...run, revision: run.revision + 1, execution: "stopped" }; }, unavailable: (value: boolean) => { unavailable = value; }, listFails: (value: boolean) => { listFails = value; }, projectFails: (value: boolean) => { projectFails = value; }, deferFresh: (reply: Promise<ToolResponse>) => { freshReply = reply; } };
}
const mutations = (calls: Array<{ name: string }>) => calls.filter(call => /workflow_(?:start|resume|preview|update|apply|cancel_task|save_template|delete)$/.test(call.name));

test("an expired or unknown lease is discarded and a fresh view reads the stopped server run without restarting it", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected();
  const before = f.calls.length;
  f.expire();
  await f.panel.heartbeat();
  assert.deepEqual(f.calls.slice(before).filter(call => call.name === "workflow_panel_lease").map(call => call.args), [{ leaseId: "lease-old" }, {}]);
  assert.equal(f.panel.state.connection, "connected");
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.selected?.execution, "stopped");
  const recovered = f.calls.length;
  await f.panel.heartbeat();
  assert.deepEqual(f.calls.slice(recovered).filter(call => call.name === "workflow_panel_lease").map(call => call.args), [{ leaseId: "lease-new" }]);
  assert.deepEqual(mutations(f.calls), []);
});

test("a transport outage retains the lease and bounded retry restores only server-reported state", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected();
  f.unavailable(true);
  await f.panel.heartbeat();
  assert.equal(f.panel.state.connection, "degraded");
  assert.equal(f.panel.selected?.execution, "running");
  const failedCalls = f.calls.length;
  await f.panel.heartbeat(); await f.panel.refresh();
  assert.equal(f.calls.length, failedCalls);
  f.unavailable(false); f.advance(5000);
  await f.panel.heartbeat();
  assert.equal(f.panel.state.connection, "connected");
  assert.deepEqual(f.calls.filter(call => call.name === "workflow_panel_lease").at(-1)?.args, { leaseId: "lease-old" });
  assert.deepEqual(mutations(f.calls), []);
});

test("automatic recovery stops after six failures and an explicit or visibility recovery can retry safely", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected(); f.unavailable(true);
  for (let index = 0; index < 6; index++) { f.advance(31000); await f.panel.heartbeat(); }
  const bounded = f.calls.length;
  f.advance(120000); await f.panel.heartbeat(); await f.panel.refresh(); await f.panel.visibilityChanged(false);
  assert.equal(f.calls.length, bounded);
  assert.match(f.panel.state.error, /自动重试已暂停/);
  f.unavailable(false); f.expire();
  await f.panel.visibilityChanged(true);
  assert.equal(f.panel.state.connection, "connected");
  assert.equal(f.panel.selected?.execution, "stopped");
  assert.deepEqual(mutations(f.calls), []);
});

test("obtaining a new lease cannot enable actions while truthful run synchronization fails", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected(); f.expire(); f.listFails(true);
  await f.panel.heartbeat();
  assert.equal(f.panel.state.connection, "degraded");
  assert.equal(f.panel.canAct, false);
  assert.equal(f.panel.selected?.execution, "running");
  await f.panel.perform("stop", true); await f.panel.perform("resume", true);
  assert.deepEqual(mutations(f.calls), []);
  f.listFails(false); await f.panel.reconnect();
  assert.equal(f.panel.selected?.execution, "stopped");
  assert.equal(f.panel.canAct, true);
});

test("a failed project pipe preserves the saved run directory but disables actions until project ownership recovers", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected();
  f.projectFails(true); await f.panel.reconnect();
  assert.equal(f.panel.state.connection, "connected");
  assert.match(f.panel.state.projectsError, /pipe ended/);
  assert.equal(f.panel.state.projectPath, "");
  assert.equal(f.panel.canAct, false);
  assert.equal(f.panel.selected?.projectPath, "/fixture-project");
  assert.deepEqual(mutations(f.calls), []);
});

test("a late fresh lease acquired during teardown is released without reading or adopting old runs", async t => {
  const f = fixture();
  await f.panel.connected(); f.expire();
  let reply!: (response: ToolResponse) => void;
  const pending = new Promise<ToolResponse>(resolve => { reply = resolve; });
  f.deferFresh(pending);
  const before = f.calls.length;
  const recovering = f.panel.heartbeat();
  await Promise.resolve(); await Promise.resolve();
  await f.panel.teardown();
  reply({ structuredContent: { leaseId: "late-fresh" } });
  await recovering;
  assert.equal(f.panel.state.connection, "closed");
  assert.deepEqual(f.calls.at(-1), { name: "workflow_panel_lease", args: { leaseId: "late-fresh", release: true } });
  assert.equal(f.calls.slice(before).some(call => call.name === "workflow_list_runs"), false);
  assert.deepEqual(mutations(f.calls), []);
});
