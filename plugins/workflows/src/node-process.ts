import type { Activity, WorkflowRun } from "./types.ts";

export function diagnosticText(value: string, maximum = 4000): string {
  return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\x1b\[[0-9;]*m/g, "").slice(0, maximum);
}

export function nodeProcess(run: WorkflowRun, input: { taskId?: string; phase?: string; scope?: "workflow" | "unphased"; detail?: "brief" | "developer" }) {
  if ([input.taskId, input.phase, input.scope].filter(Boolean).length !== 1) throw new Error("Select exactly one workflow task, phase or scope");
  const tasks = input.scope === "workflow" ? run.tasks : input.scope === "unphased" ? run.tasks.filter(task => !task.phase) : input.taskId ? run.tasks.filter(task => task.id === input.taskId) : run.tasks.filter(task => task.phase === input.phase);
  if (input.taskId && !tasks.length) throw new Error("Unknown workflow task");
  if (input.phase && !tasks.length && !run.meta.phases?.some(phase => phase.title === input.phase)) throw new Error("Unknown workflow phase");
  const last = tasks.at(-1);
  const status = input.scope === "workflow" && ["preparing", "failed", "stopping", "stopped"].includes(run.execution) ? run.execution : tasks.some(task => task.status === "running") ? "running" : tasks.some(task => task.status === "stopping") ? "stopping" : tasks.some(task => task.status === "failed") ? "failed" : tasks.some(task => task.status === "queued") ? "queued" : tasks.some(task => task.status === "interrupted") ? "interrupted" : tasks.length ? "completed" : "planned";
  const prep: Activity[] = input.scope === "workflow" ? (run.preparation?.stages ?? []).map(stage => ({ ...stage, kind: "initializing" as const })) : [];
  const activities: Activity[] = [...prep, ...tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.activities ?? []))].slice(-100).map(activity => ({ ...activity, label: diagnosticText(activity.label, 100), ...(activity.detail ? { detail: diagnosticText(activity.detail, 240) } : {}) }));
  const current = tasks.find(task => task.currentActivity?.status === "running")?.currentActivity ?? last?.currentActivity;
  const error = tasks.find(task => task.status === "failed")?.error ?? (input.scope === "workflow" ? run.error : undefined);
  const summary = status === "failed" ? "本节点执行失败，查看错误与过程后再决定是否继续。" : status === "completed" ? "本节点已完成。" : status === "preparing" ? prep.find(activity => activity.status === "running")?.label ?? "正在准备工作流。" : status === "running" ? current?.label ?? "正在执行任务，等待新的活动。" : status === "stopping" ? "正在等待任务退出。" : status === "interrupted" || status === "stopped" ? "本节点已中断，进度保留。" : "本节点尚未执行。";
  const ids = new Set(tasks.map(task => task.id));
  return {
    id: run.id, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.phase ? { phase: input.phase } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    label: diagnosticText(input.scope === "workflow" ? run.meta.name : input.scope === "unphased" ? "未分阶段的任务" : input.phase ?? last?.label ?? `任务 ${(last?.index ?? 0) + 1}`, 120), status,
    ...(current ? { currentActivity: { ...current, label: diagnosticText(current.label, 100), ...(current.detail ? { detail: diagnosticText(current.detail, 240) } : {}) } } : {}),
    activities, summary: diagnosticText(summary, 240), ...(error ? { error: diagnosticText(error, 480) } : {}),
    ...(input.detail === "developer" ? { logs: run.logs.filter(log => input.scope === "workflow" || log.taskId && ids.has(log.taskId)).slice(-200).map(log => ({ ...log, message: diagnosticText(log.message) })) } : {}),
  };
}
