import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "../runtime/types.js";
import type { RunStore } from "../runtime/run-store.js";
import type { WorkerClient } from "../workers/worker-client.js";
import { ScopeSchema } from "./schemas.js";
import { agent, phase, type WorkflowRuntime } from "./primitives.js";
import { writeCheckpoint } from "../runtime/checkpoint.js";

export interface DeepResearchRunInput {
  manifest: RunManifest;
  store: RunStore;
  worker: WorkerClient;
}

export async function runDeepResearch(input: DeepResearchRunInput): Promise<void> {
  const status = await input.store.readStatus(input.manifest.runId);
  const outputDir = await input.store.getRunDir(input.manifest.runId);
  const runtime: WorkflowRuntime = {
    store: input.store,
    runId: input.manifest.runId,
    status,
    worker: input.worker,
  };

  try {
    await phase(runtime, "planning");
    const scope = await agent(
      runtime,
      {
        label: "scope",
        schemaName: "ScopeSchema",
        prompt:
          `Decompose this research question into 3-6 complementary search angles.\n\n` +
          `Question: ${input.manifest.question}\n\nReturn structured JSON only.`,
      },
      { parse: ScopeSchema.parse },
    );

    runtime.status.research.angles = scope.angles.length;
    await input.store.writeStatus(runtime.status);
    await writeCheckpoint(input.store, input.manifest.runId, "001-scope", scope);

    await phase(runtime, "synthesizing");
    const reportPath = join(outputDir, "report.md");
    const summaryPath = join(outputDir, "report.summary.md");
    await writeFile(
      reportPath,
      `# ${input.manifest.question}\n\n## 摘要\n\n${scope.summary}\n\n## Search Angles\n\n${scope.angles
        .map((angle) => `- ${angle.label}: ${angle.query}`)
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(summaryPath, scope.summary + "\n", "utf8");

    runtime.status.phase = "completed";
    runtime.status.state = "completed";
    runtime.status.output = { reportPath, summaryPath };
    await input.store.writeStatus(runtime.status);
    await input.store
      .emit(input.manifest.runId, { type: "phase.started", phase: "completed", message: "completed" })
      .catch(() => undefined);
    await input.store
      .emit(input.manifest.runId, { type: "report.written", message: reportPath })
      .catch(() => undefined);
  } catch (error) {
    runtime.status.state = "failed";
    await input.store.writeStatus(runtime.status).catch(() => undefined);
    await input.store
      .emit(input.manifest.runId, {
        type: "run.failed",
        message: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
