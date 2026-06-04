export async function runBounded<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const results: T[] = new Array(tasks.length);
  let next = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped && next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
