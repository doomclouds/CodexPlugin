import type { PhaseName, Role } from "./types.js";

export interface PromptEnvelope {
  run: {
    question: string;
    mode: "mixed" | "web" | "repo";
    depth: "quick" | "standard" | "deep";
  };
  task: {
    id: string;
    phase: PhaseName;
    role: Role;
    persona: string;
    objective: string;
  };
  constraints: string[];
  injected: Record<string, unknown>;
  outputSchema: unknown;
}

export function buildPromptEnvelope(envelope: PromptEnvelope): PromptEnvelope {
  return envelope;
}

export function redactPromptEnvelope(envelope: PromptEnvelope): PromptEnvelope {
  return {
    ...envelope,
    injected: redactValue(envelope.injected) as Record<string, unknown>,
  };
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 120)}...[redacted ${value.length - 120} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }
  return value;
}
