import { describe, expect, it } from "vitest";
import { buildPromptEnvelope, type PromptEnvelope, redactPromptEnvelope } from "../src/runtime/prompt-builder.js";

describe("prompt builder", () => {
  it("builds and redacts prompt envelopes", () => {
    const envelope = buildPromptEnvelope(
      createEnvelope({
        injected: {
          claim: { id: "claim_001", text: "A fast-moving claim" },
          largeExcerpt: "x".repeat(2000),
        },
      }),
    );

    const redacted = redactPromptEnvelope(envelope);
    expect(redacted.task.persona).toBe("skeptic:freshness_checker");
    expect(JSON.stringify(redacted)).not.toContain("x".repeat(2000));
  });

  it("recursively redacts long strings across the whole envelope", () => {
    const longQuestion = "q".repeat(800);
    const longObjective = "o".repeat(800);
    const longConstraint = "c".repeat(800);
    const longSchemaDescription = "s".repeat(800);
    const envelope = createEnvelope({
      run: { question: longQuestion, mode: "mixed", depth: "standard" },
      task: {
        id: "task_001",
        phase: "voting",
        role: "skeptic",
        persona: "skeptic:freshness_checker",
        objective: longObjective,
      },
      constraints: ["Use cited evidence only", longConstraint],
      outputSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: longSchemaDescription,
          },
        },
      },
    });

    const redactedJson = JSON.stringify(redactPromptEnvelope(envelope));

    expect(redactedJson).not.toContain(longQuestion);
    expect(redactedJson).not.toContain(longObjective);
    expect(redactedJson).not.toContain(longConstraint);
    expect(redactedJson).not.toContain(longSchemaDescription);
    expect(redactedJson).toContain("[redacted 680 chars]");
  });

  it("redacts nested objects and arrays without mutating the original envelope", () => {
    const longNestedValue = "n".repeat(700);
    const envelope = createEnvelope({
      injected: {
        claims: [
          { id: "claim_001", excerpts: [longNestedValue] },
          { id: "claim_002", note: "short" },
        ],
      },
    });
    const originalJson = JSON.stringify(envelope);

    const redacted = redactPromptEnvelope(envelope);

    expect(JSON.stringify(redacted)).not.toContain(longNestedValue);
    expect(JSON.stringify(envelope)).toBe(originalJson);
    expect(envelope.injected).not.toBe(redacted.injected);
  });
});

function createEnvelope(overrides: Partial<PromptEnvelope> = {}): PromptEnvelope {
  return {
    run: { question: "Question?", mode: "mixed", depth: "standard" },
    task: {
      id: "task_001",
      phase: "voting",
      role: "skeptic",
      persona: "skeptic:freshness_checker",
      objective: "Check freshness",
    },
    constraints: ["Use cited evidence only"],
    injected: {},
    outputSchema: { type: "object" },
    ...overrides,
  };
}
