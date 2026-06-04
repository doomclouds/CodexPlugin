import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";

export async function watchCommand(runId: string): Promise<void> {
  const store = new RunStore(process.cwd());
  const outputDir = await store.getRunDir(runId);
  const raw = await readFile(join(outputDir, "events.jsonl"), "utf8").catch(() => "");
  console.log(raw.trim());
}
