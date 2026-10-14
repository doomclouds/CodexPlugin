import assert from "node:assert/strict";
import test from "node:test";
import { nodeProcess } from "../src/node-process.ts";
import type { WorkflowRun } from "../src/types.ts";

const run = { id: "wf_0123456789abcdef01234567", meta: { name: "test", description: "test", phases: [{ title: "检查" }] },
  tasks: [{ id: "task_1", index: 0, label: "检查配置", phase: "检查", prompt: "Private full task prompt", status: "failed", error: "request token=secret-token failed", attempts: [{ activities: [{ id: "event_1", kind: "files", label: "读取配置", status: "completed", startedAt: "2026-10-14T00:00:00Z" }] }] }],
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
  const first = { ...run.tasks[0]!, status: "completed" as const, error: undefined };
  const last = { ...first, id: "task_2", index: 1, label: "验收结果" };
  const rejected = { ...run, execution: "failed" as const, tasks: [first, last], error: "Validation rejected token=private-fixture" };
  const view = nodeProcess(rejected, { taskId: "task_2" });
  assert.equal(view.status, "completed", "Do not relabel a successful worker as failed.");
  assert.match(view.summary, /结果判断时失败/);
  assert.match(view.error ?? "", /Validation rejected/);
  assert.ok(!JSON.stringify(view).includes("private-fixture"));
  assert.equal(nodeProcess(rejected, { taskId: "task_1" }).error, undefined, "An earlier completed task is not the later validation failure.");
});

test("stopped processes explain the recorded cause without presenting an Abort error", () => {
  const stopped = { ...run, execution: "stopped" as const, stopReason: "panel-closed" as const, tasks: run.tasks.map(task => ({ ...task, status: "interrupted" as const, error: undefined })) };
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
  const reviewed = { ...run, execution: "failed" as const, failureContext: { kind: "review" as const, phase: "检查" }, error: "Could not build reviewed changes token=private-fixture", tasks: run.tasks.map(task => ({ ...task, status: "completed" as const, error: undefined })) };
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
