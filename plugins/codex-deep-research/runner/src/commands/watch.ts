import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export async function watchCommand(runId: string): Promise<void> {
  const store = new RunStore(resolveWorkspaceRoot());
  const outputDir = await store.getRunDir(runId);
  const raw = await readFile(join(outputDir, "events.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  console.log(raw.trim());
}
