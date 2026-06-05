import { describe, expect, it } from "vitest";
import { createRunId } from "../src/runtime/ids.js";

describe("ids", () => {
  it("preserves milliseconds in readable run ids", () => {
    const id = createRunId(new Date("2026-01-02T03:04:05.678Z"));

    expect(id).toBe("dr_20260102T030405678Z");
  });

  it("does not collide for runs created in the same second", () => {
    const first = createRunId(new Date("2026-01-02T03:04:05.001Z"));
    const second = createRunId(new Date("2026-01-02T03:04:05.002Z"));

    expect(first).not.toBe(second);
  });
});
