import { RunStore } from "../runtime/run-store.js";

export async function statusCommand(runId: string): Promise<void> {
  const status = await new RunStore(process.cwd()).readStatus(runId);
  console.log(JSON.stringify(status, null, 2));
}
