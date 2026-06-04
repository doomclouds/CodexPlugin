import { describe, expect, it } from "vitest";
import { runBounded } from "../src/runtime/scheduler.js";

describe("runBounded", () => {
  it("returns an empty result for empty task lists", async () => {
    await expect(runBounded([], 3)).resolves.toEqual([]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(runBounded([async () => 1], 0)).rejects.toThrow("concurrency");
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await runBounded(
      Array.from({ length: 10 }, (_, index) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      }),
      3,
    );

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("propagates the original error and stops starting queued tasks after a failure", async () => {
    const error = new Error("task failed");
    const started: number[] = [];

    await expect(
      runBounded(
        [
          async () => {
            started.push(0);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return 0;
          },
          async () => {
            started.push(1);
            throw error;
          },
          async () => {
            started.push(2);
            return 2;
          },
        ],
        2,
      ),
    ).rejects.toBe(error);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([0, 1]);
  });
});
