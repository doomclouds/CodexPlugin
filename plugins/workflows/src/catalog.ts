import { readFile } from "node:fs/promises";

const template = {
  id: "review-changes",
  name: "审查改动并核实发现",
  description: "每个文件独立审查，流水线核实发现，最后汇总。",
  status: "executable",
  scriptFormat: "workflow-javascript-v1",
  source: "builtin",
  input: { files: "要审查的文件路径数组" },
} as const;

export function listTemplates() {
  return [template];
}

export async function getTemplate(id: string) {
  if (id !== template.id) return undefined;
  const script = await readFile(new URL("../workflows/review-changes.workflow.js", import.meta.url), "utf8");
  return { ...template, script };
}

export function getCapabilities() {
  return {
    version: "0.2.0",
    stage: "runtime-v1",
    available: ["list-templates", "read-template", "save-template", "cross-project-reuse", "preview", "dynamic-execution", "stop", "task-cancellation", "persistence", "replay-resume", "isolated-writing", "review", "conflict-checked-apply", "task-panel"],
    execution: { available: true, adapter: "codex-app-server", requirements: ["Node.js >=22", "Codex CLI with app-server and an existing login"], maxConcurrentWriters: 1, startRequiresPanelAction: true },
    ui: { available: true, stage: "live", hostIntegration: "requires-version-specific-verification", exampleDataOnly: false },
    recovery: { automatic: false, mode: "launch-order-replay", stoppedAgentsRestart: true },
    pendingDesign: ["multiple-concurrent-writing-workers"],
  };
}
