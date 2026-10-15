import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { CodexAdapter } from "../src/adapter.ts";

const fixture = fileURLToPath(new URL("fixtures/discovery-app-server.mjs", import.meta.url));
type FixtureSettings = { model?: string; wait?: boolean; invalid?: boolean; previousPid?: number };
type Trace = { type?: string; method?: string; pid: number; cwd: string; previousAlive?: boolean; params?: { cwd?: string } };
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflows-discovery-test-")));
  const cwd = path.join(root, "project"); await mkdir(cwd);
  const trace = path.join(root, "trace.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath, args: [fixture, trace], startupTimeoutMs: 3000, shutdownTimeoutMs: 100 });
  const configure = (settings: FixtureSettings = {}, directory = cwd) => writeFile(path.join(directory, "discovery-settings.json"), JSON.stringify({ model: "model-a", wait: true, ...settings }));
  const transcript = async (): Promise<Trace[]> => {
    try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const waitFor = async (predicate: (entries: Trace[]) => boolean) => {
    const until = Date.now() + 2500;
    while (Date.now() < until) { const entries = await transcript(); if (predicate(entries)) return entries; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("Discovery fixture did not reach the expected protocol boundary");
  };
  const ready = (directory = cwd) => writeFile(path.join(directory, "catalogue-ready"), "ready");
  t.after(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); });
  await configure();
  return { root, cwd, adapter, configure, transcript, waitFor, ready };
}
function assertExited(pid: number) { assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); }

test("concurrent discovery canonicalizes aliases, shares one native session and returns independent values", async t => {
  const f = await setup(t);
  const alias = path.join(f.root, "project-alias");
  await symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const pending = [f.cwd, alias, f.cwd, alias].map(cwd => f.adapter.executionEnvironment(cwd, new AbortController().signal));
  await f.waitFor(entries => entries.some(entry => entry.method === "model/list"));
  assert.equal((await f.transcript()).filter(entry => entry.type === "started").length, 1);
  await f.ready();
  const results = await Promise.all(pending);
  assert.deepEqual(results[0], results[1]);
  results[0]!.defaults.model = "mutated";
  results[0]!.models[0]!.supportedReasoningEfforts.push("mutated");
  assert.equal(results[1]!.defaults.model, "model-a");
  assert.deepEqual(results[1]!.models[0]!.supportedReasoningEfforts, ["max"]);
  let entries = await f.transcript();
  assert.equal(entries.filter(entry => entry.method === "config/read").length, 1);
  assertExited(entries.find(entry => entry.type === "started")!.pid);
  await f.configure({ model: "model-b", wait: false });
  const refreshed = await f.adapter.executionEnvironment(alias, new AbortController().signal);
  assert.equal(refreshed.defaults.model, "model-b");
  entries = await f.transcript();
  assert.equal(entries.filter(entry => entry.method === "config/read").length, 2, "A completed discovery never caches the effective configuration");
  assert.equal(entries.filter(entry => entry.type === "started").length, 2);
});

test("cancelling one discovery subscriber preserves the other subscriber and its native session", async t => {
  const f = await setup(t), first = new AbortController(), second = new AbortController();
  const cancelled = assert.rejects(f.adapter.executionEnvironment(f.cwd, first.signal), { name: "AbortError" });
  const remaining = f.adapter.executionEnvironment(f.cwd, second.signal);
  const entries = await f.waitFor(entries => entries.some(entry => entry.method === "model/list"));
  const pid = entries.find(entry => entry.type === "started")!.pid;
  first.abort(); await cancelled;
  assert.doesNotThrow(() => process.kill(pid, 0));
  await f.ready();
  assert.equal((await remaining).defaults.model, "model-a");
  assert.equal((await f.transcript()).filter(entry => entry.type === "started").length, 1);
  assertExited(pid);
});

test("last subscriber cancellation waits for cleanup before a replacement discovery starts", async t => {
  const f = await setup(t), first = new AbortController(), second = new AbortController();
  const firstCancelled = assert.rejects(f.adapter.executionEnvironment(f.cwd, first.signal), { name: "AbortError" });
  const lastCancelled = assert.rejects(f.adapter.executionEnvironment(f.cwd, second.signal), { name: "AbortError" });
  const entries = await f.waitFor(entries => entries.some(entry => entry.method === "model/list"));
  const pid = entries.find(entry => entry.type === "started")!.pid;
  first.abort(); await firstCancelled;
  await f.configure({ model: "model-b", wait: false, previousPid: pid });
  second.abort();
  const replacement = f.adapter.executionEnvironment(f.cwd, new AbortController().signal);
  await lastCancelled; assertExited(pid);
  assert.equal((await replacement).defaults.model, "model-b");
  const starts = (await f.transcript()).filter(entry => entry.type === "started");
  assert.equal(starts.length, 2);
  assert.equal(starts[1]!.previousAlive, false, "The cancelled native process is gone before its successor starts");
});

test("adapter close cancels every shared subscriber and waits for the native discovery to exit", async t => {
  const f = await setup(t);
  const pending = Array.from({ length: 3 }, () => assert.rejects(f.adapter.executionEnvironment(f.cwd, new AbortController().signal), { name: "AbortError" }));
  const entries = await f.waitFor(entries => entries.some(entry => entry.method === "model/list"));
  await f.adapter.close(); await Promise.all(pending);
  const starts = entries.filter(entry => entry.type === "started");
  assert.equal(starts.length, 1); assertExited(starts[0]!.pid);
  await assert.rejects(f.adapter.executionEnvironment(f.cwd, new AbortController().signal), /closed/);
});

test("concurrent discoveries for different canonical directories keep separate fresh configurations", async t => {
  const f = await setup(t), other = path.join(f.root, "other"); await mkdir(other);
  await f.configure({ model: "model-b" }, other);
  const pending = [f.cwd, other].map(cwd => f.adapter.executionEnvironment(cwd, new AbortController().signal));
  const entries = await f.waitFor(entries => entries.filter(entry => entry.method === "model/list").length === 2);
  assert.deepEqual(new Set(entries.filter(entry => entry.method === "config/read").map(entry => entry.params!.cwd)), new Set([f.cwd, other]));
  await Promise.all([f.ready(), f.ready(other)]);
  assert.deepEqual((await Promise.all(pending)).map(result => result.defaults.model), ["model-a", "model-b"]);
  const starts = entries.filter(entry => entry.type === "started");
  assert.equal(new Set(starts.map(entry => entry.pid)).size, 2);
  starts.forEach(entry => assertExited(entry.pid));
});

test("failed shared discoveries clean up once and a later request can inspect fresh configuration", async t => {
  const f = await setup(t); await f.configure({ invalid: true });
  const failed = Array.from({ length: 2 }, () => assert.rejects(f.adapter.executionEnvironment(f.cwd, new AbortController().signal)));
  await f.waitFor(entries => entries.some(entry => entry.method === "model/list"));
  await f.ready(); await Promise.all(failed);
  let starts = (await f.transcript()).filter(entry => entry.type === "started");
  assert.equal(starts.length, 1); assertExited(starts[0]!.pid);
  await f.configure({ wait: false, model: "model-b" });
  assert.equal((await f.adapter.executionEnvironment(f.cwd, new AbortController().signal)).defaults.model, "model-b");
  starts = (await f.transcript()).filter(entry => entry.type === "started");
  assert.equal(starts.length, 2); starts.forEach(entry => assertExited(entry.pid));
});
