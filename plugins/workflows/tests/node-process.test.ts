import assert from "node:assert/strict";
import test from "node:test";
import { nodeProcess } from "../src/node-process.ts";
import type { WorkflowRun } from "../src/types.ts";

const run = { id: "wf_0123456789abcdef01234567", meta: { name: "test", description: "test", phases: [{ title: "检查" }] },
  tasks: [{ id: "task_1", index: 0, label: "检查配置", phase: "检查", prompt: "Private full task prompt", status: "failed", error: "request token=secret-token failed", attempts: [{ id: "task_1_attempt_1", status: "failed", error: "request token=secret-token failed", activities: [{ id: "event_1", kind: "files", label: "读取配置", status: "completed", startedAt: "2026-10-14T00:00:00Z" }] }] }],
  logs: [{ taskId: "task_1", at: "2026-10-14T00:00:01Z", level: "error", message: "Authorization: Bearer sensitive-token" }, { taskId: "task_2", message: "another task" }],
} as unknown as WorkflowRun;

test("brief node process excludes raw prompts, output and diagnostic logs", () => {
  const view = nodeProcess(run, { taskId: "task_1" });
  assert.equal(view.status, "failed"); assert.equal(view.label, "检查配置");
  assert.equal(view.activities[0]?.label, "读取配置");
  assert.ok(!("logs" in view));
  assert.ok(!JSON.stringify(view).includes("Private full task prompt"));
  assert.ok(!JSON.stringify(view).includes("secret-token"));
});
test("developer process includes only selected node diagnostics and redacts common credentials", () => {
  const view = nodeProcess(run, { taskId: "task_1", detail: "developer" });
  assert.equal(view.logs?.length, 1);
  assert.ok(!JSON.stringify(view).includes("sensitive-token"));
  assert.ok(!JSON.stringify(view).includes("another task"));
});
test("phase process groups only phase tasks and validates identities", () => {
  assert.equal(nodeProcess(run, { phase: "检查" }).status, "failed");
  assert.throws(() => nodeProcess(run, { taskId: "missing" }), /Unknown workflow task/);
  assert.throws(() => nodeProcess(run, { phase: "missing" }), /Unknown workflow phase/);
});
test("workflow process includes preparation failure with no task and unphased has an explicit identity", () => {
  const preparing = { ...run, execution: "failed", error: "Workspace preparation failed", tasks: [], preparation: { startedAt: "2026-10-14T00:00:00Z", stages: [{ id: "workspace", label: "准备工作区", status: "failed", startedAt: "2026-10-14T00:00:00Z" }] } } as WorkflowRun;
  const view = nodeProcess(preparing, { scope: "workflow" });
  assert.equal(view.status, "failed"); assert.equal(view.error, "Workspace preparation failed");
  assert.equal(view.activities[0]?.label, "准备工作区");
  const unphased = { ...run, tasks: run.tasks.map(task => { const copy = { ...task }; delete copy.phase; return copy; }) };
  assert.equal(nodeProcess(unphased, { scope: "unphased" }).status, "failed");
});

test("a completed task distinguishes later workflow validation failure from worker failure", () => {
  const first = { ...run.tasks[0]!, status: "completed" as const, error: undefined, attempts: run.tasks[0]!.attempts.map(attempt => ({ ...attempt, status: "completed" as const, error: undefined })) };
  const last = { ...first, id: "task_2", index: 1, label: "验收结果", attempts: first.attempts.map(attempt => ({ ...attempt, id: "task_2_attempt_1" })) };
  const rejected = { ...run, execution: "failed" as const, tasks: [first, last], error: "Validation rejected token=private-fixture" };
  const view = nodeProcess(rejected, { taskId: "task_2" });
  assert.equal(view.status, "completed", "Do not relabel a successful worker as failed.");
  assert.match(view.summary, /结果判断时失败/);
  assert.match(view.error ?? "", /Validation rejected/);
  assert.ok(!JSON.stringify(view).includes("private-fixture"));
  assert.equal(nodeProcess(rejected, { taskId: "task_1" }).error, undefined, "An earlier completed task is not the later validation failure.");
});

test("stopped processes explain the recorded cause without presenting an Abort error", () => {
  const stopped = { ...run, execution: "stopped" as const, stopReason: "panel-closed" as const, tasks: run.tasks.map(task => ({ ...task, status: "interrupted" as const, error: undefined, attempts: task.attempts.map(attempt => ({ ...attempt, status: "interrupted" as const, error: undefined })) })) };
  const workflow = nodeProcess(stopped, { scope: "workflow" });
  const task = nodeProcess(stopped, { taskId: "task_1" });
  assert.equal(workflow.status, "stopped");
  assert.match(workflow.summary, /面板已关闭/);
  assert.equal(task.status, "interrupted");
  assert.match(task.summary, /面板已关闭/);
  assert.equal(workflow.error, undefined);
  assert.equal(task.error, undefined);
  assert.match(nodeProcess({ ...stopped, stopReason: "owner-exited" }, { scope: "workflow" }).summary, /上次执行进程已退出/);
});

test("review generation failures belong to the workflow without relabeling successful tasks or phases", () => {
  const reviewed = { ...run, execution: "failed" as const, failureContext: { kind: "review" as const, phase: "检查" }, error: "Could not build reviewed changes token=private-fixture", tasks: run.tasks.map(task => ({ ...task, status: "completed" as const, error: undefined, attempts: task.attempts.map(attempt => ({ ...attempt, status: "completed" as const, error: undefined })) })) };
  const workflow = nodeProcess(reviewed, { scope: "workflow" });
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.summary, "任务已完成，生成改动审查失败，可重试审查。");
  assert.match(workflow.error ?? "", /Could not build reviewed changes/);
  assert.ok(!JSON.stringify(workflow).includes("private-fixture"));
  for (const input of [{ taskId: "task_1" }, { phase: "检查" }] as const) {
    const process = nodeProcess(reviewed, input);
    assert.equal(process.status, "completed");
    assert.equal(process.error, undefined);
    assert.equal(process.summary, "本节点已完成。");
  }
});

test("a review failure retains its own error when the script handled an earlier failed parallel task", () => {
  const reviewed = { ...run, execution: "failed" as const, failureContext: { kind: "review" as const }, error: "Review generation unavailable" };
  const process = nodeProcess(reviewed, { scope: "workflow" });
  assert.equal(process.summary, "部分任务未成功，继续时会重新执行失效任务并重新生成审查。");
  assert.equal(process.error, "Review generation unavailable");
  assert.match(nodeProcess(reviewed, { taskId: "task_1" }).error ?? "", /request/);
});

function retried(): WorkflowRun {
  const old = { id: "task_1_attempt_1", status: "failed" as const, startedAt: "2026-10-15T00:00:00Z", endedAt: "2026-10-15T00:00:01Z", error: "First failure token=old-private-token", output: "PRIVATE OLD OUTPUT", recoveryAttempts: 1, activities: [{ id: "old-command", kind: "command" as const, label: "第一次构建", status: "failed" as const, startedAt: "2026-10-15T00:00:00Z", endedAt: "2026-10-15T00:00:01Z" }] };
  const latest = { id: "task_1_attempt_2", status: "running" as const, startedAt: "2026-10-15T00:01:00Z", activities: [{ id: "new-command", kind: "command" as const, label: "第二次构建", status: "running" as const, startedAt: "2026-10-15T00:01:00Z" }] };
  return { ...run, execution: "running", tasks: [{ ...run.tasks[0]!, status: "running", error: "A stale task-level error must not leak", attempts: [old, latest], currentActivity: latest.activities[0] }], logs: [
    { at: old.startedAt, level: "error", taskId: "task_1", attemptId: old.id, message: "First attempt diagnostic token=old-private-log" },
    { at: latest.startedAt, level: "info", taskId: "task_1", attemptId: latest.id, message: "Second attempt diagnostic token=new-private-log" },
    { at: old.startedAt, level: "info", taskId: "task_1", message: "Legacy task diagnostic token=legacy-private-log" },
    { at: old.startedAt, level: "info", taskId: "task_2", attemptId: old.id, message: "Unrelated task diagnostic" },
  ] } as WorkflowRun;
}

test("task process defaults to its latest real attempt without mixing earlier errors or activities", () => {
  const value = retried(), original = JSON.stringify(value);
  const process = nodeProcess(value, { taskId: "task_1" });
  assert.equal(process.selectedAttemptId, "task_1_attempt_2"); assert.equal(process.status, "running");
  assert.deepEqual(process.activities.map(activity => activity.id), ["new-command"]);
  assert.equal(process.currentActivity?.id, "new-command"); assert.equal(process.error, undefined);
  assert.deepEqual(process.attempts?.map(attempt => [attempt.id, attempt.status]), [["task_1_attempt_1", "failed"], ["task_1_attempt_2", "running"]]);
  assert.equal(process.attempts?.[0]?.recoveryAttempts, 1);
  assert.ok(!JSON.stringify(process).includes("PRIVATE OLD OUTPUT")); assert.ok(!JSON.stringify(process).includes("First failure"));
  assert.equal(JSON.stringify(value), original);
});

test("selecting a historical attempt reports that attempt's status, diagnostics and activity only", () => {
  const process = nodeProcess(retried(), { taskId: "task_1", attemptId: "task_1_attempt_1", detail: "developer" });
  assert.equal(process.selectedAttemptId, "task_1_attempt_1"); assert.equal(process.status, "failed");
  assert.deepEqual(process.activities.map(activity => activity.id), ["old-command"]); assert.equal(process.currentActivity?.id, "old-command");
  assert.match(process.error!, /First failure/); assert.doesNotMatch(JSON.stringify(process), /old-private|new-private|legacy-private|Second attempt diagnostic|Unrelated task/);
  assert.equal(process.logs?.length, 2); assert.match(process.logs?.[0]?.message ?? "", /First attempt diagnostic/);
  assert.match(process.logs?.[1]?.message ?? "", /^\[历史任务日志，未关联具体尝试\]/); assert.equal(process.legacyLogCount, 1);
  const latest = nodeProcess(retried(), { taskId: "task_1", detail: "developer" });
  assert.match(latest.logs?.[0]?.message ?? "", /Second attempt diagnostic/); assert.doesNotMatch(JSON.stringify(latest), /First attempt diagnostic/);
});

test("attempt selection requires a known attempt belonging to the selected actual task", () => {
  const value = retried();
  assert.throws(() => nodeProcess(value, { taskId: "task_1", attemptId: "missing" }), /Unknown workflow task attempt/);
  assert.throws(() => nodeProcess(value, { taskId: "task_1", attemptId: "" }), /Unknown workflow task attempt/);
  assert.throws(() => nodeProcess(value, { phase: "检查", attemptId: "task_1_attempt_1" }), /requires a taskId/);
  assert.throws(() => nodeProcess(value, { scope: "workflow", attemptId: "task_1_attempt_1" }), /requires a taskId/);
  assert.throws(() => nodeProcess(value, { taskId: "task_1", phase: "检查", attemptId: "task_1_attempt_1" }), /exactly one/);
});

test("phase and workflow process retain aggregate attempt activities without claiming a selected attempt", () => {
  const value = retried();
  for (const input of [{ phase: "检查" }, { scope: "workflow" as const }] as const) {
    const process = nodeProcess(value, input);
    assert.equal(process.status, "running"); assert.equal(process.selectedAttemptId, undefined); assert.equal(process.attempts, undefined);
    assert.deepEqual(process.activities.map(activity => activity.id), ["old-command", "new-command"]);
  }
});

test("checkpoint membership requires verified coverage for the selected exact attempt", () => {
  const value = retried();
  value.nodeCheckpoint = { id: "cp_" + "a".repeat(24), sequence: 1, createdAt: "2026-10-15T00:00:00.000Z", digest: "b".repeat(64), reason: "node", completedTasks: 1 };
  value.checkpointState = { status: "ready" };
  const latestCoverage = new Set(["task_1:task_1_attempt_2"]);
  assert.equal(nodeProcess(value, { taskId: "task_1" }).checkpoint.covered, false, "A reference or completed count cannot prove coverage.");
  assert.equal(nodeProcess(value, { taskId: "task_1" }, new Set(["task_1"])).checkpoint.covered, false);
  assert.equal(nodeProcess(value, { taskId: "task_1" }, latestCoverage).checkpoint.covered, true);
  assert.equal(nodeProcess(value, { taskId: "task_1", attemptId: "task_1_attempt_1" }, latestCoverage).checkpoint.covered, false);
  assert.equal(nodeProcess(value, { taskId: "task_1", attemptId: "task_1_attempt_1" }, new Set(["task_1:task_1_attempt_1"])).checkpoint.covered, true);
  const process = nodeProcess(value, { taskId: "task_1" }, latestCoverage);
  assert.deepEqual(process.checkpoint.latest, value.nodeCheckpoint); assert.equal(process.checkpoint.state, "ready");
  delete value.nodeCheckpoint;
  assert.equal(nodeProcess(value, { taskId: "task_1" }, latestCoverage).checkpoint.covered, false);
});

test("a historical completed attempt does not inherit a later script validation error", () => {
  const value = retried(); value.execution = "failed";
  value.tasks[0]!.status = "completed"; value.tasks[0]!.attempts = value.tasks[0]!.attempts.map(attempt => ({ ...attempt, status: "completed" }));
  delete value.tasks[0]!.error; for (const attempt of value.tasks[0]!.attempts) delete attempt.error;
  value.failureContext = { kind: "script", afterTaskId: "task_1" }; value.error = "Later result check failed";
  const old = nodeProcess(value, { taskId: "task_1", attemptId: "task_1_attempt_1" });
  assert.equal(old.status, "completed"); assert.equal(old.error, undefined); assert.equal(old.summary, "本节点已完成。");
  assert.equal(nodeProcess(value, { taskId: "task_1" }).error, "Later result check failed");
});

test("unstarted tasks expose no fabricated attempt or current activity", () => {
  const value = retried(); value.tasks[0]!.attempts = []; value.tasks[0]!.status = "queued";
  const process = nodeProcess(value, { taskId: "task_1" });
  assert.deepEqual(process.attempts, []); assert.equal(process.selectedAttemptId, undefined); assert.equal(process.currentActivity, undefined); assert.deepEqual(process.activities, []); assert.equal(process.checkpoint.covered, false);
});

test("a failed cache validation is visible separately from the successful historical worker", () => {
  const value = retried(); value.execution = "failed"; value.tasks[0]!.status = "failed";
  value.tasks[0]!.error = "Saved result no longer passes the declared contract token=validation-private";
  value.tasks[0]!.attempts = value.tasks[0]!.attempts.map(attempt => ({ ...attempt, status: "completed" }));
  for (const attempt of value.tasks[0]!.attempts) delete attempt.error;
  const current = nodeProcess(value, { taskId: "task_1" });
  assert.equal(current.status, "completed"); assert.equal(current.error, undefined);
  assert.match(current.validationError!, /Saved result no longer passes/); assert.doesNotMatch(current.validationError!, /validation-private/);
  assert.match(current.summary, /当前结果或检查点校验失败，历史执行状态保留/);
  assert.equal(value.tasks[0]!.attempts.at(-1)?.status, "completed");
  const old = nodeProcess(value, { taskId: "task_1", attemptId: "task_1_attempt_1" });
  assert.equal(old.status, "completed"); assert.equal(old.validationError, undefined); assert.equal(old.error, undefined); assert.equal(old.summary, "本节点已完成。");
});
