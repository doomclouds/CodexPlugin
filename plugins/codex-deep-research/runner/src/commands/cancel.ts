import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";
import type { RunState } from "../runtime/types.js";
import { resolveWorkspaceRoot } from "./workspace.js";

const TERMINAL_STATES = new Set<RunState>(["completed", "partial", "failed", "cancelled"]);

export async function cancelCommand(runId: string): Promise<void> {
  const store = new RunStore(resolveWorkspaceRoot());
  const outputDir = await store.getRunDir(runId);
  await writeFile(join(outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
  await store.emit(runId, { type: "run.cancel_requested", message: "Cancellation requested" });

  const status = await store.readStatus(runId);
  const nextState = TERMINAL_STATES.has(status.state) ? status.state : "cancelled";
  await store.writeStatus({
    ...status,
    state: nextState,
    lastEvents: [...status.lastEvents.slice(-9), "Cancellation requested"],
  });

  console.log(`Cancel requested for ${runId}.`);
}
