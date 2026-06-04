import type { RunStatus } from "../runtime/types.js";
import { runBounded } from "../runtime/scheduler.js";
import type { RunStore } from "../runtime/run-store.js";
import type { WorkerClient, WorkerTask } from "../workers/worker-client.js";

export interface WorkflowRuntime {
  store: RunStore;
  runId: string;
  status: RunStatus;
  worker: WorkerClient;
}

export interface AgentOptions<T> {
  parse?: (result: unknown) => T;
}

export async function phase(runtime: WorkflowRuntime, phaseName: RunStatus["phase"]): Promise<void> {
  runtime.status.phase = phaseName;
  await runtime.store.writeStatus(runtime.status);
  await runtime.store.emit(runtime.runId, { type: "phase.started", phase: phaseName, message: phaseName });
}

export async function agent<T>(runtime: WorkflowRuntime, task: WorkerTask, options: AgentOptions<T> = {}): Promise<T> {
  runtime.status.progress.running += 1;
  let result!: T;
  let hasResult = false;
  let workerError: unknown;
  let emitError: unknown;
  let statusError: unknown;

  try {
    await runtime.store.writeStatus(runtime.status);
    await runtime.store.emit(runtime.runId, { type: "task.started", taskId: task.label, message: task.label });

    try {
      const workerResult = await runtime.worker.run<unknown>(task);
      result = options.parse ? options.parse(workerResult) : (workerResult as T);
      hasResult = true;
      runtime.status.progress.completed += 1;
      await runtime.store
        .emit(runtime.runId, { type: "task.completed", taskId: task.label, message: task.label })
        .catch((error: unknown) => {
          emitError = error;
        });
    } catch (error) {
      workerError = error;
      runtime.status.progress.failed += 1;
      await runtime.store
        .emit(runtime.runId, {
          type: "task.failed",
          taskId: task.label,
          message: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  } catch (error) {
    emitError = error;
  } finally {
    runtime.status.progress.running -= 1;
    await runtime.store.writeStatus(runtime.status).catch((error: unknown) => {
      statusError = error;
    });
  }

  if (workerError !== undefined) {
    throw workerError;
  }
  if (emitError !== undefined) {
    throw emitError;
  }
  if (statusError !== undefined) {
    throw statusError;
  }
  if (!hasResult) {
    throw new Error(`Worker task did not return a result: ${task.label}`);
  }
  return result;
}

export async function parallel<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  return await runBounded(tasks, concurrency);
}
