#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const callerWorkspace = process.env.INIT_CWD || process.cwd();

const distCli = join(pluginRoot, "dist", "cli.js");
const sourceCli = join(pluginRoot, "runner", "src", "cli.ts");
const tsxCli = join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs");

let args;
if (existsSync(distCli)) {
  args = [distCli, ...process.argv.slice(2)];
} else if (existsSync(sourceCli) && existsSync(tsxCli)) {
  args = [tsxCli, sourceCli, ...process.argv.slice(2)];
} else {
  console.error(
    [
      "codex-deep-research runner is not built in this plugin copy.",
      "",
      `Plugin root: ${pluginRoot}`,
      "",
      "For repository development, run:",
      "  npm install",
      "  npm run build",
      "",
      "Then retry this wrapper from the caller workspace:",
      `  node "${join(pluginRoot, "scripts", "run.mjs")}" <command>`,
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(process.execPath, args, {
  cwd: pluginRoot,
  env: {
    ...process.env,
    INIT_CWD: callerWorkspace,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`codex-deep-research runner exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
