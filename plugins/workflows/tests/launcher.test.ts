import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const launcher = await import(new URL("../src/launcher.mjs", import.meta.url).href);
const exec = promisify(execFile);
const node = process.execPath;

test("desktop launch selects only explicit host runtime candidates in priority order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-launcher-"));
  try {
    const alternate = path.join(directory, "alternate-node");
    await writeFile(alternate, "host-runtime-fixture");
    await chmod(alternate, 0o700);
    const env = { CODEX_APP_TOOLS_PIPE_PATH: "/desktop.sock", CODEX_MCP_NODE_PATH: path.join(directory, "missing"), CODEX_BROWSER_USE_NODE_PATH: alternate, KEEP_VALUE: "kept" };
    const plan = launcher.createLaunchPlan({ platform: "darwin", env, execPath: path.join(directory, "initial-node"), argv: ["initial", "/package/runtime/launcher.mjs", "argument"], version: "v24.0.0", execveAvailable: true });
    assert.equal(plan.kind, "exec");
    assert.deepEqual(plan.argv, [plan.node, "/package/runtime/launcher.mjs", "argument"]);
    assert.equal(plan.env.KEEP_VALUE, "kept");
    assert.equal(plan.env.CODEX_APP_TOOLS_PIPE_PATH, "/desktop.sock");
    assert.equal(launcher.desktopNodeCandidates({ CODEX_MCP_NODE_PATH: "/mcp/node", CODEX_BROWSER_USE_NODE_PATH: "/browser/node", CODEX_ELECTRON_RESOURCES_PATH: "/resources", CODEX_CLI_PATH: "/cli/codex" })[0], "/mcp/node");
    assert.deepEqual(launcher.desktopNodeCandidates({ CODEX_ELECTRON_RESOURCES_PATH: "/resources", CODEX_CLI_PATH: "/cli/codex" }), [path.join("/resources", "cua_node", "bin", "node"), path.join("/cli", "cua_node", "bin", "node")]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI and Windows startup keep their runtime and same-runtime detection prevents recursion", () => {
  const env = { CODEX_APP_TOOLS_PIPE_PATH: "/desktop.sock", CODEX_MCP_NODE_PATH: node };
  assert.equal(launcher.createLaunchPlan({ platform: "win32", env }).kind, "start");
  assert.equal(launcher.createLaunchPlan({ platform: "linux", env }).kind, "start");
  assert.equal(launcher.createLaunchPlan({ platform: "darwin", env: { CODEX_MCP_NODE_PATH: node } }).kind, "start");
  assert.equal(launcher.createLaunchPlan({ platform: "darwin", env, execPath: node }).kind, "start");
  assert.equal(launcher.createLaunchPlan({ platform: "darwin", env: { CODEX_APP_TOOLS_PIPE_PATH: "/desktop.sock", CODEX_MCP_NODE_PATH: "relative-node" } }).kind, "start");
});

test("desktop replacement reports unsupported Node without spawning an unsigned child", () => {
  const base = { platform: "darwin", env: { CODEX_APP_TOOLS_PIPE_PATH: "/desktop.sock", CODEX_MCP_NODE_PATH: node }, execPath: "/initial-missing-node", argv: ["initial", "/package/launcher.mjs"] };
  assert.throws(() => launcher.createLaunchPlan({ ...base, version: "v22.14.0", execveAvailable: true }), /22\.15/);
  assert.throws(() => launcher.createLaunchPlan({ ...base, version: "v24.0.0", execveAvailable: false }), /process\.execve/);
  assert.equal(launcher.supportsExecve("v22.15.0"), true);
  assert.equal(launcher.supportsExecve("v21.9.0"), false);
});

test("runtime and source launchers are identical and remain inside the released package", async () => {
  assert.equal(await readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8"), await readFile(new URL("../runtime/launcher.mjs", import.meta.url), "utf8"));
  const mcp = JSON.parse(await readFile(new URL("../mcp.json", import.meta.url), "utf8"));
  assert.deepEqual(mcp.mcpServers.workflows.args, ["${PLUGIN_ROOT}/runtime/launcher.mjs"]);
});

test("direct main startup follows a directory alias and loads its package entry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-launcher-alias-"));
  try {
    const packageRoot = path.join(directory, "package"), alias = path.join(directory, "alias");
    await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
    await cp(new URL("../src/launcher.mjs", import.meta.url), path.join(packageRoot, "runtime", "launcher.mjs"));
    await writeFile(path.join(packageRoot, "runtime", "index.js"), 'console.log(JSON.stringify({ started: process.pid, argument: process.argv[2] }));');
    await symlink(packageRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const filename = path.join(alias, "runtime", "launcher.mjs");
    assert.equal(launcher.isMainModule(pathToFileURL(path.join(packageRoot, "runtime", "launcher.mjs")), filename), true);
    assert.equal(launcher.isMainModule(pathToFileURL(filename), path.join(directory, "absent.mjs")), false);
    const { stdout, stderr } = await exec(node, [filename, "main-started"], { env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: "" }, timeout: 10_000 });
    const event = JSON.parse(stdout.trim());
    assert.equal(typeof event.started, "number");
    assert.equal(event.argument, "main-started");
    assert.equal(stderr, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real execve replacement preserves PID, arguments and environment", { skip: process.platform === "win32" || typeof process.execve !== "function" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflows-launcher-pid-"));
  try {
    const driver = path.join(directory, "driver.mjs"), entry = path.join(directory, "entry.mjs");
    await writeFile(entry, 'console.log(JSON.stringify({ after: process.pid, argument: process.argv[2], retained: process.env.LAUNCH_RETAINED_VALUE }));');
    await writeFile(driver, `import { launchWorkflow } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/launcher.mjs", import.meta.url))).href)};
console.log(JSON.stringify({ before: process.pid }));
await launchWorkflow({ platform: "darwin", entry: ${JSON.stringify(entry)}, execPath: process.env.LAUNCH_REPLACED ? process.execPath : "/initial-missing-node", env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: "/desktop.sock", CODEX_MCP_NODE_PATH: process.execPath, LAUNCH_REPLACED: "1" } });
`);
    const { stdout } = await exec(node, [driver, "preserved-argument"], { env: { ...process.env, LAUNCH_RETAINED_VALUE: "preserved-value" }, timeout: 10_000 });
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 3);
    assert.equal(events[0].before, events[1].before);
    assert.equal(events[0].before, events[2].after);
    assert.equal(events[2].argument, "preserved-argument");
    assert.equal(events[2].retained, "preserved-value");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
