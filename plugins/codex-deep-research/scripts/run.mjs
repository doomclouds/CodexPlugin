#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const callerWorkspace = process.env.INIT_CWD || process.cwd();
const runIdPattern = /^dr_\d{8}T\d{9}Z(?:_\d{2})?$/;
const terminalStates = new Set(["completed", "partial", "failed", "cancelled"]);

function runsDir() {
  return join(callerWorkspace, ".codex-deep-research", "runs");
}

function validateRunId(runId) {
  if (!runIdPattern.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function runDir(runId) {
  validateRunId(runId);
  return join(runsDir(), runId);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readManifest(runId) {
  return await readJson(join(runDir(runId), "manifest.json"));
}

async function readStatus(runId) {
  await readManifest(runId);
  return await readJson(join(runDir(runId), "status.json"));
}

async function writeStatus(status) {
  await readManifest(status.runId);
  const updated = { ...status, updatedAt: new Date().toISOString() };
  await writeFile(join(runDir(status.runId), "status.json"), JSON.stringify(updated, null, 2), "utf8");
}

async function emit(runId, event) {
  validateRunId(runId);
  await readManifest(runId).catch((error) => {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  await appendFile(
    join(runDir(runId), "events.jsonl"),
    JSON.stringify({ ...event, at: new Date().toISOString(), runId }) + "\n",
    "utf8",
  );
}

async function listCommand() {
  try {
    const names = await readdir(runsDir());
    console.log(names.filter((name) => runIdPattern.test(name)).sort().join("\n"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log("");
      return;
    }
    throw error;
  }
}

async function statusCommand(runId) {
  console.log(JSON.stringify(await readStatus(runId), null, 2));
}

async function reportCommand(runId) {
  const status = await readStatus(runId);
  if (!status.output) {
    console.log(`No report is available for ${runId}.`);
    return;
  }

  const outputDir = runDir(runId);
  const reportPath = join(outputDir, "report.md");
  const summaryPath = join(outputDir, "report.summary.md");
  await access(reportPath).catch((error) => {
    if (error && error.code === "ENOENT") {
      throw new Error(`Report file is missing for ${runId}: ${reportPath}`);
    }
    throw error;
  });

  const summary = await readFile(summaryPath, "utf8").catch((error) => {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (summary === undefined) {
    console.log(`No report is available for ${runId}.`);
    return;
  }

  console.log(`Report: ${reportPath}\n\n${summary}`);
}

async function readEvents(path) {
  return await readFile(path).catch((error) => {
    if (error && error.code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw error;
  });
}

function printNewLines(buffer, offset) {
  if (buffer.length <= offset) {
    return { nextOffset: offset, printed: false };
  }

  const chunk = buffer.subarray(offset).toString("utf8").trimEnd();
  if (chunk.length === 0) {
    return { nextOffset: buffer.length, printed: false };
  }

  for (const line of chunk.split(/\r?\n/)) {
    console.log(line);
  }
  return { nextOffset: buffer.length, printed: true };
}

async function watchCommand(runId) {
  await readManifest(runId);
  const eventsPath = join(runDir(runId), "events.jsonl");
  const pollIntervalMs = 1000;
  const terminalDrainMs = 50;
  let offset = 0;
  let printed = false;

  while (true) {
    const events = await readEvents(eventsPath);
    const result = printNewLines(events, offset);
    offset = result.nextOffset;
    printed = printed || result.printed;

    const status = await readStatus(runId);
    if (terminalStates.has(status.state)) {
      await setTimeout(terminalDrainMs);
      const finalEvents = await readEvents(eventsPath);
      const finalResult = printNewLines(finalEvents, offset);
      printed = printed || finalResult.printed;
      break;
    }

    await setTimeout(pollIntervalMs);
  }

  if (!printed) {
    console.log("");
  }
}

async function cancelCommand(runId) {
  await readManifest(runId);
  await writeFile(join(runDir(runId), "cancel.requested"), new Date().toISOString() + "\n", "utf8");
  await emit(runId, { type: "run.cancel_requested", message: "Cancellation requested" });

  const status = await readStatus(runId);
  const nextState = terminalStates.has(status.state) ? status.state : "cancelled";
  await writeStatus({
    ...status,
    state: nextState,
    lastEvents: [...status.lastEvents.slice(-9), "Cancellation requested"],
  });

  console.log(`Cancel requested for ${runId}.`);
}

function printHelp() {
  console.log(`Usage: codex-deep-research <command> [args]

Dependency-free installed commands:
  list                 List known research run ids
  status <run_id>      Print run status JSON
  watch <run_id>       Follow run events until terminal status
  report <run_id>      Print report path and summary
  cancel <run_id>      Request cooperative cancellation

Runner commands requiring a built runner or repository dev dependencies:
  start <question>
  run <run_id>
`);
}

function delegateToRunner(commandArgs) {
  const distCli = join(pluginRoot, "dist", "cli.js");
  const sourceCli = join(pluginRoot, "runner", "src", "cli.ts");
  const tsxCli = join(pluginRoot, "node_modules", "tsx", "dist", "cli.mjs");
  let args;

  if (existsSync(distCli)) {
    args = [distCli, ...commandArgs];
  } else if (existsSync(sourceCli) && existsSync(tsxCli)) {
    args = [tsxCli, sourceCli, ...commandArgs];
  } else {
    console.error(
      [
        `codex-deep-research command "${commandArgs[0] ?? ""}" requires the runner to be built or dev dependencies to be installed.`,
        "",
        `Plugin root: ${pluginRoot}`,
        "",
        "For repository development, run:",
        "  npm install",
        "  npm run build",
        "",
        "Installed v0 cache copies can still use:",
        "  list, status, watch, report, cancel",
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
}

function requireRunId(command, runId) {
  if (!runId) {
    throw new Error(`Missing <run_id> for ${command}.`);
  }
  return runId;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "list":
      await listCommand();
      return;
    case "status":
      await statusCommand(requireRunId(command, args[1]));
      return;
    case "watch":
      await watchCommand(requireRunId(command, args[1]));
      return;
    case "report":
      await reportCommand(requireRunId(command, args[1]));
      return;
    case "cancel":
      await cancelCommand(requireRunId(command, args[1]));
      return;
    case "start":
    case "run":
      delegateToRunner(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
