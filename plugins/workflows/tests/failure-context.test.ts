import assert from "node:assert/strict";
import test from "node:test";
import { failureContext, failureErrorSummary, failureErrorText, resultCheckFailure } from "../src/failure-context.ts";
import type { FailureContextInput } from "../src/failure-context.ts";

const legacy: FailureContextInput = {
  execution: "failed", startedAt: "2026-10-15T10:00:00Z", meta: { phases: ["预检", "结果验证"] },
  tasks: [{ id: "task_1", index: 0, phase: "预检", status: "completed" }],
  logs: [{ at: "2026-10-15T10:00:01Z", message: "Phase: 结果验证" }],
};

test("legacy script checks use an entered declared phase without failing their completed worker", () => {
  assert.deepEqual(resultCheckFailure(legacy), { kind: "script", phase: "结果验证", afterTaskId: "task_1" });
  assert.equal(legacy.tasks[0]!.status, "completed");
  assert.equal(resultCheckFailure({ ...legacy, tasks: [{ ...legacy.tasks[0]!, status: "failed" }] }), undefined);
  assert.equal(resultCheckFailure({ ...legacy, execution: "stopped" }), undefined);
  assert.equal(resultCheckFailure({ ...legacy, preparation: { stages: [{ status: "failed" }] } }), undefined);
});

test("explicit failure provenance overrides legacy phase heuristics and checkpoint failures stay distinct", () => {
  const failure = { kind: "script" as const, phase: "动态验收", afterTaskId: "task_1" };
  assert.deepEqual(failureContext({ ...legacy, failureContext: failure }), failure);
  assert.equal(resultCheckFailure({ ...legacy, failureContext: { kind: "checkpoint" } }), undefined);
  assert.equal(resultCheckFailure({ ...legacy, failureContext: { kind: "preparation" } }), undefined);
});

test("legacy fallback ignores earlier attempts, unknown phases and worker-produced phase strings", () => {
  const logs = [
    { at: "2026-10-15T09:00:00Z", message: "Phase: 结果验证" },
    { at: "2026-10-15T10:00:02Z", message: "Phase: invented" },
    { at: "2026-10-15T10:00:03Z", message: "Phase: 结果验证", taskId: "task_1" },
    { at: "2026-10-15T10:00:04Z", message: "Phase: 结果验证\nprivate appendix" },
  ];
  assert.deepEqual(failureContext({ ...legacy, logs }), { kind: "script", phase: "预检", afterTaskId: "task_1" });
});

test("top errors expose a bounded first paragraph while preserving detail elsewhere", () => {
  assert.equal(failureErrorSummary("Result check rejected\n\nFull diagnostic\n" + "detail ".repeat(1000)), "Result check rejected");
  assert.equal(failureErrorSummary("x".repeat(500)).length, 180);
  assert.match(failureErrorSummary("Access failed token=private-fixture"), /\[redacted\]/);
  assert.ok(!failureErrorSummary("Access failed token=private-fixture").includes("private-fixture"));
});

test("oversized full errors are bounded after credential redaction", () => {
  const text = failureErrorText("Diagnostic\n" + "x".repeat(65_510) + " token=" + "private-secret".repeat(500));
  assert.ok(!text.includes("private-secret"));
  assert.ok(text.length <= 65_536);
  const huge = failureErrorText("x".repeat(100_000));
  assert.equal(huge.length, 65_536);
  assert.match(huge, /后续内容已省略/);
});
