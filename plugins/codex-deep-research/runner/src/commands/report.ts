import { readFile } from "node:fs/promises";
import { RunStore } from "../runtime/run-store.js";

export async function reportCommand(runId: string): Promise<void> {
  const status = await new RunStore(process.cwd()).readStatus(runId);
  if (!status.output?.summaryPath || !status.output.reportPath) {
    console.log(`No report is available for ${runId}.`);
    return;
  }

  const summary = await readFile(status.output.summaryPath, "utf8");
  console.log(`Report: ${status.output.reportPath}\n\n${summary}`);
}
