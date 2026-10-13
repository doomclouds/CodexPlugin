// PROTOTYPE ONLY: static, loopback preview. No model calls or project file writes.
import http from "node:http";
import { readFile } from "node:fs/promises";

const fragmentPath = new URL("./workflow-panel.html", import.meta.url);
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/") {
    response.writeHead(404); response.end(); return;
  }
  try {
    const fragment = await readFile(fragmentPath, "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflows panel prototype</title><style>:root{color-scheme:light dark}body{margin:0;background:light-dark(#eef0f3,#111214)}main{max-width:800px;margin:24px auto}@media(max-width:520px){main{margin:0}}</style></head><body><main>${fragment}</main></body></html>`);
  } catch (error) {
    console.error(error); response.writeHead(500); response.end("Prototype preview unavailable.");
  }
});

server.listen(0, "127.0.0.1", () => console.log(`Workflows prototype: http://127.0.0.1:${server.address().port}/`));
