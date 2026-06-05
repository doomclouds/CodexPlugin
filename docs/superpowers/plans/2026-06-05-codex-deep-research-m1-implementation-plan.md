# Codex Deep Research M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `codex-deep-research` from a scope/report skeleton into a cited research workflow that collects sources, extracts claims, verifies them with votes, writes machine-readable state files, and produces a report with real source references.

**Architecture:** Keep plugin runtime artifacts under `plugins/codex-deep-research/bin`, with TypeScript source under `src/codex-deep-research`. Extend the existing `RunStore` as the single filesystem boundary; add small runtime modules for source normalization, repo fallback, deterministic voting/decision helpers, and report assembly. `runDeepResearch` remains the workflow orchestrator and uses the existing `WorkerClient` abstraction for planner/search/extract/vote/synthesize agents.

**Tech Stack:** TypeScript, Node.js `fs/promises`, `child_process.spawn`, Vitest, Zod, current `CodexExecWorkerClient`, esbuild Windows CLI packaging, npm security audit against the official npm registry.

---

## Preflight: Current Workspace Discipline and Dependency Security

The workspace currently contains uncommitted M1 draft documents:

- `docs/superpowers/specs/2026-06-05-codex-deep-research-m1-design.md`
- `docs/superpowers/plans/2026-06-05-codex-deep-research-m1-implementation-plan.md`

Do not commit any M1 code until the user approves implementation.

Run before implementation:

```powershell
git status --short --branch
git diff -- docs\superpowers\specs\2026-06-05-codex-deep-research-m1-design.md docs\superpowers\plans\2026-06-05-codex-deep-research-m1-implementation-plan.md
```

Expected: no implementation files are dirty before Task 0 starts.

Dependency security evidence from current code, verified on 2026-06-05:

```powershell
npm --prefix src\codex-deep-research audit --audit-level=moderate
```

This failed because the configured mirror `https://registry.npmmirror.com/` does not implement the npm security audit endpoint. Do not treat that as a clean audit.

```powershell
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Current result: FAIL. The lockfile contains vulnerable `vitest -> vite -> esbuild` versions:

```text
esbuild <=0.24.2
vite <=6.4.1
vite-node <=2.2.0-beta.2
vitest <=4.1.0-beta.6
```

Task 0 is mandatory before feature work. Do not add or keep package versions that fail official npm audit.

## File Map

Runtime state:

- Modify `src/codex-deep-research/runner/src/runtime/types.ts`
  - Add source status, source/claim/vote/decision/finding data shapes.
  - Keep existing `RunStatus` shape compatible.
- Modify `src/codex-deep-research/runner/src/runtime/run-store.ts`
  - Add typed JSONL helpers.
  - Add artifact writer.
  - Add run discoverability files: `TITLE.txt`, `QUESTION.md`, `.codex-deep-research/runs/INDEX.md`.
- Create `src/codex-deep-research/runner/src/runtime/source-provider.ts`
  - Repo fallback provider.
  - Source dedupe and source id assignment.
- Create `src/codex-deep-research/runner/src/runtime/research-state.ts`
  - Claim/vote/decision helper functions.

Workflow:

- Modify `src/codex-deep-research/runner/src/workflow/schemas.ts`
  - Add worker output schemas for M1 phases.
- Modify `src/codex-deep-research/runner/src/workflow/primitives.ts`
  - Add richer task events and current-task status handling.
- Modify `src/codex-deep-research/runner/src/workflow/deep-research.workflow.ts`
  - Implement planning, searching, collecting, extracting, cross-checking, voting, synthesizing, verifying.

Reports:

- Modify `src/codex-deep-research/runner/src/report/report-writer.ts`
  - Generate cited report from decisions and sources.
- Modify `src/codex-deep-research/runner/src/report/report-verifier.ts`
  - Verify source references and source statuses.

CLI:

- Modify `src/codex-deep-research/runner/src/commands/start.ts`
  - Add `windowsHide: true`.
  - Add `--open-console`.
  - Add watcher terminal launcher.
- Modify `src/codex-deep-research/runner/src/cli.ts`
  - Wire `--open-console`.

Tests:

- Modify existing tests:
  - `src/codex-deep-research/runner/tests/run-store.test.ts`
  - `src/codex-deep-research/runner/tests/schemas.test.ts`
  - `src/codex-deep-research/runner/tests/deep-research.workflow.test.ts`
  - `src/codex-deep-research/runner/tests/report-verifier.test.ts`
  - `src/codex-deep-research/runner/tests/commands.test.ts`
- Create:
  - `src/codex-deep-research/runner/tests/source-provider.test.ts`
  - `src/codex-deep-research/runner/tests/research-state.test.ts`

Packaging:

- Rebuild:
  - `plugins/codex-deep-research/bin/codex-deep-research.mjs`
  - `plugins/codex-deep-research/bin/codex-deep-research.cmd`

Dependency security:

- Modify `src/codex-deep-research/package.json`
  - Upgrade vulnerable direct dev dependencies.
  - Avoid adding new runtime dependencies unless a task explicitly requires one.
- Modify `src/codex-deep-research/package-lock.json`
  - Regenerate with the official npm registry during audit-sensitive work.

---

## Task 0: Dependency Security Gate

**Files:**

- Modify: `src/codex-deep-research/package.json`
- Modify: `src/codex-deep-research/package-lock.json`

- [ ] **Step 1: Confirm current audit failure against official npm registry**

```powershell
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Expected before this task is fixed:

```text
esbuild <=0.24.2
vite <=6.4.1
vitest <=4.1.0-beta.6
```

If this command exits 0 because the lockfile was already fixed by another agent, skip to Step 5 and still run the full verification commands.

- [ ] **Step 2: Check current safe package versions from the official npm registry**

```powershell
npm view vitest version --registry=https://registry.npmjs.org/
npm view esbuild version --registry=https://registry.npmjs.org/
npm view zod version --registry=https://registry.npmjs.org/
npm view commander version --registry=https://registry.npmjs.org/
```

Known values observed on 2026-06-05:

```text
vitest 4.1.8
esbuild 0.28.0
zod 4.4.3
commander 15.0.0
```

Use these observed values only as a floor. If npm reports newer versions during implementation, prefer the newest non-vulnerable stable version unless it forces code changes outside this plan.

- [ ] **Step 3: Upgrade only the vulnerable direct dev dependencies first**

Run:

```powershell
npm --prefix src\codex-deep-research install --save-dev vitest@4.1.8 esbuild@0.28.0 --registry=https://registry.npmjs.org/
```

Expected file changes:

```text
src\codex-deep-research\package.json
src\codex-deep-research\package-lock.json
```

Do not upgrade `zod` from v3 to v4 in this task unless audit flags it, because Zod v4 can require schema behavior review. Do not upgrade `commander` unless audit flags it or tests require it.

- [ ] **Step 4: Verify dependency audit is clean**

```powershell
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Expected:

```text
found 0 vulnerabilities
```

If `vitest@4.1.8` still pulls a vulnerable `vite` or `esbuild` in the future, do not suppress the audit. Run `npm view vitest version --registry=https://registry.npmjs.org/`, upgrade to the newest stable `vitest`, then repeat this step.

- [ ] **Step 5: Verify the dependency upgrade did not break the current runner**

```powershell
npm --prefix src\codex-deep-research test
npm --prefix src\codex-deep-research run typecheck
npm --prefix src\codex-deep-research run build
```

Expected: all commands exit 0. If Vitest output format changes but tests pass, do not change tests for formatting only.

- [ ] **Step 6: Gate every new third-party package added by later tasks**

If a later task proposes a new package, run this sequence before adding it:

```powershell
npm view <package-name> version --registry=https://registry.npmjs.org/
npm --prefix src\codex-deep-research install <package-name>@<exact-version> --registry=https://registry.npmjs.org/
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Expected: audit exits 0. If audit fails, remove that package immediately:

```powershell
npm --prefix src\codex-deep-research uninstall <package-name>
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Task rule: M1 should not need new dependencies beyond existing `commander`, `zod`, `vitest`, `typescript`, `tsx`, `esbuild`, and `@types/node`. Prefer Node standard library and existing runtime helpers.

---

## Task 1: Runtime Types, JSONL Files, and Run Discoverability

**Files:**

- Modify: `src/codex-deep-research/runner/src/runtime/types.ts`
- Modify: `src/codex-deep-research/runner/src/runtime/run-store.ts`
- Modify: `src/codex-deep-research/runner/tests/run-store.test.ts`

- [ ] **Step 1: Add failing tests for typed research files**

Append these tests to `src/codex-deep-research/runner/tests/run-store.test.ts` inside `describe("RunStore", ...)`.

```ts
it("writes and reads sources, claims, votes, and decisions JSONL files", async () => {
  const { root, store } = await createTempStore();
  const manifest = await createRun(store, root);

  await store.appendSources(manifest.runId, [
    {
      id: "S1",
      kind: "repo",
      status: "fetched",
      title: "Design spec",
      urlOrPath: "docs/superpowers/specs/example.md",
      retrievedAt: "2026-06-05T00:00:00.000Z",
      quality: "official",
      authorityScore: 0.9,
      freshnessScore: 0.7,
      relevanceScore: 0.8,
      angleIds: ["angle_001"],
      excerptRefs: ["artifacts/sources/S1.md"],
      summary: "Design source summary",
    },
  ]);
  await store.appendClaims(manifest.runId, [
    {
      id: "C1",
      text: "Codex Deep Research needs cited output.",
      sourceId: "S1",
      quote: "report.md must contain source ids",
      importance: "central",
      freshnessRequired: false,
    },
  ]);
  await store.appendVotes(manifest.runId, [
    {
      id: "V1",
      claimId: "C1",
      voter: "strict_quorum_judge",
      refuted: false,
      confidence: "high",
      evidence: "Supported by S1",
    },
  ]);
  await store.appendDecisions(manifest.runId, [
    {
      claimId: "C1",
      decision: "confirmed",
      validVotes: 1,
      refutations: 0,
      rationale: "Supported by source",
    },
  ]);

  expect(await store.readSources(manifest.runId)).toHaveLength(1);
  expect(await store.readClaims(manifest.runId)).toHaveLength(1);
  expect(await store.readVotes(manifest.runId)).toHaveLength(1);
  expect(await store.readDecisions(manifest.runId)).toHaveLength(1);

  await rm(root, { recursive: true, force: true });
});

it("creates human-readable run title, question, and run index files", async () => {
  const { root, store } = await createTempStore();
  const manifest = await store.createRun({
    question: "对比 Claude Code dynamic workflow，研究如何在 Codex 中实现类似能力",
    workspace: root,
    mode: "mixed",
    depth: "standard",
    maxConcurrency: 8,
    maxTasks: 120,
    debugPrompts: false,
  });

  await expect(readFile(join(manifest.outputDir, "TITLE.txt"), "utf8")).resolves.toContain("Claude Code");
  await expect(readFile(join(manifest.outputDir, "QUESTION.md"), "utf8")).resolves.toContain(manifest.runId);
  await expect(readFile(join(root, ".codex-deep-research", "runs", "INDEX.md"), "utf8")).resolves.toContain(
    manifest.runId,
  );

  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests and confirm failure**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/run-store.test.ts
```

Expected: fails because `appendSources`, `readSources`, `appendClaims`, `readClaims`, `appendVotes`, `readVotes`, `appendDecisions`, `readDecisions`, and discovery files do not exist yet.

- [ ] **Step 3: Update runtime types**

In `src/codex-deep-research/runner/src/runtime/types.ts`, keep existing exported names and add these types.

```ts
export type SourceStatus = "searched" | "fetched" | "extracted" | "verified_used" | "failed";

export interface SourceCard {
  id: string;
  kind: "web" | "official_docs" | "repo" | "github" | "mcp" | "command";
  status: SourceStatus;
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
  summary: string;
  snippet?: string;
}

export interface ResearchFinding {
  id: string;
  title: string;
  claimIds: string[];
  sourceIds: string[];
  confidence: "high" | "medium" | "low";
  decision: "include" | "include_with_caveat" | "appendix_only" | "drop";
  summary: string;
  caveat?: string;
}
```

Update the existing `SourceCard` declaration rather than duplicating it. Keep `Claim`, `Vote`, and `ClaimDecision` names as the canonical runtime types; do not create parallel `ResearchClaim` names.

- [ ] **Step 4: Add RunStore helpers**

In `src/codex-deep-research/runner/src/runtime/run-store.ts`, import `readJsonl`:

```ts
import { appendJsonl, readJsonl } from "./jsonl.js";
```

Extend the type import:

```ts
import type { Claim, ClaimDecision, RunManifest, RunStatus, SourceCard, Vote, WorkflowEvent } from "./types.js";
```

Add public methods to `RunStore`:

```ts
async appendSources(runId: string, sources: SourceCard[]): Promise<void> {
  await this.appendRecords(runId, "sources.jsonl", sources);
}

async readSources(runId: string): Promise<SourceCard[]> {
  return await this.readRecords<SourceCard>(runId, "sources.jsonl");
}

async appendClaims(runId: string, claims: Claim[]): Promise<void> {
  await this.appendRecords(runId, "claims.jsonl", claims);
}

async readClaims(runId: string): Promise<Claim[]> {
  return await this.readRecords<Claim>(runId, "claims.jsonl");
}

async appendVotes(runId: string, votes: Vote[]): Promise<void> {
  await this.appendRecords(runId, "votes.jsonl", votes);
}

async readVotes(runId: string): Promise<Vote[]> {
  return await this.readRecords<Vote>(runId, "votes.jsonl");
}

async appendDecisions(runId: string, decisions: ClaimDecision[]): Promise<void> {
  await this.appendRecords(runId, "decisions.jsonl", decisions);
}

async readDecisions(runId: string): Promise<ClaimDecision[]> {
  return await this.readRecords<ClaimDecision>(runId, "decisions.jsonl");
}

async writeArtifact(runId: string, relativePath: string, content: string): Promise<string> {
  this.validateRunId(runId);
  if (relativePath.includes("..") || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Invalid artifact path: ${relativePath}`);
  }
  const artifactPath = join(this.resolveRunDir(runId), "artifacts", relativePath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, content, "utf8");
  return artifactPath;
}
```

Add private helpers:

```ts
private async appendRecords<T>(runId: string, fileName: string, records: T[]): Promise<void> {
  this.validateRunId(runId);
  await this.readManifest(runId);
  for (const record of records) {
    await appendJsonl(join(this.resolveRunDir(runId), fileName), record);
  }
}

private async readRecords<T>(runId: string, fileName: string): Promise<T[]> {
  this.validateRunId(runId);
  await this.readManifest(runId);
  return await readJsonl<T>(join(this.resolveRunDir(runId), fileName));
}
```

Add `dirname` import from `node:path`.

- [ ] **Step 5: Add run title/question/index files**

In `createRun`, after writing `manifest.json` and `status.json`, call:

```ts
await this.writeRunDiscoveryFiles(manifest);
```

Add exported helper below the class:

```ts
export function createRunTitle(question: string): string {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled research";
  }
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77).trimEnd()}...`;
}
```

Add private method:

```ts
private async writeRunDiscoveryFiles(manifest: RunManifest): Promise<void> {
  const title = createRunTitle(manifest.question);
  await writeFile(join(manifest.outputDir, "TITLE.txt"), `${title}\n`, "utf8");
  await writeFile(
    join(manifest.outputDir, "QUESTION.md"),
    [
      `# ${title}`,
      "",
      `- Run: \`${manifest.runId}\``,
      `- Created: \`${manifest.createdAt}\``,
      `- Mode: \`${manifest.mode}\``,
      `- Depth: \`${manifest.depth}\``,
      "",
      "## Question",
      "",
      manifest.question,
      "",
    ].join("\n"),
    "utf8",
  );
  await this.rewriteRunIndex();
}
```

Add private index method:

```ts
private async rewriteRunIndex(): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  await mkdir(this.runsDir(), { recursive: true });
  const entries: Array<{ runId: string; title: string; createdAt: string }> = [];
  for (const runId of await readdir(this.runsDir())) {
    if (!isRunId(runId)) {
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(this.runsDir(), runId, "manifest.json"), "utf8")) as RunManifest;
      const title = await readFile(join(this.runsDir(), runId, "TITLE.txt"), "utf8").then((value) => value.trim());
      entries.push({ runId, title: title || createRunTitle(manifest.question), createdAt: manifest.createdAt });
    } catch {
      continue;
    }
  }
  entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  await writeFile(
    join(this.runsDir(), "INDEX.md"),
    [
      "# Codex Deep Research Runs",
      "",
      ...entries.map(
        (entry) =>
          `- ${entry.createdAt} - ${entry.title} (\`${entry.runId}\`) - [status](./${entry.runId}/status.json) - [report](./${entry.runId}/report.md)`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );
}
```

- [ ] **Step 6: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/run-store.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: both commands pass.

---

## Task 2: M1 Schemas and Repo Source Provider

**Files:**

- Modify: `src/codex-deep-research/runner/src/workflow/schemas.ts`
- Create: `src/codex-deep-research/runner/src/runtime/source-provider.ts`
- Create: `src/codex-deep-research/runner/tests/source-provider.test.ts`
- Modify: `src/codex-deep-research/runner/tests/schemas.test.ts`

- [ ] **Step 1: Add schema tests**

Append to `src/codex-deep-research/runner/tests/schemas.test.ts`:

```ts
it("accepts M1 search results with source metadata", () => {
  const parsed = SearchSchema.parse({
    results: [
      {
        title: "Official announcement",
        urlOrPath: "https://example.com/announcement",
        kind: "web",
        quality: "official",
        snippet: "Dynamic workflow announcement",
        relevance: "high",
      },
    ],
  });

  expect(parsed.results[0].quality).toBe("official");
});

it("accepts M1 report findings with source ids", () => {
  const parsed = ReportSchema.parse({
    summary: "Codex can implement workflow orchestration with a runner.",
    findings: [
      {
        title: "Runner state is required",
        claim: "Workflow state must live outside model context.",
        confidence: "high",
        sources: ["S1"],
        evidence: "State files keep progress observable.",
      },
    ],
    caveats: "External source coverage depends on providers.",
    openQuestions: [],
  });

  expect(parsed.findings[0].sources).toEqual(["S1"]);
});
```

- [ ] **Step 2: Update schemas**

Change `SearchSchema` result object to:

```ts
z.object({
  title: z.string().min(1),
  urlOrPath: z.string().min(1),
  kind: z.enum(["web", "official_docs", "repo", "github", "mcp", "command"]).default("web"),
  quality: z.enum(["primary", "official", "secondary", "community", "commercial", "forum", "unreliable"]).default("secondary"),
  snippet: z.string().optional(),
  relevance: z.enum(["high", "medium", "low"]),
})
```

Keep the `.max(6)` budget.

Change `ReportSchema.findings` objects to include a `title`:

```ts
z.object({
  title: z.string().min(1),
  claim: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  sources: z.array(z.string().min(1)).min(1),
  evidence: z.string().min(1),
  vote: z.string().optional(),
})
```

- [ ] **Step 3: Add source provider tests**

Create `src/codex-deep-research/runner/tests/source-provider.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRepoSources, dedupeSources, normalizeWorkerSources } from "../src/runtime/source-provider.js";

describe("source provider", () => {
  it("collects repo fallback sources from docs and source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdr-source-provider-"));
    await mkdir(join(root, "docs", "superpowers", "specs"), { recursive: true });
    await mkdir(join(root, "src", "codex-deep-research"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Codex Plugin\nDeep research plugin.\n", "utf8");
    await writeFile(
      join(root, "docs", "superpowers", "specs", "deep-research.md"),
      "# Deep Research\nDynamic workflow implementation notes.\n",
      "utf8",
    );
    await writeFile(join(root, "src", "codex-deep-research", "runner.ts"), "export const runner = true;\n", "utf8");

    const sources = await collectRepoSources({
      workspace: root,
      question: "How should Codex implement dynamic workflow?",
      angleIds: ["angle_001"],
      now: "2026-06-05T00:00:00.000Z",
    });

    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.map((source) => source.kind)).toContain("repo");
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("Codex Plugin");

    await rm(root, { recursive: true, force: true });
  });

  it("deduplicates sources by normalized url or path", () => {
    const sources = normalizeWorkerSources(
      [
        { title: "A", urlOrPath: "https://example.com/page?utm_source=x", kind: "web", quality: "secondary", relevance: "high" },
        { title: "A duplicate", urlOrPath: "https://example.com/page", kind: "web", quality: "secondary", relevance: "medium" },
      ],
      { angleId: "angle_001", startIndex: 1, now: "2026-06-05T00:00:00.000Z" },
    );

    expect(dedupeSources(sources)).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Implement source provider**

Create `src/codex-deep-research/runner/src/runtime/source-provider.ts` with these exports:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createSequentialId } from "./ids.js";
import type { SourceCard, SourceQuality } from "./types.js";

export interface WorkerSearchResult {
  title: string;
  urlOrPath: string;
  kind?: SourceCard["kind"];
  quality?: SourceQuality;
  snippet?: string;
  relevance: "high" | "medium" | "low";
}

export interface RepoSourceInput {
  workspace: string;
  question: string;
  angleIds: string[];
  now?: string;
}

export function normalizeWorkerSources(
  results: WorkerSearchResult[],
  options: { angleId: string; startIndex: number; now: string },
): SourceCard[] {
  return results.map((result, index) => ({
    id: createSequentialId("S", options.startIndex + index),
    kind: result.kind ?? "web",
    status: "searched",
    title: result.title,
    urlOrPath: result.urlOrPath,
    retrievedAt: options.now,
    quality: result.quality ?? "secondary",
    authorityScore: scoreQuality(result.quality ?? "secondary"),
    freshnessScore: result.relevance === "high" ? 0.8 : result.relevance === "medium" ? 0.6 : 0.4,
    relevanceScore: result.relevance === "high" ? 0.9 : result.relevance === "medium" ? 0.65 : 0.35,
    angleIds: [options.angleId],
    excerptRefs: [],
    summary: result.snippet ?? result.title,
    snippet: result.snippet,
  }));
}

export async function collectRepoSources(input: RepoSourceInput): Promise<SourceCard[]> {
  const candidates = await collectCandidateFiles(input.workspace);
  const terms = tokenize(input.question);
  const now = input.now ?? new Date().toISOString();
  const scored = [];

  for (const path of candidates) {
    const content = await readFile(join(input.workspace, path), "utf8").catch(() => "");
    const score = terms.filter((term) => content.toLowerCase().includes(term)).length;
    const baseScore = path.includes("codex-deep-research") ? 2 : 0;
    scored.push({ path, content, score: score + baseScore });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 6)
    .map((candidate, index) => ({
      id: createSequentialId("S", index + 1),
      kind: "repo",
      status: "fetched",
      title: candidate.path,
      urlOrPath: candidate.path,
      retrievedAt: now,
      quality: candidate.path.includes("docs/superpowers/specs") ? "official" : "secondary",
      authorityScore: candidate.path.includes("docs/superpowers/specs") ? 0.85 : 0.65,
      freshnessScore: 0.7,
      relevanceScore: Math.min(0.95, 0.45 + candidate.score * 0.1),
      angleIds: input.angleIds,
      excerptRefs: [],
      summary: summarize(candidate.content),
      snippet: summarize(candidate.content),
    }));
}

export function dedupeSources(sources: SourceCard[]): SourceCard[] {
  const seen = new Map<string, SourceCard>();
  for (const source of sources) {
    const key = normalizeSourceKey(source.urlOrPath);
    const existing = seen.get(key);
    if (!existing || source.relevanceScore > existing.relevanceScore) {
      seen.set(key, { ...source, angleIds: Array.from(new Set([...(existing?.angleIds ?? []), ...source.angleIds])) });
    }
  }
  return Array.from(seen.values()).map((source, index) => ({ ...source, id: createSequentialId("S", index + 1) }));
}

async function collectCandidateFiles(workspace: string): Promise<string[]> {
  const roots = ["README.md", "docs/superpowers/specs", "docs/superpowers/plans", "docs/superpowers/archives", "src/codex-deep-research"];
  const files: string[] = [];
  for (const root of roots) {
    const absolute = join(workspace, root);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) {
      continue;
    }
    if (info.isFile()) {
      files.push(root.replaceAll("\\", "/"));
      continue;
    }
    for (const file of await walk(absolute)) {
      if (/\.(?:md|ts|json)$/i.test(file)) {
        files.push(relative(workspace, file).replaceAll("\\", "/"));
      }
    }
  }
  return files;
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function normalizeSourceKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  }
}

function tokenize(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3);
}

function summarize(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 500);
}

function scoreQuality(quality: SourceQuality): number {
  return { primary: 0.95, official: 0.9, secondary: 0.7, community: 0.55, commercial: 0.45, forum: 0.4, unreliable: 0.2 }[quality];
}
```

- [ ] **Step 5: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/schemas.test.ts runner/tests/source-provider.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: both commands pass.

---

## Task 3: Research State Decisions

**Files:**

- Create: `src/codex-deep-research/runner/src/runtime/research-state.ts`
- Create: `src/codex-deep-research/runner/tests/research-state.test.ts`

- [ ] **Step 1: Add decision tests**

Create `src/codex-deep-research/runner/tests/research-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideClaims, selectReportClaims } from "../src/runtime/research-state.js";
import type { Claim, Vote } from "../src/runtime/types.js";

const claims: Claim[] = [
  {
    id: "C1",
    text: "Codex needs state outside model context.",
    sourceId: "S1",
    quote: "state files keep workflow observable",
    importance: "central",
    freshnessRequired: false,
  },
  {
    id: "C2",
    text: "Unsupported claim should not enter report.",
    sourceId: "S2",
    quote: "weak quote",
    importance: "supporting",
    freshnessRequired: true,
  },
];

describe("research state decisions", () => {
  it("confirms claims with two valid non-refuting votes", () => {
    const votes: Vote[] = [
      { id: "V1", claimId: "C1", voter: "strict", refuted: false, confidence: "high", evidence: "S1 supports it" },
      { id: "V2", claimId: "C1", voter: "quality", refuted: false, confidence: "medium", evidence: "Source is official" },
      { id: "V3", claimId: "C1", voter: "freshness", refuted: false, confidence: "low", evidence: "Not time sensitive" },
    ];

    expect(decideClaims(claims, votes)[0]).toMatchObject({ claimId: "C1", decision: "confirmed", validVotes: 3 });
  });

  it("refutes claims with two refutations", () => {
    const votes: Vote[] = [
      { id: "V1", claimId: "C2", voter: "strict", refuted: true, confidence: "high", evidence: "Contradicted" },
      { id: "V2", claimId: "C2", voter: "quality", refuted: true, confidence: "medium", evidence: "Weak source" },
    ];

    expect(decideClaims(claims, votes)[0]).toMatchObject({ claimId: "C2", decision: "refuted", refutations: 2 });
  });

  it("selects only confirmed or weakened claims for report body", () => {
    const decisions = [
      { claimId: "C1", decision: "confirmed" as const, validVotes: 3, refutations: 0, rationale: "ok" },
      { claimId: "C2", decision: "refuted" as const, validVotes: 2, refutations: 2, rationale: "no" },
    ];

    expect(selectReportClaims(claims, decisions).map((claim) => claim.id)).toEqual(["C1"]);
  });
});
```

- [ ] **Step 2: Implement decision helpers**

Create `src/codex-deep-research/runner/src/runtime/research-state.ts`:

```ts
import type { Claim, ClaimDecision, Vote } from "./types.js";

export function decideClaims(claims: Claim[], votes: Vote[]): ClaimDecision[] {
  return claims.map((claim) => {
    const claimVotes = votes.filter((vote) => vote.claimId === claim.id);
    const validVotes = claimVotes.length;
    const refutations = claimVotes.filter((vote) => vote.refuted).length;
    const decision =
      refutations >= 2 ? "refuted" : validVotes >= 2 && refutations < 2 ? (refutations === 1 ? "weakened" : "confirmed") : "unverified";

    return {
      claimId: claim.id,
      decision,
      validVotes,
      refutations,
      rationale: buildRationale(decision, validVotes, refutations),
    };
  });
}

export function selectReportClaims(claims: Claim[], decisions: ClaimDecision[]): Claim[] {
  const allowed = new Set(
    decisions
      .filter((decision) => decision.decision === "confirmed" || decision.decision === "weakened")
      .map((decision) => decision.claimId),
  );
  return claims.filter((claim) => allowed.has(claim.id));
}

function buildRationale(decision: ClaimDecision["decision"], validVotes: number, refutations: number): string {
  if (decision === "refuted") {
    return `Dropped because ${refutations} verifier votes refuted the claim.`;
  }
  if (decision === "unverified") {
    return `Dropped because only ${validVotes} verifier votes were valid.`;
  }
  if (decision === "weakened") {
    return `Included with caveat because ${refutations} verifier raised a concern.`;
  }
  return `Included because ${validVotes} verifier votes supported the claim.`;
}
```

- [ ] **Step 3: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/research-state.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: both commands pass.

---

## Task 4: Report Writer and Verifier for Cited Output

**Files:**

- Modify: `src/codex-deep-research/runner/src/report/report-writer.ts`
- Modify: `src/codex-deep-research/runner/src/report/report-verifier.ts`
- Modify: `src/codex-deep-research/runner/tests/report-verifier.test.ts`
- Create or update report writer tests inside `src/codex-deep-research/runner/tests/deep-research.workflow.test.ts`

- [ ] **Step 1: Add verifier tests for M1 source statuses**

In `src/codex-deep-research/runner/tests/report-verifier.test.ts`, keep existing tests and add:

```ts
it("accepts extracted and verified_used source statuses", () => {
  const result = verifyReportCitations("Claim cites [S1] and [S2].", [
    { id: "S1", status: "extracted" },
    { id: "S2", status: "verified_used" },
  ]);

  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Expand ReportInput**

Replace `ReportInput` in `report-writer.ts` with:

```ts
export interface ReportInput {
  outputDir: string;
  question: string;
  summary: string;
  claims: Claim[];
  decisions: ClaimDecision[];
  sources: SourceCard[];
  caveats?: string;
}
```

Import:

```ts
import type { Claim, ClaimDecision, SourceCard } from "../runtime/types.js";
```

- [ ] **Step 3: Generate cited findings**

Use this output structure:

```md
# <question>

## 摘要

...

## 关键发现

### 1. <claim text>

- Confidence: high | medium | low
- Decision: confirmed | weakened
- Evidence: <quote> [S1]
- Caveat: <only for weakened>

## 不确定性与限制

...

## 来源

- [S1] <title>: <urlOrPath>
```

Implementation rules:

- Include only decisions with `confirmed` or `weakened`.
- Source id is `claim.sourceId`.
- Confidence:
  - `confirmed` with `validVotes >= 3`: `high`
  - `confirmed` with `validVotes == 2`: `medium`
  - `weakened`: `low`
- If no included claims exist, write a partial report with a clear warning and no fake finding.

- [ ] **Step 4: Keep verifier strict**

`verifyReportCitations` already permits `fetched`, `extracted`, `verified_used`. Keep that rule. Ensure its input type accepts `status: string` or `SourceStatus` without forcing every report test to construct full `SourceCard`.

- [ ] **Step 5: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/report-verifier.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: both commands pass.

---

## Task 5: Workflow Phase Chain

**Files:**

- Modify: `src/codex-deep-research/runner/src/workflow/primitives.ts`
- Modify: `src/codex-deep-research/runner/src/workflow/deep-research.workflow.ts`
- Modify: `src/codex-deep-research/runner/tests/deep-research.workflow.test.ts`

- [ ] **Step 1: Add failing full-workflow test**

Replace the first `runDeepResearch` test currently named `"runs a minimal fake workflow and writes a report"` with this M1 test.

```ts
it("runs a cited M1 workflow and writes source, claim, vote, and decision files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdr-flow-"));
  await mkdir(join(root, "docs", "superpowers", "specs"), { recursive: true });
  await writeFile(
    join(root, "docs", "superpowers", "specs", "dynamic-workflow.md"),
    "# Dynamic Workflow\nCodex should keep workflow state outside model context and cite sources.\n",
    "utf8",
  );
  const store = new RunStore(root);
  const manifest = await store.createRun({
    question: "How should Codex implement dynamic workflow research?",
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
      summary: "Use official, implementation, and skeptical angles.",
      angles: [
        { label: "official", query: "official dynamic workflow docs", rationale: "Primary source" },
        { label: "implementation", query: "Codex workflow runner implementation", rationale: "Implementation" },
        { label: "skeptical", query: "workflow limitations", rationale: "Risk" },
      ],
    },
    {
      results: [
        {
          title: "Official dynamic workflow note",
          urlOrPath: "https://example.com/dynamic-workflow",
          kind: "web",
          quality: "official",
          snippet: "Dynamic workflow requires state and observable tasks.",
          relevance: "high",
        },
      ],
    },
    {
      results: [
        {
          title: "Codex runner design",
          urlOrPath: "docs/superpowers/specs/dynamic-workflow.md",
          kind: "repo",
          quality: "official",
          snippet: "Codex should keep workflow state outside model context.",
          relevance: "high",
        },
      ],
    },
    {
      results: [
        {
          title: "Workflow limitations",
          urlOrPath: "https://example.com/workflow-limitations",
          kind: "web",
          quality: "secondary",
          snippet: "Unchecked workflows need verification.",
          relevance: "medium",
        },
      ],
    },
    {
      sourceQuality: "official",
      publishDate: "2026-06-01",
      claims: [
        {
          claim: "Dynamic workflow implementation needs durable state.",
          quote: "Dynamic workflow requires state and observable tasks.",
          importance: "central",
        },
      ],
    },
    {
      sourceQuality: "official",
      claims: [
        {
          claim: "Codex should keep workflow state outside model context.",
          quote: "Codex should keep workflow state outside model context.",
          importance: "central",
        },
      ],
    },
    {
      sourceQuality: "secondary",
      claims: [
        {
          claim: "Unchecked workflows need a verification phase.",
          quote: "Unchecked workflows need verification.",
          importance: "supporting",
        },
      ],
    },
    { refuted: false, evidence: "The source directly supports durable state.", confidence: "high" },
    { refuted: false, evidence: "The source quality is official.", confidence: "medium" },
    { refuted: false, evidence: "The claim is not time-sensitive.", confidence: "medium" },
    { refuted: false, evidence: "The repo source supports externalized state.", confidence: "high" },
    { refuted: false, evidence: "The quote is directly relevant.", confidence: "medium" },
    { refuted: false, evidence: "No freshness issue found.", confidence: "medium" },
    { refuted: false, evidence: "The limitation source supports verification.", confidence: "medium" },
    { refuted: false, evidence: "The source is secondary but usable.", confidence: "medium" },
    { refuted: false, evidence: "The scope matches the question.", confidence: "medium" },
  ]);

  await runDeepResearch({ manifest, store, worker });

  const status = await store.readStatus(manifest.runId);
  expect(status.state).toBe("completed");
  expect(status.phase).toBe("completed");
  expect(status.research.sourcesCollected).toBeGreaterThanOrEqual(3);
  expect(status.research.claimsExtracted).toBeGreaterThanOrEqual(3);
  expect(status.research.claimsVerified).toBeGreaterThanOrEqual(3);
  expect(status.research.confirmed).toBeGreaterThanOrEqual(3);
  await expect(readFile(join(manifest.outputDir, "sources.jsonl"), "utf8")).resolves.toContain("Official dynamic workflow note");
  await expect(readFile(join(manifest.outputDir, "claims.jsonl"), "utf8")).resolves.toContain("durable state");
  await expect(readFile(join(manifest.outputDir, "votes.jsonl"), "utf8")).resolves.toContain("strict_quorum_judge");
  await expect(readFile(join(manifest.outputDir, "decisions.jsonl"), "utf8")).resolves.toContain("confirmed");
  await expect(readFile(join(manifest.outputDir, "report.md"), "utf8")).resolves.toContain("[S1]");
  await expect(readFile(join(manifest.outputDir, "report.sources.md"), "utf8")).resolves.not.toContain("No sources were collected");

  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test and confirm failure**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/deep-research.workflow.test.ts
```

Expected: fails because current workflow only runs scope and writes no source/claim/vote/decision files.

- [ ] **Step 3: Enhance task events**

In `workflow/primitives.ts`, update `agent` events to include task metadata:

```ts
await runtime.store.emit(runtime.runId, {
  type: "task.started",
  taskId: task.label,
  message: task.label,
  data: {
    role: task.role,
    persona: task.persona,
    objective: task.objective,
    schemaName: task.schemaName,
  },
});
```

This requires extending `WorkerTask` in `worker-client.ts`:

```ts
role?: Role;
persona?: string;
objective?: string;
```

Import `Role` from runtime types.

- [ ] **Step 4: Implement full phase chain**

In `deep-research.workflow.ts`, keep `stopIfCancellationRequested`. Replace the post-scope immediate synthesize path with these phase functions:

```ts
const scope = await runPlanning(runtime, input.manifest);
const sources = await runSearching(runtime, input.manifest, scope);
const fetchedSources = await runCollecting(runtime, input.manifest, sources);
const claims = await runExtracting(runtime, fetchedSources);
const votes = await runVoting(runtime, claims);
const decisions = decideClaims(claims, votes);
await input.store.appendDecisions(input.manifest.runId, decisions);
const { reportPath, summaryPath, sourcesPath } = await runSynthesis(runtime, input.manifest, fetchedSources, claims, decisions);
await runReportVerification(runtime, fetchedSources, reportPath);
```

Concrete behavior:

- `runSearching`
  - `phase(runtime, "searching")`
  - For each `scope.angles`, call `agent` with `SearchSchema`.
  - Normalize worker results with `normalizeWorkerSources`.
  - Always merge `collectRepoSources`.
  - Dedupe.
  - Append to `sources.jsonl`.
  - Set `status.research.sourcesCollected`.
- `runCollecting`
  - `phase(runtime, "collecting")`
  - For each source, write `artifacts/sources/<source.id>.md`.
  - Mark `status: "fetched"`.
  - Append updated sources to `sources.jsonl` only if the source was not already appended as fetched; simplest M1 path may append searched and fetched records, but report must use the latest in-memory fetched list.
  - Set `sourcesFetched`.
- `runExtracting`
  - `phase(runtime, "extracting")`
  - For each fetched source, call `agent` with `ExtractSchema`.
  - Map claims to `C001`, `C002`, etc.
  - Append to `claims.jsonl`.
- `runVoting`
  - `phase(runtime, "cross_checking")`, then `phase(runtime, "voting")`.
  - For each central/supporting claim, run 3 vote tasks with personas:
    - `strict_quorum_judge`
    - `source_quality_voter`
    - `freshness_or_scope_voter`
  - Parse `VerdictSchema`.
  - Append to `votes.jsonl`.
- `runSynthesis`
  - `phase(runtime, "synthesizing")`.
  - Call `writeReports` using sources, claims, decisions.
- `runReportVerification`
  - `phase(runtime, "verifying")`.
  - Read report markdown and call `verifyReportCitations`.
  - If verifier fails, set `status.state = "partial"` and write a warning into report.

- [ ] **Step 5: Update status consistently**

After each phase:

```ts
runtime.status.research.sourcesCollected = sources.length;
runtime.status.research.sourcesFetched = fetchedSources.length;
runtime.status.research.claimsExtracted = claims.length;
runtime.status.research.claimsVerified = decisions.length;
runtime.status.research.confirmed = decisions.filter((d) => d.decision === "confirmed").length;
runtime.status.research.weakened = decisions.filter((d) => d.decision === "weakened").length;
runtime.status.research.refuted = decisions.filter((d) => d.decision === "refuted").length;
runtime.status.research.unverified = decisions.filter((d) => d.decision === "unverified").length;
await runtime.store.writeStatus(runtime.status);
```

- [ ] **Step 6: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/deep-research.workflow.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: workflow tests and typecheck pass. Existing cancellation tests must still pass.

---

## Task 6: Windows Console Controls

**Files:**

- Modify: `src/codex-deep-research/runner/src/commands/start.ts`
- Modify: `src/codex-deep-research/runner/src/cli.ts`
- Modify: `src/codex-deep-research/runner/tests/commands.test.ts`

- [ ] **Step 1: Add tests for hidden default spawn**

In `commands.test.ts`, update the existing `"prints a status path created with platform path joining"` test expectation:

```ts
expect(spawn).toHaveBeenCalledWith(
  expect.any(String),
  expect.any(Array),
  expect.objectContaining({
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }),
);
```

- [ ] **Step 2: Add test for open-console option**

Append:

```ts
it("opens a watcher console when requested", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cdr-start-console-workspace-"));
  const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-start-console-plugin-"));
  process.env.INIT_CWD = workspace;
  vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  await startCommand("Should open watcher console?", {
    mode: "mixed",
    depth: "standard",
    maxConcurrency: "8",
    maxTasks: "120",
    debugPrompts: false,
    openConsole: true,
  });

  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Array),
    expect.objectContaining({ detached: true, windowsHide: false }),
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(pluginCwd, { recursive: true, force: true });
});
```

- [ ] **Step 3: Extend option parsing**

In `start.ts`, add `openConsole?: unknown` to `RawStartOptions` and `openConsole: boolean` to `StartOptions`.

In `validateStartOptions`, add:

```ts
openConsole: Boolean(options.openConsole),
```

- [ ] **Step 4: Hide default background runner**

Update runner spawn:

```ts
const child = spawn(launcher.command, launcher.args(manifest.runId), {
  cwd: workspace,
  detached: true,
  env: { ...process.env, INIT_CWD: workspace },
  stdio: "ignore",
  windowsHide: true,
});
```

- [ ] **Step 5: Add watcher console launcher**

Add after `child.unref()`:

```ts
if (options.openConsole) {
  const watcher = createWatcherConsoleLauncher(launcher, manifest.runId);
  const watcherChild = spawn(watcher.command, watcher.args, {
    cwd: workspace,
    detached: true,
    env: { ...process.env, INIT_CWD: workspace },
    stdio: "ignore",
    windowsHide: false,
  });
  watcherChild.unref();
}
```

Add exported helper for tests:

```ts
export function createWatcherConsoleLauncher(launcher: StartLauncher, runId: string): { command: string; args: string[] } {
  const commandLine = [quoteForShell(launcher.command), ...launcher.args(runId).map(quoteForShell).slice(0, -2), "watch", runId]
    .filter(Boolean)
    .join(" ");
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoExit", "-Command", commandLine],
    };
  }
  return {
    command: launcher.command,
    args: launcher.args(runId).slice(0, -2).concat(["watch", runId]),
  };
}

function quoteForShell(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
```

Note: This helper intentionally starts with `powershell.exe` fallback for M1. Add `wt.exe` preference only after this path is tested, because `wt.exe` behavior differs across Windows installs.

- [ ] **Step 6: Wire CLI option**

In `cli.ts`, add:

```ts
.option("--open-console", "open a watcher console for this run", false)
```

before `.action(startCommand)`.

- [ ] **Step 7: Run task verification**

```powershell
npm --prefix src\codex-deep-research test -- runner/tests/commands.test.ts
npm --prefix src\codex-deep-research run typecheck
```

Expected: both commands pass.

---

## Task 7: Packaging, Installed CLI, and End-to-End Test

**Files:**

- Modify: `src/codex-deep-research/package.json` only if scripts need adjustment after Task 0.
- Modify: `src/codex-deep-research/package-lock.json` only if dependency security verification requires a lockfile refresh after Task 0.
- Generated: `plugins/codex-deep-research/bin/codex-deep-research.mjs`
- Generated: `plugins/codex-deep-research/bin/codex-deep-research.cmd`
- Update docs only if command behavior changes:
  - `plugins/codex-deep-research/README.md`
  - `plugins/codex-deep-research/skills/deep-research/SKILL.md`

- [ ] **Step 1: Run official npm security audit**

```powershell
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
```

Expected:

```text
found 0 vulnerabilities
```

Do not use the default mirror result for release gating, because `npmmirror` returned `[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet` during plan verification.

- [ ] **Step 2: Run all tests**

```powershell
npm --prefix src\codex-deep-research test
```

Expected: all Vitest files pass.

- [ ] **Step 3: Run typecheck**

```powershell
npm --prefix src\codex-deep-research run typecheck
```

Expected: TypeScript exits 0.

- [ ] **Step 4: Build Windows CLI**

```powershell
npm --prefix src\codex-deep-research run build
```

Expected:

```text
plugins\codex-deep-research\bin\codex-deep-research.mjs
plugins\codex-deep-research\bin\codex-deep-research.cmd
```

are updated.

- [ ] **Step 5: Smoke installed CLI help**

```powershell
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd --help
```

Expected output contains:

```text
Usage: codex-deep-research [options] [command]
start
watch
report
```

- [ ] **Step 6: End-to-end research run**

Start:

```powershell
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd start "对比 Claude Code 最近新推出的 dynamic workflow，研究如何在 Codex 中实现类似能力"
```

Capture `runId` from JSON output.

Watch:

```powershell
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd watch <run_id>
```

Expected event types include:

```text
phase.started planning
phase.started searching
phase.started collecting
phase.started extracting
phase.started cross_checking
phase.started voting
phase.started synthesizing
phase.started verifying
report.written
```

Inspect artifacts:

```powershell
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\sources.jsonl
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\claims.jsonl
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\votes.jsonl
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\decisions.jsonl
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\report.md
Get-Content -Encoding utf8 .codex-deep-research\runs\<run_id>\report.sources.md
```

Expected:

- `sources.jsonl` has at least 3 lines.
- `claims.jsonl` has at least 3 lines.
- `votes.jsonl` has at least 6 lines.
- `decisions.jsonl` has at least 3 lines.
- `report.md` contains `[S1]`.
- `report.sources.md` does not contain `_No sources were collected by this v0 run._`.
- `TITLE.txt`, `QUESTION.md`, and `.codex-deep-research/runs/INDEX.md` exist and contain the run topic.

- [ ] **Step 7: Verify default console behavior**

Manual check:

```powershell
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd start "console hidden smoke"
```

Expected: no extra Windows console appears for the background runner.

Manual check for visible watcher:

```powershell
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd start --open-console "console watcher smoke"
```

Expected: one watcher console opens and prints `watch` events for the new run.

- [ ] **Step 8: Git and asset closeout**

Run:

```powershell
git status --short --branch
git diff --check
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
$env:PYTHONIOENCODING='utf-8'; python C:\Users\10062\.codex\plugins\cache\codex-plugin\superpowers-asset-compounding\0.2.5\skills\compound-development-asset\scripts\asset_closeout.py . --topic "codex-deep-research m1" --json
```

Expected:

- `git diff --check` exits 0.
- official npm audit exits 0.
- asset closeout either finds the M1 spec/plan or asks for an archive after implementation is complete.
- Final response includes an auditable `asset_gate`.

Do not commit until the user explicitly asks.

---

## Implementation Order and Review Gates

Use subagent-driven development if the user approves implementation:

1. Task 0 main agent: dependency audit and vulnerable build-chain upgrade.
2. Task 1 local or subagent: runtime files and run discoverability.
3. Task 2 subagent: source provider and schemas.
4. Task 3 subagent: decision helpers.
5. Task 4 subagent: report writer/verifier.
6. Task 5 main agent: workflow integration, because it touches the most shared behavior.
7. Task 6 subagent or main agent: Windows console controls.
8. Task 7 main agent: packaging, E2E, audit, asset closeout.

After each task:

```powershell
npm --prefix src\codex-deep-research test -- <task-specific-tests>
npm --prefix src\codex-deep-research run typecheck
npm --prefix src\codex-deep-research audit --audit-level=moderate --registry=https://registry.npmjs.org/
git status --short
```

If a task changes dependencies or generated CLI behavior, run:

```powershell
npm --prefix src\codex-deep-research run build
& .\plugins\codex-deep-research\bin\codex-deep-research.cmd --help
```

Do not move to the next task while task-specific tests fail.

---

## Self-Review

Spec coverage:

- Async run lifecycle, watchable status, and visible run topic: Task 1, Task 5, Task 6, Task 7.
- Research source collection and repo fallback: Task 2, Task 5.
- Claim extraction, adversarial verification, and voting decisions: Task 3, Task 5.
- Cited Markdown report and strict citation verification: Task 4, Task 7.
- Windows CLI packaging and no per-install build requirement: Task 7.
- Dependency vulnerability prevention: Task 0 and Task 7.

Placeholder scan:

```powershell
rg -n "T[B]D|T[O]DO|implement lat[e]r|fill in deta[i]ls|Add appropriat[e]|Write tests for the abov[e]|Similar t[o]|待[定]|占[位]|先[不]|以后[再]|后续[再]" docs\superpowers\plans\2026-06-05-codex-deep-research-m1-implementation-plan.md
```

Expected: no matches.

Type consistency:

- Runtime source type is `SourceCard`; do not introduce parallel `ResearchSource`.
- Runtime claim type is `Claim`; do not introduce parallel `ResearchClaim`.
- Runtime vote type is `Vote`.
- Runtime decision type is `ClaimDecision`.
- Workflow entry point remains `runDeepResearch(input: DeepResearchRunInput): Promise<void>`.
- Filesystem boundary remains `RunStore`.
- Worker execution boundary remains `WorkerClient.run<T>(task: WorkerTask): Promise<T>`.

Dependency consistency:

- Feature tasks should not add new third-party packages.
- If a package is added anyway, Task 0 Step 6 is mandatory before continuing.
- Release gate is official npm audit, not mirror audit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-codex-deep-research-m1-implementation-plan.md`.

Execution options:

1. Subagent-Driven: dispatch a fresh subagent per task, review between tasks, fastest with the least context bleed.
2. Inline Execution: execute tasks in this session using `superpowers:executing-plans`, with checkpoints after each task.

Recommended path: Subagent-Driven. Start with Task 0 because current official npm audit is failing.
