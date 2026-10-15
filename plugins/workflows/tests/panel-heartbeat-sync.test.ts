import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowPanelController } from "../prototypes/panel.ts";
import type { WorkflowRun } from "../prototypes/panel.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(reply => { resolve = reply; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(resolve => { setImmediate(resolve); });

function fixture() {
  let clock = 1000, lease = "", expiresAt = 0, newLeases = 0, expiredLeases = 0, unavailable = false;
  let run: WorkflowRun = { id: "sync-run", revision: 1, createdAt: "", updatedAt: "", meta: { name: "sync-test", description: "Actual scope" }, script: "return args", args: {}, projectPath: "/project", allowWrite: false, execution: "draft", review: "unavailable", application: "none", tasks: [], logs: [], limits: { maxReadWorkers: 1, maxCalls: 2, timeoutMs: 10000, maxTokens: 0 } };
  let summarized = false;
  const gates = new Map<string, { started: ReturnType<typeof deferred<void>>; reply: ReturnType<typeof deferred<void>> }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const timers: Array<{ callback: () => void; milliseconds: number; disposed: boolean }> = [];
  const panel = new WorkflowPanelController(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    const gate = gates.get(name);
    if (gate) { gate.started.resolve(); await gate.reply.promise; }
    if (name === "workflow_panel_lease") {
      if (args.release) return { structuredContent: { leaseId: args.leaseId } };
      if (unavailable) throw new Error("fixture transport unavailable");
      if (args.leaseId && (args.leaseId !== lease || clock >= expiresAt)) {
        expiredLeases++;
        return { isError: true, content: [{ type: "text", text: "Panel lease is unknown or expired; reconnect the panel" }] };
      }
      if (!args.leaseId) lease = `lease-${++newLeases}`;
      expiresAt = clock + 90000;
      return { structuredContent: { leaseId: lease, expiresAt } };
    }
    if (name === "workflow_get_projects") return { structuredContent: { available: true, contextSource: "thread", currentProjectId: "project-id", projects: [{ projectId: "project-id", label: "Project", path: run.projectPath, hostId: "local" }] } };
    if (name === "workflow_list_runs") {
      const row = summarized ? { id: run.id, revision: run.revision, createdAt: run.createdAt, updatedAt: run.updatedAt, meta: run.meta, projectPath: run.projectPath, execution: run.execution, review: run.review, application: run.application } : run;
      return { structuredContent: { runs: [row], ...(summarized ? { listSummary: true, totalRuns: 1 } : {}) } };
    }
    if (name === "workflow_get_run") return { structuredContent: { run } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: { settings: { revision: 0 }, models: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" }], source: "codex-config", mainAgentContextAvailable: false, codexDefaults: { model: "fixture-model", reasoningEffort: "max" }, defaultsStatus: { available: true }, effectiveDefaults: { model: "fixture-model", reasoningEffort: "max", source: "codex-config" } } };
    throw new Error(`Unexpected mutation in heartbeat fixture: ${name}`);
  }, () => {}, (callback, milliseconds) => {
    const timer = { callback, milliseconds, disposed: false };
    timers.push(timer);
    return () => { timer.disposed = true; };
  }, () => clock);
  return {
    panel, calls, timers,
    count: (name: string) => calls.filter(call => call.name === name).length,
    hold: (name: string) => {
      const gate = { started: deferred<void>(), reply: deferred<void>() };
      gates.set(name, gate);
      return { started: gate.started.promise, release: () => { gates.delete(name); gate.reply.resolve(); } };
    },
    update: (value: Partial<WorkflowRun>, summaries = true) => { run = { ...run, ...value }; summarized = summaries; },
    unavailable: (value: boolean) => { unavailable = value; },
    async ticks(count: number) {
      for (let index = 0; index < count; index++) {
        clock += 5000;
        const timer = timers.find(item => item.milliseconds === 5000 && !item.disposed);
        assert.ok(timer, "Lease polling must start immediately after acquiring the first lease.");
        timer.callback();
        await settle();
      }
    },
    leaseState: () => ({ newLeases, expiredLeases, expiresAt, clock }),
  };
}
function assertLiveLease(f: ReturnType<typeof fixture>, before: number) {
  assert.equal(f.count("workflow_panel_lease") - before, 25, "Every settled timer tick must renew the lease during slow reads.");
  assert.equal(f.leaseState().newLeases, 1);
  assert.equal(f.leaseState().expiredLeases, 0);
  assert.ok(f.leaseState().expiresAt > f.leaseState().clock);
  assert.equal(f.calls.some(call => /workflow_(?:start|resume|apply|stop|preview|update)$/.test(call.name)), false);
}

test("initial project discovery keeps renewing its lease while ownership and actions remain unconfirmed", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  const project = f.hold("workflow_get_projects");
  const connecting = f.panel.connected();
  await project.started;
  assert.equal(f.panel.projectBound, false);
  assert.equal(f.panel.state.projectsBusy, true);
  assert.equal(f.panel.canAct, false);
  const before = f.count("workflow_panel_lease");
  await f.ticks(25);
  assertLiveLease(f, before);
  assert.equal(f.count("workflow_get_projects"), 1);
  assert.equal(f.count("workflow_list_runs"), 0);
  project.release(); await connecting;
  assert.equal(f.panel.canAct, true);
  assert.equal(f.panel.state.reconnecting, false);
});

test("initial run synchronization cannot starve lease renewal or enable actions before the list returns", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  const listing = f.hold("workflow_list_runs");
  const connecting = f.panel.connected();
  await listing.started;
  assert.equal(f.panel.projectBound, true);
  assert.equal(f.panel.state.reconnecting, true);
  assert.equal(f.panel.canAct, false);
  const before = f.count("workflow_panel_lease");
  await f.ticks(25);
  assertLiveLease(f, before);
  assert.equal(f.count("workflow_list_runs"), 1);
  listing.release(); await connecting;
  assert.equal(f.panel.selected?.revision, 1);
  assert.equal(f.panel.canAct, true);
});

test("newer summary details stay fenced throughout a long reconnect while the lease continues renewing", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected();
  f.update({ revision: 2, execution: "stopped", args: { verified: "new scope" } });
  const detail = f.hold("workflow_get_run");
  const reconnecting = f.panel.reconnect();
  await detail.started;
  assert.equal(f.panel.selected?.revision, 1);
  assert.equal(f.panel.stopTarget?.revision, 2);
  assert.equal(f.panel.state.detailsBusy, true);
  assert.equal(f.panel.canAct, false);
  const before = f.count("workflow_panel_lease");
  await f.ticks(25);
  assertLiveLease(f, before);
  assert.equal(f.count("workflow_get_run"), 1);
  detail.release(); await reconnecting;
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.canAct, true);
  assert.deepEqual(f.panel.selected?.args, { verified: "new scope" });
});

test("slow initial model discovery does not lock a confirmed view or block renewed state synchronization", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  const settings = f.hold("workflow_get_execution_settings");
  const connecting = f.panel.connected();
  await settings.started;
  assert.equal(f.panel.state.settingsBusy, true);
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.canAct, true);
  const before = f.count("workflow_panel_lease");
  await f.ticks(25);
  assertLiveLease(f, before);
  const reads = f.count("workflow_list_runs");
  f.update({ revision: 2, execution: "stopped" }, false);
  await f.panel.visibilityChanged(false);
  assert.equal(f.count("workflow_list_runs"), reads);
  await Promise.all([f.panel.reconnect(), f.panel.visibilityChanged(true)]);
  assert.equal(f.count("workflow_list_runs"), reads + 1, "Overlapping explicit and visibility synchronization must coalesce.");
  assert.equal(f.panel.selected?.revision, 2);
  assert.equal(f.count("workflow_get_execution_settings"), 1, "A pending auxiliary catalogue is shared separately from the lease.");
  assert.equal(f.panel.canAct, true);
  settings.release(); await connecting;
  assert.equal(f.panel.state.settingsBusy, false);
  assert.equal(f.panel.state.settings?.models[0]?.id, "fixture-model");
});

test("a slow workflow library is auxiliary and cannot block confirmed state or lease renewal", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  const templates = f.hold("workflow_list_templates");
  const connecting = f.panel.connected();
  await templates.started;
  assert.equal(f.panel.state.templatesLoaded, false);
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.canAct, true);
  const before = f.count("workflow_panel_lease");
  await f.ticks(25);
  assertLiveLease(f, before);
  templates.release(); await connecting;
  assert.equal(f.panel.state.templatesLoaded, true);
});

test("closing during project synchronization releases the lease and never starts history or auxiliary reads", async () => {
  const f = fixture();
  const project = f.hold("workflow_get_projects");
  const connecting = f.panel.connected();
  await project.started;
  await f.panel.teardown();
  assert.equal(f.panel.state.connection, "closed");
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.calls.filter(call => call.name === "workflow_panel_lease" && call.args.release).length, 1);
  assert.ok(f.timers.every(timer => timer.disposed));
  project.release(); await connecting;
  assert.equal(f.panel.state.connection, "closed");
  assert.equal(f.panel.projectBound, false);
  assert.equal(f.count("workflow_list_runs"), 0);
  assert.equal(f.count("workflow_list_templates"), 0);
  assert.equal(f.count("workflow_get_execution_settings"), 0);
});

test("lease transport failure during a pending detail keeps the view degraded until bounded recovery reads actual state", async t => {
  const f = fixture(); t.after(() => f.panel.teardown());
  await f.panel.connected();
  f.update({ revision: 2, execution: "stopped" });
  const detail = f.hold("workflow_get_run");
  const reconnecting = f.panel.reconnect();
  await detail.started;
  f.unavailable(true);
  await f.panel.heartbeat();
  assert.equal(f.panel.state.connection, "degraded");
  detail.release(); await reconnecting;
  assert.equal(f.panel.state.connection, "degraded");
  assert.equal(f.panel.canAct, false);
  const before = f.count("workflow_panel_lease");
  await f.panel.heartbeat();
  assert.equal(f.count("workflow_panel_lease"), before, "A completed state read cannot bypass the transport retry backoff.");
  f.unavailable(false);
  await f.ticks(1);
  assert.equal(f.panel.state.connection, "connected");
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.selected?.revision, 2);
  assert.equal(f.panel.canAct, true);
  assert.equal(f.calls.some(call => /workflow_(?:start|resume|stop)$/.test(call.name)), false);
});

test("closing while model discovery is pending does not reopen the view or issue another synchronization", async () => {
  const f = fixture();
  const settings = f.hold("workflow_get_execution_settings");
  const connecting = f.panel.connected();
  await settings.started;
  await f.panel.teardown();
  const before = f.calls.length;
  settings.release(); await connecting;
  await f.panel.visibilityChanged(true); await f.panel.reconnect();
  assert.equal(f.panel.state.connection, "closed");
  assert.equal(f.panel.state.reconnecting, false);
  assert.equal(f.panel.state.settings, undefined);
  assert.equal(f.panel.canAct, false);
  assert.equal(f.calls.length, before);
});
