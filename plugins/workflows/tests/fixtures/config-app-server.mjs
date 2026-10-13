import { spawn } from "node:child_process";

// Test isolation only: the child is the real CLI, using a disposable Codex config home.
const child = spawn(process.env.WORKFLOWS_CODEX_COMMAND ?? "codex", ["app-server"], {
  cwd: process.cwd(), env: { ...process.env, CODEX_HOME: process.argv[2] }, stdio: ["pipe", "pipe", "pipe"],
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.resume();
child.stdin.on("error", () => {});
child.on("error", () => { process.exitCode = 1; });
child.on("close", code => { process.exit(code ?? 1); });
process.on("SIGTERM", () => { child.kill("SIGTERM"); });
process.on("SIGINT", () => { child.kill("SIGINT"); });
