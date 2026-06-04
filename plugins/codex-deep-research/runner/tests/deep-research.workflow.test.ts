import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../src/runtime/run-store.js";
import { runDeepResearch } from "../src/workflow/deep-research.workflow.js";
import { FakeWorkerClient } from "../src/workers/fake-worker.js";

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
    expect(status.output?.reportPath).toContain("report.md");

    await rm(root, { recursive: true, force: true });
  });
});
