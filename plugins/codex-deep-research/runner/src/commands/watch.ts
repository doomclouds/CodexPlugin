import { setTimeout } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";
import type { RunState } from "../runtime/types.js";
import { resolveWorkspaceRoot } from "./workspace.js";

const TERMINAL_STATES = new Set<RunState>(["completed", "partial", "failed", "cancelled"]);

export interface WatchOptions {
  follow?: boolean;
  pollIntervalMs?: number;
}

async function readEvents(path: string): Promise<Buffer> {
  return await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw error;
  });
}

function printNewLines(buffer: Buffer, offset: number): { nextOffset: number; printed: boolean } {
  if (buffer.length <= offset) {
    return { nextOffset: offset, printed: false };
  }

  const chunk = buffer.subarray(offset).toString("utf8").trimEnd();
  if (chunk.length === 0) {
    return { nextOffset: buffer.length, printed: false };
  }

  for (const line of chunk.split(/\r?\n/)) {
    console.log(line);
  }
  return { nextOffset: buffer.length, printed: true };
}

export async function watchCommand(runId: string, options: WatchOptions = {}): Promise<void> {
  const follow = options.follow ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const store = new RunStore(resolveWorkspaceRoot());
  const outputDir = await store.getRunDir(runId);
  const eventsPath = join(outputDir, "events.jsonl");
  let offset = 0;
  let printed = false;

  while (true) {
    const events = await readEvents(eventsPath);
    const result = printNewLines(events, offset);
    offset = result.nextOffset;
    printed = printed || result.printed;

    const status = await store.readStatus(runId);
    if (!follow || TERMINAL_STATES.has(status.state)) {
      break;
    }

    await setTimeout(pollIntervalMs);
  }

  if (!printed) {
    console.log("");
  }
}
