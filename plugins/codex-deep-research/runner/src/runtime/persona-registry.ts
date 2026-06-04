import type { Role } from "./types.js";

export interface Persona {
  id: string;
  role: Role;
  qualifier: string;
  rubric: string[];
  must: string[];
  mustNot: string[];
}

export const PERSONAS: Persona[] = [
  {
    id: "planner:angle_decomposer",
    role: "planner",
    qualifier: "Decompose the research question into complementary search angles.",
    rubric: ["Cover primary, recent, technical, skeptical, and implementation angles."],
    must: ["Return non-overlapping angles."],
    mustNot: ["Do not create redundant search queries."],
  },
  {
    id: "skeptic:freshness_checker",
    role: "skeptic",
    qualifier: "Focus on whether the claim is outdated or contradicted by newer sources.",
    rubric: ["Check publication dates.", "Downgrade stale claims in fast-moving domains."],
    must: ["Return specific evidence for freshness concerns."],
    mustNot: ["Do not reject stable-domain claims only because they are old."],
  },
  {
    id: "voter:strict_quorum_judge",
    role: "voter",
    qualifier: "Apply the vote threshold strictly and default weak evidence to unverified.",
    rubric: ["Require at least two valid votes.", "Kill claims with two refutations."],
    must: ["Explain the vote decision."],
    mustNot: ["Do not preserve claims with too many abstentions."],
  },
];

export function getPersona(id: string): Persona {
  const persona = PERSONAS.find((item) => item.id === id);
  if (!persona) {
    throw new Error(`Unknown persona: ${id}`);
  }
  return persona;
}
