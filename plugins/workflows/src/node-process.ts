import type { Activity, WorkflowRun } from "./types.ts";
import { failureContext, resultCheckFailure } from "./failure-context.ts";
import { stopSummary } from "./stop-context.ts";

export function diagnosticText(value: string, maximum = 4000): string {
  return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\x1b\[[0-9;]*m/g, "").slice(0, maximum);
}

export function nodeProcess(run: WorkflowRun, input: { taskId?: string; attemptId?: string; phase?: string; scope?: "workflow" | "unphased"; detail?: "brief" | "developer" }, checkpointCoverage?: ReadonlySet<string>) {
  if ([input.taskId, input.phase, input.scope].filter(Boolean).length !== 1) throw new Error("Select exactly one workflow task, phase or scope");
  if (input.attemptId !== undefined && !input.taskId) throw new Error("Selecting an attempt requires a taskId");
  const tasks = input.scope === "workflow" ? run.tasks : input.scope === "unphased" ? run.tasks.filter(task => !task.phase) : input.taskId ? run.tasks.filter(task => task.id === input.taskId) : run.tasks.filter(task => task.phase === input.phase);
  if (input.taskId && !tasks.length) throw new Error("Unknown workflow task");
  if (input.phase && !tasks.length && !run.meta.phases?.some(phase => phase.title === input.phase)) throw new Error("Unknown workflow phase");
  const selectedTask = input.taskId ? tasks[0] : undefined;
  const selectedAttempt = selectedTask && (input.attemptId !== undefined ? selectedTask.attempts.find(attempt => attempt.id === input.attemptId) : selectedTask.attempts.at(-1));
  if (input.attemptId !== undefined && !selectedAttempt) throw new Error("Unknown workflow task attempt");
  const latestAttemptSelected = !selectedTask || selectedAttempt === selectedTask.attempts.at(-1);
  const last = tasks.at(-1);
  const status = selectedTask ? selectedAttempt?.status ?? selectedTask.status : input.scope === "workflow" && ["preparing", "failed", "stopping", "stopped"].includes(run.execution) ? run.execution : tasks.some(task => task.status === "running") ? "running" : tasks.some(task => task.status === "stopping") ? "stopping" : tasks.some(task => task.status === "failed") ? "failed" : tasks.some(task => task.status === "queued") ? "queued" : tasks.some(task => task.status === "interrupted") ? "interrupted" : tasks.length ? "completed" : "planned";
  const prep: Activity[] = input.scope === "workflow" ? (run.preparation?.stages ?? []).map(stage => ({ ...stage, kind: "initializing" as const })) : [];
  const attemptActivities = selectedTask ? selectedAttempt?.activities ?? [] : tasks.flatMap(task => task.attempts.flatMap(attempt => attempt.activities ?? []));
  const activities: Activity[] = [...prep, ...attemptActivities].slice(-100).map(activity => ({ ...activity, label: diagnosticText(activity.label, 100), ...(activity.detail ? { detail: diagnosticText(activity.detail, 240) } : {}) }));
  // A historical attempt must never inherit the current task's live activity.
  const current = selectedTask ? [...attemptActivities].reverse().find(activity => activity.status === "running") ?? attemptActivities.at(-1) : tasks.find(task => task.currentActivity?.status === "running")?.currentActivity ?? last?.currentActivity;
  const failure = resultCheckFailure(run);
  const reviewFailed = input.scope === "workflow" && failureContext(run)?.kind === "review";
  const newPreviewRequired = input.scope === "workflow" && failureContext(run)?.recovery === "new-preview";
  const failedAfterTasks = Boolean(latestAttemptSelected && failure && (input.scope === "workflow" || input.phase && input.phase === failure.phase || tasks.some(task => task.id === failure.afterTaskId)));
  const taskError = selectedTask ? selectedAttempt ? selectedAttempt.error : selectedTask.error : tasks.find(task => task.status === "failed")?.error;
  const validationError = selectedTask?.status === "failed" && latestAttemptSelected && selectedAttempt?.status === "completed" ? selectedTask.error : undefined;
  const error = reviewFailed ? run.error : taskError ?? (input.scope === "workflow" || failedAfterTasks ? run.error : undefined);
  const summary = validationError ? "当前结果或检查点校验失败，历史执行状态保留。请核对校验原因后再选择恢复方式。" : newPreviewRequired ? "旧检查点无法复用。点击“重新检查”创建新预览，核对当前项目后再启动；现有文件和旧运行保留。" : reviewFailed ? run.tasks.every(task => task.status === "completed") ? "任务已完成，生成改动审查失败，可重试审查。" : "部分任务未成功，继续时会重新执行失效任务并重新生成审查。" : failedAfterTasks ? "任务执行已完成，但工作流在后续检查或结果判断时失败。请核对错误，再选择是否从此节点重试。" : status === "failed" ? "本节点执行失败，查看错误与过程后再决定是否继续。" : status === "completed" ? "本节点已完成。" : status === "preparing" ? prep.find(activity => activity.status === "running")?.label ?? "正在准备工作流。" : status === "running" ? current?.label ?? "正在执行任务，等待新的活动。" : status === "stopping" ? "正在等待任务退出。" : status === "interrupted" || status === "stopped" ? stopSummary(run.stopReason) : "本节点尚未执行。";
  const ids = new Set(tasks.map(task => task.id));
  const scopedLogs = run.logs as Array<WorkflowRun["logs"][number] & { attemptId?: string }>;
  const logs = scopedLogs.filter(log => (input.scope === "workflow" || log.taskId && ids.has(log.taskId)) && (!selectedTask || !log.attemptId || log.attemptId === selectedAttempt?.id));
  const legacyLogCount = logs.filter(log => log.taskId && !log.attemptId).length;
  // Coverage is supplied only after the engine verifies the checkpoint manifest.
  // IDs or completed status alone do not establish membership in a checkpoint.
  const covered = Boolean(run.nodeCheckpoint && tasks.length && tasks.every(task => {
    const attempt = selectedTask ? selectedAttempt : task.attempts.at(-1);
    return attempt && checkpointCoverage?.has(`${task.id}:${attempt.id}`);
  }));
  return {
    id: run.id, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.phase ? { phase: input.phase } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(selectedTask ? {
      attempts: selectedTask.attempts.map(attempt => ({ id: attempt.id, status: attempt.status, ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}), ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}), ...(attempt.recoveryAttempts !== undefined ? { recoveryAttempts: attempt.recoveryAttempts } : {}) })),
      ...(selectedAttempt ? { selectedAttemptId: selectedAttempt.id } : {}),
    } : {}),
    checkpoint: { state: run.checkpointState?.status ?? (run.nodeCheckpoint ? "ready" : "unavailable"), ...(run.nodeCheckpoint ? { latest: { ...run.nodeCheckpoint } } : {}), covered },
    label: diagnosticText(input.scope === "workflow" ? run.meta.name : input.scope === "unphased" ? "未分阶段的任务" : input.phase ?? last?.label ?? `任务 ${(last?.index ?? 0) + 1}`, 120), status,
    ...(current ? { currentActivity: { ...current, label: diagnosticText(current.label, 100), ...(current.detail ? { detail: diagnosticText(current.detail, 240) } : {}) } } : {}),
    activities, summary: diagnosticText(summary, 240), ...(error ? { error: diagnosticText(error, 480) } : {}), ...(validationError ? { validationError: diagnosticText(validationError, 480) } : {}),
    ...(input.detail === "developer" ? { legacyLogCount, logs: logs.slice(-200).map(log => ({ ...log, message: diagnosticText(`${log.taskId && !log.attemptId ? "[历史任务日志，未关联具体尝试] " : ""}${log.message}`) })) } : {}),
  };
}
