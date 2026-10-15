import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const mode of ["normal", "cleanup-failure"]) test(`the real stdio runtime exits with its owner and open stdin (${mode})`, { skip: process.platform === "win32", timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-parent-lifetime-"));
  const server = createServer(); let socket: Socket | undefined; let childPid: number | undefined;
  const connected = new Promise<Socket>(resolve => server.once("connection", value => { socket = value; resolve(value); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const owner = fork(fileURLToPath(new URL("./fixtures/stdio-owner.mjs", import.meta.url)), [String(address.port), path.join(root, "state"), mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const ownerClosed = new Promise<void>(resolve => owner.once("close", () => resolve()));
  t.after(async () => {
    owner.kill("SIGKILL"); await ownerClosed;
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    socket?.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  childPid = await new Promise<number>((resolve, reject) => {
    owner.once("error", reject);
    owner.once("message", value => {
      const message = value as { event: string; pid: number };
      if (message.event === "spawned" && Number.isInteger(message.pid)) resolve(message.pid);
      else reject(new Error("Fixture owner did not identify its child"));
    });
  });
  const channel = await connected;
  let text = "";
  const initialized = new Promise<void>(resolve => channel.on("data", data => { text += data.toString(); if (text.includes('"id":1')) resolve(); }));
  channel.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "parent-lifetime-fixture", version: "1" } } }) + "\n");
  await initialized;
  assert.equal(channel.destroyed, false);
  const runtimeClosed = new Promise<void>(resolve => channel.once("end", () => resolve()));
  assert.equal(owner.kill("SIGKILL"), true); await ownerClosed;
  await runtimeClosed;
  assert.match(text, /"serverInfo"/);
  const deadline = Date.now() + 3000;
  while (true) {
    try { process.kill(childPid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); break; }
    if (Date.now() > deadline) throw new Error("Owned runtime remained alive after its parent exited");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  childPid = undefined;
});
