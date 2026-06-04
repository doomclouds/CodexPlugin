import { z } from "zod";

export const ScopeSchema = z.object({
  question: z.string().min(1),
  summary: z.string().min(1),
  angles: z
    .array(
      z.object({
        label: z.string().min(1),
        query: z.string().min(1),
        rationale: z.string().optional(),
      }),
    )
    .min(3)
    .max(6),
});

export const SearchSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().min(1),
        title: z.string().min(1),
        snippet: z.string().optional(),
        relevance: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(6),
});

export const ExtractSchema = z.object({
  sourceQuality: z.enum(["primary", "official", "secondary", "community", "commercial", "forum", "unreliable"]),
  publishDate: z.string().optional(),
  claims: z
    .array(
      z.object({
        claim: z.string().min(1),
        quote: z.string().min(1),
        importance: z.enum(["central", "supporting", "tangential"]),
      }),
    )
    .max(5),
});

export const VerdictSchema = z.object({
  refuted: z.boolean(),
  evidence: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  counterSource: z.string().optional(),
});

export const ReportSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      claim: z.string().min(1),
      confidence: z.enum(["high", "medium", "low"]),
      sources: z.array(z.string().min(1)),
      evidence: z.string().min(1),
      vote: z.string().optional(),
    }),
  ),
  caveats: z.string().min(1),
  openQuestions: z.array(z.string()).default([]),
});
