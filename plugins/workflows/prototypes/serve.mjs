// Development-only loopback preview; a browser without an MCP host stays offline.
import http from "node:http";
import { readFile } from "node:fs/promises";

const fragmentPath = new URL("../runtime/panel.html", import.meta.url);
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/") {
    response.writeHead(404); response.end(); return;
  }
  try {
    const fragment = await readFile(fragmentPath, "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(fragment);
  } catch (error) {
    console.error(error); response.writeHead(500); response.end("Build the plugin before opening the development preview.");
  }
});

server.listen(0, "127.0.0.1", () => console.log(`Workflows prototype: http://127.0.0.1:${server.address().port}/`));
