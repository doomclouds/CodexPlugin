# Codex Deep Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable `codex-deep-research` Codex plugin with an async TypeScript runner, observable run state, bounded worker concurrency, structured research artifacts, and Markdown reports.

**Architecture:** The plugin is an independent package under `plugins/codex-deep-research`. The Codex skill is a thin launcher; all research behavior lives in a TypeScript runner with small modules for state, CLI commands, workflow primitives, persona selection, worker execution, and reporting. v0 uses a deterministic fake worker in tests and a `codex exec --json` worker implementation for real execution.

**Tech Stack:** Node.js 18+, TypeScript, Vitest, Commander, Zod, Codex plugin manifest, PowerShell-compatible npm commands.

---

## Source Spec

Implement from:

`docs/superpowers/specs/2026-06-04-codex-deep-research-design.md`

Reference behavior from:

`.claude/workflows/deep-research.js`

## File Structure

Create:

- `plugins/codex-deep-research/.codex-plugin/plugin.json`：Codex plugin manifest。
- `plugins/codex-deep-research/README.md`：安装、命令、输出目录、隐私和调试说明。
- `plugins/codex-deep-research/package.json`：runner package、scripts、dependencies。
- `plugins/codex-deep-research/tsconfig.json`：TypeScript config。
- `plugins/codex-deep-research/vitest.config.ts`：test config。
- `plugins/codex-deep-research/skills/deep-research/SKILL.md`：Codex skill 入口。
- `plugins/codex-deep-research/runner/src/cli.ts`：CLI dispatcher。
- `plugins/codex-deep-research/runner/src/commands/start.ts`：创建 run 并启动 runner。
- `plugins/codex-deep-research/runner/src/commands/status.ts`：读取状态快照。
- `plugins/codex-deep-research/runner/src/commands/watch.ts`：tail 事件流。
- `plugins/codex-deep-research/runner/src/commands/report.ts`：定位并打印报告路径/摘要。
- `plugins/codex-deep-research/runner/src/commands/cancel.ts`：写 cancel marker。
- `plugins/codex-deep-research/runner/src/commands/list.ts`：列出 runs。
- `plugins/codex-deep-research/runner/src/commands/run.ts`：后台执行指定 run。
- `plugins/codex-deep-research/runner/src/runtime/types.ts`：核心类型。
- `plugins/codex-deep-research/runner/src/runtime/ids.ts`：run/task/source/claim id。
- `plugins/codex-deep-research/runner/src/runtime/jsonl.ts`：JSONL 读写。
- `plugins/codex-deep-research/runner/src/runtime/run-store.ts`：run directory、manifest、status、events、artifacts。
- `plugins/codex-deep-research/runner/src/runtime/context-selector.ts`：最小上下文投影。
- `plugins/codex-deep-research/runner/src/runtime/prompt-builder.ts`：PromptEnvelope 生成和脱敏记录。
- `plugins/codex-deep-research/runner/src/runtime/persona-registry.ts`：role/persona registry。
- `plugins/codex-deep-research/runner/src/runtime/scheduler.ts`：bounded concurrency。
- `plugins/codex-deep-research/runner/src/runtime/checkpoint.ts`：checkpoint 保存和恢复。
- `plugins/codex-deep-research/runner/src/workflow/schemas.ts`：Zod schemas。
- `plugins/codex-deep-research/runner/src/workflow/primitives.ts`：v0 exports `phase/agent/parallel`; later phases add `pipeline/checkpoint/emit` as needed.
- `plugins/codex-deep-research/runner/src/workflow/deep-research.workflow.ts`：v0 workflow。
- `plugins/codex-deep-research/runner/src/workers/worker-client.ts`：worker 接口。
- `plugins/codex-deep-research/runner/src/workers/codex-exec-worker.ts`：`codex exec --json` worker。
- `plugins/codex-deep-research/runner/src/workers/fake-worker.ts`：测试 worker。
- `plugins/codex-deep-research/runner/src/report/report-writer.ts`：Markdown 报告。
- `plugins/codex-deep-research/runner/src/report/report-verifier.ts`：引用和裁决一致性检查。
- `plugins/codex-deep-research/runner/tests/*.test.ts`：单元测试。

Modify:

- `.gitignore`：追加 `.codex-deep-research/`。

## Task 1: Scaffold Plugin Package

**Files:**

- Create: `plugins/codex-deep-research/.codex-plugin/plugin.json`
- Create: `plugins/codex-deep-research/package.json`
- Create: `plugins/codex-deep-research/tsconfig.json`
- Create: `plugins/codex-deep-research/vitest.config.ts`
- Create: `plugins/codex-deep-research/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Create package metadata**

Create `plugins/codex-deep-research/package.json`:

```json
{
  "name": "codex-deep-research",
  "version": "0.1.0",
  "description": "Codex plugin runner for async deep research workflows.",
  "type": "module",
  "private": true,
  "bin": {
    "codex-deep-research": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "tsx runner/src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "tsx": "^4.16.2",
    "typescript": "^5.5.3",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `plugins/codex-deep-research/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "runner/src",
    "types": ["node"]
  },
  "include": ["runner/src/**/*.ts"],
  "exclude": ["dist", "node_modules", "runner/tests"]
}
```

Create `plugins/codex-deep-research/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runner/tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Create plugin manifest**

Create `plugins/codex-deep-research/.codex-plugin/plugin.json`:

```json
{
  "name": "codex-deep-research",
  "version": "0.1.0",
  "description": "Async deep research workflow plugin for Codex.",
  "author": {
    "name": "doomclouds",
    "url": "https://github.com/doomclouds"
  },
  "homepage": "https://github.com/doomclouds/CodexPlugin/tree/main/plugins/codex-deep-research#readme",
  "repository": "https://github.com/doomclouds/CodexPlugin",
  "license": "MIT",
  "keywords": ["codex", "research", "workflow", "agents"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Codex Deep Research",
    "shortDescription": "Run async multi-agent research workflows from Codex.",
    "longDescription": "Launch v0 skeleton deep research runs that create a run directory and write Markdown report skeletons with source placeholders; cited reports, full search, extraction, verification, and structured state files are planned for later phases.",
    "developerName": "doomclouds",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Start a deep research run about this technical question.",
      "Show status for a deep research run.",
      "Open the report from the latest deep research run."
    ],
    "brandColor": "#3B82F6"
  }
}
```

- [ ] **Step 4: Create README**

Create `plugins/codex-deep-research/README.md`:

```md
# Codex Deep Research

`codex-deep-research` runs async, bounded-concurrency research workflows from Codex.

## Commands

```text
npm --prefix plugins\codex-deep-research run dev -- start "<question>"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
npm --prefix plugins\codex-deep-research run dev -- list
```

## Output

Runs are written to:

```text
.codex-deep-research/runs/<run_id>/
```

The main files are:

- `manifest.json`
- `status.json`
- `events.jsonl`
- `report.md`
- `report.summary.md`
- `report.sources.md`

## Privacy

Prompt envelopes are redacted by default. Use `--debug-prompts` only when you explicitly want full prompt capture for local debugging.
```

- [ ] **Step 5: Update gitignore**

Append to `.gitignore` if not already present:

```gitignore
.codex-deep-research/
```

- [ ] **Step 6: Install dependencies and verify scaffold**

Run:

```powershell
npm --prefix plugins\codex-deep-research install
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
added ... packages
```

`npm run typecheck` may fail until Task 2 creates source files. If it fails with `No inputs were found`, continue to Task 2.

- [ ] **Step 7: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add .gitignore plugins/codex-deep-research
git commit -m "feat: scaffold codex deep research plugin"
```

## Task 2: Core Types, Schemas, and JSONL Utilities

**Files:**

- Create: `plugins/codex-deep-research/runner/src/runtime/types.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/ids.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/jsonl.ts`
- Create: `plugins/codex-deep-research/runner/src/workflow/schemas.ts`
- Create: `plugins/codex-deep-research/runner/tests/jsonl.test.ts`
- Create: `plugins/codex-deep-research/runner/tests/schemas.test.ts`

- [ ] **Step 1: Write JSONL failing test**

Create `plugins/codex-deep-research/runner/tests/jsonl.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/jsonl.test.ts
```

Expected:

```text
FAIL runner/tests/jsonl.test.ts
Cannot find module '../src/runtime/jsonl.js'
```

- [ ] **Step 3: Implement JSONL utility**

Create `plugins/codex-deep-research/runner/src/runtime/jsonl.ts`:

```ts
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendFile } from "node:fs/promises";

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\n", "utf8");
}

export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
```

- [ ] **Step 4: Add core ids**

Create `plugins/codex-deep-research/runner/src/runtime/ids.ts`:

```ts
export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `dr_${stamp}`;
}

export function createSequentialId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}
```

- [ ] **Step 5: Add core types**

Create `plugins/codex-deep-research/runner/src/runtime/types.ts`:

```ts
export type PhaseName =
  | "created"
  | "planning"
  | "searching"
  | "collecting"
  | "extracting"
  | "cross_checking"
  | "voting"
  | "synthesizing"
  | "verifying"
  | "completed";

export type RunState = "running" | "completed" | "partial" | "failed" | "cancelled";
export type Role = "planner" | "searcher" | "collector" | "extractor" | "skeptic" | "voter" | "synthesizer" | "verifier";
export type SourceQuality = "primary" | "official" | "secondary" | "community" | "commercial" | "forum" | "unreliable";
export type ClaimDecisionValue = "confirmed" | "weakened" | "refuted" | "unverified";

export interface RunManifest {
  runId: string;
  question: string;
  workspace: string;
  outputDir: string;
  mode: "mixed" | "web" | "repo";
  depth: "quick" | "standard" | "deep";
  maxConcurrency: number;
  maxTasks: number;
  debugPrompts: boolean;
  createdAt: string;
}

export interface RunStatus {
  runId: string;
  question: string;
  phase: PhaseName;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  progress: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  research: {
    angles: number;
    sourcesCollected: number;
    sourcesFetched: number;
    claimsExtracted: number;
    claimsVerified: number;
    confirmed: number;
    weakened: number;
    refuted: number;
    unverified: number;
  };
  currentTasks: CurrentTaskSummary[];
  lastEvents: string[];
  output?: {
    reportPath?: string;
    summaryPath?: string;
  };
}

export interface CurrentTaskSummary {
  taskId: string;
  phase: PhaseName;
  role: Role;
  persona: string;
  label: string;
}

export interface WorkflowEvent {
  type: string;
  at: string;
  runId: string;
  phase?: PhaseName;
  taskId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SourceCard {
  id: string;
  kind: "web" | "official_docs" | "repo" | "github" | "mcp" | "command";
  title: string;
  urlOrPath: string;
  retrievedAt: string;
  publishedAt?: string;
  quality: SourceQuality;
  authorityScore: number;
  freshnessScore: number;
  relevanceScore: number;
  angleIds: string[];
  excerptRefs: string[];
}

export interface Claim {
  id: string;
  text: string;
  sourceId: string;
  quote: string;
  importance: "central" | "supporting" | "tangential";
  freshnessRequired: boolean;
}

export interface Vote {
  id: string;
  claimId: string;
  voter: string;
  refuted: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string;
  counterSource?: string;
}

export interface ClaimDecision {
  claimId: string;
  decision: ClaimDecisionValue;
  validVotes: number;
  refutations: number;
  rationale: string;
}
```

- [ ] **Step 6: Write schema tests**

Create `plugins/codex-deep-research/runner/tests/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ScopeSchema, VerdictSchema } from "../src/workflow/schemas.js";

describe("workflow schemas", () => {
  it("accepts a valid scope result", () => {
    const parsed = ScopeSchema.parse({
      question: "What changed in Codex plugins?",
      summary: "Search official docs, implementation examples, and limitations.",
      angles: [
        { label: "official docs", query: "Codex plugins official docs", rationale: "Primary source" },
        { label: "examples", query: "Codex plugin examples", rationale: "Implementation signal" },
        { label: "limitations", query: "Codex plugin limitations", rationale: "Risk signal" },
      ],
    });
    expect(parsed.angles).toHaveLength(3);
  });

  it("rejects a verdict without confidence", () => {
    expect(() =>
      VerdictSchema.parse({
        refuted: false,
        evidence: "The quote supports the claim.",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 7: Implement schemas**

Create `plugins/codex-deep-research/runner/src/workflow/schemas.ts`:

```ts
import { z } from "zod";

export const ScopeSchema = z.object({
  question: z.string().min(1),
  summary: z.string().min(1),
  angles: z
    .array(
      z.object({
        label: z.string().min(1),
        query: z.string().min(1),
        rationale: z.string().optional(),
      }),
    )
    .min(3)
    .max(6),
});

export const SearchSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().min(1),
        title: z.string().min(1),
        snippet: z.string().optional(),
        relevance: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(6),
});

export const ExtractSchema = z.object({
  sourceQuality: z.enum(["primary", "official", "secondary", "community", "commercial", "forum", "unreliable"]),
  publishDate: z.string().optional(),
  claims: z
    .array(
      z.object({
        claim: z.string().min(1),
        quote: z.string().min(1),
        importance: z.enum(["central", "supporting", "tangential"]),
      }),
    )
    .max(5),
});

export const VerdictSchema = z.object({
  refuted: z.boolean(),
  evidence: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  counterSource: z.string().optional(),
});

export const ReportSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      claim: z.string().min(1),
      confidence: z.enum(["high", "medium", "low"]),
      sources: z.array(z.string().min(1)),
      evidence: z.string().min(1),
      vote: z.string().optional(),
    }),
  ),
  caveats: z.string().min(1),
  openQuestions: z.array(z.string()).default([]),
});
```

- [ ] **Step 8: Verify Task 2**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/jsonl.test.ts runner/tests/schemas.test.ts
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
2 passed
```

and typecheck exits with code `0`.

- [ ] **Step 9: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add deep research core schemas"
```

## Task 3: Run Store and Observable State

**Files:**

- Create: `plugins/codex-deep-research/runner/src/runtime/run-store.ts`
- Create: `plugins/codex-deep-research/runner/tests/run-store.test.ts`

- [ ] **Step 1: Write run-store test**

Create `plugins/codex-deep-research/runner/tests/run-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/run-store.test.ts
```

Expected:

```text
FAIL runner/tests/run-store.test.ts
Cannot find module '../src/runtime/run-store.js'
```

- [ ] **Step 3: Implement RunStore**

Create `plugins/codex-deep-research/runner/src/runtime/run-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.js";
import { createRunId } from "./ids.js";
import type { RunManifest, RunStatus, WorkflowEvent } from "./types.js";

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
    const runId = createRunId();
    const outputDir = join(this.rootDir, ".codex-deep-research", "runs", runId);
    await mkdir(outputDir, { recursive: true });

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
    const manifest = await this.readManifest(runId).catch(() => undefined);
    const outputDir = manifest?.outputDir ?? join(this.rootDir, ".codex-deep-research", "runs", runId);
    await appendJsonl(join(outputDir, "events.jsonl"), {
      ...event,
      at: new Date().toISOString(),
      runId,
    });
  }

  private async resolveRunFile(runId: string, fileName: string): Promise<string> {
    return join(this.rootDir, ".codex-deep-research", "runs", runId, fileName);
  }
}
```

- [ ] **Step 4: Verify Task 3**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/run-store.test.ts
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
1 passed
```

and typecheck exits with code `0`.

- [ ] **Step 5: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add deep research run store"
```

## Task 4: Scheduler, Personas, Context, and Prompt Envelopes

**Files:**

- Create: `plugins/codex-deep-research/runner/src/runtime/scheduler.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/persona-registry.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/context-selector.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/prompt-builder.ts`
- Create: `plugins/codex-deep-research/runner/tests/scheduler.test.ts`
- Create: `plugins/codex-deep-research/runner/tests/prompt-builder.test.ts`

- [ ] **Step 1: Write scheduler test**

Create `plugins/codex-deep-research/runner/tests/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runBounded } from "../src/runtime/scheduler.js";

describe("runBounded", () => {
  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await runBounded(
      Array.from({ length: 10 }, (_, index) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      }),
      3,
    );

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Implement scheduler**

Create `plugins/codex-deep-research/runner/src/runtime/scheduler.ts`:

```ts
export async function runBounded<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (concurrency < 1) {
    throw new Error("concurrency must be at least 1");
  }

  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
```

- [ ] **Step 3: Write prompt builder test**

Create `plugins/codex-deep-research/runner/tests/prompt-builder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPromptEnvelope, redactPromptEnvelope } from "../src/runtime/prompt-builder.js";

describe("prompt builder", () => {
  it("builds and redacts prompt envelopes", () => {
    const envelope = buildPromptEnvelope({
      run: { question: "Question?", mode: "mixed", depth: "standard" },
      task: {
        id: "task_001",
        phase: "voting",
        role: "skeptic",
        persona: "skeptic:freshness_checker",
        objective: "Check freshness",
      },
      constraints: ["Use cited evidence only"],
      injected: {
        claim: { id: "claim_001", text: "A fast-moving claim" },
        largeExcerpt: "x".repeat(2000),
      },
      outputSchema: { type: "object" },
    });

    const redacted = redactPromptEnvelope(envelope);
    expect(redacted.task.persona).toBe("skeptic:freshness_checker");
    expect(JSON.stringify(redacted)).not.toContain("x".repeat(2000));
  });
});
```

- [ ] **Step 4: Implement persona registry**

Create `plugins/codex-deep-research/runner/src/runtime/persona-registry.ts`:

```ts
import type { Role } from "./types.js";

export interface Persona {
  id: string;
  role: Role;
  qualifier: string;
  rubric: string[];
  must: string[];
  mustNot: string[];
}

export const PERSONAS: Persona[] = [
  {
    id: "planner:angle_decomposer",
    role: "planner",
    qualifier: "Decompose the research question into complementary search angles.",
    rubric: ["Cover primary, recent, technical, skeptical, and implementation angles."],
    must: ["Return non-overlapping angles."],
    mustNot: ["Do not create redundant search queries."],
  },
  {
    id: "skeptic:freshness_checker",
    role: "skeptic",
    qualifier: "Focus on whether the claim is outdated or contradicted by newer sources.",
    rubric: ["Check publication dates.", "Downgrade stale claims in fast-moving domains."],
    must: ["Return specific evidence for freshness concerns."],
    mustNot: ["Do not reject stable-domain claims only because they are old."],
  },
  {
    id: "voter:strict_quorum_judge",
    role: "voter",
    qualifier: "Apply the vote threshold strictly and default weak evidence to unverified.",
    rubric: ["Require at least two valid votes.", "Kill claims with two refutations."],
    must: ["Explain the vote decision."],
    mustNot: ["Do not preserve claims with too many abstentions."],
  },
];

export function getPersona(id: string): Persona {
  const persona = PERSONAS.find((item) => item.id === id);
  if (!persona) {
    throw new Error(`Unknown persona: ${id}`);
  }
  return persona;
}
```

- [ ] **Step 5: Implement context selector**

Create `plugins/codex-deep-research/runner/src/runtime/context-selector.ts`:

```ts
import type { Claim, SourceCard } from "./types.js";

export interface SkepticContextInput {
  claim: Claim;
  source: SourceCard;
  knownCounterEvidence: string[];
}

export function selectSkepticContext(input: SkepticContextInput): Record<string, unknown> {
  return {
    claim: {
      id: input.claim.id,
      text: input.claim.text,
      freshnessRequired: input.claim.freshnessRequired,
    },
    supportingEvidence: [
      {
        sourceId: input.source.id,
        quote: input.claim.quote,
        publishDate: input.source.publishedAt,
        sourceQuality: input.source.quality,
      },
    ],
    knownCounterEvidence: input.knownCounterEvidence,
  };
}
```

- [ ] **Step 6: Implement prompt builder**

Create `plugins/codex-deep-research/runner/src/runtime/prompt-builder.ts`:

```ts
import type { PhaseName, Role } from "./types.js";

export interface PromptEnvelope {
  run: {
    question: string;
    mode: "mixed" | "web" | "repo";
    depth: "quick" | "standard" | "deep";
  };
  task: {
    id: string;
    phase: PhaseName;
    role: Role;
    persona: string;
    objective: string;
  };
  constraints: string[];
  injected: Record<string, unknown>;
  outputSchema: unknown;
}

export function buildPromptEnvelope(envelope: PromptEnvelope): PromptEnvelope {
  return envelope;
}

export function redactPromptEnvelope(envelope: PromptEnvelope): PromptEnvelope {
  return {
    ...envelope,
    injected: redactValue(envelope.injected) as Record<string, unknown>,
  };
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 120)}...[redacted ${value.length - 120} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }
  return value;
}
```

- [ ] **Step 7: Verify Task 4**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/scheduler.test.ts runner/tests/prompt-builder.test.ts
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
2 passed
```

and typecheck exits with code `0`.

- [ ] **Step 8: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add deep research runtime primitives"
```

## Task 5: Worker Interface and Codex Exec Adapter

**Files:**

- Create: `plugins/codex-deep-research/runner/src/workers/worker-client.ts`
- Create: `plugins/codex-deep-research/runner/src/workers/fake-worker.ts`
- Create: `plugins/codex-deep-research/runner/src/workers/codex-exec-worker.ts`
- Create: `plugins/codex-deep-research/runner/tests/fake-worker.test.ts`

- [ ] **Step 1: Write fake worker test**

Create `plugins/codex-deep-research/runner/tests/fake-worker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeWorkerClient } from "../src/workers/fake-worker.js";

describe("FakeWorkerClient", () => {
  it("returns queued fixture results", async () => {
    const worker = new FakeWorkerClient([{ ok: true }]);
    await expect(worker.run({ label: "scope", prompt: "test", schemaName: "ScopeSchema" })).resolves.toEqual({
      ok: true,
    });
  });
});
```

- [ ] **Step 2: Implement worker interface**

Create `plugins/codex-deep-research/runner/src/workers/worker-client.ts`:

```ts
export interface WorkerTask {
  label: string;
  prompt: string;
  schemaName: string;
  timeoutMs?: number;
}

export interface WorkerClient {
  run<T = unknown>(task: WorkerTask): Promise<T>;
}
```

- [ ] **Step 3: Implement fake worker**

Create `plugins/codex-deep-research/runner/src/workers/fake-worker.ts`:

```ts
import type { WorkerClient, WorkerTask } from "./worker-client.js";

export class FakeWorkerClient implements WorkerClient {
  constructor(private readonly results: unknown[]) {}

  async run<T = unknown>(_task: WorkerTask): Promise<T> {
    if (this.results.length === 0) {
      throw new Error("FakeWorkerClient has no queued result");
    }
    return this.results.shift() as T;
  }
}
```

- [ ] **Step 4: Implement codex exec worker**

Create `plugins/codex-deep-research/runner/src/workers/codex-exec-worker.ts`:

```ts
import { spawn } from "node:child_process";
import type { WorkerClient, WorkerTask } from "./worker-client.js";

export interface CodexExecWorkerOptions {
  codexBinary?: string;
  cwd: string;
}

export class CodexExecWorkerClient implements WorkerClient {
  constructor(private readonly options: CodexExecWorkerOptions) {}

  async run<T = unknown>(task: WorkerTask): Promise<T> {
    const codex = this.options.codexBinary ?? "codex";
    const prompt = `${task.prompt}\n\nReturn only valid JSON for schema ${task.schemaName}.`;

    return await new Promise<T>((resolve, reject) => {
      const child = spawn(codex, ["exec", "--json", prompt], {
        cwd: this.options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      const timeout = task.timeoutMs
        ? setTimeout(() => {
            child.kill();
            reject(new Error(`Worker timed out: ${task.label}`));
          }, task.timeoutMs)
        : undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (code !== 0) {
          reject(new Error(`codex exec failed with code ${code}: ${stderr}`));
          return;
        }
        resolve(parseLastJsonObject(stdout) as T);
      });
    });
  }
}

function parseLastJsonObject(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as { type?: string; item?: unknown; message?: unknown };
      if (typeof parsed.message === "string") {
        return JSON.parse(parsed.message);
      }
      if (parsed.item && typeof parsed.item === "object" && "text" in parsed.item) {
        return JSON.parse(String((parsed.item as { text: unknown }).text));
      }
    } catch {
      continue;
    }
  }
  throw new Error("No JSON object found in codex exec output");
}
```

- [ ] **Step 5: Verify Task 5**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/fake-worker.test.ts
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
1 passed
```

and typecheck exits with code `0`.

- [ ] **Step 6: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add codex deep research workers"
```

## Task 6: Workflow Primitives and Deep Research v0 Flow

**Files:**

- Create: `plugins/codex-deep-research/runner/src/workflow/primitives.ts`
- Create: `plugins/codex-deep-research/runner/src/workflow/deep-research.workflow.ts`
- Create: `plugins/codex-deep-research/runner/src/runtime/checkpoint.ts`
- Create: `plugins/codex-deep-research/runner/tests/deep-research.workflow.test.ts`

- [ ] **Step 1: Write workflow smoke test**

Create `plugins/codex-deep-research/runner/tests/deep-research.workflow.test.ts`:

```ts
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
```

- [ ] **Step 2: Implement checkpoint helper**

Create `plugins/codex-deep-research/runner/src/runtime/checkpoint.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeCheckpoint(outputDir: string, name: string, state: unknown): Promise<string> {
  const dir = join(outputDir, "checkpoints");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
  return path;
}
```

- [ ] **Step 3: Implement primitives**

Create `plugins/codex-deep-research/runner/src/workflow/primitives.ts`:

```ts
import type { RunStatus } from "../runtime/types.js";
import { runBounded } from "../runtime/scheduler.js";
import type { RunStore } from "../runtime/run-store.js";
import type { WorkerClient, WorkerTask } from "../workers/worker-client.js";

export interface WorkflowRuntime {
  store: RunStore;
  runId: string;
  status: RunStatus;
  worker: WorkerClient;
}

export async function phase(runtime: WorkflowRuntime, phaseName: RunStatus["phase"]): Promise<void> {
  runtime.status.phase = phaseName;
  await runtime.store.writeStatus(runtime.status);
  await runtime.store.emit(runtime.runId, { type: "phase.started", phase: phaseName, message: phaseName });
}

export async function agent<T>(runtime: WorkflowRuntime, task: WorkerTask): Promise<T> {
  runtime.status.progress.running += 1;
  await runtime.store.writeStatus(runtime.status);
  await runtime.store.emit(runtime.runId, { type: "task.started", taskId: task.label, message: task.label });
  try {
    const result = await runtime.worker.run<T>(task);
    runtime.status.progress.completed += 1;
    await runtime.store.emit(runtime.runId, { type: "task.completed", taskId: task.label, message: task.label });
    return result;
  } catch (error) {
    runtime.status.progress.failed += 1;
    await runtime.store.emit(runtime.runId, {
      type: "task.failed",
      taskId: task.label,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    runtime.status.progress.running -= 1;
    await runtime.store.writeStatus(runtime.status);
  }
}

export async function parallel<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  return await runBounded(tasks, concurrency);
}
```

- [ ] **Step 4: Implement minimal workflow**

Create `plugins/codex-deep-research/runner/src/workflow/deep-research.workflow.ts`:

```ts
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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
  const runtime: WorkflowRuntime = {
    store: input.store,
    runId: input.manifest.runId,
    status,
    worker: input.worker,
  };

  await phase(runtime, "planning");
  const scope = ScopeSchema.parse(
    await agent(runtime, {
      label: "scope",
      schemaName: "ScopeSchema",
      prompt:
        `Decompose this research question into 3-6 complementary search angles.\n\n` +
        `Question: ${input.manifest.question}\n\nReturn structured JSON only.`,
    }),
  );

  runtime.status.research.angles = scope.angles.length;
  await input.store.writeStatus(runtime.status);
  await writeCheckpoint(input.manifest.outputDir, "001-scope", scope);

  await phase(runtime, "synthesizing");
  const reportPath = join(input.manifest.outputDir, "report.md");
  const summaryPath = join(input.manifest.outputDir, "report.summary.md");
  await writeFile(
    reportPath,
    `# ${input.manifest.question}\n\n## 摘要\n\n${scope.summary}\n\n## Search Angles\n\n${scope.angles
      .map((angle) => `- ${angle.label}: ${angle.query}`)
      .join("\n")}\n`,
    "utf8",
  );
  await writeFile(summaryPath, scope.summary + "\n", "utf8");

  await phase(runtime, "completed");
  runtime.status.state = "completed";
  runtime.status.output = { reportPath, summaryPath };
  await input.store.writeStatus(runtime.status);
  await input.store.emit(input.manifest.runId, { type: "report.written", message: reportPath });
}
```

- [ ] **Step 5: Verify Task 6**

Run:

```powershell
npm --prefix plugins\codex-deep-research test -- runner/tests/deep-research.workflow.test.ts
npm --prefix plugins\codex-deep-research run typecheck
```

Expected:

```text
1 passed
```

and typecheck exits with code `0`.

- [ ] **Step 6: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add deep research workflow skeleton"
```

## Task 7: CLI Commands

**Files:**

- Create: `plugins/codex-deep-research/runner/src/cli.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/start.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/run.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/status.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/report.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/cancel.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/list.ts`
- Create: `plugins/codex-deep-research/runner/src/commands/watch.ts`

- [ ] **Step 1: Implement CLI dispatcher**

Create `plugins/codex-deep-research/runner/src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { reportCommand } from "./commands/report.js";
import { cancelCommand } from "./commands/cancel.js";
import { listCommand } from "./commands/list.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program.name("codex-deep-research").description("Run Codex deep research workflows").version("0.1.0");

program
  .command("start")
  .argument("<question>")
  .option("--mode <mode>", "mixed|web|repo", "mixed")
  .option("--depth <depth>", "quick|standard|deep", "standard")
  .option("--max-concurrency <n>", "maximum concurrent workers", "8")
  .option("--max-tasks <n>", "maximum logical tasks", "120")
  .option("--debug-prompts", "save full prompt envelopes", false)
  .action(startCommand);

program.command("run").argument("<runId>").action(runCommand);
program.command("status").argument("<runId>").action(statusCommand);
program.command("watch").argument("<runId>").action(watchCommand);
program.command("report").argument("<runId>").action(reportCommand);
program.command("cancel").argument("<runId>").action(cancelCommand);
program.command("list").action(listCommand);

await program.parseAsync(process.argv);
```

- [ ] **Step 2: Implement command helpers**

Create `plugins/codex-deep-research/runner/src/commands/start.ts`:

```ts
import { spawn } from "node:child_process";
import { RunStore } from "../runtime/run-store.js";

interface StartOptions {
  mode: "mixed" | "web" | "repo";
  depth: "quick" | "standard" | "deep";
  maxConcurrency: string;
  maxTasks: string;
  debugPrompts: boolean;
}

export async function startCommand(question: string, options: StartOptions): Promise<void> {
  const workspace = process.cwd();
  const store = new RunStore(workspace);
  const manifest = await store.createRun({
    question,
    workspace,
    mode: options.mode,
    depth: options.depth,
    maxConcurrency: Number(options.maxConcurrency),
    maxTasks: Number(options.maxTasks),
    debugPrompts: Boolean(options.debugPrompts),
  });

  const child = spawn(process.execPath, [new URL("../cli.js", import.meta.url).pathname, "run", manifest.runId], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(JSON.stringify({ runId: manifest.runId, statusPath: `${manifest.outputDir}/status.json` }, null, 2));
}
```

Create `plugins/codex-deep-research/runner/src/commands/run.ts`:

```ts
import { RunStore } from "../runtime/run-store.js";
import { CodexExecWorkerClient } from "../workers/codex-exec-worker.js";
import { runDeepResearch } from "../workflow/deep-research.workflow.js";

export async function runCommand(runId: string): Promise<void> {
  const store = new RunStore(process.cwd());
  const manifest = await store.readManifest(runId);
  const worker = new CodexExecWorkerClient({ cwd: manifest.workspace });
  await runDeepResearch({ manifest, store, worker });
}
```

Create `plugins/codex-deep-research/runner/src/commands/status.ts`:

```ts
import { RunStore } from "../runtime/run-store.js";

export async function statusCommand(runId: string): Promise<void> {
  const status = await new RunStore(process.cwd()).readStatus(runId);
  console.log(JSON.stringify(status, null, 2));
}
```

Create `plugins/codex-deep-research/runner/src/commands/report.ts`:

```ts
import { readFile } from "node:fs/promises";
import { RunStore } from "../runtime/run-store.js";

export async function reportCommand(runId: string): Promise<void> {
  const status = await new RunStore(process.cwd()).readStatus(runId);
  if (!status.output?.summaryPath || !status.output.reportPath) {
    console.log(`No report is available for ${runId}.`);
    return;
  }
  const summary = await readFile(status.output.summaryPath, "utf8");
  console.log(`Report: ${status.output.reportPath}\n\n${summary}`);
}
```

Create `plugins/codex-deep-research/runner/src/commands/cancel.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../runtime/run-store.js";

export async function cancelCommand(runId: string): Promise<void> {
  const manifest = await new RunStore(process.cwd()).readManifest(runId);
  await writeFile(join(manifest.outputDir, "cancel.requested"), new Date().toISOString() + "\n", "utf8");
  console.log(`Cancel requested for ${runId}.`);
}
```

Create `plugins/codex-deep-research/runner/src/commands/list.ts`:

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function listCommand(): Promise<void> {
  const runsDir = join(process.cwd(), ".codex-deep-research", "runs");
  try {
    const names = await readdir(runsDir);
    console.log(names.filter((name) => name.startsWith("dr_")).join("\n"));
  } catch {
    console.log("");
  }
}
```

Create `plugins/codex-deep-research/runner/src/commands/watch.ts`:

```ts
import { readFile } from "node:fs/promises";
import { RunStore } from "../runtime/run-store.js";

export async function watchCommand(runId: string): Promise<void> {
  const manifest = await new RunStore(process.cwd()).readManifest(runId);
  const raw = await readFile(`${manifest.outputDir}/events.jsonl`, "utf8").catch(() => "");
  console.log(raw.trim());
}
```

- [ ] **Step 3: Verify CLI typecheck**

Run:

```powershell
npm --prefix plugins\codex-deep-research run typecheck
npm --prefix plugins\codex-deep-research run build
```

Expected:

```text
tsc -p tsconfig.json --noEmit
tsc -p tsconfig.json
```

Both commands exit with code `0`.

- [ ] **Step 4: Smoke test CLI with fake-safe command**

Run:

```powershell
npm --prefix plugins\codex-deep-research run dev -- list
```

Expected:

```text

```

An empty list is acceptable when no runs exist.

- [ ] **Step 5: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add plugins/codex-deep-research
git commit -m "feat: add deep research runner cli"
```

## Task 8: Report Verifier, Skill Entry, and Final Validation

**Files:**

- Create: `plugins/codex-deep-research/runner/src/report/report-verifier.ts`
- Create: `plugins/codex-deep-research/runner/src/report/report-writer.ts`
- Create: `plugins/codex-deep-research/runner/tests/report-verifier.test.ts`
- Create: `plugins/codex-deep-research/skills/deep-research/SKILL.md`
- Modify: `plugins/codex-deep-research/README.md`

- [ ] **Step 1: Write report verifier test**

Create `plugins/codex-deep-research/runner/tests/report-verifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifyReportCitations } from "../src/report/report-verifier.js";

describe("verifyReportCitations", () => {
  it("rejects citations that are not in fetched sources", () => {
    const result = verifyReportCitations("Claim cites [S2].", [{ id: "S1", status: "fetched" }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("S2");
  });

  it("accepts citations from fetched sources", () => {
    const result = verifyReportCitations("Claim cites [S1].", [{ id: "S1", status: "fetched" }]);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement report verifier**

Create `plugins/codex-deep-research/runner/src/report/report-verifier.ts`:

```ts
export interface VerifiableSource {
  id: string;
  status: "fetched" | "extracted" | "verified_used";
}

export interface ReportVerificationResult {
  ok: boolean;
  errors: string[];
}

export function verifyReportCitations(markdown: string, sources: VerifiableSource[]): ReportVerificationResult {
  const allowed = new Set(sources.map((source) => source.id));
  const cited = Array.from(markdown.matchAll(/\[(S\d+)\]/g)).map((match) => match[1]);
  const errors = cited.filter((id) => !allowed.has(id)).map((id) => `Citation ${id} is not a fetched source.`);
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 3: Implement report writer**

Create `plugins/codex-deep-research/runner/src/report/report-writer.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReportInput {
  outputDir: string;
  question: string;
  summary: string;
  findings: string[];
  sources: Array<{ id: string; title: string; urlOrPath: string }>;
}

export async function writeReports(input: ReportInput): Promise<{ reportPath: string; summaryPath: string; sourcesPath: string }> {
  const reportPath = join(input.outputDir, "report.md");
  const summaryPath = join(input.outputDir, "report.summary.md");
  const sourcesPath = join(input.outputDir, "report.sources.md");

  const report = `# ${input.question}\n\n## 摘要\n\n${input.summary}\n\n## 关键发现\n\n${input.findings
    .map((finding, index) => `### ${index + 1}. Finding\n\n${finding}`)
    .join("\n\n")}\n\n## 来源\n\n${input.sources.map((source) => `- [${source.id}] ${source.title}: ${source.urlOrPath}`).join("\n")}\n`;

  await writeFile(reportPath, report, "utf8");
  await writeFile(summaryPath, input.summary + "\n", "utf8");
  await writeFile(sourcesPath, input.sources.map((source) => `- [${source.id}] ${source.title}: ${source.urlOrPath}`).join("\n") + "\n", "utf8");

  return { reportPath, summaryPath, sourcesPath };
}
```

- [ ] **Step 4: Create Codex skill**

Create `plugins/codex-deep-research/skills/deep-research/SKILL.md`:

```md
---
name: deep-research
description: Start, inspect, watch, cancel, or read Codex Deep Research runs from the codex-deep-research plugin.
---

# Codex Deep Research

Use this skill when the user asks for deep research, dynamic workflow research, multi-agent research, adversarial verification, or status/report management for a research run.

## Commands

Use the plugin runner from the caller workspace root.

Start:

```powershell
npm --prefix plugins\codex-deep-research run dev -- start "<question>"
```

Status:

```powershell
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
```

Watch:

```powershell
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
```

Report:

```powershell
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
```

Cancel:

```powershell
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
```

## Behavior

- Start returns a `run_id`.
- Full reports are written to `.codex-deep-research/runs/<run_id>/report.md`.
- Chat responses should summarize status and provide the report path instead of pasting full reports by default.
- Prompt envelopes are redacted unless `--debug-prompts` is explicitly requested.
```

- [ ] **Step 5: Update README with skill usage**

Append to `plugins/codex-deep-research/README.md`:

```md

## Codex Skill

The plugin includes a `deep-research` skill. In Codex, use it to start and inspect runs:

```text
npm --prefix plugins\codex-deep-research run dev -- start "your research question"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
```
```

- [ ] **Step 6: Verify final package**

Run:

```powershell
npm --prefix plugins\codex-deep-research test
npm --prefix plugins\codex-deep-research run typecheck
npm --prefix plugins\codex-deep-research run build
```

Expected:

```text
Test Files ... passed
```

and both typecheck/build exit with code `0`.

- [ ] **Step 7: Repository-level validation**

Run from repository root:

```powershell
npm --prefix plugins\codex-deep-research run dev -- list
```

Expected:

```text
```

An empty list is acceptable when no runs exist. Review the working tree separately before committing, but do not rely on stale sample status output from before the implementation was committed.

- [ ] **Step 8: Git checkpoint**

Only run if the user has approved committing this implementation:

```powershell
git add .gitignore plugins/codex-deep-research docs/superpowers/plans/2026-06-04-codex-deep-research-implementation-plan.md
git commit -m "feat: add codex deep research v0"
```

## Self-Review Checklist

- Spec coverage:
  - Plugin directory and manifest are covered by Task 1.
  - Runtime state and observable files are covered by Task 3.
  - Context injection and persona registry are covered by Task 4.
  - Worker abstraction and `codex exec --json` adapter are covered by Task 5.
  - Workflow primitives and first workflow skeleton are covered by Task 6.
  - CLI commands are covered by Task 7.
  - Report verification and skill entry are covered by Task 8.
- No placeholder terms are used as implementation instructions.
- Type names are consistent across tasks: `RunStore`, `WorkerClient`, `PromptEnvelope`, `RunManifest`, `RunStatus`.
- The plan intentionally implements a runnable v0 skeleton first. Full search/fetch/verify depth can be expanded after the skeleton passes tests.

