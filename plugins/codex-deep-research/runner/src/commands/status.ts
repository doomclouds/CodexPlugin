import { RunStore } from "../runtime/run-store.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export async function statusCommand(runId: string): Promise<void> {
  const status = await new RunStore(resolveWorkspaceRoot()).readStatus(runId);
  console.log(JSON.stringify(status, null, 2));
}
