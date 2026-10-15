import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { StableCheckpointGate } from "../src/checkpoint-gate.ts";
import type { CheckpointRelease } from "../src/checkpoint-gate.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;

test("parallel workers leave independently and the last release waits for stable capture", async () => {
  const capture = deferred();
  let captures = 0;
  const gate = new StableCheckpointGate(() => { captures++; return capture.promise; });
  const releaseFirst = await gate.enter(signal());
  const releaseLast = await gate.enter(signal());

  await releaseFirst();
  assert.equal(captures, 0, "non-last workers must not wait for another worker");
  let left = false;
  const leaving = releaseLast().then(() => { left = true; });
  assert.equal(captures, 1);
  await nextTurn();
  assert.equal(left, false);
  capture.resolve();
  await leaving;
  assert.equal(left, true);
});

test("new workers wait during capture and can enter together after it completes", async () => {
  const capture = deferred();
  let captures = 0;
  const gate = new StableCheckpointGate(() => ++captures === 1 ? capture.promise : Promise.resolve());
  const release = await gate.enter(signal());
  const leaving = release();
  const admitted: CheckpointRelease[] = [];
  const first = gate.enter(signal()).then(value => { admitted.push(value); });
  const second = gate.enter(signal()).then(value => { admitted.push(value); });
  await nextTurn();
  assert.equal(admitted.length, 0);
  capture.resolve();
  await Promise.all([leaving, first, second]);
  assert.equal(admitted.length, 2);
  await admitted[0]!();
  assert.equal(captures, 1);
  await admitted[1]!();
  assert.equal(captures, 2);
});

test("capture failure rejects the last release, waiting enters and all future enters", async () => {
  const capture = deferred();
  const failure = new Error("Checkpoint storage failed");
  let captures = 0;
  const gate = new StableCheckpointGate(() => { captures++; return capture.promise; });
  const release = await gate.enter(signal());
  const last = assert.rejects(release(), error => error === failure);
  const waitSignal = signal();
  const waiter = assert.rejects(gate.enter(waitSignal), error => error === failure);
  assert.equal(getEventListeners(waitSignal, "abort").length, 1);
  capture.reject(failure);
  await Promise.all([last, waiter]);
  assert.equal(getEventListeners(waitSignal, "abort").length, 0);
  await assert.rejects(gate.enter(signal()), error => error === failure);
  assert.equal(captures, 1);
});

test("waiting enter cancellation removes its listener and never claims a worker slot", async () => {
  const capture = deferred();
  let captures = 0;
  const gate = new StableCheckpointGate(() => ++captures === 1 ? capture.promise : Promise.resolve());
  const release = await gate.enter(signal());
  const leaving = release();
  const controller = new AbortController();
  const reason = new Error("Cancelled queued worker");
  const waiting = assert.rejects(gate.enter(controller.signal), error => error === reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(reason);
  await waiting;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  capture.resolve();
  await leaving;
  const next = await gate.enter(signal());
  await next();
  assert.equal(captures, 2, "cancelled waiter must not keep the gate active");
});

test("a successful waiting enter also removes its abort listener", async () => {
  const capture = deferred();
  let captures = 0;
  const gate = new StableCheckpointGate(() => ++captures === 1 ? capture.promise : Promise.resolve());
  const release = await gate.enter(signal());
  const leaving = release();
  const waitSignal = signal();
  const entering = gate.enter(waitSignal);
  assert.equal(getEventListeners(waitSignal, "abort").length, 1);
  capture.resolve();
  const next = await entering;
  await leaving;
  assert.equal(getEventListeners(waitSignal, "abort").length, 0);
  await next();
});

test("an already aborted enter creates no slot or abort listener", async () => {
  let captures = 0;
  const gate = new StableCheckpointGate(async () => { captures++; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gate.enter(controller.signal), { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const release = await gate.enter(signal());
  await release();
  assert.equal(captures, 1);
});

test("repeated release calls share one promise without underflow or duplicate capture", async () => {
  const capture = deferred();
  let captures = 0;
  const gate = new StableCheckpointGate(() => ++captures === 1 ? capture.promise : Promise.resolve());
  const first = await gate.enter(signal());
  const second = await gate.enter(signal());
  const leftFirst = first();
  assert.equal(first(), leftFirst);
  await leftFirst;
  const leftSecond = second();
  assert.equal(second(), leftSecond);
  assert.equal(captures, 1);
  capture.resolve();
  await leftSecond;
  assert.equal(second(), leftSecond);
  const next = await gate.enter(signal());
  await next();
  assert.equal(captures, 2);
});

test("consecutive worker waves capture once per empty boundary without a completion deadlock", async () => {
  let captures = 0;
  const gate = new StableCheckpointGate(async () => { captures++; await nextTurn(); });
  for (let wave = 0; wave < 8; wave++) {
    const releases = await Promise.all(Array.from({ length: 4 }, () => gate.enter(signal())));
    await Promise.all(releases.map(release => release()));
    assert.equal(captures, wave + 1);
  }
});

test("a callback that synchronously releases the same worker cannot underflow the counter", async () => {
  const capture = deferred();
  let release!: CheckpointRelease;
  let duplicate!: Promise<void>;
  let captures = 0;
  const gate = new StableCheckpointGate(() => {
    if (++captures !== 1) return Promise.resolve();
    duplicate = release();
    return capture.promise;
  });
  release = await gate.enter(signal());
  const leaving = release();
  assert.equal(leaving, duplicate);
  capture.resolve();
  await leaving;
  const next = await gate.enter(signal());
  await next();
  assert.equal(captures, 2);
});

test("synchronous onStable exceptions close the gate before a reentrant enter can proceed", async () => {
  const failure = new Error("Synchronous checkpoint failure");
  let reentrant!: Promise<CheckpointRelease>;
  let captures = 0;
  let gate!: StableCheckpointGate;
  gate = new StableCheckpointGate(() => {
    captures++;
    reentrant = gate.enter(signal());
    throw failure;
  });
  const release = await gate.enter(signal());
  const leaving = assert.rejects(release(), error => error === failure);
  const waiting = assert.rejects(reentrant, error => error === failure);
  await Promise.all([leaving, waiting]);
  await assert.rejects(gate.enter(signal()), error => error === failure);
  assert.equal(captures, 1);
});

test("the capture barrier is installed before a successful onStable callback reenters", async () => {
  const capture = deferred();
  let entered = false;
  let reentrant!: Promise<CheckpointRelease>;
  let captures = 0;
  let gate!: StableCheckpointGate;
  gate = new StableCheckpointGate(() => {
    if (++captures !== 1) return Promise.resolve();
    reentrant = gate.enter(signal()).then(release => { entered = true; return release; });
    return capture.promise;
  });
  const release = await gate.enter(signal());
  const leaving = release();
  await nextTurn();
  assert.equal(entered, false);
  capture.resolve();
  const next = await reentrant;
  await leaving;
  assert.equal(entered, true);
  await next();
  assert.equal(captures, 2);
});

test("aborting an active worker does not release its checkpoint boundary early", async () => {
  let captures = 0;
  const gate = new StableCheckpointGate(async () => { captures++; });
  const controller = new AbortController();
  const release = await gate.enter(controller.signal);
  controller.abort();
  await nextTurn();
  assert.equal(captures, 0);
  await release();
  assert.equal(captures, 1);
});

test("non-Error capture rejection still closes all later worker entries", async () => {
  const gate = new StableCheckpointGate(() => Promise.reject(undefined));
  const release = await gate.enter(signal());
  const failures: unknown[] = [];
  await release().catch(error => { failures.push(error); });
  await gate.enter(signal()).catch(error => { failures.push(error); });
  assert.deepEqual(failures, [undefined, undefined]);
});
