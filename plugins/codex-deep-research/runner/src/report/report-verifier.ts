export interface VerifiableSource {
  id: string;
  status: "fetched" | "extracted" | "verified_used";
}

export interface ReportVerificationResult {
  ok: boolean;
  errors: string[];
}

export function verifyReportCitations(markdown: string, sources: VerifiableSource[]): ReportVerificationResult {
  const allowed = new Set(sources.map((source) => source.id));
  const cited = Array.from(markdown.matchAll(/\[(S\d+)\]/g)).map((match) => match[1]);
  const errors = cited.filter((id) => !allowed.has(id)).map((id) => `Citation ${id} is not a fetched source.`);
  return { ok: errors.length === 0, errors };
}
