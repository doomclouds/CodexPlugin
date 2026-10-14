import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Test isolation only: the child is the real CLI, using a disposable Codex config home.
const child = spawn(process.env.WORKFLOWS_CODEX_COMMAND ?? "codex", ["app-server"], {
  cwd: process.cwd(), env: { ...process.env, CODEX_HOME: process.argv[2] }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
child.stdout.pipe(process.stdout);
child.stderr.resume();
child.stdin.on("error", () => {});
let closing = false;
let childClosed = false;
let shutdown;
const closed = new Promise(resolve => {
  child.once("close", code => { childClosed = true; resolve(code); if (!closing) process.exit(code ?? 1); });
});
child.on("error", () => { process.exitCode = 1; });
async function waitForChild(milliseconds) {
  let timer;
  try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function closeOwnedChild() {
  shutdown ??= (async () => {
    closing = true;
    child.stdin.end();
    if (await waitForChild(2500)) return;
    if (!childClosed) child.kill("SIGTERM");
    if (await waitForChild(1500)) return;
    if (!childClosed) child.kill("SIGKILL");
    if (!await waitForChild(1500)) throw new Error("Owned fixture app-server did not close after bounded shutdown");
  })();
  return shutdown;
}
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { /* Other input stays native protocol data. */ }
  if (request?.method !== "fixture/shutdown") { if (!closing) child.stdin.write(line + "\n"); return; }
  void closeOwnedChild().then(() => {
    process.stdout.write(JSON.stringify({ id: request.id, result: { closed: true } }) + "\n", () => { input.close(); process.exit(0); });
  }, error => {
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: error.message } }) + "\n", () => process.exit(1));
  });
});
input.on("close", () => { void closeOwnedChild().then(() => { if (!closing) process.exit(0); }, () => process.exit(1)); });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void closeOwnedChild().then(() => process.exit(0), () => process.exit(1)); });
