import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export async function reportCommand(runId: string): Promise<void> {
  const store = new RunStore(resolveWorkspaceRoot());
  const status = await store.readStatus(runId);
  if (!status.output) {
    console.log(`No report is available for ${runId}.`);
    return;
  }

  const runDir = await store.getRunDir(runId);
  const reportPath = join(runDir, "report.md");
  const summaryPath = join(runDir, "report.summary.md");
  const summary = await readFile(summaryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (summary === undefined) {
    console.log(`No report is available for ${runId}.`);
    return;
  }

  console.log(`Report: ${reportPath}\n\n${summary}`);
}
