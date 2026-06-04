import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../src/runtime/run-store.js";
import type { RunStatus } from "../src/runtime/types.js";

async function createTempStore(): Promise<{ root: string; store: RunStore }> {
  const root = await mkdtemp(join(tmpdir(), "cdr-store-"));
  return { root, store: new RunStore(root) };
}

async function createRun(store: RunStore, root: string) {
  return store.createRun({
    question: "What is Codex Deep Research?",
    workspace: root,
    mode: "mixed",
    depth: "standard",
    maxConcurrency: 8,
    maxTasks: 120,
    debugPrompts: false,
  });
}

describe("RunStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a run directory with manifest, status, and events", async () => {
    const { root, store } = await createTempStore();

    const manifest = await createRun(store, root);

    expect(manifest.runId.startsWith("dr_")).toBe(true);
    const status = await store.readStatus(manifest.runId);
    expect(status.phase).toBe("created");
    expect(status.progress.queued).toBe(0);

    await store.emit(manifest.runId, { type: "phase.started", message: "Planning" });
    const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain("phase.started");

    await rm(root, { recursive: true, force: true });
  });

  it("refreshes updatedAt and preserves status fields when writing status", async () => {
    const { root, store } = await createTempStore();
    const manifest = await createRun(store, root);
    const status = await store.readStatus(manifest.runId);
    const updatedStatus: RunStatus = {
      ...status,
      phase: "planning",
      progress: { ...status.progress, queued: 3, running: 1 },
      lastEvents: ["Planning started"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    vi.setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    await store.writeStatus(updatedStatus);

    const written = await store.readStatus(manifest.runId);
    expect(written).toEqual({
      ...updatedStatus,
      updatedAt: "2026-01-02T03:04:05.678Z",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("creates distinct run directories when generated run ids collide", async () => {
    const { root, store } = await createTempStore();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.678Z"));

    const first = await createRun(store, root);
    const second = await createRun(store, root);

    expect(first.runId).toBe("dr_20260102T030405678Z");
    expect(second.runId).toBe("dr_20260102T030405678Z_01");
    expect(second.outputDir).not.toBe(first.outputDir);
    const secondStatus = await store.readStatus(second.runId);
    expect(secondStatus.runId).toBe(second.runId);

    await rm(root, { recursive: true, force: true });
  });

  it("appends a fallback event when the manifest is missing", async () => {
    const { root, store } = await createTempStore();
    const runId = "dr_20260102T030405678Z";

    await store.emit(runId, { type: "phase.started", message: "Planning" });

    const eventsRaw = await readFile(join(root, ".codex-deep-research", "runs", runId, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain("\"runId\":\"dr_20260102T030405678Z\"");

    await rm(root, { recursive: true, force: true });
  });

  it("rejects emit when the manifest is corrupted", async () => {
    const { root, store } = await createTempStore();
    const runId = "dr_20260102T030405678Z";
    const runDir = join(root, ".codex-deep-research", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), "{not-json", "utf8");

    await expect(store.emit(runId, { type: "phase.started", message: "Planning" })).rejects.toThrow(SyntaxError);

    await rm(root, { recursive: true, force: true });
  });

  it("rejects run ids that would escape the runs directory", async () => {
    const { root, store } = await createTempStore();

    await expect(store.emit("../outside", { type: "phase.started", message: "Planning" })).rejects.toThrow(
      /Invalid run id/,
    );

    await rm(root, { recursive: true, force: true });
  });
});
