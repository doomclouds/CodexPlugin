export type WorkspaceMode = "snapshot" | "git-worktree" | "local";
export type ApprovalMode = "auto-review" | "never";
export interface Activity {
  id: string;
  kind: "initializing" | "command" | "files" | "search" | "mcp" | "message" | "waiting";
  label: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string; endedAt?: string; detail?: string;
}
export interface FileRecord { hash: string; mode: number; kind: "file" | "link" }
export interface Workspace {
  root: string; baseline: Record<string, FileRecord>; original: string;
  kind?: WorkspaceMode;
  baselineRoot?: string;
  // New local runs persist exact decimal identities; numeric values are legacy records.
  rootIdentity?: { dev: string | number; ino: string | number };
  // Missing on historical runs whose manifest keys use native path separators.
  localPathFormat?: "posix";
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
