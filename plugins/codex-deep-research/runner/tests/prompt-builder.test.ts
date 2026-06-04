import { describe, expect, it } from "vitest";
import { buildPromptEnvelope, redactPromptEnvelope } from "../src/runtime/prompt-builder.js";

describe("prompt builder", () => {
  it("builds and redacts prompt envelopes", () => {
    const envelope = buildPromptEnvelope({
      run: { question: "Question?", mode: "mixed", depth: "standard" },
      task: {
        id: "task_001",
        phase: "voting",
        role: "skeptic",
        persona: "skeptic:freshness_checker",
        objective: "Check freshness",
      },
      constraints: ["Use cited evidence only"],
      injected: {
        claim: { id: "claim_001", text: "A fast-moving claim" },
        largeExcerpt: "x".repeat(2000),
      },
      outputSchema: { type: "object" },
    });

    const redacted = redactPromptEnvelope(envelope);
    expect(redacted.task.persona).toBe("skeptic:freshness_checker");
    expect(JSON.stringify(redacted)).not.toContain("x".repeat(2000));
  });
});
