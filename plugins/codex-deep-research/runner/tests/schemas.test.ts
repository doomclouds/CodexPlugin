import { describe, expect, it } from "vitest";
import { ExtractSchema, ReportSchema, ScopeSchema, SearchSchema, VerdictSchema } from "../src/workflow/schemas.js";

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

  it("limits search results to the workflow budget", () => {
    const results = Array.from({ length: 7 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Result ${index}`,
      relevance: "medium" as const,
    }));

    expect(() => SearchSchema.parse({ results })).toThrow();
  });

  it("limits extracted claims to the workflow budget", () => {
    const claims = Array.from({ length: 6 }, (_, index) => ({
      claim: `Claim ${index}`,
      quote: `Quote ${index}`,
      importance: "supporting" as const,
    }));

    expect(() => ExtractSchema.parse({ sourceQuality: "official", claims })).toThrow();
  });

  it("requires reports to include at least one sourced finding", () => {
    const report = {
      summary: "A concise answer.",
      findings: [
        {
          claim: "The official source supports this.",
          confidence: "high" as const,
          sources: ["https://example.com/source"],
          evidence: "The source states the relevant fact.",
        },
      ],
      caveats: "No caveats.",
    };

    expect(ReportSchema.parse(report).findings).toHaveLength(1);
    expect(() => ReportSchema.parse({ ...report, findings: [] })).toThrow();
    expect(() => ReportSchema.parse({ ...report, findings: [{ ...report.findings[0], sources: [] }] })).toThrow();
  });
});
