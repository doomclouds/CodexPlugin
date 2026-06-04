export interface WorkerTask {
  label: string;
  prompt: string;
  schemaName: string;
  timeoutMs?: number;
}

export interface WorkerClient {
  run<T = unknown>(task: WorkerTask): Promise<T>;
}
