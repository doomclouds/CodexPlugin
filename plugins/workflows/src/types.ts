export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "stopping";
export interface Attempt {
  id: string; status: TaskStatus; startedAt?: string; endedAt?: string;
  threadId?: string; turnId?: string; output?: unknown; error?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
export interface Task {
  id: string; index: number; prompt: string; options: Record<string, unknown>;
  label?: string; phase?: string; mode: "read" | "write";
  status: TaskStatus; cached: boolean; attempts: Attempt[]; output?: unknown; error?: string;
}
export interface Limits { maxReadWorkers: number; maxCalls: number; timeoutMs: number; maxTokens: number }
export interface FileRecord { hash: string; mode: number; kind: "file" | "link" }
export interface Workspace {
  root: string; baseline: Record<string, FileRecord>; original: string;
}
export interface Diff {
  text: string; files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  fingerprint: string; conflicts?: string[];
}
export interface WorkflowRun {
  id: string; revision: number; createdAt: string; updatedAt: string;
  meta: { name: string; description: string; phases?: Array<{ title: string; detail?: string }> };
  script: string; args: unknown; projectPath: string; allowWrite: boolean; limits: Limits;
  execution: "draft" | "running" | "stopping" | "stopped" | "completed" | "failed";
  review: "unavailable" | "pending" | "ready";
  application: "none" | "applying" | "applied" | "conflict" | "failed";
  tasks: Task[]; logs: Array<{ at: string; level: "info" | "error"; message: string; taskId?: string }>;
  workspace?: Workspace; workspacePath?: string; diff?: Diff; result?: unknown; error?: string;
  leaseId?: string; scriptDigest: string; contextDigest?: string;
}
