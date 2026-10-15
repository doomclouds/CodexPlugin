import type { WorkflowMeta } from "./script.ts";
import type { EffectiveExecutionSettings, NodeSettings } from "./execution-settings.ts";
import type { WorkflowFailureContext } from "./failure-context.ts";
import type { WorkflowStopReason } from "./stop-context.ts";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "stopping";
export type WorkspaceMode = "snapshot" | "git-worktree" | "local";
export interface Activity {
  id: string;
  kind: "initializing" | "command" | "files" | "search" | "mcp" | "message" | "waiting";
  label: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string; endedAt?: string; detail?: string;
}
export interface Preparation {
  startedAt: string; endedAt?: string;
  stages: Array<{ id: "settings" | "project" | "workspace" | "validation"; label: string;
    status: "running" | "completed" | "failed" | "interrupted"; startedAt: string; endedAt?: string }>;
}
export interface DefinitionSource { id: string; revision: number }
export interface Attempt {
  id: string; status: TaskStatus; startedAt?: string; endedAt?: string;
  threadId?: string; turnId?: string; output?: unknown; error?: string;
  toolsUsed?: string[];
  executionSettings?: EffectiveExecutionSettings;
  outcome?: "confirmed" | "unknown";
  activities?: Activity[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
export interface Task {
  id: string; index: number; prompt: string; options: Record<string, unknown>;
  label?: string; phase?: string; mode: "read" | "write";
  status: TaskStatus; cached: boolean; attempts: Attempt[]; output?: unknown; error?: string;
  cacheInvalidated?: boolean;
  executionSettings?: EffectiveExecutionSettings;
  configurationTarget?: string;
  currentActivity?: Activity;
}
export interface Limits { maxReadWorkers: number; maxCalls: number; timeoutMs: number; maxTokens: number }
export interface FileRecord { hash: string; mode: number; kind: "file" | "link" }
export interface Workspace {
  root: string; baseline: Record<string, FileRecord>; original: string;
  kind?: WorkspaceMode;
  baselineRoot?: string;
  rootIdentity?: { dev: number; ino: number };
  git?: { base: string; branch: string; upstream?: string; target?: string };
}
export interface Diff {
  text: string; files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  fingerprint: string; conflicts?: string[];
  previewTruncated?: boolean; totalBytes?: number; contentSha256?: string;
}
export interface MaintenancePlan {
  steps: Array<{ id: string; command: string[]; networkAccess?: boolean; timeoutMs?: number; retries?: number; idempotent?: boolean; protectedPaths?: string[] }>;
  activation?: { serverName: string; command: string; args: string[] };
}
export interface MaintenanceArtifact extends FileRecord { path: string; size: number }
export interface MaintenanceReview {
  base: string; target: string; branch: string; upstream?: string;
  diff: Diff; artifacts: MaintenanceArtifact[]; artifactFingerprint: string;
  fingerprint: string; preparedClean: boolean;
  submodules?: Array<{ path: string; commit: string; initialized: boolean; head?: string }>;
}
export interface ActivationResult {
  status: "pending_restart" | "verified" | "failed"; serverName: string;
  configPath?: string; backupPath?: string; command?: string; args?: string[]; error?: string;
}
export interface WorkflowRun {
  id: string; revision: number; createdAt: string; updatedAt: string;
  meta: WorkflowMeta;
  script: string; args: unknown; projectPath: string; allowWrite: boolean; limits: Limits;
  execution: "draft" | "preparing" | "running" | "stopping" | "stopped" | "completed" | "failed";
  review: "unavailable" | "pending" | "ready";
  application: "none" | "applying" | "applied" | "partial" | "conflict" | "failed";
  tasks: Task[]; logs: Array<{ at: string; level: "info" | "error"; message: string; taskId?: string }>;
  workspace?: Workspace; workspacePath?: string; diff?: Diff; result?: unknown; error?: string;
  leaseId?: string; scriptDigest: string; contextDigest?: string;
  networkAccess?: boolean; workspaceMode?: WorkspaceMode;
  // Internal preview-time sandbox scope. Its absence keeps legacy runs unchanged.
  localGitWrite?: true;
  maintenance?: MaintenancePlan; maintenanceReview?: MaintenanceReview;
  activation?: ActivationResult; controlId?: string; workspaceCheckpoint?: string;
  localCheckpointState?: { filesDigest: string; gitDigest: string | null };
  allowedMcpServers?: string[]; allowedMcpTools?: Record<string, string[]>;
  nodeSettings?: NodeSettings;
  executionSettings?: Partial<EffectiveExecutionSettings>;
  preparation?: Preparation; startedAt?: string; endedAt?: string;
  progressSequence?: number;
  failureContext?: WorkflowFailureContext;
  stopReason?: WorkflowStopReason;
  sourceDefinition?: DefinitionSource;
  deletionPending?: boolean;
  deletionTarget?: { kind: "run" | "definition"; id: string; revision: number; runIds?: string[]; includeAssociatedRuns?: true };
}
