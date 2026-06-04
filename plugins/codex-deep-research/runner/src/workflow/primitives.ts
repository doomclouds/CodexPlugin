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

export async function phase(runtime: WorkflowRuntime, phaseName: RunStatus["phase"]): Promise<void> {
  runtime.status.phase = phaseName;
  await runtime.store.writeStatus(runtime.status);
  await runtime.store.emit(runtime.runId, { type: "phase.started", phase: phaseName, message: phaseName });
}

export async function agent<T>(runtime: WorkflowRuntime, task: WorkerTask): Promise<T> {
  runtime.status.progress.running += 1;
  await runtime.store.writeStatus(runtime.status);
  await runtime.store.emit(runtime.runId, { type: "task.started", taskId: task.label, message: task.label });
  try {
    const result = await runtime.worker.run<T>(task);
    runtime.status.progress.completed += 1;
    await runtime.store.emit(runtime.runId, { type: "task.completed", taskId: task.label, message: task.label });
    return result;
  } catch (error) {
    runtime.status.progress.failed += 1;
    await runtime.store.emit(runtime.runId, {
      type: "task.failed",
      taskId: task.label,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    runtime.status.progress.running -= 1;
    await runtime.store.writeStatus(runtime.status);
  }
}

export async function parallel<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  return await runBounded(tasks, concurrency);
}
