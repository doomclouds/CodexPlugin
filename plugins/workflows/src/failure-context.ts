export interface WorkflowFailureContext {
  kind: "script" | "preparation" | "review" | "checkpoint";
  phase?: string;
  afterTaskId?: string;
  recovery?: "new-preview";
}

export interface FailureContextInput {
  execution: string;
  failureContext?: WorkflowFailureContext;
  meta?: { phases?: Array<string | { title?: string; name?: string }> };
  tasks: Array<{ id: string; index: number; status: string; phase?: string }>;
  preparation?: { stages: Array<{ status: string }> };
  logs?: Array<{ at?: string; message: string; taskId?: string }>;
  startedAt?: string;
}

// Prefer recorded failure provenance. Legacy records can identify a script
// check only when every dispatched worker completed and preparation succeeded.
export function failureContext(run: FailureContextInput): WorkflowFailureContext | undefined {
  if (run.execution !== "failed") return undefined;
  if (run.failureContext) return run.failureContext;
  if (!run.tasks.length || run.tasks.some(task => task.status !== "completed") || run.preparation?.stages.some(stage => stage.status === "failed" || stage.status === "interrupted")) return undefined;
  const last = [...run.tasks].sort((left, right) => left.index - right.index).at(-1)!;
  const declared = new Set((run.meta?.phases ?? []).map(phase => typeof phase === "string" ? phase : phase.title ?? phase.name ?? "").filter(Boolean));
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const phase = [...(run.logs ?? [])].reverse().find(log => {
    if (log.taskId) return false;
    if (Number.isFinite(started) && (!log.at || !Number.isFinite(Date.parse(log.at)) || Date.parse(log.at) < started)) return false;
    return log.message.startsWith("Phase: ") && declared.has(log.message.slice(7));
  })?.message.slice(7) ?? last.phase;
  return { kind: "script", ...(phase ? { phase } : {}), afterTaskId: last.id };
}

export function resultCheckFailure(run: FailureContextInput): WorkflowFailureContext | undefined {
  const failure = failureContext(run);
  return failure?.kind === "script" && run.tasks.every(task => task.status === "completed") ? failure : undefined;
}

export function failureErrorSummary(value: string, maximum = 180): string {
  const first = failureErrorText(value).trim().split(/\r?\n\s*\r?\n|\r?\n/)[0]?.trim() ?? "";
  return first.length > maximum ? first.slice(0, Math.max(0, maximum - 1)).trimEnd() + "…" : first;
}

export function failureErrorText(value: string): string {
  const safe = value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]").replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]").replace(/\x1b\[[0-9;]*m/g, "");
  const maximum = 65_536, marker = "\n[错误内容过长，后续内容已省略。]";
  return safe.length > maximum ? safe.slice(0, maximum - marker.length) + marker : safe;
}
