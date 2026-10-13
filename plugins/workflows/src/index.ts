import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";
import { WorkflowEngine } from "./engine.ts";

const engine = new WorkflowEngine();
const server = createServer(engine);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await engine.close(); await server.close(); }
  catch (error) { console.error("Workflows shutdown failed:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.stdin.on("end", () => { void shutdown(); });
server.server.onclose = () => { void shutdown(); };
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error("Workflows MCP failed to start:", error);
  await engine.close();
  process.exitCode = 1;
}
