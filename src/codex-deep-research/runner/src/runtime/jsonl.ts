import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("JSONL record is not serializable");
  }

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serialized + "\n", "utf8");
}

export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
