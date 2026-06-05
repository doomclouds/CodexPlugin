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

  it("rejects citations to sources with unsupported statuses", () => {
    const result = verifyReportCitations("Claim cites [S1].", [{ id: "S1", status: "searched" }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Source S1 has unsupported status "searched". Allowed statuses: fetched, extracted, verified_used.');
    expect(result.errors).toContain("Citation S1 does not reference a source with an allowed status.");
  });

  it("deduplicates repeated invalid citations", () => {
    const result = verifyReportCitations("Claim cites [S2] and [S2].", [{ id: "S1", status: "fetched" }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Citation S2 is not a fetched source."]);
  });
});
