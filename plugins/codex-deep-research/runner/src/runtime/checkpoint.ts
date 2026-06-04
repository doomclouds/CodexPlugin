import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeCheckpoint(outputDir: string, name: string, state: unknown): Promise<string> {
  const dir = join(outputDir, "checkpoints");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
  return path;
}
