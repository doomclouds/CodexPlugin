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
  .option("--debug-prompts", "reserved prompt capture manifest flag", false)
  .action(startCommand);

program.command("run").argument("<runId>").description("execute a queued research run").action(runCommand);
program.command("status").argument("<runId>").description("print run status JSON").action(statusCommand);
program
  .command("watch")
  .argument("<runId>")
  .description("follow run events until the run reaches a terminal state")
  .action(watchCommand);
program.command("report").argument("<runId>").description("print report paths and summary").action(reportCommand);
program
  .command("cancel")
  .argument("<runId>")
  .description("request cooperative cancellation for an active run")
  .action(cancelCommand);
program.command("list").description("list known research run ids").action(listCommand);

await program.parseAsync(process.argv);
