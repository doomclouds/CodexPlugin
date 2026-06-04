#!/usr/bin/env node
import { Command } from "commander";
import { cancelCommand } from "./commands/cancel.js";
import { listCommand } from "./commands/list.js";
import { reportCommand } from "./commands/report.js";
import { runCommand } from "./commands/run.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
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
