import { readFile } from "node:fs/promises";

const template = {
  id: "review-changes",
  name: "审查改动并核实发现",
  description: "每个文件独立审查，流水线核实发现，最后汇总。",
  status: "example-only",
  scriptFormat: "claude-style-javascript-draft",
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
    stage: "scaffold",
    available: ["list-templates", "read-template", "inspect-capabilities"],
    execution: { available: false, adapter: null },
    ui: { available: false, hostIntegration: "not-verified" },
    pendingDesign: ["execution-backend", "context-and-permissions", "cancellation-and-resume", "workflow-ui"],
  };
}
