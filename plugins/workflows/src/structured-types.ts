import type { CompiledDefinition, DefinitionNode, ExpressionEnvironment, JsonValue, WorkflowDefinition } from "./definition.ts";
import type { Activity, ApprovalMode, Diff, Workspace, WorkspaceMode } from "./types.ts";
import type { EffectiveExecutionSettings } from "./execution-settings.ts";

export interface RunGrants {
  allowWrite: boolean;
  networkAccess: boolean;
  allowedMcpServers: string[];
  allowedMcpTools: Record<string, string[]>;
  workspaceMode: WorkspaceMode;
  approvalMode: ApprovalMode;
}
export interface RunLimits { maxReadWorkers: number; maxCalls: number; timeoutMs: number; maxTokens: number; maxInstances: number; }
export type RunStatus = "draft" | "preparing" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "waiting" | "completed" | "failed" | "unknown";
export type InstanceStatus = "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export interface StructuredAttempt {
  id: string; status: InstanceStatus; startedAt: string; endedAt?: string; output?: JsonValue; error?: string;
  resultEventSequence?: number;
  activities: Activity[]; logs: Array<{ at: string; message: string }>; threadId?: string; turnId?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; executionSettings?: EffectiveExecutionSettings;
}
export interface NodeInstance {
  id: string; nodeId: string; type: DefinitionNode["type"] | "scope"; label: string; path: string; parentId?: string;
  status: InstanceStatus; attempts: StructuredAttempt[]; output?: JsonValue; error?: string;
  startedAt?: string; endedAt?: string; iteration?: number; itemKey?: string; branchId?: string;
  cursor?: Record<string, JsonValue>; environment?: ExpressionEnvironment;
}
export interface StructuredEvent {
  sequence: number; at: string; type: string; instanceId?: string; nodeId?: string; parentId?: string;
  edgeId?: string; fromInstanceId?: string; toInstanceId?: string; data?: JsonValue;
}
export interface StructuredCheckpoint { id: string; sequence: number; at: string; fingerprint: string; definitionHash: string; }
export interface StructuredRun {
  format: "structured-v1"; id: string; revision: number; createdAt: string; updatedAt: string;
  definition: WorkflowDefinition; definitionHash: string; compiled: CompiledDefinition;
  args: JsonValue; projectPath: string; grants: RunGrants; limits: RunLimits; status: RunStatus;
  instances: NodeInstance[]; events: StructuredEvent[]; checkpoint?: StructuredCheckpoint;
  workspace?: Workspace; workspaceFingerprint?: string; executionSettings?: EffectiveExecutionSettings;
  sourceDefinition?: { id: string; revision: number }; startedAt?: string; endedAt?: string; error?: string; result?: JsonValue;
  review?: "unavailable" | "ready" | "failed"; application?: "none" | "applied" | "conflict"; diff?: Diff;
  preparation?: Array<{ id: string; label: string; status: "running" | "completed" | "failed" }>;
  ownerToken?: string; recoveryEpoch?: number;
}
export interface StructuredDefinitionRecord {
  id: string; revision: number; definition: WorkflowDefinition; hash: string; createdAt: string; updatedAt: string;
  args?: JsonValue; grants?: Partial<RunGrants>; limits?: Partial<RunLimits>;
}
export interface ActivityRequest { run: StructuredRun; node: DefinitionNode; instance: NodeInstance; env: ExpressionEnvironment; }
export interface ActivityDriver {
  prepare?(run: StructuredRun, signal: AbortSignal, onProgress?: () => void): Promise<void>;
  execute(request: ActivityRequest, signal: AbortSignal, onEvent: (event: import("./adapter.ts").WorkerEvent) => void): Promise<JsonValue>;
  captureCheckpoint?(run: StructuredRun): Promise<string>;
  validateCheckpoint?(run: StructuredRun, fingerprint: string): Promise<void>;
  finish?(run: StructuredRun): Promise<void>;
  close?(): Promise<void>;
}
export interface StructuredPreview {
  definition: WorkflowDefinition; args?: JsonValue; projectPath: string;
  grants?: Partial<RunGrants>; limits?: Partial<RunLimits>; sourceDefinition?: { id: string; revision: number };
}
