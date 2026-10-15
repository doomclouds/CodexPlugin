import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";
import { WorkflowEngine } from "./engine.ts";
import { watchParentExit } from "./parent-lifecycle.ts";

const engine = new WorkflowEngine();
const server = createServer(engine);
let shuttingDown = false;
const stopWatchingParent = watchParentExit(() => { void shutdown(); });
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatchingParent();
  // Close the transport even if checkpoint/worker cleanup reports a failure.
  // Otherwise a live stdio reader can keep a failed runtime resident forever.
  try { await engine.close(); }
  catch (error) { console.error("Workflows shutdown failed:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally {
    try { await server.close(); }
    catch (error) { console.error("Workflows transport shutdown failed:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.stdin.on("end", () => { void shutdown(); });
server.server.onclose = () => { void shutdown(); };
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error("Workflows MCP failed to start:", error);
  await shutdown();
  process.exitCode = 1;
}
