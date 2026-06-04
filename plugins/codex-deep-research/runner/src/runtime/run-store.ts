import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.js";
import { createRunId } from "./ids.js";
import type { RunManifest, RunStatus, WorkflowEvent } from "./types.js";

const RUN_ID_PATTERN = /^dr_\d{8}T\d{9}Z(?:_\d{2})?$/;

export interface CreateRunInput {
  question: string;
  workspace: string;
  mode: RunManifest["mode"];
  depth: RunManifest["depth"];
  maxConcurrency: number;
  maxTasks: number;
  debugPrompts: boolean;
}

export class RunStore {
  constructor(private readonly rootDir: string) {}

  async createRun(input: CreateRunInput): Promise<RunManifest> {
    const { runId, outputDir } = await this.createRunDirectory();

    const now = new Date().toISOString();
    const manifest: RunManifest = {
      runId,
      question: input.question,
      workspace: input.workspace,
      outputDir,
      mode: input.mode,
      depth: input.depth,
      maxConcurrency: input.maxConcurrency,
      maxTasks: input.maxTasks,
      debugPrompts: input.debugPrompts,
      createdAt: now,
    };

    const status: RunStatus = {
      runId,
      question: input.question,
      phase: "created",
      state: "running",
      startedAt: now,
      updatedAt: now,
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

    await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(join(outputDir, "status.json"), JSON.stringify(status, null, 2), "utf8");
    await this.emit(runId, { type: "run.created", message: "Run created" });
    return manifest;
  }

  async readManifest(runId: string): Promise<RunManifest> {
    const path = await this.resolveRunFile(runId, "manifest.json");
    return JSON.parse(await readFile(path, "utf8")) as RunManifest;
  }

  async readStatus(runId: string): Promise<RunStatus> {
    const path = await this.resolveRunFile(runId, "status.json");
    return JSON.parse(await readFile(path, "utf8")) as RunStatus;
  }

  async writeStatus(status: RunStatus): Promise<void> {
    const manifest = await this.readManifest(status.runId);
    const updated: RunStatus = { ...status, updatedAt: new Date().toISOString() };
    await writeFile(join(manifest.outputDir, "status.json"), JSON.stringify(updated, null, 2), "utf8");
  }

  async emit(runId: string, event: Omit<WorkflowEvent, "at" | "runId">): Promise<void> {
    this.validateRunId(runId);
    const manifest = await this.readManifest(runId).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    const outputDir = manifest?.outputDir ?? join(this.runsDir(), runId);
    await appendJsonl(join(outputDir, "events.jsonl"), {
      ...event,
      at: new Date().toISOString(),
      runId,
    });
  }

  private async createRunDirectory(): Promise<{ runId: string; outputDir: string }> {
    const baseRunId = createRunId();
    await mkdir(this.runsDir(), { recursive: true });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runId = attempt === 0 ? baseRunId : `${baseRunId}_${String(attempt).padStart(2, "0")}`;
      const outputDir = join(this.runsDir(), runId);

      try {
        await mkdir(outputDir);
        return { runId, outputDir };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Unable to create a unique run directory for ${baseRunId}`);
  }

  private async resolveRunFile(runId: string, fileName: string): Promise<string> {
    this.validateRunId(runId);
    return join(this.runsDir(), runId, fileName);
  }

  private validateRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`Invalid run id: ${runId}`);
    }
  }

  private runsDir(): string {
    return join(this.rootDir, ".codex-deep-research", "runs");
  }
}
