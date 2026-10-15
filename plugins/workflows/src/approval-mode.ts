import type { ApprovalMode } from "./types.ts";

export function resolveApprovalMode(value: unknown, fallback: ApprovalMode = "never"): ApprovalMode {
  if (value === undefined) return fallback;
  if (value !== "auto-review" && value !== "never") throw new Error("Unsupported workflow approval mode; choose auto-review or never");
  return value;
}
