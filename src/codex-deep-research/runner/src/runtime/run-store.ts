import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.js";
import { createRunId } from "./ids.js";
import type { RunManifest, RunStatus, WorkflowEvent } from "./types.js";

const RUN_ID_PATTERN = /^dr_\d{8}T\d{9}Z(?:_\d{2})?$/;

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

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
    await this.readManifest(status.runId);
    const current = await this.readStatus(status.runId);
    if (status.state === "completed") {
      if (current.state === "cancelled") {
        return;
      }
      if (current.state !== "completed" && (await this.isCancellationRequested(status.runId))) {
        await this.writeStatusFile(this.asCancelledStatus(current));
        return;
      }
    }
    await this.writeStatusFile(status);
  }

  async writeCompletionStatus(status: RunStatus): Promise<boolean> {
    if (status.state !== "completed") {
      throw new Error(`Completion status must be completed, got ${status.state}`);
    }

    await this.readManifest(status.runId);
    const current = await this.readStatus(status.runId);
    if (
      current.state === "cancelled" ||
      (current.state !== "completed" && (await this.isCancellationRequested(status.runId)))
    ) {
      if (current.state !== "cancelled") {
        await this.writeStatus(this.asCancelledStatus(current));
      }
      return false;
    }

    await this.writeStatus(status);
    return (await this.readStatus(status.runId)).state === "completed";
  }

  async emit(runId: string, event: Omit<WorkflowEvent, "at" | "runId">): Promise<void> {
    this.validateRunId(runId);
    await this.readManifest(runId).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    await appendJsonl(join(this.resolveRunDir(runId), "events.jsonl"), {
      ...event,
      at: new Date().toISOString(),
      runId,
    });
  }

  async getRunDir(runId: string): Promise<string> {
    await this.readManifest(runId);
    return this.resolveRunDir(runId);
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    await this.readManifest(runId);
    return await access(join(this.resolveRunDir(runId), "cancel.requested"))
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
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
    return join(this.resolveRunDir(runId), fileName);
  }

  private async writeStatusFile(status: RunStatus): Promise<void> {
    const updated: RunStatus = { ...status, updatedAt: new Date().toISOString() };
    await writeFile(join(this.resolveRunDir(status.runId), "status.json"), JSON.stringify(updated, null, 2), "utf8");
  }

  private asCancelledStatus(status: RunStatus): RunStatus {
    return {
      ...status,
      state: "cancelled",
      progress: { ...status.progress, running: 0 },
      lastEvents: [...status.lastEvents.slice(-9), "Run cancelled"],
    };
  }

  private resolveRunDir(runId: string): string {
    this.validateRunId(runId);
    return join(this.runsDir(), runId);
  }

  private validateRunId(runId: string): void {
    if (!isRunId(runId)) {
      throw new Error(`Invalid run id: ${runId}`);
    }
  }

  private runsDir(): string {
    return join(this.rootDir, ".codex-deep-research", "runs");
  }
}
