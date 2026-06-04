import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..", "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const pluginRelativePath = "plugins/codex-deep-research";

async function createTrackedPluginCopy(): Promise<{ copyRoot: string; workspace: string; cleanup: () => Promise<void> }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "cdr-installed-runner-"));
  const workspace = await mkdtemp(join(tmpdir(), "cdr-installed-workspace-"));
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", pluginRelativePath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  for (const relativePath of stdout.split("\0").filter(Boolean)) {
    const source = join(repoRoot, relativePath);
    const target = join(tempRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  const copyRoot = join(tempRoot, pluginRelativePath);
  await rm(join(copyRoot, "dist"), { recursive: true, force: true });
  await rm(join(copyRoot, "node_modules"), { recursive: true, force: true });

  return {
    copyRoot,
    workspace,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

describe("installed wrapper", () => {
  it("runs installed commands from a tracked-file plugin copy without dist or node_modules", async () => {
    const copy = await createTrackedPluginCopy();

    try {
      const commonOptions = {
        cwd: copy.workspace,
        env: { ...process.env, INIT_CWD: copy.workspace },
        encoding: "utf8" as const,
        windowsHide: true,
      };
      const list = await execFileAsync(process.execPath, [join(copy.copyRoot, "scripts", "run.mjs"), "list"], commonOptions);
      const help = await execFileAsync(process.execPath, [join(copy.copyRoot, "scripts", "run.mjs"), "--help"], commonOptions);

      expect(list.stdout).toBe("\n");
      expect(help.stdout).toContain("Usage: codex-deep-research <command>");
      expect(help.stdout).toContain("list");
      expect(help.stdout).toContain("watch");
      expect(help.stdout).toContain("cancel");

      const runId = "dr_20260102T030405678Z";
      const outputDir = join(copy.workspace, ".codex-deep-research", "runs", runId);
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(outputDir, "manifest.json"),
        JSON.stringify(
          {
            runId,
            question: "Can installed wrapper inspect tracked copies?",
            workspace: copy.workspace,
            outputDir,
            mode: "mixed",
            depth: "standard",
            maxConcurrency: 8,
            maxTasks: 120,
            debugPrompts: false,
            createdAt: "2026-01-02T03:04:05.678Z",
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(outputDir, "status.json"),
        JSON.stringify(
          {
            runId,
            question: "Can installed wrapper inspect tracked copies?",
            phase: "synthesizing",
            state: "running",
            startedAt: "2026-01-02T03:04:05.678Z",
            updatedAt: "2026-01-02T03:04:05.678Z",
            progress: { queued: 0, running: 0, completed: 1, failed: 0, skipped: 0 },
            research: {
              angles: 3,
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
            output: {
              reportPath: join(outputDir, "report.md"),
              summaryPath: join(outputDir, "report.summary.md"),
              sourcesPath: join(outputDir, "report.sources.md"),
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(outputDir, "events.jsonl"),
        JSON.stringify({ runId, type: "run.created", at: "2026-01-02T03:04:05.678Z", message: "Run created" }) + "\n",
        "utf8",
      );
      await writeFile(join(outputDir, "report.md"), "# Report\n", "utf8");
      await writeFile(join(outputDir, "report.summary.md"), "Summary from tracked copy.\n", "utf8");
      await writeFile(join(outputDir, "report.sources.md"), "No sources.\n", "utf8");

      const listedRun = await execFileAsync(
        process.execPath,
        [join(copy.copyRoot, "scripts", "run.mjs"), "list"],
        commonOptions,
      );
      const status = await execFileAsync(
        process.execPath,
        [join(copy.copyRoot, "scripts", "run.mjs"), "status", runId],
        commonOptions,
      );
      const report = await execFileAsync(
        process.execPath,
        [join(copy.copyRoot, "scripts", "run.mjs"), "report", runId],
        commonOptions,
      );
      const cancel = await execFileAsync(
        process.execPath,
        [join(copy.copyRoot, "scripts", "run.mjs"), "cancel", runId],
        commonOptions,
      );
      const watch = await execFileAsync(
        process.execPath,
        [join(copy.copyRoot, "scripts", "run.mjs"), "watch", runId],
        commonOptions,
      );

      expect(listedRun.stdout.trim()).toBe(runId);
      expect(JSON.parse(status.stdout)).toMatchObject({ runId, state: "running" });
      expect(report.stdout).toContain("Summary from tracked copy.");
      expect(cancel.stdout).toContain(`Cancel requested for ${runId}.`);
      expect(JSON.parse(await readFile(join(outputDir, "status.json"), "utf8"))).toMatchObject({ state: "cancelled" });
      expect(watch.stdout).toContain("run.cancel_requested");
    } finally {
      await copy.cleanup();
    }
  });
});
