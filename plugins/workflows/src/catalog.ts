import { readFileSync } from "node:fs";
import { validateScript } from "./script.ts";

const reviewScript = readFileSync(new URL("../workflows/review-changes.workflow.js", import.meta.url), "utf8");
const reviewMeta = validateScript(reviewScript).meta;

const template = {
  id: "review-changes",
  name: "审查改动并核实发现",
  description: "每个文件独立审查，流水线核实发现，最后汇总。",
  status: "executable",
  scriptFormat: "workflow-javascript-v1",
  source: "builtin",
  meta: reviewMeta,
} as const;

export function listTemplates() {
  return [template];
}

export async function getTemplate(id: string) {
  if (id !== template.id) return undefined;
  return { ...template, script: reviewScript };
}

export function getCapabilities() {
  return {
    version: "0.6.5",
    stage: "runtime-v2",
    available: ["host-thread-directory-binding", "bounded-run-transport", "artifact-pagination", "paged-run-summaries", "bounded-diff-preview", "declared-protected-command-paths", "explicit-task-retry", "snapshot-checkpoint", "git-context-cache", "preparation-progress", "node-activity", "node-process", "bounded-mcp-error-diagnostics", "complete-run-deletion", "complete-definition-deletion", "immutable-project-binding", "host-runtime-launcher", "list-templates", "read-template", "save-template", "cross-project-reuse", "codex-local-projects", "caller-thread-project-context", "preview", "execution-settings", "node-model-settings", "model-catalogue", "dynamic-execution", "stop", "task-cancellation", "persistence", "replay-resume", "isolated-writing", "local-project-writing", "local-project-git-writing", "project-writer-serialization", "review", "conflict-checked-apply", "task-panel", "agent-driven-execution", "explicit-network-scope", "configured-mcp-allowlist", "configured-mcp-tool-grants", "git-worktree", "declared-maintenance", "activation-review", "git-submodules", "absolute-toolchain-arguments", "isolated-command-cache"],
    execution: { available: true, adapter: "codex-app-server", requirements: ["Node.js >=22", "Codex CLI with app-server and an existing login"], maxConcurrentWriters: 1, startRequiresPanelAction: false, userAuthorizationRequired: true, defaultNetworkAccess: false, defaultAllowedMcpServers: [], defaultAllowedMcpTools: {}, mcpReadOnlyRequiresHint: true, mcpToolApprovalsPreserved: true, interactiveToolApprovalsAvailable: false, parentChatAppsInherited: false, nativeTools: ["file-reading", "command-execution", "patch-writing"], nativeToolScope: "official-app-server-and-declared-sandbox", networkShellRequiresGrant: true, readOnlyNetworkSupported: true, networkAccessIndependentFromWrite: true, maintenanceRequiresWriteWorktree: true, proprietaryDesktopToolsInherited: false, defaultWorkspaceMode: "snapshot", workspaceModes: ["snapshot", "git-worktree", "local"], localMode: { requiresAllowWrite: true, writesOriginalProject: true, requiresApply: false, automaticRollback: false, deletionOwnsProject: false, maintenanceSupported: false, projectGitMetadataWrite: true, gitMetadataScope: "canonical-project-contained-only", legacyRunsKeepRecordedWriteScope: true, protectedInstructionDirectoriesAutoGranted: false, maxConcurrentProjectWriters: 1, coordinationScope: "shared-workflows-data-directory", externalEditorsSerialized: false }, submodules: { initialized: "independent-local-copy", uninitialized: "preserve-explicit-state", automaticNetworkInitialization: false } },
    ui: { available: true, stage: "live", hostIntegration: "requires-version-specific-verification", exampleDataOnly: false, entrypoints: ["thread"], projectChatRequired: true, projectSelection: "fixed-current-chat-project", unassignedContext: "project-guidance-with-actions-disabled", programmaticProjectPath: "explicit-user-authorized-target" },
    recovery: { automatic: false, mode: "launch-order-replay", stoppedAgentsRestart: true },
    pendingDesign: ["multiple-concurrent-writing-workers"],
  };
}
