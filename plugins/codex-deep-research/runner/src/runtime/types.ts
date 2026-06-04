export type PhaseName =
  | "created"
  | "planning"
  | "searching"
  | "collecting"
  | "extracting"
  | "cross_checking"
  | "voting"
  | "synthesizing"
  | "verifying"
  | "completed";

export type RunState = "running" | "completed" | "partial" | "failed" | "cancelled";
export type Role = "planner" | "searcher" | "collector" | "extractor" | "skeptic" | "voter" | "synthesizer" | "verifier";
export type SourceQuality = "primary" | "official" | "secondary" | "community" | "commercial" | "forum" | "unreliable";
export type ClaimDecisionValue = "confirmed" | "weakened" | "refuted" | "unverified";

export interface RunManifest {
  runId: string;
  question: string;
  workspace: string;
  outputDir: string;
  mode: "mixed" | "web" | "repo";
  depth: "quick" | "standard" | "deep";
  maxConcurrency: number;
  maxTasks: number;
  debugPrompts: boolean;
  createdAt: string;
}

export interface RunStatus {
  runId: string;
  question: string;
  phase: PhaseName;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  progress: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  research: {
    angles: number;
    sourcesCollected: number;
    sourcesFetched: number;
    claimsExtracted: number;
    claimsVerified: number;
    confirmed: number;
    weakened: number;
    refuted: number;
    unverified: number;
  };
  currentTasks: CurrentTaskSummary[];
  lastEvents: string[];
  output?: {
    reportPath?: string;
    summaryPath?: string;
  };
}

export interface CurrentTaskSummary {
  taskId: string;
  phase: PhaseName;
  role: Role;
  persona: string;
  label: string;
}

export interface WorkflowEvent {
  type: string;
  at: string;
  runId: string;
  phase?: PhaseName;
  taskId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SourceCard {
  id: string;
  kind: "web" | "official_docs" | "repo" | "github" | "mcp" | "command";
  title: string;
  urlOrPath: string;
  retrievedAt: string;
  publishedAt?: string;
  quality: SourceQuality;
  authorityScore: number;
  freshnessScore: number;
  relevanceScore: number;
  angleIds: string[];
  excerptRefs: string[];
}

export interface Claim {
  id: string;
  text: string;
  sourceId: string;
  quote: string;
  importance: "central" | "supporting" | "tangential";
  freshnessRequired: boolean;
}

export interface Vote {
  id: string;
  claimId: string;
  voter: string;
  refuted: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string;
  counterSource?: string;
}

export interface ClaimDecision {
  claimId: string;
  decision: ClaimDecisionValue;
  validVotes: number;
  refutations: number;
  rationale: string;
}
