import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliPath, "run", manifest.runId], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(JSON.stringify({ runId: manifest.runId, statusPath: `${manifest.outputDir}/status.json` }, null, 2));
}
