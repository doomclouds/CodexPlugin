import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";

export async function cancelCommand(runId: string): Promise<void> {
  const store = new RunStore(process.cwd());
  const outputDir = await store.getRunDir(runId);
  await writeFile(join(outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
  console.log(`Cancel requested for ${runId}.`);
}
