import { describe, expect, it } from "vitest";
import { ScopeSchema, VerdictSchema } from "../src/workflow/schemas.js";

describe("workflow schemas", () => {
  it("accepts a valid scope result", () => {
    const parsed = ScopeSchema.parse({
      question: "What changed in Codex plugins?",
      summary: "Search official docs, implementation examples, and limitations.",
      angles: [
        { label: "official docs", query: "Codex plugins official docs", rationale: "Primary source" },
        { label: "examples", query: "Codex plugin examples", rationale: "Implementation signal" },
        { label: "limitations", query: "Codex plugin limitations", rationale: "Risk signal" },
      ],
    });
    expect(parsed.angles).toHaveLength(3);
  });

  it("rejects a verdict without confidence", () => {
    expect(() =>
      VerdictSchema.parse({
        refuted: false,
        evidence: "The quote supports the claim.",
      }),
    ).toThrow();
  });
});
