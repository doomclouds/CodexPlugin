import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunStore } from "../src/runtime/run-store.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { RunStatus } from "../src/runtime/types.js";
import { runDeepResearch } from "../src/workflow/deep-research.workflow.js";
import { agent, type WorkflowRuntime } from "../src/workflow/primitives.js";
import { FakeWorkerClient } from "../src/workers/fake-worker.js";
import type { WorkerClient } from "../src/workers/worker-client.js";

function createStatus(runId: string): RunStatus {
  return {
    runId,
    question: "Should Codex use workflow state?",
    phase: "created",
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    progress: { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    research: {
      angles: 0,
      sourcesCollected: 0,
      sourcesFetched: 0,
      claimsExtracted: 0,
      claimsVerified: 0,
      confirmed: 0,
      weakened: 0,
      refuted: 0,
      unverified: 0,
    },
    currentTasks: [],
    lastEvents: [],
  };
}

function createRuntime(overrides: {
  emit?: RunStore["emit"];
  worker?: WorkerClient;
}): WorkflowRuntime {
  const runId = "dr_20260101T000000000Z";
  const status = createStatus(runId);
  return {
    runId,
    status,
    store: {
      writeStatus: async () => undefined,
      emit: overrides.emit ?? (async () => undefined),
    } as unknown as RunStore,
    worker:
      overrides.worker ??
      ({
        run: async () => ({ ok: true }),
      } satisfies WorkerClient),
  };
}

describe("runDeepResearch", () => {
  it("runs a minimal fake workflow and writes a report", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should Codex use workflow state?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });

    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Use official and skeptical angles.",
        angles: [
          { label: "official", query: "official docs", rationale: "Primary source" },
          { label: "skeptical", query: "limitations", rationale: "Counter evidence" },
          { label: "examples", query: "examples", rationale: "Implementation" },
        ],
      },
    ]);

    await runDeepResearch({ manifest, store, worker });
    const status = await store.readStatus(manifest.runId);
    expect(status.phase).toBe("completed");
    expect(status.state).toBe("completed");
    expect(status.progress).toEqual({ queued: 0, running: 0, completed: 1, failed: 0, skipped: 0 });
    expect(status.research.angles).toBe(3);
    expect(status.output?.reportPath).toContain("report.md");
    expect(status.output?.sourcesPath).toContain("report.sources.md");
    await expect(readFile(join(manifest.outputDir, "checkpoints", "001-scope.json"), "utf8")).resolves.toContain(
      "official docs",
    );
    await expect(readFile(join(manifest.outputDir, "report.md"), "utf8")).resolves.toContain(
      "skeptical: limitations",
    );
    await expect(readFile(join(manifest.outputDir, "report.sources.md"), "utf8")).resolves.toContain(
      "No sources were collected",
    );

    await rm(root, { recursive: true, force: true });
  });

  it("keeps a completed run successful when post-completion event emit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should completed runs tolerate final event failures?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Final event failure should not change success.",
        angles: [
          { label: "state", query: "completed state", rationale: "Success" },
          { label: "events", query: "event failure", rationale: "Hardening" },
          { label: "report", query: "report written", rationale: "Output" },
        ],
      },
    ]);
    const originalEmit = store.emit.bind(store);
    store.emit = async (runId, event) => {
      if (event.type === "report.written") {
        throw new Error("report emit failed");
      }
      await originalEmit(runId, event);
    };

    try {
      await expect(runDeepResearch({ manifest, store, worker })).resolves.toBeUndefined();
      const status = await store.readStatus(manifest.runId);
      expect(status.phase).toBe("completed");
      expect(status.state).toBe("completed");
      expect(status.progress).toEqual({ queued: 0, running: 0, completed: 1, failed: 0, skipped: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes checkpoints and reports to the run directory when manifest outputDir is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should Codex trust manifest outputDir?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    const outsideDir = join(root, "outside-run-dir");
    await mkdir(outsideDir, { recursive: true });
    const tamperedManifest = { ...manifest, outputDir: outsideDir };
    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Use safe paths.",
        angles: [
          { label: "store", query: "run store", rationale: "Boundary" },
          { label: "checkpoint", query: "checkpoint path", rationale: "Regression" },
          { label: "report", query: "report path", rationale: "Regression" },
        ],
      },
    ]);

    await runDeepResearch({ manifest: tamperedManifest, store, worker });

    const status = await store.readStatus(manifest.runId);
    expect(status.output?.reportPath).toBe(join(manifest.outputDir, "report.md"));
    expect(status.output?.sourcesPath).toBe(join(manifest.outputDir, "report.sources.md"));
    await expect(readFile(join(manifest.outputDir, "checkpoints", "001-scope.json"), "utf8")).resolves.toContain(
      "run store",
    );
    await expect(readFile(join(manifest.outputDir, "report.md"), "utf8")).resolves.toContain("report: report path");
    await expect(readFile(join(manifest.outputDir, "report.sources.md"), "utf8")).resolves.toContain(
      "No sources were collected",
    );
    await expect(readFile(join(outsideDir, "checkpoints", "001-scope.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(outsideDir, "report.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outsideDir, "report.sources.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(root, { recursive: true, force: true });
  });

  it("stops at phase boundaries when a cancellation marker exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-cancel-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should cancellation prevent report synthesis?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    await writeFile(join(manifest.outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Should not be used.",
        angles: [
          { label: "cancel", query: "cancel requested", rationale: "Boundary" },
          { label: "status", query: "cancelled status", rationale: "Boundary" },
          { label: "report", query: "no report", rationale: "Boundary" },
        ],
      },
    ]);

    await expect(runDeepResearch({ manifest, store, worker })).resolves.toBeUndefined();

    const status = await store.readStatus(manifest.runId);
    expect(status.state).toBe("cancelled");
    expect(status.output).toBeUndefined();
    const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain("run.cancelled");
    await expect(readFile(join(manifest.outputDir, "report.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(root, { recursive: true, force: true });
  });

  it("does not overwrite cancellation requested after report files are written", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-late-cancel-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should late cancellation win over completion?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Late cancellation should remain terminal.",
        angles: [
          { label: "cancel", query: "late cancel", rationale: "Race" },
          { label: "report", query: "report write", rationale: "Boundary" },
          { label: "status", query: "terminal status", rationale: "Regression" },
        ],
      },
    ]);
    const originalIsCancellationRequested = store.isCancellationRequested.bind(store);
    store.isCancellationRequested = async (runId) => {
      const reportExists = await readFile(join(manifest.outputDir, "report.md"), "utf8")
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        });
      if (reportExists) {
        await writeFile(join(manifest.outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
      }
      return await originalIsCancellationRequested(runId);
    };

    try {
      await expect(runDeepResearch({ manifest, store, worker })).resolves.toBeUndefined();
      const status = await store.readStatus(manifest.runId);
      expect(status.state).toBe("cancelled");
      expect(status.output).toBeUndefined();
      const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
      expect(eventsRaw).toContain("run.cancelled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite cancellation marker written just before final completion status", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-final-cancel-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should final-boundary cancellation win over completion?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    const worker = new FakeWorkerClient([
      {
        question: manifest.question,
        summary: "Final cancellation should remain terminal.",
        angles: [
          { label: "cancel", query: "final cancel", rationale: "Race" },
          { label: "completion", query: "completion write", rationale: "Boundary" },
          { label: "status", query: "cancelled terminal", rationale: "Regression" },
        ],
      },
    ]);
    const originalWriteStatus = store.writeStatus.bind(store);
    let injected = false;
    store.writeStatus = async (status) => {
      if (!injected && status.state === "completed") {
        injected = true;
        await writeFile(join(manifest.outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
      }
      await originalWriteStatus(status);
    };

    try {
      await expect(runDeepResearch({ manifest, store, worker })).resolves.toBeUndefined();
      const status = await store.readStatus(manifest.runId);
      expect(status.state).toBe("cancelled");
      expect(status.phase).not.toBe("completed");
      expect(status.output).toBeUndefined();
      const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
      expect(eventsRaw).not.toContain('"phase":"completed"');
      expect(eventsRaw).not.toContain('"type":"report.written"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks the run failed when worker output does not match the workflow schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-flow-"));
    const store = new RunStore(root);
    const manifest = await store.createRun({
      question: "Should invalid worker output fail the run?",
      workspace: root,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 2,
      maxTasks: 20,
      debugPrompts: false,
    });
    const worker = new FakeWorkerClient([{ question: manifest.question, summary: "Too few angles.", angles: [] }]);

    await expect(runDeepResearch({ manifest, store, worker })).rejects.toThrow();

    const status = await store.readStatus(manifest.runId);
    expect(status.state).toBe("failed");
    expect(status.progress.running).toBe(0);
    expect(status.progress.completed).toBe(0);
    expect(status.progress.failed).toBe(1);
    const eventsRaw = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain("task.failed");
    expect(eventsRaw).toContain("run.failed");

    await rm(root, { recursive: true, force: true });
  });
});

describe("agent", () => {
  it("does not count a successful worker as failed when task.completed emit fails", async () => {
    const runtime = createRuntime({
      emit: async (_runId, event) => {
        if (event.type === "task.completed") {
          throw new Error("completed emit failed");
        }
      },
    });

    await expect(agent(runtime, { label: "scope", schemaName: "ScopeSchema", prompt: "prompt" })).rejects.toThrow(
      "completed emit failed",
    );

    expect(runtime.status.progress).toEqual({ queued: 0, running: 0, completed: 1, failed: 0, skipped: 0 });
  });

  it("preserves the worker error when task.failed emit fails", async () => {
    const runtime = createRuntime({
      worker: {
        run: async () => {
          throw new Error("worker failed");
        },
      },
      emit: async (_runId, event) => {
        if (event.type === "task.failed") {
          throw new Error("failed emit failed");
        }
      },
    });

    await expect(agent(runtime, { label: "scope", schemaName: "ScopeSchema", prompt: "prompt" })).rejects.toThrow(
      "worker failed",
    );

    expect(runtime.status.progress).toEqual({ queued: 0, running: 0, completed: 0, failed: 1, skipped: 0 });
  });

  it("decrements running when task.started emit fails before the worker runs", async () => {
    let workerCalls = 0;
    const runtime = createRuntime({
      worker: {
        run: async () => {
          workerCalls += 1;
          return { ok: true };
        },
      },
      emit: async (_runId, event) => {
        if (event.type === "task.started") {
          throw new Error("started emit failed");
        }
      },
    });

    await expect(agent(runtime, { label: "scope", schemaName: "ScopeSchema", prompt: "prompt" })).rejects.toThrow(
      "started emit failed",
    );

    expect(workerCalls).toBe(0);
    expect(runtime.status.progress).toEqual({ queued: 0, running: 0, completed: 0, failed: 0, skipped: 0 });
  });
});
