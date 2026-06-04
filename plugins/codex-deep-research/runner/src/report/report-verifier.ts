export interface VerifiableSource {
  id: string;
  status: string;
}

export interface ReportVerificationResult {
  ok: boolean;
  errors: string[];
}

const ALLOWED_SOURCE_STATUSES = new Set(["fetched", "extracted", "verified_used"]);

export function verifyReportCitations(markdown: string, sources: VerifiableSource[]): ReportVerificationResult {
  const errors = new Set<string>();
  const allowed = new Set<string>();
  const known = new Set<string>();

  for (const source of sources) {
    known.add(source.id);
    if (ALLOWED_SOURCE_STATUSES.has(source.status)) {
      allowed.add(source.id);
    } else {
      errors.add(
        `Source ${source.id} has unsupported status "${source.status}". Allowed statuses: ${Array.from(
          ALLOWED_SOURCE_STATUSES,
        ).join(", ")}.`,
      );
    }
  }

  const cited = new Set(Array.from(markdown.matchAll(/\[(S\d+)\]/g)).map((match) => match[1]));
  for (const id of cited) {
    if (!known.has(id)) {
      errors.add(`Citation ${id} is not a fetched source.`);
    } else if (!allowed.has(id)) {
      errors.add(`Citation ${id} does not reference a source with an allowed status.`);
    }
  }

  return { ok: errors.size === 0, errors: Array.from(errors) };
}
