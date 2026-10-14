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
