import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../runtime/run-store.js";
import type { RunManifest } from "../runtime/types.js";
import { resolveWorkspaceRoot } from "./workspace.js";

interface RawStartOptions {
  mode: unknown;
  depth: unknown;
  maxConcurrency: unknown;
  maxTasks: unknown;
  debugPrompts?: unknown;
}

interface StartOptions {
  mode: RunManifest["mode"];
  depth: RunManifest["depth"];
  maxConcurrency: number;
  maxTasks: number;
  debugPrompts: boolean;
}

export interface StartLauncher {
  command: string;
  args: (runId: string) => string[];
}

const MODES = ["mixed", "web", "repo"] as const;
const DEPTHS = ["quick", "standard", "deep"] as const;

export function validateStartOptions(options: RawStartOptions): StartOptions {
  return {
    mode: parseChoice("--mode", options.mode, MODES),
    depth: parseChoice("--depth", options.depth, DEPTHS),
    maxConcurrency: parsePositiveInteger("--max-concurrency", options.maxConcurrency),
    maxTasks: parsePositiveInteger("--max-tasks", options.maxTasks),
    debugPrompts: Boolean(options.debugPrompts),
  };
}

export function resolveStartLauncher(currentModuleUrl: string): StartLauncher {
  const currentFile = fileURLToPath(currentModuleUrl);
  const normalized = currentFile.replaceAll("\\", "/");

  if (normalized.endsWith("/dist/commands/start.js")) {
    const cliPath = join(dirname(currentFile), "..", "cli.js");
    assertFileExists(cliPath, "built CLI");
    return {
      command: process.execPath,
      args: (runId) => [cliPath, "run", runId],
    };
  }

  if (normalized.endsWith("/runner/src/commands/start.ts")) {
    const pluginRoot = join(dirname(currentFile), "..", "..", "..");
    const tsxCliPath = join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const cliPath = join(pluginRoot, "runner", "src", "cli.ts");
    assertFileExists(tsxCliPath, "tsx CLI");
    assertFileExists(cliPath, "source CLI");
    return {
      command: process.execPath,
      args: (runId) => [tsxCliPath, cliPath, "run", runId],
    };
  }

  throw new Error(`Unable to determine start launcher for ${currentFile}`);
}

export async function startCommand(question: string, rawOptions: RawStartOptions): Promise<void> {
  const options = validateStartOptions(rawOptions);
  const launcher = resolveStartLauncher(import.meta.url);
  const workspace = resolveWorkspaceRoot();
  const store = new RunStore(workspace);
  const manifest = await store.createRun({
    question,
    workspace,
    mode: options.mode,
    depth: options.depth,
    maxConcurrency: options.maxConcurrency,
    maxTasks: options.maxTasks,
    debugPrompts: options.debugPrompts,
  });

  const child = spawn(launcher.command, launcher.args(manifest.runId), {
    cwd: workspace,
    detached: true,
    env: { ...process.env, INIT_CWD: workspace },
    stdio: "ignore",
  });
  child.unref();

  console.log(JSON.stringify({ runId: manifest.runId, statusPath: join(manifest.outputDir, "status.json") }, null, 2));
}

function parseChoice<T extends readonly string[]>(optionName: string, rawValue: unknown, choices: T): T[number] {
  if (typeof rawValue === "string" && choices.includes(rawValue)) {
    return rawValue;
  }

  throw new Error(`Invalid ${optionName}: expected ${choices.join("|")}, got ${JSON.stringify(rawValue)}.`);
}

function parsePositiveInteger(optionName: string, rawValue: unknown): number {
  if (typeof rawValue === "string" && /^[1-9]\d*$/.test(rawValue)) {
    return Number(rawValue);
  }

  throw new Error(`Invalid ${optionName}: expected a positive integer, got ${JSON.stringify(rawValue)}.`);
}

function assertFileExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Cannot launch deep research: ${label} does not exist at ${path}`);
  }
}
