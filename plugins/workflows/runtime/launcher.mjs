import { constants, accessSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeEntry = fileURLToPath(new URL("../runtime/index.js", import.meta.url));

export function supportsExecve(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return !!match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 15);
}

function executableFile(candidate) {
  try {
    if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) return undefined;
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch { return undefined; }
}

export function desktopNodeCandidates(env) {
  const value = key => typeof env[key] === "string" ? env[key].trim() : "";
  const resources = value("CODEX_ELECTRON_RESOURCES_PATH");
  const cli = value("CODEX_CLI_PATH");
  return [
    value("CODEX_MCP_NODE_PATH"),
    value("CODEX_BROWSER_USE_NODE_PATH"),
    resources && path.join(resources, "cua_node", "bin", "node"),
    cli && path.isAbsolute(cli) && path.join(path.dirname(cli), "cua_node", "bin", "node"),
  ].filter(Boolean);
}

export function createLaunchPlan({ platform = process.platform, env = process.env, execPath = process.execPath, argv = process.argv, version = process.version, execveAvailable = typeof process.execve === "function", entry = runtimeEntry } = {}) {
  if (platform !== "darwin" || !env.CODEX_APP_TOOLS_PIPE_PATH?.trim()) return { kind: "start", entry };
  const node = desktopNodeCandidates(env).map(executableFile).find(Boolean);
  if (!node) return { kind: "start", entry };
  if (node === executableFile(execPath)) return { kind: "start", entry };
  if (!supportsExecve(version) || !execveAvailable) throw new Error("Desktop project access requires Node.js 22.15 or newer with process.execve. Update the Node runtime used to launch Workflows.");
  // Replacing the current process keeps the desktop CLI as its parent. Spawning
  // a child instead would leave an unsigned Node in the host's peer chain.
  return {
    kind: "exec",
    node,
    argv: [node, ...argv.slice(1)],
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
  };
}

export async function launchWorkflow(options = {}) {
  const plan = createLaunchPlan(options);
  if (plan.kind === "exec") {
    process.execve(plan.node, plan.argv, plan.env);
    throw new Error("The desktop Node replacement unexpectedly returned.");
  }
  await import(pathToFileURL(plan.entry).href);
}

export function isMainModule(moduleURL, argvFilename) {
  if (!argvFilename) return false;
  try { return realpathSync(path.resolve(argvFilename)) === realpathSync(fileURLToPath(moduleURL)); }
  catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await launchWorkflow();
}
