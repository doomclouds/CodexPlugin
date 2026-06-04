import { describe, expect, it } from "vitest";
import { verifyReportCitations } from "../src/report/report-verifier.js";

describe("verifyReportCitations", () => {
  it("rejects citations that are not in fetched sources", () => {
    const result = verifyReportCitations("Claim cites [S2].", [{ id: "S1", status: "fetched" }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("S2");
  });

  it("accepts citations from fetched sources", () => {
    const result = verifyReportCitations("Claim cites [S1].", [{ id: "S1", status: "fetched" }]);
    expect(result.ok).toBe(true);
  });
});
