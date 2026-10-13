import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCapabilities, getTemplate, listTemplates } from "./catalog.ts";
import type { WorkflowEngine } from "./engine.ts";
import { TemplateStore } from "./templates.ts";

function result(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const panelResourceUri = "ui://workflows/panel.html";
const panelResourceUris = [
  panelResourceUri,
  "ui://workflows/prototype/0.1.4.html",
  "ui://workflows/panel/0.2.0.html",
  "ui://workflows/panel/0.2.1.html",
];

export function createServer(engine: WorkflowEngine) {
  const serverInfo = { name: "workflows", version: "0.3.1" };
  const panelHtml = readFileSync(new URL("../runtime/panel.html", import.meta.url), "utf8");
  const server = new McpServer(serverInfo);
  const templates = new TemplateStore(engine.store);

  registerAppTool(server, "workflow_open_panel", {
    title: "Workflows",
    description: "Open the Workflows task panel. Preview, execution, and reviewed changes follow the user-authorized tool workflow; the panel shows progress and also provides controls.",
    inputSchema: {},
    annotations,
    _meta: {
      ui: { resourceUri: panelResourceUri },
      "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] },
    },
  }, async () => result({ version: serverInfo.version, prototype: false, executionAvailable: true, description: "动态工作流任务面板：查看代理生成的计划、执行进度和改动审查。" }));

  // Versioned aliases preserve saved entrypoints after the host reconnects.
  for (const uri of panelResourceUris) {
    registerAppResource(server, uri === panelResourceUri ? "Workflows task panel" : `Workflows task panel compatibility (${uri})`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: panelHtml,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } },
      }],
    }));
  }

  server.registerTool("workflow_get_capabilities", {
    title: "查看工作流插件能力",
    description: "Report the workflow runtime, Codex adapter, persistence, cancellation, recovery, and panel capabilities.",
    inputSchema: {},
    annotations,
  }, async () => result({ ...getCapabilities(), version: serverInfo.version }));

  server.registerTool("workflow_list_templates", {
    title: "查看工作流模板目录",
    description: "List bundled workflow scripts. Listing does not start execution.",
    inputSchema: {},
    annotations,
  }, async () => result({ templates: [...listTemplates(), ...(await templates.list()).map(({ id, name, description, source, revision }) => ({ id, name, description, source, revision }))] }));

  server.registerTool("workflow_get_template", {
    title: "读取工作流示例",
    description: "Read a bundled workflow script by catalog ID, for previewing with explicit project input.",
    inputSchema: { id: z.string().min(1).max(80) },
    annotations,
  }, async ({ id }) => {
    const template = id.startsWith("saved:") ? await templates.get(id) : await getTemplate(id);
    return template ? result({ ...template }) : {
      isError: true,
      content: [{ type: "text", text: `Unknown workflow template: ${id}` }],
    };
  });

  const id = z.string().regex(/^wf_[a-f0-9]{24}$/);
  const revision = z.number().int().nonnegative();
  const limits = z.object({ maxReadWorkers: z.number().int().min(1).max(16).optional(), maxCalls: z.number().int().min(1).max(1000).optional(), timeoutMs: z.number().int().min(100).max(86400000).optional(), maxTokens: z.number().int().nonnegative().optional() }).optional();
  const maintenance = z.object({
    steps: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      command: z.array(z.string().min(1)).min(1).max(128),
      networkAccess: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(86400000).optional(),
      retries: z.number().int().min(0).max(2).optional(),
      idempotent: z.boolean().optional().describe("Explicitly declare safe replay; defaults false. Required for retries or replay after an unknown command outcome."),
    }).refine(step => !(step.retries && step.retries > 0) || step.idempotent === true, "Command retries require an explicitly idempotent step")).min(1).max(64),
    activation: z.object({ serverName: z.string().min(1).max(128), command: z.string().min(1), args: z.array(z.string()) }).optional(),
  }).optional();
  const scope = { networkAccess: z.boolean().optional(), allowedMcpTools: z.record(z.string().min(1).max(128).refine(name => !["__proto__", "constructor", "prototype"].includes(name), "Invalid MCP server key"), z.array(z.string().min(1).max(256)).max(256)).optional(), allowedMcpServers: z.array(z.string().min(1).max(128).refine(name => name.toLowerCase() !== "workflows" && !name.toLowerCase().startsWith("plugin_workflows"), "The Workflows server cannot be used recursively")).max(100).optional(), workspaceMode: z.enum(["snapshot", "git-worktree"]).optional(), maintenance };
  const scopedInput = (input: { networkAccess?: boolean | undefined; allowedMcpServers?: string[] | undefined; allowedMcpTools?: Record<string, string[]> | undefined; workspaceMode?: "snapshot" | "git-worktree" | undefined; maintenance?: unknown }): Record<string, unknown> => ({
    ...(input.networkAccess !== undefined ? { networkAccess: input.networkAccess } : {}),
    ...(input.allowedMcpServers !== undefined ? { allowedMcpServers: input.allowedMcpServers } : {}),
    ...(input.allowedMcpTools !== undefined ? { allowedMcpTools: input.allowedMcpTools } : {}),
    ...(input.workspaceMode !== undefined ? { workspaceMode: input.workspaceMode } : {}),
    ...(input.maintenance !== undefined ? { maintenance: input.maintenance } : {}),
  });
  const safe = (operation: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<CallToolResult> => Promise.resolve().then(operation).then(result).catch(error => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }));
  server.registerTool("workflow_save_template", {
    description: "Save a reusable workflow definition in the user's library. Includes script and default input, without a project, run results, or workspace. Load the saved revision to update an existing definition.",
    inputSchema: { script: z.string().min(1), args: z.unknown().optional(), allowWrite: z.boolean().optional(), revision: revision.optional(), limits, ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => ({ template: await templates.save({ ...scopedInput(input), script: input.script, ...(input.args !== undefined ? { args: input.args } : {}), ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}), ...(input.limits ? { limits: Object.fromEntries(Object.entries(input.limits).filter(([, value]) => value !== undefined)) } : {}) }) })));
  server.registerTool("workflow_preview", {
    description: "Validate and save a dynamic JavaScript workflow plan. Does not execute. projectPath must be explicit; networkAccess defaults false and is independent of allowWrite: read-only workers may use authorized network access without file writes. workspaceMode defaults snapshot. Declare any optional maintenance argv steps and activation before starting; maintenance operations require an isolated git-worktree and allowWrite; steps default non-idempotent, and unknown started-command outcomes cannot be replayed unless explicitly declared idempotent; allowedMcpServers is an explicit configured-server allowlist, default none, and cannot include Workflows. allowedMcpTools maps server names to granted configured tool names; grants do not bypass tool approvals.",
    inputSchema: { projectPath: z.string().min(1), script: z.string().min(1), args: z.unknown().optional(), allowWrite: z.boolean().optional(), limits, ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => ({ run: await engine.preview({ ...scopedInput({ ...input, networkAccess: input.networkAccess ?? false, allowedMcpServers: input.allowedMcpServers ?? [], allowedMcpTools: input.allowedMcpTools ?? {}, workspaceMode: input.workspaceMode ?? "snapshot" }), projectPath: input.projectPath, script: input.script, ...(input.args !== undefined ? { args: input.args } : {}), ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}), ...(input.limits ? { limits: Object.fromEntries(Object.entries(input.limits).filter(([, value]) => value !== undefined)) } : {}) }) })));
  server.registerTool("workflow_update", {
    description: "Save an updated script and input for a stopped or draft workflow. Requires a fresh preview revision and another user start.",
    inputSchema: { id, revision, script: z.string().min(1), args: z.unknown(), allowWrite: z.boolean().optional(), ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => ({ run: await engine.update({ ...scopedInput(input), id: input.id, revision: input.revision, script: input.script, args: input.args, ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}) }) })));
  server.registerTool("workflow_list_runs", { description: "List saved workflow runs without starting or resuming them.", inputSchema: { projectPath: z.string().optional() }, annotations }, async input => safe(async () => ({ runs: await engine.list(input.projectPath) })));
  server.registerTool("workflow_get_run", { description: "Read a workflow plan, real tasks, reports, final diff, and logs.", inputSchema: { id }, annotations }, async input => safe(async () => ({ run: await engine.get(input.id) })));
  server.registerTool("workflow_stop", { description: "Stop dispatch, interrupt all active workers, wait for their exit, and save progress.", inputSchema: { id }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(async () => ({ run: await engine.stop(input.id) })));
  const appOnly = { ui: { visibility: ["app"] } };
  server.registerTool("workflow_panel_lease", { description: "Maintain the task panel lifecycle lease; losing the lease stops its active workflows.", inputSchema: { leaseId: z.string().optional(), release: z.boolean().optional() }, _meta: appOnly, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(() => engine.lease({ ...(input.leaseId ? { leaseId: input.leaseId } : {}), ...(input.release !== undefined ? { release: input.release } : {}) })));
  for (const action of ["start", "resume"] as const) server.registerTool(`workflow_${action}`, {
    description: `${action} the previewed workflow when the user has authorized execution. Requires the current revision and declared project/write/network scope. UI callers also pass their live panel lease; chat callers omit leaseId.`,
    inputSchema: { id, revision, leaseId: z.string().min(1).optional() },
    _meta: { ui: { visibility: ["model", "app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async input => safe(async () => ({ run: await engine.start({ id: input.id, revision: input.revision, ...(input.leaseId ? { leaseId: input.leaseId } : {}) }, action === "resume") })));
  server.registerTool("workflow_cancel_task", { description: "Cancel one active task on the user request. The script can handle its failure; other tasks keep running.", inputSchema: { id, taskId: z.string().min(1) }, _meta: { ui: { visibility: ["model", "app"] } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(async () => ({ run: await engine.cancelTask(input.id, input.taskId) })));
  server.registerTool("workflow_apply", { description: "Apply the final reviewed changes when the user has authorized application. Requires the current revision and completed review; detects baseline conflicts and retains project edits. Maintenance activation uses only its predeclared command.", inputSchema: { id, revision }, _meta: { ui: { visibility: ["model", "app"] } }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async input => safe(async () => ({ run: await engine.apply(input.id, input.revision) })));

  return server;
}
