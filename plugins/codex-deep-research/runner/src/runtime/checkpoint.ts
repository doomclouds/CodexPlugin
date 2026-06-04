import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStore } from "./run-store.js";

export async function writeCheckpoint(store: RunStore, runId: string, name: string, state: unknown): Promise<string> {
  const outputDir = await store.getRunDir(runId);
  const dir = join(outputDir, "checkpoints");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
  return path;
}
