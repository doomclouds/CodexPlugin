import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("creates parent directories before appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdr-jsonl-"));
    const file = join(dir, "nested", "events.jsonl");

    await appendJsonl(file, { type: "created" });

    await expect(readJsonl(file)).resolves.toEqual([{ type: "created" }]);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when the JSONL file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdr-jsonl-"));
    const file = join(dir, "missing.jsonl");

    await expect(readJsonl(file)).resolves.toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores blank lines while reading JSONL records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdr-jsonl-"));
    const file = join(dir, "events.jsonl");

    await appendJsonl(file, { type: "one" });
    await appendJsonl(file, { type: "two" });
    await appendFile(file, "\n  \n", "utf8");

    await expect(readJsonl(file)).resolves.toEqual([{ type: "one" }, { type: "two" }]);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects values that cannot be serialized as JSON records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdr-jsonl-"));
    const file = join(dir, "events.jsonl");

    await expect(appendJsonl(file, undefined)).rejects.toThrow("JSONL record is not serializable");
    await rm(dir, { recursive: true, force: true });
  });
});
