import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFileSync } from "node:fs";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Icon, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCapabilities, getTemplate, listTemplates } from "./catalog.ts";
import type { WorkflowEngine } from "./engine.ts";
import { TemplateStore } from "./templates.ts";
import { modelSettingsSchema, nodeModelSettingsSchema } from "./execution-settings.ts";
import { CodexProjectsProvider } from "./projects.ts";
import type { ProjectsProvider } from "./projects.ts";
import { DeletionService } from "./deletion.ts";
import type { DeleteInput } from "./deletion.ts";
import { readDeletionConfig } from "./deletion-config.ts";
import { nodeProcess } from "./node-process.ts";
import { assertControlPlaneTransportable, projectRunForTransport, TransportProjectionError } from "./run-view.ts";
import type { WorkflowRun } from "./types.ts";

function result(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function listSummary(run: WorkflowRun): Record<string, unknown> {
  return {
    id: run.id, revision: run.revision, projectPath: run.projectPath,
    meta: { name: run.meta.name.slice(0, 128), description: run.meta.description.slice(0, 512) },
    execution: run.execution, review: run.review, application: run.application,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.progressSequence !== undefined ? { progressSequence: run.progressSequence } : {}),
    ...(run.error ? { error: run.error.slice(0, 180) } : {}),
    ...(run.deletionPending !== undefined ? { deletionPending: run.deletionPending } : {}),
    ...(run.deletionTarget ? { deletionTarget: run.deletionTarget } : {}),
    ...(run.sourceDefinition ? { sourceDefinition: run.sourceDefinition } : {}),
  };
}

function listPage(runs: WorkflowRun[], offset: number, limit: number): Record<string, unknown> {
  const page: Array<Record<string, unknown>> = [];
  const budget = 3 * 1024 * 1024;
  let bytes = Buffer.byteLength(JSON.stringify({ runs: [], listSummary: true, totalRuns: runs.length, nextOffset: Number.MAX_SAFE_INTEGER }));
  for (const run of runs.slice(offset, offset + limit)) {
    const summary = listSummary(run);
    const size = Buffer.byteLength(JSON.stringify(summary)) + (page.length ? 1 : 0);
    if (bytes + size > budget) {
      if (!page.length) throw new Error("Workflow list identity exceeds its transport budget; the original record was preserved.");
      break;
    }
    bytes += size; page.push(summary);
  }
  const nextOffset = offset + page.length;
  return { runs: page, listSummary: true, totalRuns: runs.length, ...(nextOffset < runs.length ? { nextOffset } : {}) };
}

function acceptedRun(run: WorkflowRun): Record<string, unknown> {
  try { return { run: projectRunForTransport(run) }; }
  catch (error) {
    // A completed action must not look rejected merely because its view is too large.
    return { run: listSummary(run), listSummary: true, operationAccepted: true, projectionError: {
      code: error instanceof TransportProjectionError ? error.code : "RUN_PROJECTION_FAILED",
      message: (error instanceof Error ? error.message : "Unable to project this completed operation response.").slice(0, 512),
    } };
  }
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const panelResourceUri = "ui://workflows/panel.html";
// A compact package asset is cached with the server so upgraded/deleted install
// directories cannot invalidate icon descriptors on the existing connection.
const panelIcons: Icon[] = [{
  src: `data:image/png;base64,${readFileSync(new URL("../assets/workflows-sidebar-icon.png", import.meta.url)).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["128x128"],
}];
const panelResourceUris = [
  panelResourceUri,
  "ui://workflows/prototype/0.1.4.html",
  "ui://workflows/panel/0.2.0.html",
  "ui://workflows/panel/0.2.1.html",
];

function registerPanelToolWithIcons(server: McpServer, register: () => void) {
  // MCP SDK 1.32.1 validates tool.icons but registerTool drops that property.
  // Decorate its public tools/list handler once, keeping SDK schema conversion,
  // registration, ordering and calls intact; no private registry is accessed.
  const protocol = server.server;
  const original = protocol.setRequestHandler;
  const setHandler = original.bind(protocol);
  protocol.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, ListToolsRequestSchema)) return setHandler(schema, handler);
    setHandler(schema, async (request, extra) => {
      const value = await handler(request, extra);
      const catalog = value as ListToolsResult;
      return { ...catalog, tools: catalog.tools.map(tool => tool.name === "workflow_open_panel" ? { ...tool, icons: panelIcons } : tool) };
    });
  };
  try { register(); }
  finally { protocol.setRequestHandler = original; }
}

export function createServer(engine: WorkflowEngine, options: { projects?: ProjectsProvider; readDeletionConfig?: (projectPaths: string[]) => Promise<Record<string, unknown>> } = {}) {
  const serverInfo = { name: "workflows", version: "0.5.8", icons: panelIcons };
  const panelHtml = readFileSync(new URL("../runtime/panel.html", import.meta.url), "utf8");
  const server = new McpServer(serverInfo);
  const templates = new TemplateStore(engine.store);
  const deletion = new DeletionService(engine.store, templates, { readEffectiveConfig: options.readDeletionConfig ?? readDeletionConfig });
  const projects = options.projects ?? new CodexProjectsProvider();

  registerPanelToolWithIcons(server, () => registerAppTool(server, "workflow_open_panel", {
    title: "Workflows",
    description: "Open the Workflows task panel. Preview, execution, and reviewed changes follow the user-authorized tool workflow; the panel shows progress and also provides controls.",
    inputSchema: {},
    annotations,
    _meta: {
      ui: { resourceUri: panelResourceUri },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  }, async () => result({ version: serverInfo.version, prototype: false, executionAvailable: true, description: "动态工作流任务面板：查看代理生成的计划、执行进度和改动审查。" })));

  // Versioned aliases preserve saved entrypoints after the host reconnects.
  for (const uri of panelResourceUris) {
    registerAppResource(server, uri === panelResourceUri ? "Workflows task panel" : `Workflows task panel compatibility (${uri})`, uri, { mimeType: RESOURCE_MIME_TYPE, icons: panelIcons }, async () => ({
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
  }, async () => result({ templates: [...listTemplates(), ...(await templates.list()).map(({ id, name, description, source, revision, meta }) => ({ id, name, description, source, revision, meta }))] }));

  server.registerTool("workflow_get_template", {
    title: "读取工作流示例",
    description: "Read a bundled workflow script by catalog ID, for previewing with explicit project input.",
    inputSchema: { id: z.string().min(1).max(80) },
    annotations,
  }, async ({ id }) => {
    const template = id.startsWith("saved:") ? await templates.get(id) : await getTemplate(id.replace(/^builtin:/, ""));
    return template ? result({ ...template }) : {
      isError: true,
      content: [{ type: "text", text: `Unknown workflow template: ${id}` }],
    };
  });

  const id = z.string().regex(/^wf_[a-f0-9]{24}$/);
  const revision = z.number().int().nonnegative();
  const sourceDefinition = z.object({ id: z.string().regex(/^(?:(?:saved|builtin):)?[a-z][a-z0-9-]{0,63}$/), revision }).optional();
  const deletionInput = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run"), id, revision }),
    z.object({ kind: z.literal("definition"), id: z.string().regex(/^(?:saved|builtin):[a-z][a-z0-9-]{0,63}$/), revision, runIds: z.array(id).max(1000).optional() }),
  ]);
  const deletionFields = { kind: z.enum(["run", "definition"]), id: z.string().min(1).max(80), revision, runIds: z.array(id).max(1000).optional() };
  const parsedDeletion = (value: unknown): DeleteInput => {
    const target = deletionInput.parse(value);
    return target.kind === "run" ? target : { kind: target.kind, id: target.id, revision: target.revision, ...(target.runIds ? { runIds: target.runIds } : {}) };
  };
  const verifiedDefinition = async (source: { id: string; revision: number } | undefined, script: string) => {
    if (!source) return undefined;
    const template = source.id.startsWith("saved:") ? await templates.get(source.id) : await getTemplate(source.id.replace(/^builtin:/, ""));
    if (!template || ("revision" in template ? template.revision : 0) !== source.revision || template.script !== script) throw new Error("Workflow definition changed or does not match the planned script; reload it before creating a run.");
    return { id: template.source === "builtin" ? `builtin:${template.id}` : template.id, revision: source.revision };
  };
  const nodeSettings = z.record(z.string().min(1).max(256), nodeModelSettingsSchema).optional();
  const limits = z.object({ maxReadWorkers: z.number().int().min(1).max(16).optional(), maxCalls: z.number().int().min(1).max(1000).optional(), timeoutMs: z.number().int().min(100).max(86400000).optional(), maxTokens: z.number().int().nonnegative().optional() }).optional();
  const maintenance = z.object({
    steps: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      command: z.array(z.string().min(1)).min(1).max(128),
      networkAccess: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(86400000).optional(),
      retries: z.number().int().min(0).max(2).optional(),
      idempotent: z.boolean().optional().describe("Explicitly declare safe replay; defaults false. Required for retries or replay after an unknown command outcome."),
      protectedPaths: z.array(z.string().min(1).max(1024)).min(1).max(16).optional().describe("Explicit user-authorized .agents/.codex directories or their subdirectories, relative to this isolated Git checkout. Applies only to this declared command, never to agent workers."),
    }).refine(step => !(step.retries && step.retries > 0) || step.idempotent === true, "Command retries require an explicitly idempotent step")).min(1).max(64),
    activation: z.object({ serverName: z.string().min(1).max(128), command: z.string().min(1), args: z.array(z.string()) }).optional(),
  }).optional();
  const scope = { networkAccess: z.boolean().optional(), allowedMcpTools: z.record(z.string().min(1).max(128).refine(name => !["__proto__", "constructor", "prototype"].includes(name), "Invalid MCP server key"), z.array(z.string().min(1).max(256)).max(256)).optional(), allowedMcpServers: z.array(z.string().min(1).max(128).refine(name => name.toLowerCase() !== "workflows" && !name.toLowerCase().startsWith("plugin_workflows"), "The Workflows server cannot be used recursively")).max(100).optional(), workspaceMode: z.enum(["snapshot", "git-worktree"]).optional(), maintenance, nodeSettings };
  const scopedInput = (input: { networkAccess?: boolean | undefined; allowedMcpServers?: string[] | undefined; allowedMcpTools?: Record<string, string[]> | undefined; workspaceMode?: "snapshot" | "git-worktree" | undefined; maintenance?: unknown; nodeSettings?: unknown }): Record<string, unknown> => ({
    ...(input.networkAccess !== undefined ? { networkAccess: input.networkAccess } : {}),
    ...(input.allowedMcpServers !== undefined ? { allowedMcpServers: input.allowedMcpServers } : {}),
    ...(input.allowedMcpTools !== undefined ? { allowedMcpTools: input.allowedMcpTools } : {}),
    ...(input.workspaceMode !== undefined ? { workspaceMode: input.workspaceMode } : {}),
    ...(input.maintenance !== undefined ? { maintenance: input.maintenance } : {}),
    ...(input.nodeSettings !== undefined ? { nodeSettings: input.nodeSettings } : {}),
  });
  const safe = (operation: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<CallToolResult> => Promise.resolve().then(operation).then(result).catch(error => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }));
  server.registerTool("workflow_get_projects", {
    title: "读取 Codex 本机项目",
    description: "Read the current Codex desktop's local projects and this request's real thread/project ownership through the host's read-only app tools. Canonicalizes accessible local project directories without inferring caller ownership. Returns explicit unavailable status if pipe, caller metadata, schemas or the current project directory are unavailable. Global/unassigned callers receive no automatic project selection. Does not infer a project from cwd or shared server environment, inspect GUI databases, or start workers.",
    inputSchema: {}, annotations, _meta: { ui: { visibility: ["model", "app"] } },
  }, async (_input, extra) => safe(async () => ({ ...await projects.getProjects({ meta: extra._meta, signal: extra.signal }) })));
  server.registerTool("workflow_get_execution_settings", {
    title: "读取工作流默认模型",
    description: "Read Workflows' own default model/effort and the real Codex model catalogue without starting a turn. Main desktop dialogue settings are unavailable. Unset Workflows defaults use effective Codex CLI configuration, never claim main-dialogue inheritance.",
    inputSchema: { projectPath: z.string().min(1).optional() }, annotations,
  }, async input => safe(() => engine.getExecutionSettings(input.projectPath)));
  server.registerTool("workflow_update_execution_settings", {
    title: "保存工作流默认模型",
    description: "Replace Workflows' own default model/effort with revision compare-and-swap. Omitted model/effort clears that override and falls back to effective Codex CLI configuration. Validates against the actual model catalogue; does not edit Codex config, run a turn, or change existing run snapshots.",
    inputSchema: { revision, model: modelSettingsSchema.shape.model, reasoningEffort: modelSettingsSchema.shape.reasoningEffort, projectPath: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(() => engine.updateExecutionSettings({ revision: input.revision, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.projectPath ? { projectPath: input.projectPath } : {}) })));
  server.registerTool("workflow_save_template", {
    description: "Save a reusable workflow definition in the user's library. Includes script and default input, without a project, run results, or workspace. Load the saved revision to update an existing definition.",
    inputSchema: { script: z.string().min(1), args: z.unknown().optional(), allowWrite: z.boolean().optional(), revision: revision.optional(), limits, ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => {
    assertControlPlaneTransportable(input);
    return { template: await templates.save({ ...scopedInput(input), script: input.script, ...(input.args !== undefined ? { args: input.args } : {}), ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}), ...(input.limits ? { limits: Object.fromEntries(Object.entries(input.limits).filter(([, value]) => value !== undefined)) } : {}) }) };
  }));
  server.registerTool("workflow_preview", {
    description: "Validate and save a dynamic JavaScript workflow plan. Does not execute. projectPath must be explicit; networkAccess defaults false and is independent of allowWrite: read-only workers may use authorized network access without file writes. workspaceMode defaults snapshot. Declare any optional maintenance argv steps and activation before starting; maintenance operations require an isolated git-worktree and allowWrite; steps default non-idempotent, and unknown started-command outcomes cannot be replayed unless explicitly declared idempotent; allowedMcpServers is an explicit configured-server allowlist, default none, and cannot include Workflows. allowedMcpTools maps server names to granted configured tool names; grants do not bypass tool approvals.",
    inputSchema: { projectPath: z.string().min(1), script: z.string().min(1), args: z.unknown().optional(), allowWrite: z.boolean().optional(), sourceDefinition, limits, ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => {
    assertControlPlaneTransportable(input);
    const source = await verifiedDefinition(input.sourceDefinition, input.script);
    return acceptedRun(await engine.preview({ ...scopedInput({ ...input, networkAccess: input.networkAccess ?? false, allowedMcpServers: input.allowedMcpServers ?? [], allowedMcpTools: input.allowedMcpTools ?? {}, workspaceMode: input.workspaceMode ?? "snapshot" }), projectPath: input.projectPath, script: input.script, ...(source ? { sourceDefinition: source } : {}), ...(input.args !== undefined ? { args: input.args } : {}), ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}), ...(input.limits ? { limits: Object.fromEntries(Object.entries(input.limits).filter(([, value]) => value !== undefined)) } : {}) }));
  }));
  server.registerTool("workflow_update", {
    description: "Save an updated script and input for a stopped or draft workflow. Requires a fresh preview revision and another user start.",
    inputSchema: { id, revision, script: z.string().min(1), args: z.unknown(), allowWrite: z.boolean().optional(), ...scope },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => safe(async () => {
    const existing = await engine.get(input.id);
    const supplied = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    assertControlPlaneTransportable({ ...existing, ...supplied });
    return acceptedRun(await engine.update({ ...scopedInput(input), id: input.id, revision: input.revision, script: input.script, args: input.args, ...(input.allowWrite !== undefined ? { allowWrite: input.allowWrite } : {}) }));
  }));
  server.registerTool("workflow_list_runs", { description: "List bounded, paged run summaries without starting or resuming them. Summaries omit execution inputs and details; use workflow_get_run before inspecting or controlling a selected run.", inputSchema: { projectPath: z.string().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations }, async input => safe(async () => listPage(await engine.list(input.projectPath), input.offset ?? 0, input.limit ?? 100)));
  server.registerTool("workflow_get_run", { description: "Read a workflow's complete control scope with bounded transport views of tasks, logs and diff. Artifact pages use artifactOffset and artifactLimit; omitted artifacts and display previews never replace the stored review used for application.", inputSchema: { id, artifactOffset: z.number().int().nonnegative().optional(), artifactLimit: z.number().int().min(1).max(200).optional() }, annotations }, async input => safe(async () => ({ run: projectRunForTransport(await engine.get(input.id), { ...(input.artifactOffset !== undefined ? { artifactOffset: input.artifactOffset } : {}), ...(input.artifactLimit !== undefined ? { artifactLimit: input.artifactLimit } : {}) }) })));
  server.registerTool("workflow_get_node_process", {
    title: "查看节点过程",
    description: "Read concise node or phase activities and errors. Brief view excludes task prompts and raw diagnostics; developer detail explicitly adds bounded node logs. Does not execute a workflow.",
    inputSchema: { id, taskId: z.string().min(1).max(128).optional(), phase: z.string().min(1).max(256).optional(), scope: z.enum(["workflow", "unphased"]).optional(), detail: z.enum(["brief", "developer"]).optional() }, annotations, _meta: { ui: { visibility: ["model", "app"] } },
  }, async input => safe(async () => ({ process: nodeProcess(await engine.get(input.id), { ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.phase ? { phase: input.phase } : {}), ...(input.scope ? { scope: input.scope } : {}), ...(input.detail ? { detail: input.detail } : {}) }) })));
  server.registerTool("workflow_preview_deletion", {
    title: "预览工作流彻底清理",
    description: "Inspect complete owned-data deletion of one run, or a saved definition and its reliably associated runs. Explicit runIds may select legacy records; names never establish association. Returns exact scope, bytes and blockers, without deleting or stopping anything.",
    inputSchema: deletionFields, annotations, _meta: { ui: { visibility: ["model", "app"] } },
  }, async input => safe(async () => ({ preview: await deletion.preview(parsedDeletion(input)) })));
  server.registerTool("workflow_delete", {
    title: "彻底清理工作流",
    description: "Delete the exact confirmed owned-data scope using its fresh preview fingerprint. Requires user authorization, stopped workers and released references. Preserves delivered project changes. Cleanup failure reports remaining objects; it never hides leftover data as success.",
    inputSchema: { ...deletionFields, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: { ui: { visibility: ["model", "app"] } },
  }, async input => safe(async () => { const value = await deletion.execute({ ...parsedDeletion(input), fingerprint: input.fingerprint }); if (value.deletedRunIds.length) engine.forgetDeletedRuns(value.deletedRunIds); return { deletion: value }; }));
  server.registerTool("workflow_stop", { description: "Stop dispatch, interrupt all active workers, wait for their exit, and save progress.", inputSchema: { id }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(async () => acceptedRun(await engine.stop(input.id))));
  const appOnly = { ui: { visibility: ["app"] } };
  server.registerTool("workflow_panel_lease", { description: "Maintain the task panel lifecycle lease; losing the lease stops its active workflows.", inputSchema: { leaseId: z.string().optional(), release: z.boolean().optional() }, _meta: appOnly, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(() => engine.lease({ ...(input.leaseId ? { leaseId: input.leaseId } : {}), ...(input.release !== undefined ? { release: input.release } : {}) })));
  for (const action of ["start", "resume"] as const) server.registerTool(`workflow_${action}`, {
    description: `${action} the previewed workflow when the user has authorized execution. Requires the current revision and declared project/write/network scope. UI callers also pass their live panel lease; chat callers omit leaseId.${action === "resume" ? " Optional retryFromTaskId explicitly reruns that task and invalidates following results, preserving the earlier prefix. Already-started non-idempotent operations cannot be repeated." : ""}`,
    inputSchema: { id, revision, leaseId: z.string().min(1).optional(), ...(action === "resume" ? { retryFromTaskId: z.string().regex(/^task_[1-9][0-9]*$/).optional() } : {}) },
    _meta: { ui: { visibility: ["model", "app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async input => safe(async () => acceptedRun(await engine.start({ id: input.id, revision: input.revision, ...(input.leaseId ? { leaseId: input.leaseId } : {}), ...("retryFromTaskId" in input && typeof input.retryFromTaskId === "string" ? { retryFromTaskId: input.retryFromTaskId } : {}) }, action === "resume"))));
  server.registerTool("workflow_cancel_task", { description: "Cancel one active task on the user request. The script can handle its failure; other tasks keep running.", inputSchema: { id, taskId: z.string().min(1) }, _meta: { ui: { visibility: ["model", "app"] } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async input => safe(async () => acceptedRun(await engine.cancelTask(input.id, input.taskId))));
  server.registerTool("workflow_apply", { description: "Apply the final reviewed changes when the user has authorized application. Requires the current revision and completed review; detects baseline conflicts and retains project edits. Maintenance activation uses only its predeclared command.", inputSchema: { id, revision }, _meta: { ui: { visibility: ["model", "app"] } }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async input => safe(async () => acceptedRun(await engine.apply(input.id, input.revision))));

  return server;
}
