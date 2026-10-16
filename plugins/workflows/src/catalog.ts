export function getCapabilities() {
  return {
    version: "0.10.0", format: "structured-v1", schemaVersion: 1,
    definition: { singleSource: true, legacyScripts: false, migration: false, nodeTypes: ["agent", "command", "transform", "wait", "subflow", "expand", "choice", "parallel", "map", "repeat", "try"], expressions: "pure-json", evaluation: "no-eval", immutableRunDefinition: true, exactSubflowRevisions: true },
    execution: { adapter: "codex-app-server", nativeTools: true, explicitMcpGrants: true, defaultNetworkAccess: false, defaultAllowWrite: false, workspaceModes: ["snapshot", "git-worktree", "local"], localChangesImmediatelyEffective: true, maxConcurrentProjectWriters: 1, defaultActivityAttempts: 1, toolErrorRecovery: "native-agent-context", approvalModes: ["never", "auto-review"], approvalDenialBypass: false },
    persistence: { engine: "sqlite", namespace: "structured-v1", transactions: true, dispatchIntentBeforeWorker: true, recovery: "durable-instance-cursors", currentFilesPreserved: true, automaticFileRollback: false, unknownWriteEffects: "requires-observed-evidence", exactlyOnce: false },
    control: { pause: "settle-active-activities", stop: "interrupt-and-await-exit", retry: "explicit-instance-and-dependent-invalidation", loopInstances: true, parallelPolicy: ["fail-fast", "all-settled"], boundedLoops: true },
    projection: { authority: "backend-compiled-plan-and-instance-events", scopedInstances: true, branchEvidence: true, dynamicExpansion: "committed-before-execution", logs: "bounded-per-instance-and-attempt" },
    library: { immutableRevisions: true, crossProjectReuse: "new-run-in-target-project", defaultTemplates: false, deletion: "definitions-all-revisions-and-associated-runs-or-one-run", originalProjectDeleted: false },
    ui: { transport: "mcp-app", entrypoints: ["thread"], project: "fixed-caller-project", scriptEditor: false, theme: "host" },
    runtimeLifecycle: { transport: "stdio", scope: "host-connection", globalSingleton: false, parentExitCleanup: true, processId: process.pid, parentProcessId: process.ppid },
  };
}
