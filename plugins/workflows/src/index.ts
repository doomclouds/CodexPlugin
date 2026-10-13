import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const server = createServer();
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error("Workflows MCP failed to start:", error);
  process.exitCode = 1;
}
