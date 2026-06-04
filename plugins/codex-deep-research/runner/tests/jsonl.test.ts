import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendJsonl, readJsonl } from "../src/runtime/jsonl.js";

describe("jsonl", () => {
  it("appends and reads JSONL records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdr-jsonl-"));
    const file = join(dir, "events.jsonl");
    await appendJsonl(file, { type: "one", value: 1 });
    await appendJsonl(file, { type: "two", value: 2 });

    await expect(readJsonl(file)).resolves.toEqual([
      { type: "one", value: 1 },
      { type: "two", value: 2 },
    ]);

    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
