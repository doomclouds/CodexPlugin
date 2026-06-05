import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelCommand } from "../src/commands/cancel.js";
import { listCommand } from "../src/commands/list.js";
import { reportCommand } from "../src/commands/report.js";
import { resolveStartLauncher, startCommand, validateStartOptions } from "../src/commands/start.js";
import { watchCommand } from "../src/commands/watch.js";
import { resolveWorkspaceRoot } from "../src/commands/workspace.js";
import { RunStore } from "../src/runtime/run-store.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const originalInitCwd = process.env.INIT_CWD;

afterEach(() => {
  if (originalInitCwd === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = originalInitCwd;
  }
  vi.restoreAllMocks();
});

describe("command workspace resolution", () => {
  it("uses INIT_CWD before process.cwd for npm --prefix invocation", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\plugin");
    process.env.INIT_CWD = "C:\\workspace";

    expect(resolveWorkspaceRoot()).toBe("C:\\workspace");
    expect(cwdSpy).not.toHaveBeenCalled();
  });

  it("falls back to process.cwd when INIT_CWD is not set", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\plugin");
    delete process.env.INIT_CWD;

    expect(resolveWorkspaceRoot()).toBe("C:\\plugin");
    expect(cwdSpy).toHaveBeenCalledOnce();
  });
});

describe("listCommand", () => {
  it("lists sorted run ids from the INIT_CWD workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-list-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-list-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runsDir = join(workspace, ".codex-deep-research", "runs");
    await mkdir(join(runsDir, "dr_20260102T030405678Z"), { recursive: true });
    await mkdir(join(runsDir, "not-a-run"), { recursive: true });
    await mkdir(join(runsDir, "dr_20260101T030405678Z"), { recursive: true });

    await listCommand();

    expect(logSpy).toHaveBeenCalledWith("dr_20260101T030405678Z\ndr_20260102T030405678Z");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });
});

describe("reportCommand", () => {
  it("reads fixed report files from the run directory instead of trusting status output paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-report-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-report-plugin-"));
    const outside = await mkdtemp(join(tmpdir(), "cdr-report-outside-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should report trust status paths?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });
    const status = await store.readStatus(manifest.runId);
    await writeFile(join(manifest.outputDir, "report.md"), "# Real report\n", "utf8");
    await writeFile(join(manifest.outputDir, "report.summary.md"), "Real summary\n", "utf8");
    await writeFile(join(outside, "report.summary.md"), "Tampered summary\n", "utf8");
    await writeFile(
      join(manifest.outputDir, "status.json"),
      JSON.stringify(
        {
          ...status,
          output: {
            reportPath: join(outside, "report.md"),
            summaryPath: join(outside, "report.summary.md"),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await reportCommand(manifest.runId);

    const message = logSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain(`Report: ${join(manifest.outputDir, "report.md")}`);
    expect(message).toContain("Real summary");
    expect(message).not.toContain("Tampered summary");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("fails clearly when report.md is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-report-missing-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-report-missing-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should report require report.md?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });
    const status = await store.readStatus(manifest.runId);
    await writeFile(join(manifest.outputDir, "report.summary.md"), "Real summary\n", "utf8");
    await writeFile(
      join(manifest.outputDir, "status.json"),
      JSON.stringify(
        {
          ...status,
          output: {
            reportPath: join(manifest.outputDir, "report.md"),
            summaryPath: join(manifest.outputDir, "report.summary.md"),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(reportCommand(manifest.runId)).rejects.toThrow(
      `Report file is missing for ${manifest.runId}: ${join(manifest.outputDir, "report.md")}`,
    );

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });
});

describe("watchCommand", () => {
  it("prints empty output for a terminal run with no events file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-watch-missing-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-watch-missing-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should watch tolerate missing events?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });
    await rm(join(manifest.outputDir, "events.jsonl"));
    await store.writeStatus({ ...(await store.readStatus(manifest.runId)), state: "completed", phase: "completed" });

    await watchCommand(manifest.runId);

    expect(logSpy).toHaveBeenCalledWith("");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });

  it("follows appended events until the run reaches a terminal state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-watch-tail-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-watch-tail-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should watch follow event appends?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });

    const watch = watchCommand(manifest.runId, { pollIntervalMs: 5 });
    await appendFile(
      join(manifest.outputDir, "events.jsonl"),
      JSON.stringify({ runId: manifest.runId, type: "test.appended", at: new Date().toISOString() }) + "\n",
      "utf8",
    );
    await store.writeStatus({ ...(await store.readStatus(manifest.runId)), state: "completed", phase: "completed" });

    await watch;

    expect(logSpy.mock.calls.map((call) => call[0]).join("\n")).toContain("test.appended");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });

  it("drains an event appended just after terminal status is observed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-watch-terminal-drain-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-watch-terminal-drain-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should watch drain final events?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });
    await store.writeStatus({ ...(await store.readStatus(manifest.runId)), state: "completed", phase: "completed" });

    const watch = watchCommand(manifest.runId, { pollIntervalMs: 20 });
    await setTimeout(1);
    await appendFile(
      join(manifest.outputDir, "events.jsonl"),
      JSON.stringify({ runId: manifest.runId, type: "test.final", at: new Date().toISOString() }) + "\n",
      "utf8",
    );

    await watch;

    expect(logSpy.mock.calls.map((call) => call[0]).join("\n")).toContain("test.final");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });

  it("propagates events file read errors other than ENOENT", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-watch-error-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-watch-error-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should watch surface read errors?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });
    const eventsPath = join(manifest.outputDir, "events.jsonl");
    await rm(eventsPath);
    await mkdir(eventsPath);

    await expect(watchCommand(manifest.runId, { follow: false })).rejects.toMatchObject({
      code: expect.not.stringMatching(/^ENOENT$/),
    });

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });
});

describe("cancelCommand", () => {
  it("records a cooperative cancellation request in marker, events, and status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-cancel-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-cancel-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const store = new RunStore(workspace);
    const manifest = await store.createRun({
      question: "Should cancel update observable state?",
      workspace,
      mode: "mixed",
      depth: "standard",
      maxConcurrency: 8,
      maxTasks: 120,
      debugPrompts: false,
    });

    await cancelCommand(manifest.runId);

    await expect(readFile(join(manifest.outputDir, "cancel.requested"), "utf8")).resolves.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const status = await store.readStatus(manifest.runId);
    expect(status.state).toBe("cancelled");
    expect(status.lastEvents).toContain("Cancellation requested");
    const events = await readFile(join(manifest.outputDir, "events.jsonl"), "utf8");
    expect(events).toContain("run.cancel_requested");

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });
});

describe("start command helpers", () => {
  it.each([
    [{ mode: "invalid", depth: "standard", maxConcurrency: "8", maxTasks: "120", debugPrompts: false }, /--mode/],
    [{ mode: "mixed", depth: "invalid", maxConcurrency: "8", maxTasks: "120", debugPrompts: false }, /--depth/],
    [{ mode: "mixed", depth: "standard", maxConcurrency: "0", maxTasks: "120", debugPrompts: false }, /--max-concurrency/],
    [{ mode: "mixed", depth: "standard", maxConcurrency: "1.5", maxTasks: "120", debugPrompts: false }, /--max-concurrency/],
    [{ mode: "mixed", depth: "standard", maxConcurrency: "8", maxTasks: "-1", debugPrompts: false }, /--max-tasks/],
  ])("rejects invalid start options before run creation", (options, message) => {
    expect(() => validateStartOptions(options)).toThrow(message);
  });

  it("resolves the bundled Windows CLI launcher to the same CLI file", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "cdr-bin-launcher-"));
    await mkdir(join(pluginRoot, "bin"), { recursive: true });
    const cliPath = join(pluginRoot, "bin", "codex-deep-research.mjs");
    await writeFile(cliPath, "", "utf8");

    const launcher = resolveStartLauncher(pathToFileURL(cliPath).href);

    expect(launcher.command).toBe(process.execPath);
    expect(launcher.args("dr_20260102T030405678Z")).toEqual([cliPath, "run", "dr_20260102T030405678Z"]);

    await rm(pluginRoot, { recursive: true, force: true });
  });

  it("resolves the built launcher to dist/cli.js", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "cdr-built-launcher-"));
    await mkdir(join(pluginRoot, "dist", "commands"), { recursive: true });
    await writeFile(join(pluginRoot, "dist", "cli.js"), "", "utf8");

    const launcher = resolveStartLauncher(pathToFileURL(join(pluginRoot, "dist", "commands", "start.js")).href);

    expect(launcher.command).toBe(process.execPath);
    expect(launcher.args("dr_20260102T030405678Z")).toEqual([
      join(pluginRoot, "dist", "cli.js"),
      "run",
      "dr_20260102T030405678Z",
    ]);

    await rm(pluginRoot, { recursive: true, force: true });
  });

  it("resolves the source launcher through the local tsx binary", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "cdr-source-launcher-"));
    await mkdir(join(pluginRoot, "runner", "src", "commands"), { recursive: true });
    await mkdir(join(pluginRoot, "node_modules", "tsx", "dist"), { recursive: true });
    await writeFile(join(pluginRoot, "runner", "src", "cli.ts"), "", "utf8");
    await writeFile(join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs"), "", "utf8");

    const launcher = resolveStartLauncher(pathToFileURL(join(pluginRoot, "runner", "src", "commands", "start.ts")).href);

    expect(launcher.command).toBe(process.execPath);
    expect(launcher.args("dr_20260102T030405678Z")).toEqual([
      join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      join(pluginRoot, "runner", "src", "cli.ts"),
      "run",
      "dr_20260102T030405678Z",
    ]);

    await rm(pluginRoot, { recursive: true, force: true });
  });

  it("fails before claiming launch success when the launcher target is missing", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "cdr-missing-launcher-"));
    await mkdir(join(pluginRoot, "dist", "commands"), { recursive: true });

    expect(() => resolveStartLauncher(pathToFileURL(join(pluginRoot, "dist", "commands", "start.js")).href)).toThrow(
      /does not exist/,
    );

    await rm(pluginRoot, { recursive: true, force: true });
  });

  it("prints a status path created with platform path joining", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cdr-start-workspace-"));
    const pluginCwd = await mkdtemp(join(tmpdir(), "cdr-start-plugin-"));
    process.env.INIT_CWD = workspace;
    vi.spyOn(process, "cwd").mockReturnValue(pluginCwd);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand("Should start output joined paths?", {
      mode: "mixed",
      depth: "standard",
      maxConcurrency: "8",
      maxTasks: "120",
      debugPrompts: false,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { runId: string; statusPath: string };
    expect(output.statusPath).toBe(join(workspace, ".codex-deep-research", "runs", output.runId, "status.json"));

    await rm(workspace, { recursive: true, force: true });
    await rm(pluginCwd, { recursive: true, force: true });
  });
});
