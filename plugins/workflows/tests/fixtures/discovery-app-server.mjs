// Protocol-only discovery fixture. It never invokes a model or an MCP server.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const trace = process.argv[2];
const settings = () => JSON.parse(readFileSync(path.join(process.cwd(), "discovery-settings.json"), "utf8"));
const record = value => appendFileSync(trace, JSON.stringify({ ...value, pid: process.pid, cwd: process.cwd() }) + "\n");
const startup = settings();
let previousAlive;
if (startup.previousPid) {
  try { process.kill(startup.previousPid, 0); previousAlive = true; }
  catch (error) { if (error.code !== "ESRCH") throw error; previousAlive = false; }
}
record({ type: "started", ...(previousAlive !== undefined ? { previousAlive } : {}) });
const timers = new Set();
const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const { id, method, params } = JSON.parse(line);
  record({ method, params });
  if (method === "initialize") respond(id, {});
  else if (method === "config/read") respond(id, { config: { model: settings().model, model_reasoning_effort: "max", mcp_servers: {} } });
  else if (method === "model/list") {
    const publish = () => respond(id, { data: settings().invalid ? [{ id: "invalid" }] : ["model-a", "model-b"].map(model => ({ id: model, displayName: model, isDefault: model === "model-a", supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Fixture" }], defaultReasoningEffort: "max" })), nextCursor: null });
    if (!settings().wait || existsSync(path.join(process.cwd(), "catalogue-ready"))) publish();
    else {
      const timer = setInterval(() => {
        if (!existsSync(path.join(process.cwd(), "catalogue-ready"))) return;
        clearInterval(timer); timers.delete(timer); publish();
      }, 10);
      timers.add(timer);
    }
  }
});
input.once("close", () => { for (const timer of timers) clearInterval(timer); });
