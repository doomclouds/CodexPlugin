export interface TaskFailureOrigin { taskId: string; attemptId?: string; phase?: string }

export class WorkflowTaskError extends Error {
  readonly origin: TaskFailureOrigin;
  constructor(error: unknown, origin: TaskFailureOrigin) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "WorkflowTaskError";
    this.origin = { ...origin };
  }
}
