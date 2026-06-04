import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../src/runtime/run-store.js";

describe("RunStore", () => {
  it("creates a run directory with manifest, status, and events", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-store-"));
    const store = new RunStore(root);

    const manifest = await store.createRun({
      question: "What is Codex Deep Research?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });

    expect(manifest.runId.startsWith("dr_")).toBe(true);
    const status = await store.readStatus(manifest.runId);
    expect(status.phase).toBe("created");
    expect(status.progress.queued).toBe(0);

    await store.emit(manifest.runId, { type: "phase.started", message: "Planning" });
    const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain("phase.started");

    await rm(root, { recursive: true, force: true });
  });
});
