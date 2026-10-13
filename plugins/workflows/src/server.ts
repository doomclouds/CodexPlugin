import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCapabilities, getTemplate, listTemplates } from "./catalog.ts";

function result(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer() {
  const server = new McpServer({ name: "workflows", version: "0.1.0" });

  server.registerTool("workflow_get_capabilities", {
    title: "查看工作流插件能力",
    description: "Report the implemented features and pending design decisions. This scaffold cannot execute workflows.",
    inputSchema: {},
    annotations,
  }, async () => result(getCapabilities()));

  server.registerTool("workflow_list_templates", {
    title: "查看工作流模板目录",
    description: "List bundled workflow examples for inspection and discussion. Listing does not execute scripts.",
    inputSchema: {},
    annotations,
  }, async () => result({ templates: listTemplates() }));

  server.registerTool("workflow_get_template", {
    title: "读取工作流示例",
    description: "Read a bundled workflow script by its catalog ID. The script is a draft and cannot run in this scaffold.",
    inputSchema: { id: z.string().min(1).max(64) },
    annotations,
  }, async ({ id }) => {
    const template = await getTemplate(id);
    return template ? result(template) : {
      isError: true,
      content: [{ type: "text", text: `Unknown workflow template: ${id}` }],
    };
  });

  return server;
}
