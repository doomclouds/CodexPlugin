import type { WorkerClient, WorkerTask } from "./worker-client.js";

export class FakeWorkerClient implements WorkerClient {
  constructor(private readonly results: unknown[]) {}

  async run<T = unknown>(_task: WorkerTask): Promise<T> {
    if (this.results.length === 0) {
      throw new Error("FakeWorkerClient has no queued result");
    }
    return this.results.shift() as T;
  }
}
