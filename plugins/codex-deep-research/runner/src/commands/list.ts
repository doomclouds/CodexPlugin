import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function listCommand(): Promise<void> {
  const runsDir = join(process.cwd(), ".codex-deep-research", "runs");
  try {
    const names = await readdir(runsDir);
    console.log(names.filter((name) => name.startsWith("dr_")).join("\n"));
  } catch {
    console.log("");
  }
}
