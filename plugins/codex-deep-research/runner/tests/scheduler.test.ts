import { describe, expect, it } from "vitest";
import { runBounded } from "../src/runtime/scheduler.js";

describe("runBounded", () => {
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
});
