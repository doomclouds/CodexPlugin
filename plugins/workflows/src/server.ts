import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Icon, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WorkflowEngine } from "./engine.ts";
import { getCapabilities } from "./catalog.ts";
import { CodexProjectsProvider } from "./projects.ts";
import type { ProjectsProvider } from "./projects.ts";
import { modelSettingsSchema } from "./execution-settings.ts";
import { cloneJson, validateDefinition } from "./definition.ts";
import type { RunGrants, RunLimits } from "./structured-types.ts";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const id = z.string().min(1).max(160), revision = z.number().int().positive();
const identity = { id, revision }, controlIdentity = { ...identity, expectedOwnerToken: z.string().min(1).max(160).optional() }, instanceId = z.string().min(1).max(160);
const grants = z.strictObject({ allowWrite: z.boolean().optional(), networkAccess: z.boolean().optional(), workspaceMode: z.enum(["snapshot", "git-worktree", "local"]).optional(), approvalMode: z.enum(["auto-review", "never"]).optional(), allowedMcpServers: z.array(z.string().min(1).max(200)).max(100).optional(), allowedMcpTools: z.record(z.string(), z.array(z.string().min(1).max(200)).max(200)).optional() });
const limits = z.strictObject({ maxReadWorkers: z.number().int().min(1).max(32).optional(), maxCalls: z.number().int().min(1).max(10000).optional(), timeoutMs: z.number().int().min(1).max(86400000).optional(), maxTokens: z.number().int().nonnegative().optional(), maxInstances: z.number().int().min(1).max(5000).optional() });
const definition = z.strictObject({ schemaVersion: z.literal(1), name: z.string(), description: z.string(), parameters: z.array(z.record(z.string(), z.unknown())).optional(), steps: z.array(z.record(z.string(), z.unknown())) });
const reusable = { definition, args: z.unknown().optional(), grants: grants.optional(), limits: limits.optional() };
const deletion = { kind: z.enum(["run", "definition"]), ...identity };
const panelUri = "ui://workflows/panel.html";
const icons: Icon[] = [{ src: `data:image/png;base64,${readFileSync(new URL("../assets/workflows-sidebar-icon.png", import.meta.url)).toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] }];
function result(value: unknown): CallToolResult {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 6 * 1024 * 1024) throw new Error("Response exceeds the 6 MiB control-plane bound; request an instance or a smaller page.");
  return { content: [{ type: "text", text: json }], structuredContent: JSON.parse(json) };
}
function errorResult(error: unknown): CallToolResult { return { content: [{ type: "text", text: (error instanceof Error ? error.message : String(error)).slice(0, 8000) }], isError: true }; }
export function createServer(engine: WorkflowEngine, options: { projects?: ProjectsProvider } = {}) {
  const server = new McpServer({ name: "workflows", version: "0.10.0", icons });
  const html = readFileSync(new URL("../runtime/panel.html", import.meta.url), "utf8");
  const projects = options.projects ?? new CodexProjectsProvider();
  const protocol = server.server, original = protocol.setRequestHandler, set = original.bind(protocol);
  protocol.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, ListToolsRequestSchema)) return set(schema, handler);
    set(schema, async (request, extra) => { const catalog = await handler(request, extra) as ListToolsResult; return { ...catalog, tools: catalog.tools.map(tool => tool.name === "workflow_open_panel" ? { ...tool, icons } : tool) }; });
  };
  registerAppTool(server, "workflow_open_panel", { title: "Workflows", description: "Open the project workflow panel. Execution is available directly through tools; no UI scripting is required.", inputSchema: {}, annotations: readOnly, _meta: { ui: { resourceUri: panelUri }, "openai/ui": { entrypoints: [{ type: "thread" }] } } }, async () => result({ version: "0.10.0", format: "structured-v1" }));
  protocol.setRequestHandler = original;
  registerAppResource(server, "Workflows", panelUri, { mimeType: RESOURCE_MIME_TYPE, icons }, async () => ({ contents: [{ uri: panelUri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, "openai/ui": { availableDisplayModes: ["fullscreen"] } } }] }));
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (input: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>, writes = false, destructive = false) {
    const schema = z.strictObject(shape);
    server.registerTool<z.ZodRawShape, typeof schema>(name, { description, inputSchema: schema, annotations: writes ? { ...mutating, destructiveHint: destructive } : readOnly }, async input => { try { return result(await handler(input as z.infer<z.ZodObject<S>>)); } catch (error) { return errorResult(error); } });
  }
  const parsed = (input: z.infer<z.ZodObject<typeof reusable>>) => ({ definition: validateDefinition(input.definition), ...(input.args === undefined ? {} : { args: cloneJson(input.args) }), ...(input.grants ? { grants: input.grants as Partial<RunGrants> } : {}), ...(input.limits ? { limits: input.limits as Partial<RunLimits> } : {}) });
  tool("workflow_get_capabilities", "Inspect the structured workflow protocol and real runtime capabilities.", {}, () => getCapabilities());
  server.registerTool("workflow_get_projects", { description: "Resolve this panel's real caller project from Codex host metadata. The panel cannot switch its bound project.", inputSchema: {}, annotations: readOnly }, async (_input, extra) => { try { return result(await projects.getProjects({ meta: extra._meta, signal: extra.signal })); } catch (error) { return errorResult(error); } });
  tool("workflow_list_templates", "List saved reusable structured definitions. No default workflow is installed.", {}, () => ({ templates: engine.store.listDefinitions().map(item => ({ id: item.id, revision: item.revision, name: item.definition.name, description: item.definition.description, updatedAt: item.updatedAt })) }));
  tool("workflow_get_template", "Read a saved definition and its compiled plan at an exact revision or the latest.", { id, revision: revision.optional() }, input => ({ template: engine.template(input.id, input.revision) }));
  tool("workflow_save_template", "Create or update a reusable definition. Updating requires id and current revision. Each revision is immutable; existing runs stay frozen.", { ...reusable, id: id.optional(), revision: revision.optional() }, input => ({ template: engine.saveDefinition({ ...parsed(input), ...(input.id ? { id: input.id } : {}), ...(input.revision === undefined ? {} : { revision: input.revision }) }) }), true);
  tool("workflow_preview", "Validate a structured definition and freeze a draft against an explicitly authorized project. Use choice/parallel/map/repeat/try nodes; expressions are pure JSON, never JS. See the packaged skill reference.", { ...reusable, projectPath: z.string().min(1), sourceDefinition: z.strictObject(identity).optional() }, async input => engine.view((await engine.preview({ ...parsed(input), projectPath: input.projectPath, ...(input.sourceDefinition ? { sourceDefinition: input.sourceDefinition } : {}) })).id), true);
  tool("workflow_list_runs", "Page structured runs bound to a project. Legacy storage is not loaded.", { projectPath: z.string().optional(), limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().nonnegative().default(0) }, input => {
    const page = engine.list({ ...(input.projectPath ? { projectPath: input.projectPath } : {}), limit: input.limit + 1, offset: input.offset });
    return { runs: page.slice(0, input.limit).map(run => ({ id: run.id, revision: run.revision, name: run.definition.name, status: run.status, projectPath: run.projectPath, createdAt: run.createdAt, updatedAt: run.updatedAt })), ...(page.length > input.limit ? { nextOffset: input.offset + input.limit } : {}) };
  });
  tool("workflow_get_run", "Read the durable run and authoritative projection. scopeInstanceId selects a real activation, iteration, or map item.", { id, scopeInstanceId: instanceId.optional() }, input => engine.view(input.id, input.scopeInstanceId));
  tool("workflow_start", "Start a frozen draft. Tool use requires user authorization for the supplied write/network/MCP scopes.", identity, input => engine.view(engine.start(input).id), true);
  tool("workflow_pause", "Stop scheduling new nodes and wait for active work to settle before marking paused. An expectedOwnerToken pins this execution while progress revisions advance.", controlIdentity, async input => engine.view((await engine.pause({id:input.id,revision:input.revision,...(input.expectedOwnerToken?{expectedOwnerToken:input.expectedOwnerToken}:{})})).id), true);
  tool("workflow_stop", "Interrupt active work and await real worker exit. Unconfirmed write effects become unknown, never silently replayed. An expectedOwnerToken pins this execution while progress revisions advance.", controlIdentity, async input => engine.view((await engine.stop({id:input.id,revision:input.revision,...(input.expectedOwnerToken?{expectedOwnerToken:input.expectedOwnerToken}:{})})).id), true);
  tool("workflow_preview_recovery", "Compare the checkpoint and current files. Recovery preserves files and committed nodes. Failed node retry includes dependency invalidation.", { ...identity, instanceId: instanceId.optional() }, input => engine.recoveryPreview(input as { id: string; revision: number; instanceId?: string }));
  tool("workflow_resume", "Resume from the inspected recovery preview without replaying completed activities.", { ...identity, recoveryFingerprint: z.string().length(64) }, async input => engine.view((await engine.resume(input)).id), true);
  tool("workflow_retry_node", "Explicitly retry a known failed node after inspecting recovery. Unknown writes require reconciliation first.", { ...identity, instanceId, recoveryFingerprint: z.string().length(64) }, async input => engine.view((await engine.resume(input)).id), true);
  tool("workflow_resolve_wait", "Provide user input to a waiting node; resume separately after checking recovery.", { ...identity, instanceId, value: z.unknown() }, input => engine.view(engine.resolveWait({ ...input, value: cloneJson(input.value) }).id), true);
  tool("workflow_preview_unknown", "Inspect an uncertain activity and obtain its evidence-confirmation fingerprint.", { id, instanceId }, input => engine.unknownPreview(input.id, input.instanceId));
  tool("workflow_resolve_unknown", "Reconcile observed effects: completed supplies the confirmed output; retry explicitly confirms no effect or safe repetition. Evidence and fresh fingerprint are mandatory. This does not execute a worker.", { ...identity, instanceId, resolution: z.enum(["completed", "retry"]), output: z.unknown().optional(), fingerprint: z.string().length(64), evidence: z.string().min(3).max(4000) }, async input => engine.view((await engine.resolveUnknown({ ...input, ...(input.output === undefined ? {} : { output: cloneJson(input.output) }) } as Parameters<WorkflowEngine["resolveUnknown"]>[0])).id), true);
  tool("workflow_get_node_process", "Read a bounded process summary for one instance and attempt. Attempt history is paged latest first; developer logs are independent of run polling.", { id, instanceId, attemptId: id.optional(), detail: z.enum(["brief", "developer"]).default("brief"), attemptOffset: z.number().int().nonnegative().default(0), attemptLimit: z.number().int().min(1).max(100).default(30) }, input => {
    const process = engine.nodeProcess(input as Parameters<WorkflowEngine["nodeProcess"]>[0]), attempts = [...process.attempts].reverse(), page = attempts.slice(input.attemptOffset, input.attemptOffset + input.attemptLimit);
    return { process: { ...process, attempts: page, attemptTotal: attempts.length, ...(input.attemptOffset + page.length < attempts.length ? { nextAttemptOffset: input.attemptOffset + page.length } : {}) } };
  });
  tool("workflow_get_events", "Page durable transition and activity events.", { id, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100) }, input => ({ events: engine.store.events(input.id, input) }));
  tool("workflow_get_checkpoints", "Inspect committed checkpoint identities; recovery does not restore or overwrite project files.", { id }, input => ({ checkpoints: engine.store.checkpoints(input.id).slice(0, 100).map(({ snapshot: _snapshot, ...checkpoint }) => checkpoint) }));
  tool("workflow_review", "Prepare a conflict-checked change review for a stable writable run.", identity, async input => engine.view((await engine.review(input)).id), true);
  tool("workflow_apply", "Apply reviewed isolated changes. Local mode changes are already effective and require no apply.", { ...identity, fingerprint: z.string().min(1) }, async input => engine.view((await engine.apply(input)).id), true);
  tool("workflow_preview_deletion", "Inspect complete deletion: owned run data, logs, attempts, checkpoints and workspaces; definition deletion includes all its revisions and associated runs. Original projects are preserved.", deletion, input => engine.deletionPreview(input));
  tool("workflow_delete", "Execute the freshly fingerprinted complete deletion. Stop active runs and reconcile unknown effects first.", { ...deletion, fingerprint: z.string().length(64) }, input => engine.delete(input), true, true);
  tool("workflow_get_execution_settings", "Read global workflow model defaults and the real Codex model catalogue.", { projectPath: z.string().min(1) }, input => engine.settings(input.projectPath));
  tool("workflow_update_execution_settings", "Update workflow model defaults without changing frozen runs.", { ...modelSettingsSchema.shape, model: z.string().nullable().optional(), reasoningEffort: z.string().nullable().optional(), revision: z.number().int().nonnegative(), projectPath: z.string().min(1) }, async input => {
    const project = input.projectPath;
    return { settings: await engine.updateSettings({ revision: input.revision, ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) }, project) };
  }, true);
  return server;
}
