import type { Claim, SourceCard } from "./types.js";

export interface SkepticContextInput {
  claim: Claim;
  source: SourceCard;
  knownCounterEvidence: string[];
}

export function selectSkepticContext(input: SkepticContextInput): Record<string, unknown> {
  return {
    claim: {
      id: input.claim.id,
      text: input.claim.text,
      freshnessRequired: input.claim.freshnessRequired,
    },
    supportingEvidence: [
      {
        sourceId: input.source.id,
        quote: input.claim.quote,
        publishDate: input.source.publishedAt,
        sourceQuality: input.source.quality,
      },
    ],
    knownCounterEvidence: input.knownCounterEvidence,
  };
}
