import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRunId } from "../runtime/run-store.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export async function listCommand(): Promise<void> {
  const runsDir = join(resolveWorkspaceRoot(), ".codex-deep-research", "runs");
  try {
    const names = await readdir(runsDir);
    console.log(names.filter(isRunId).sort().join("\n"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("");
      return;
    }
    throw error;
  }
}
