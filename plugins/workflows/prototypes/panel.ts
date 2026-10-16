import type { WorkflowDefinition, DefinitionPlan } from "../src/definition.ts";
import { elapsedLabel, escapeHtml, renderWorkflowGraph, statusLabels } from "./panel-graph.ts";
import type { GraphProjection } from "./panel-graph.ts";
import type { StructuredRun, NodeInstance, StructuredAttempt, StructuredDefinitionRecord } from "../src/structured-types.ts";
export type { NodeInstance } from "../src/structured-types.ts";
import { readParameters, renderParameterFields } from "./panel-parameters.ts";
export { escapeHtml } from "./panel-graph.ts";
export interface ToolResponse {
    structuredContent?: unknown;
    content?: Array<{
        type: string;
        text?: string | undefined;
    }> | undefined;
    isError?: boolean | undefined;
}
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolResponse>;
export interface ExecutionChoice {
    model?: string;
    reasoningEffort?: string;
}
export interface ExecutionSettingsResponse {
    settings: ExecutionChoice & {
        revision: number;
    };
    effectiveDefaults?: ExecutionChoice;
    models: Array<{
        id: string;
        displayName: string;
        supportedReasoningEfforts: string[];
        defaultReasoningEffort: string;
    }>;
}
export interface Project {
    projectId: string;
    label: string;
    path: string;
    hostId: string;
}
export interface TemplateSummary {
    id: string;
    revision: number;
    name: string;
    description: string;
}
export type TemplateDefinition = StructuredDefinitionRecord & {
    name?: string;
    description?: string;
    plan?: DefinitionPlan;
};
export type InstanceAttempt = StructuredAttempt;
export type WorkflowRun = StructuredRun;
export interface RunSummary {
    id: string;
    revision: number;
    name?: string;
    status: string;
    projectPath: string;
    createdAt: string;
    definition?: WorkflowDefinition;
}
export interface NodeProcess {
    selectedAttemptId?: string;
    attemptTotal?:number;nextAttemptOffset?:number;
    instance?: NodeInstance;
    attempts?: InstanceAttempt[];
    attempt?: InstanceAttempt;
    activities?: Array<{
        id?: string;
        label: string;
        status: string;
        detail?: string;
    }>;
    events?: unknown[];
    output?: unknown;
    error?: unknown;
    logs?: unknown;
    [key: string]: unknown;
}
export interface RecoveryPreview {
    fingerprint: string;
    canResume: boolean;
    blockers?: unknown[];
    warnings?: unknown[];
    [key: string]: unknown;
}
export interface DeletionPreview {
    fingerprint: string;
    canDelete?: boolean;
    blockers?: unknown[];
    [key: string]: unknown;
}
export interface PanelState {
    connection: "offline" | "connecting" | "connected" | "degraded" | "closed";
    project?: Project;
    projectsError: string;
    templates: TemplateSummary[];
    runNextOffset?:number|undefined;
    runs: RunSummary[];
    run?: WorkflowRun;
    template?: TemplateDefinition;
    projection?: GraphProjection;
    selectedTemplate?: string;
    selectedRun?: string;
    busy: boolean;
    error: string;
    settings?: ExecutionSettingsResponse;
}
export interface HostStyleEffects {
    theme: (theme: "light" | "dark") => void;
    variables: (variables: Record<string, string | undefined>) => void;
    fonts: (css: string) => void;
}
// Some hosts send only style variables. Keep native menus aligned with that
// surface instead of using an unrelated operating-system color preference.
function surfaceTheme(color: string | undefined): "light" | "dark" | undefined {
    if (!color)
        return undefined;
    const value = color.trim();
    let channels: number[];
    const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
    if (hex) {
        const expanded = hex.length <= 4 ? [...hex].map(part => part + part).join("") : hex;
        if (expanded.length === 8 && expanded.slice(6).toLowerCase() !== "ff")
            return undefined;
        channels = expanded.slice(0, 6).match(/../g)!.map(part => parseInt(part, 16) / 255);
    }
    else {
        const rgb = /^rgba?\(\s*([\d.]+)(%)?[\s,]+([\d.]+)(%)?[\s,]+([\d.]+)(%)?(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/i.exec(value);
        if (!rgb)
            return undefined;
        if (rgb[7] !== undefined && Number(rgb[7]) / (rgb[8] ? 100 : 1) !== 1)
            return undefined;
        channels = [1, 3, 5].map(index => Number(rgb[index]) / (rgb[index + 1] ? 100 : 255));
    }
    if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1))
        return undefined;
    const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722 > .179 ? "light" : "dark";
}
// The pinned SDK exposes separate theme, variable and font helpers.
export function applyPanelHostStyles(context: Record<string, unknown>, effects: HostStyleEffects): void {
    const styles = context.styles as {
        variables?: Record<string, string | undefined>;
        css?: {
            fonts?: string;
        };
    } | undefined;
    const theme = context.theme === "light" || context.theme === "dark" ? context.theme : surfaceTheme(styles?.variables?.["--color-background-primary"]);
    if (theme)
        effects.theme(theme);
    if (styles?.variables)
        effects.variables(styles.variables);
    if (typeof styles?.css?.fonts === "string")
        effects.fonts(styles.css.fonts);
}
export function toolPayload(response: ToolResponse): Record<string, unknown> {
    const text = response.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
    if (response.isError)
        throw new Error(text || "工作流工具返回错误");
    let data = response.structuredContent;
    if (data === undefined && text) {
        try {
            data = JSON.parse(text);
        }
        catch {
            throw new Error("工作流工具未返回有效 JSON");
        }
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("工作流工具返回无效数据");
    return data as Record<string, unknown>;
}
const message = (error: unknown): string => error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
export function parseRun(value: unknown): WorkflowRun { const run = value as Partial<WorkflowRun> | null; if (!run || run.format !== "structured-v1" || !run.compiled?.plan || !Array.isArray(run.compiled.plan.nodes) || !Array.isArray(run.compiled.plan.edges) || typeof run.id !== "string" || !Number.isSafeInteger(run.revision) || run.definition?.schemaVersion !== 1 || typeof run.definitionHash !== "string" || !Array.isArray(run.instances) || !Array.isArray(run.events) || typeof run.status !== "string")
    throw new Error("宿主未返回有效的结构化运行；旧脚本记录不受支持"); return run as WorkflowRun; }
export function panelInputSignature(value?: WorkflowRun | TemplateDefinition): string { return value ? JSON.stringify({ definition: value.definition, args: value.args, grants: value.grants, limits: value.limits }) : ""; }
export class PanelDialogLifecycle {
    private generation = 0;
    private readonly dialog: HTMLDialogElement;
    constructor(dialog: HTMLDialogElement) { this.dialog = dialog; dialog.addEventListener("close", () => { this.generation++; }); }
    opened(): void { this.generation++; }
    current(): () => boolean { const generation = this.generation; return () => this.dialog.open && generation === this.generation; }
}
const live = (run?: WorkflowRun): boolean => !!run && ["preparing", "running", "pausing", "stopping"].includes(run.status);
/** Each background read has a selection generation. Mutations are never retried on transport failure. */
export class WorkflowPanelController {
    readonly state: PanelState = { connection: "offline", projectsError: "", templates: [], runs: [], busy: false, error: "" };
    private generation = 0;
    private pollInFlight = false;
    private closed = false;
    private stopTimer?: () => void;
    private requestedProject = "";
    private scopeInstanceId: string | undefined;
    private historyInFlight=false;
    private readonly callTool: ToolCaller;
    private readonly changed: () => void;
    private readonly schedule: (callback: () => void, ms: number) => () => void;
    constructor(callTool: ToolCaller, changed: () => void = () => { }, schedule: (callback: () => void, ms: number) => () => void = (callback, ms) => { const timer = setInterval(callback, ms); return () => clearInterval(timer); }) { this.callTool = callTool; this.changed = changed; this.schedule = schedule; }
    get selected(): WorkflowRun | undefined { return this.state.run; }
    get input(): WorkflowRun | TemplateDefinition | undefined { return this.state.run ?? this.state.template; }
    async request(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return toolPayload(await this.callTool(name, args)); }
    connecting(): void { this.state.connection = "connecting"; this.changed(); }
    disconnected(error: unknown): void { if (this.closed)
        return; this.state.connection = "degraded"; this.state.error = `连接异常：${message(error)}`; this.changed(); }
    setProjectPath(value: string): void { this.requestedProject = value; }
    receive(response: ToolResponse): void { try {
        const data = toolPayload(response);
        if (data.run)
            this.accept(data);
    }
    catch (error) {
        this.state.error = message(error);
        this.changed();
    } }
    private accept(data: Record<string, unknown>): void {
        const run = parseRun(data.run);
        if (!this.state.project) throw new Error("尚未确认当前聊天项目，不能载入运行。");
        if (run.projectPath !== this.state.project.path) throw new Error("运行不属于当前聊天项目");
        const old = this.state.run;
        if (old?.id === run.id && old.revision > run.revision) return;
        const projection = data.projection as GraphProjection | undefined;
        if (projection && (projection.definitionHash !== run.definitionHash || projection.revision !== run.revision || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges))) throw new Error("运行与投影版本不一致，请重新读取");
        this.state.run = run;
        const summary: RunSummary = { id: run.id, revision: run.revision, name: run.definition.name, status: run.status, projectPath: run.projectPath, createdAt: run.createdAt };
        const index = this.state.runs.findIndex(item => item.id === run.id);
        if (index < 0) this.state.runs.unshift(summary); else this.state.runs[index] = summary;
        this.state.selectedRun = run.id;
        delete this.state.selectedTemplate; delete this.state.template;
        if (projection) this.state.projection = projection; else delete this.state.projection;
        this.scopeInstanceId=projection?.scopeInstanceId;
        this.changed();
    }
    async connected(): Promise<void> { if (this.closed)
        return; this.connecting(); try {
        await this.refreshProjects();
        if (!this.closed) {
            this.state.connection = "connected";
            await Promise.allSettled([this.refreshLibrary(), this.refreshRuns()]);
            this.stopTimer?.();
            this.stopTimer = this.schedule(() => { void this.refresh(); }, 2000);
            this.changed();
        }
    }
    catch (error) {
        this.disconnected(error);
    } }
    async refreshProjects(): Promise<void> {
        const data = await this.request("workflow_get_projects");
        if (this.closed)
            return;
        const projects = Array.isArray(data.projects) ? data.projects as Project[] : [];
        const current = typeof data.currentProjectId === "string" ? projects.find(project => project.projectId === data.currentProjectId) : undefined;
        if (data.available !== true || !current) {
            this.generation++;delete this.state.run;delete this.state.template;delete this.state.selectedRun;delete this.state.selectedTemplate;delete this.state.projection;this.state.runs=[];
            delete this.state.project;
            this.state.projectsError = typeof data.reason === "string" ? data.reason : "请从项目聊天打开 Workflows";
            this.changed();
            return;
        }
        if (this.requestedProject && current.path !== this.requestedProject) {
            this.state.error = "面板输入目录与当前聊天项目不一致，已使用宿主确认的项目。";
        }
        if (this.state.project?.projectId !== current.projectId || this.state.project.path !== current.path) {
            this.generation++;
            delete this.state.run;
            delete this.state.template;
            delete this.state.selectedRun;
            delete this.state.selectedTemplate;
            delete this.state.projection;
            this.state.runs = [];
        }
        this.state.project = current;
        this.state.projectsError = "";
        this.changed();
    }
    async refreshLibrary(): Promise<void> { try {
        const data = await this.request("workflow_list_templates");
        if (this.closed)
            return;
        this.state.templates = Array.isArray(data.templates) ? data.templates as TemplateSummary[] : [];
        this.changed();
    }
    catch (error) {
        this.state.error = message(error);
        this.changed();
    } }
    async refreshRuns(): Promise<void> { const project = this.state.project; if (!project)
        return; const data = await this.request("workflow_list_runs", { projectPath: project.path }); if (this.closed || this.state.project?.path !== project.path)
        return; this.state.runs = Array.isArray(data.runs) ? data.runs as RunSummary[] : [];this.state.runNextOffset=typeof data.nextOffset==="number"?data.nextOffset:undefined; this.changed(); }
    async moreRuns():Promise<void>{
        const project=this.state.project,offset=this.state.runNextOffset;if(!project||offset===undefined||this.historyInFlight)return;
        this.historyInFlight=true;try{const data=await this.request("workflow_list_runs",{projectPath:project.path,offset,limit:100});if(this.closed||this.state.project?.path!==project.path)return;const ids=new Set(this.state.runs.map(run=>run.id));this.state.runs.push(...(Array.isArray(data.runs)?data.runs as RunSummary[]:[]).filter(run=>!ids.has(run.id)));this.state.runNextOffset=typeof data.nextOffset==="number"?data.nextOffset:undefined;this.changed();}finally{this.historyInFlight=false;}
    }
    async selectRun(id: string): Promise<void> { this.scopeInstanceId = undefined; const generation = ++this.generation; this.state.error = ""; try {
        const data = await this.request("workflow_get_run", { id });
        if (this.closed || generation !== this.generation)
            return;
        this.accept(data);
    }
    catch (error) {
        if (generation === this.generation) {
            this.state.error = message(error);
            this.changed();
        }
    } }
    async selectTemplate(id: string): Promise<void> { const generation = ++this.generation; this.state.error = ""; try {
        const data = await this.request("workflow_get_template", { id });
        if (this.closed || generation !== this.generation)
            return;
        const template = data.template as TemplateDefinition;
        if (template?.definition?.schemaVersion !== 1)
            throw new Error("库中定义不是当前结构化格式");
        this.state.template = { ...template, ...(data.plan ? { plan: data.plan as DefinitionPlan } : {}) };
        this.state.selectedTemplate = template.id;
        delete this.state.selectedRun;
        delete this.state.run;
        delete this.state.projection;
        this.changed();
    }
    catch (error) {
        if (generation === this.generation) {
            this.state.error = message(error);
            this.changed();
        }
    } }
    async refresh(): Promise<void> { if (this.closed || this.pollInFlight || this.state.connection === "offline")
        return; this.pollInFlight = true; const generation = this.generation, id = this.state.selectedRun; try {
        if (id) {
            const data = await this.request("workflow_get_run", { id, ...(this.scopeInstanceId ? { scopeInstanceId: this.scopeInstanceId } : {}) });
            if (!this.closed && generation === this.generation)
                this.accept(data);
        }
        if (!this.closed) {
            this.state.connection = "connected";
            this.changed();
        }
    }
    catch (error) {
        if (generation === this.generation && !this.closed)
            this.disconnected(error);
    }
    finally {
        this.pollInFlight = false;
    } }
    async selectScope(instanceId?: string): Promise<void> { this.generation++; this.scopeInstanceId = instanceId; await this.refresh(); }
    async mutate(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> { if (this.state.connection !== "connected" || !this.state.project)
        throw new Error("请先连接当前项目"); if (this.state.busy)
        throw new Error("操作处理中"); this.state.busy = true; this.state.error = ""; const generation = this.generation; this.changed(); try {
        const data = await this.request(name, args);
        if (data.run && generation === this.generation)
            this.accept(data);
        return data;
    }
    catch (error) {
        this.state.error = `操作未确认：${message(error)}。请刷新核对；不会自动重复发送。`;
        throw error;
    }
    finally {
        this.state.busy = false;
        this.changed();
    } }
    async createPreview(args?: Record<string, unknown>): Promise<void> { const input = this.input, project = this.state.project; if (!input || !project)
        return; const selected = this.state.template, source = "sourceDefinition" in input ? input.sourceDefinition : selected ? { id: selected.id, revision: selected.revision } : undefined; await this.mutate("workflow_preview", { projectPath: project.path, definition: input.definition, args: args ?? input.args ?? {}, grants: input.grants ?? {}, limits: input.limits ?? {}, ...(source ? { sourceDefinition: source } : {}) }); await this.refreshRuns(); }
    async perform(action: "start" | "pause" | "resume" | "stop", extra: Record<string, unknown> = {}): Promise<void> { if (action === "start" && (!this.state.run || this.state.run.status === "completed"))
        await this.createPreview(); const run = this.state.run; if (!run)
        return; await this.mutate(`workflow_${action}`, { id: run.id, revision: run.revision, ...((action === "pause" || action === "stop") && run.ownerToken ? { expectedOwnerToken: run.ownerToken } : {}), ...extra }); }
    async executionSettings(): Promise<ExecutionSettingsResponse> { const data = await this.request("workflow_get_execution_settings", { projectPath: this.state.project?.path }); if (!data.settings || !Array.isArray(data.models))
        throw new Error("执行设置格式无效"); this.state.settings = { ...data, effectiveDefaults: data.effectiveDefaults ?? data.defaults } as unknown as ExecutionSettingsResponse; return this.state.settings; }
    async teardown(): Promise<void> { this.closed = true; this.generation++; this.stopTimer?.(); this.state.connection = "closed"; this.changed(); }
}
export interface ProcessTarget {
    runId: string;
    instanceId: string;
    attemptId?: string;
    detail: "brief" | "developer";
    attemptOffset?:number;
}
/** Log requests are independent of snapshot polling; stale responses cannot replace another instance. */
export class NodeProcessReader {
    private generation = 0;
    private active: string | undefined;
    private target: ProcessTarget | undefined;
    private queued = false;
    private readonly call: ToolCaller;
    private readonly receive: (target: ProcessTarget, process: NodeProcess) => void;
    private readonly reject: (error: unknown) => void;
    constructor(call: ToolCaller, receive: (target: ProcessTarget, process: NodeProcess) => void, reject: (error: unknown) => void) { this.call = call; this.receive = receive; this.reject = reject; }
    select(target?: ProcessTarget): void { this.generation++; this.target = target; this.active = undefined; this.queued = false; if (target)
        void this.refresh(); }
    async refresh(): Promise<void> {
        const target = this.target;
        if (!target)
            return;
        const key = JSON.stringify(target);
        if (this.active === key) {
            this.queued = true;
            return;
        }
        const generation = this.generation;
        this.active = key;
        try {
            const data = toolPayload(await this.call("workflow_get_node_process", { id: target.runId, instanceId: target.instanceId, ...(target.attemptId ? { attemptId: target.attemptId } : {}), detail: target.detail,...(target.attemptOffset!==undefined?{attemptOffset:target.attemptOffset}:{}) }));
            if (generation === this.generation)
                this.receive(target, (data.process ?? data) as NodeProcess);
        }
        catch (error) {
            if (generation === this.generation)
                this.reject(error);
        }
        finally {
            if (generation === this.generation) {
                this.active = undefined;
                if (this.queued) {
                    this.queued = false;
                    void this.refresh();
                }
            }
        }
    }
}
export function renderNodeProcess(process: NodeProcess): string { const attempt = process.attempt ?? process.attempts?.find(attempt => attempt.id === process.selectedAttemptId), activities = process.activities ?? attempt?.activities ?? [], error = process.error ?? (process.selectedAttemptId || attempt ? attempt?.error : process.instance?.error), output = process.output ?? (process.selectedAttemptId || attempt ? attempt?.output : process.instance?.output); return `${error ? `<div class="wf-alert">${escapeHtml(message(error))}</div>` : ""}<ol class="wf-process-events">${activities.map(activity => `<li data-status="${escapeHtml(activity.status)}"><span class="wf-icon${activity.status === "running" ? " is-spinning" : ""}" data-icon="${activity.status === "completed" ? "circle-check" : activity.status === "running" ? "loader-2" : "circle"}" aria-hidden="true"></span><span>${escapeHtml(activity.label)}</span></li>`).join("")}</ol>${output !== undefined ? `<details><summary>节点结果</summary><pre>${escapeHtml(typeof output === "string" ? output : JSON.stringify(output, null, 2))}</pre></details>` : ""}${!activities.length && !error && output === undefined ? '<p class="wf-muted">暂无活动记录；状态以服务端实例为准。</p>' : ""}`; }
export function instanceDisplayLabel(instance: NodeInstance): string {
    const parts=[instance.label,instance.iteration!==undefined?`第 ${instance.iteration+1} 轮`:undefined,instance.itemKey!==undefined?`项目 ${instance.itemKey}`:undefined,instance.branchId,instance.path,statusLabels[instance.status]??instance.status];
    const seen=new Set<string>();return parts.filter((part):part is string=>{if(!part)return false;const key=part.replace(/\s+/g,"");if(seen.has(key))return false;seen.add(key);return true;}).join(" · ");
}
export function renderScopeOptions(instances:readonly NodeInstance[],selectedId?:string):string{
    return `<option value=""${selectedId?"":" selected"}>整个运行</option>${instances.filter(instance=>["scope","repeat","map","choice","parallel","try","subflow","expand"].includes(instance.type)).map(instance=>`<option value="${escapeHtml(instance.id)}"${instance.id===selectedId?" selected":""}>${escapeHtml(instanceDisplayLabel(instance))}</option>`).join("")}`;
}
export function renderPreparation(stages?: StructuredRun["preparation"]): string {
    return stages?.map(stage => `<li data-status="${escapeHtml(stage.status)}"><span class="wf-icon${stage.status === "running" ? " is-spinning" : ""}" data-icon="${stage.status === "running" ? "loader-2" : stage.status === "completed" ? "circle-check" : "alert-circle"}" aria-hidden="true"></span>${escapeHtml(stage.label)}</li>`).join("") ?? "";
}
export function renderRecoveryPreview(preview: RecoveryPreview): string {
    const count = (key: string): number => Array.isArray(preview[key]) ? preview[key].length : 0;
    const explain = (value: unknown): string => value && typeof value === "object" && "message" in value ? String(value.message) : message(value);
    return `<p>保留当前项目文件，核对检查点后继续未完成实例。</p><ul><li>复用 ${count("reusedInstanceIds")} 个已提交实例</li><li>继续或重新执行 ${count("rerunInstanceIds")} 个实例</li><li>结果待核实 ${count("unknownInstanceIds")} 个实例</li></ul>${preview.blockers?.length ? `<div class="wf-alert">${preview.blockers.map(item => escapeHtml(explain(item))).join("<br>")}</div>` : ""}${preview.warnings?.length ? `<ul class="wf-muted">${preview.warnings.map(item => `<li>${escapeHtml(explain(item))}</li>`).join("")}</ul>` : ""}<details><summary>检查点明细</summary><pre>${escapeHtml(JSON.stringify(preview, null, 2))}</pre></details>`;
}
/** The mount never replaces a dialog or an open form on a polling render. */
export function mountPanel(root: HTMLElement, callTool: ToolCaller): WorkflowPanelController {
    const element = <T extends HTMLElement = HTMLElement>(selector: string): T => { const value = root.querySelector<T>(selector); if (!value)
        throw new Error(`Workflows 元素缺失：${selector}`); return value; };
    const setText = (selector: string, value: unknown): void => { const node = element(selector); const text = String(value ?? ""); if (node.textContent !== text)
        node.textContent = text; };
    const setHtml = (selector: string, value: string): void => { const node = element(selector); if (node instanceof HTMLSelectElement && node === root.ownerDocument.activeElement && node.options.length) return;
        if (node.innerHTML !== value) node.innerHTML = value; };
    const show = (selector: string, visible: boolean): void => { element(selector).hidden = !visible; };
    const parameters = element<HTMLDialogElement>("#wf-parameters-dialog"), settings = element<HTMLDialogElement>("#wf-settings-dialog"), history = element<HTMLDialogElement>("#wf-history-dialog"), recovery = element<HTMLDialogElement>("#wf-recovery-dialog"), deletion = element<HTMLDialogElement>("#wf-delete-dialog"), waitDialog = element<HTMLDialogElement>("#wf-wait-dialog"), applyDialog = element<HTMLDialogElement>("#wf-apply-dialog");
    const lifecycle = new Map<HTMLDialogElement, PanelDialogLifecycle>([parameters, settings, history, recovery, deletion, waitDialog, applyDialog].map(dialog => [dialog, new PanelDialogLifecycle(dialog)]));
    let parameterOwner = "", parameterSignature = "", parameterStale = false, settingsRevision = -1, settingsStale = false, selectedNodeId: string | undefined, selectedInstanceId: string | undefined, selectedAttemptId: string | undefined, processDetail: "brief" | "developer" = "brief", processOwner = "", processBusy = false, zoom = 1, scopeInstanceId: string | undefined;
    const collapsed = new Set<string>();
    let instanceLimit=50,attemptHistory:InstanceAttempt[]=[],attemptNextOffset:number|undefined,attemptTotal=0;
    let recoveryValue: RecoveryPreview | undefined, recoveryTarget: string | undefined, deleteValue: DeletionPreview | undefined, deleteTarget: {
        kind: "run" | "definition";
        id: string;
        revision: number;
    } | undefined, applyTarget: {
        id: string;
        revision: number;
        fingerprint?: string;
    } | undefined;
    const open = (dialog: HTMLDialogElement): void => { lifecycle.get(dialog)!.opened(); if (!dialog.open)
        dialog.showModal(); };
    const close = (dialog: HTMLDialogElement): void => { dialog.close(); };
    const owner = (): string => controller.state.selectedRun ? `run:${controller.state.selectedRun}` : `definition:${controller.state.selectedTemplate ?? ""}`;
    const report = (error: unknown): void => { controller.state.error = message(error); render(); };
    const perform = async (callback: () => Promise<unknown>): Promise<void> => { try {
        await callback();
    }
    catch (error) {
        report(error);
    } };
    const processReader = new NodeProcessReader(callTool, (target, process) => { if (target.instanceId !== selectedInstanceId || target.attemptId !== selectedAttemptId || target.runId !== controller.state.run?.id)
        return; processBusy = false;
        const history = process.attempts ?? [];
        const known = new Set(attemptHistory.map(attempt => attempt.id));
        if (target.attemptOffset) attemptHistory.push(...history.filter(attempt => !known.has(attempt.id)));
        else { const latestIds = new Set(history.map(attempt => attempt.id)); attemptHistory = [...history, ...attemptHistory.filter(attempt => !latestIds.has(attempt.id))]; }
        attemptNextOffset = process.nextAttemptOffset; attemptTotal = process.attemptTotal ?? attemptHistory.length; renderSidebar();
        setText("#wf-process-loading", ""); if (target.detail === "developer") {
        setText("#wf-process-developer", JSON.stringify(process.logs ?? process.events ?? process, null, 2));
    }
    else
        setHtml("#wf-process-body", renderNodeProcess(process)); }, error => { processBusy = false; setText("#wf-process-loading", `读取失败：${message(error)}`); show("#wf-process-refresh", true); });
    const controller = new WorkflowPanelController(callTool, () => render());
    function activeInstance(): NodeInstance | undefined { return controller.state.run?.instances.find(instance => instance.id === selectedInstanceId); }
    function instanceLabel(instance:NodeInstance):string{return instanceDisplayLabel(instance);}
    function selectProcess(instanceId?: string): void { const run = controller.state.run; selectedInstanceId = instanceId; selectedAttemptId = undefined;attemptHistory=[];attemptNextOffset=undefined;attemptTotal=0; processOwner = run?.id ?? ""; if (!run || !instanceId) {
        processBusy = false;
        processReader.select();
        setHtml("#wf-process-body",controller.state.projection?.nodes.find(node=>node.id===selectedNodeId)?.inScope===false?'<p class="wf-muted">当前范围外。切回整个运行查看该节点的记录。</p>':'<p class="wf-muted">请选择一个执行实例查看记录；尚未激活的节点没有执行日志。</p>');
        setText("#wf-process-loading", "");
        renderSidebar();
        return;
    } processBusy = true; setText("#wf-process-loading", "正在读取节点过程…"); setText("#wf-process-developer", ""); processReader.select({ runId: run.id, instanceId, detail: processDetail }); renderSidebar(); }
    function renderSidebar(): void {
        const run = controller.state.run;
        if (!selectedNodeId) {
            show("#wf-process-sidebar", false);
            return;
        }
        show("#wf-process-sidebar", true);
        const plan = controller.state.projection ?? run?.compiled.plan ?? controller.state.template?.plan;
        const node = plan?.nodes.find(node => node.id === selectedNodeId);
        setText("#wf-process-title", node?.label ?? "节点过程");
        const projectedNode = controller.state.projection?.nodes.find(node => node.id === selectedNodeId);
        const ids = projectedNode ? [...new Set([...projectedNode.instanceIds, ...projectedNode.scopeInstanceIds ?? [], ...projectedNode.availableScopeInstanceIds ?? []])] : undefined;
        const instances = run?.instances.filter(instance => ids ? ids.includes(instance.id) : instance.nodeId === selectedNodeId) ?? [];
        const shown=instances.slice(0,instanceLimit);const selectedInstance=instances.find(instance=>instance.id===selectedInstanceId);if(selectedInstance&&!shown.some(instance=>instance.id===selectedInstance.id))shown.unshift(selectedInstance);
        show("#wf-instances-more",shown.length<instances.length);setText("#wf-instance-count",`${Math.min(shown.length,instances.length)} / ${instances.length} 个实例`);
        const options = shown.map(instance => `<option value="${escapeHtml(instance.id)}">${escapeHtml(instanceLabel(instance))}</option>`).join("");
        setHtml("#wf-instance-select", `<option value="">${instances.length ? "选择执行实例" : "尚未激活"}</option>${options}`);
        if(element("#wf-instance-select")!==root.ownerDocument.activeElement)element<HTMLSelectElement>("#wf-instance-select").value = selectedInstanceId ?? "";
        element<HTMLSelectElement>("#wf-instance-select").disabled = !instances.length;
        const instance = activeInstance(), attempts = attemptHistory;
        setHtml("#wf-attempt-select", `<option value="">当前尝试</option>${attempts.map((attempt, index) => `<option value="${escapeHtml(attempt.id)}">尝试 ${escapeHtml(attempt.id.slice(-8))} · ${escapeHtml(statusLabels[attempt.status] ?? attempt.status)}</option>`).join("")}`);
        if(element("#wf-attempt-select")!==root.ownerDocument.activeElement)element<HTMLSelectElement>("#wf-attempt-select").value = selectedAttemptId ?? "";
        show("#wf-attempt-field", attempts.length > 0);show("#wf-attempts-more",attemptNextOffset!==undefined);setText("#wf-attempt-count",`${attempts.length} / ${attemptTotal} 次尝试`);
        show("#wf-wait-toggle", instance?.type === "wait" && instance.status === "waiting");
        show("#wf-retry-node", !!instance && instance.type !== "scope" && ["failed", "interrupted", "cancelled"].includes(instance.status) && !live(run));
        element<HTMLButtonElement>("#wf-retry-node").disabled = controller.state.busy || controller.state.connection !== "connected";
        setText("#wf-instance-status", instance?.status === "unknown" ? "结果待核实：可能已有部分副作用，请让 AI 核对证据后处理，不会直接重试。" : instance ? statusLabels[instance.status] ?? instance.status : projectedNode?.inScope===false?"当前范围外":"计划节点");
        show("#wf-process-body", processDetail === "brief");
        show("#wf-process-developer", processDetail === "developer");
        for (const tab of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-process-view]")))
            tab.setAttribute("aria-selected", String(tab.dataset.processView === processDetail));
    }
    function render(): void {
        const state = controller.state, run = state.run, input = controller.input, connected = state.connection === "connected" && !!state.project;
        scopeInstanceId=state.projection?.scopeInstanceId;
        if(element("#wf-scope-select")!==root.ownerDocument.activeElement)scopeOptions();
        setText("#wf-connection", state.connection === "connected" ? "已连接宿主" : state.connection === "connecting" ? "正在连接…" : state.connection === "degraded" ? "连接异常" : "离线预览");
        setText("#wf-project-label", state.project?.label ?? "请从项目聊天打开");
        element("#wf-project-label").title = state.project?.path ?? "";
        setText("#wf-project-help", state.projectsError || "所属项目固定；跨项目复用请从另一个项目聊天新建运行。");
        setText("#wf-notification", state.error || run?.error || "");
        show("#wf-notification", !!state.error || !!run?.error);
        const select = element<HTMLSelectElement>("#wf-template-select"), selected = run ? `run:${run.id}` : state.template ? `definition:${state.template.id}` : "";
        const options = `<option value="">选择工作流</option>${state.runs.length ? `<optgroup label="当前项目运行">${state.runs.map(item => `<option value="run:${escapeHtml(item.id)}">${escapeHtml(item.definition?.name ?? item.name ?? item.id)} · ${escapeHtml(statusLabels[item.status] ?? item.status)}</option>`).join("")}</optgroup>` : ""}${state.templates.length ? `<optgroup label="工作流库">${state.templates.map(item => `<option value="definition:${escapeHtml(item.id)}">${escapeHtml(item.name)} · 库中定义</option>`).join("")}</optgroup>` : ""}`;
        if (select !== root.ownerDocument.activeElement) { if (select.innerHTML !== options) select.innerHTML = options; if(select.value!==selected) select.value=selected; }
        select.disabled = !connected || state.busy;
        setText("#wf-execution-status", run ? statusLabels[run.status] ?? run.status : input ? "尚未创建运行" : "待选择");
        setText("#wf-start-label", run?.status === "completed" ? "再次运行" : "启动");
        const preparing=run?.status==="preparing"?run.preparation?.find(stage=>stage.status==="running"):undefined;
        setText("#wf-current-action", preparing?.label??input?.definition.name ?? "在对话中创建工作流");
        setHtml("#wf-preparation",renderPreparation(run?.preparation));
        const grants=input?.grants;setText("#wf-execution-scope",grants?`${grants.workspaceMode==="local"?"原项目":grants.workspaceMode==="git-worktree"?"Git 隔离":"文件快照"} · ${grants.allowWrite?"允许修改":"只读"} · ${grants.networkAccess?"允许联网":"网络关闭"} · ${(grants.allowedMcpServers??[]).length} 个 MCP`:"由 AI 声明执行范围");
        setText("#wf-activity-time", run ? `${run.instances.length} 个实例${run.startedAt ? ` · 已运行 ${elapsedLabel(run.startedAt, run.endedAt)}` : ""}` : input?.definition.description ?? "结构、执行与面板使用同一份定义");
        for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-action]"))) {
            const action = button.dataset.action;
            button.disabled = !connected || state.busy || !input || (action === "start" ? !!run && !["draft", "completed"].includes(run.status) : action === "pause" ? !run || run.status !== "running" : action === "resume" ? !run || !["paused", "stopped", "failed", "unknown"].includes(run.status) : action === "stop" ? !run || !["preparing", "running", "pausing", "paused", "waiting"].includes(run.status) : true);
        }
        element<HTMLButtonElement>("#wf-parameters-toggle").disabled = !connected || !input || live(run) || state.busy;
        element<HTMLButtonElement>("#wf-settings-toggle").disabled = !connected;
        for (const id of ["#wf-history-toggle", "#wf-more-toggle"])
            element<HTMLButtonElement>(id).disabled = !connected;
        show("#wf-apply-toggle", !!run && run.grants.allowWrite && !!run.workspace && !live(run) && run.status !== "unknown");
        setText("#wf-apply-toggle", run?.grants.workspaceMode === "local" ? "查看本地改动" : "审查并应用改动");
        if (parameters.open) {
            const stale = owner() !== parameterOwner || panelInputSignature(input) !== parameterSignature;
            if (stale) {
                parameterStale = true;
                setText("#wf-parameter-error", "参数来源已变化。草稿已保留，请取消后重新打开再核对。");
                show("#wf-parameter-error", true);
            }
            element<HTMLButtonElement>("#wf-save-parameters").disabled = parameterStale || state.busy || !connected;
        }
        if (settings.open && state.settings && state.settings.settings.revision !== settingsRevision) {
            settingsStale = true;
            setText("#wf-settings-error", "默认设置已更新。草稿已保留，请重新打开核对。");
            show("#wf-settings-error", true);
            element<HTMLButtonElement>("#wf-save-settings").disabled = true;
        }
        const graph = element("#wf-panel-overview"), focus = root.ownerDocument.activeElement as HTMLElement | null, focused = focus?.closest<HTMLButtonElement>("[data-node]")?.dataset.node;
        const markup = renderWorkflowGraph(state.projection ?? run?.compiled.plan ?? state.template?.plan, state.projection, selectedNodeId, collapsed);
        if (graph.innerHTML !== markup) {
            graph.innerHTML = markup;
            if (focused) {
                for (const node of Array.from(graph.querySelectorAll<HTMLButtonElement>("[data-node]")))
                    if (node.dataset.node === focused) {
                        node.focus({ preventScroll: true });
                        break;
                    }
            }
        }
        if (processOwner && processOwner !== run?.id) {
            selectedNodeId = undefined;
            selectedInstanceId = undefined;
            selectedAttemptId = undefined;
            processReader.select();
        }
        renderSidebar();
    }
    function scopeOptions(): void {
        const run=controller.state.run,select=element<HTMLSelectElement>("#wf-scope-select");
        const options=renderScopeOptions(run?.instances??[],scopeInstanceId);
        if(select.innerHTML!==options)select.innerHTML=options; select.value=scopeInstanceId??"";
    }
    root.addEventListener("click", event => {
        const button = (event.target as Element).closest<HTMLElement>("button");
        if (!button || button instanceof HTMLButtonElement && button.disabled)
            return;
        const action = button.dataset.action;
        if (action) {
            if (action === "resume")
                void recoveryPreview();
            else
                void perform(() => controller.perform(action as "start" | "pause" | "stop"));
            return;
        }
        if (button.dataset.closeDialog !== undefined) {
            const dialog = button.closest<HTMLDialogElement>("dialog");
            if (dialog)
                close(dialog);
            return;
        }
        if (button.dataset.collapse) {
            const id = button.dataset.collapse;
            if (collapsed.has(id))
                collapsed.delete(id);
            else
                collapsed.add(id);
            render();
            return;
        }
        if (button.dataset.node) {
            selectedNodeId = button.dataset.node;instanceLimit=50;
            const projected = controller.state.projection?.nodes.find(node => node.id === selectedNodeId);
            const instances = controller.state.run?.instances.filter(instance => projected ? [...projected.instanceIds, ...projected.scopeInstanceIds ?? [], ...projected.availableScopeInstanceIds ?? []].includes(instance.id) : instance.nodeId === selectedNodeId) ?? [];
            selectProcess(projected?.currentInstanceId ?? (instances.length === 1 ? instances[0]!.id : undefined));
            render();
            return;
        }
        if (button.dataset.historyRun) {
            void perform(async () => { await controller.selectRun(button.dataset.historyRun!); close(history); });
            return;
        }
        if (button.dataset.processView) {
            processDetail = button.dataset.processView as "brief" | "developer";
            const run = controller.state.run;
            if (run && selectedInstanceId) {
                processBusy = true;
                setText("#wf-process-loading", "正在读取节点过程…");
                processReader.select({ runId: run.id, instanceId: selectedInstanceId, ...(selectedAttemptId ? { attemptId: selectedAttemptId } : {}), detail: processDetail });
            }
            renderSidebar();
            return;
        }
        const handlers: Record<string, () => void> = { "wf-refresh": () => void perform(async () => { await controller.refreshProjects(); await Promise.all([controller.refreshRuns(), controller.refreshLibrary(), controller.refresh()]); }), "wf-reconnect": () => void controller.connected(), "wf-parameters-toggle": () => openParameters(), "wf-settings-toggle": () => void openSettings(), "wf-history-toggle": () => void openHistory(),"wf-history-more":()=>void perform(async()=>{await controller.moreRuns();if(history.open)renderHistoryList();}),"wf-instances-more":()=>{instanceLimit+=50;renderSidebar();},"wf-attempts-more":()=>{const run=controller.state.run;if(run&&selectedInstanceId&&attemptNextOffset!==undefined)processReader.select({runId:run.id,instanceId:selectedInstanceId,...(selectedAttemptId?{attemptId:selectedAttemptId}:{}),detail:processDetail,attemptOffset:attemptNextOffset});}, "wf-more-toggle": () => { const menu = element("#wf-more-menu"); menu.hidden = !menu.hidden; button.setAttribute("aria-expanded", String(!menu.hidden)); }, "wf-save-definition": () => void saveDefinition(), "wf-delete-toggle": () => void openDeletion(), "wf-delete-confirm": () => void confirmDeletion(), "wf-recovery-confirm": () => void confirmRecovery(), "wf-retry-node": () => void recoveryPreview(selectedInstanceId), "wf-process-close": () => { selectedNodeId = undefined; processReader.select(); render(); }, "wf-process-refresh": () => void processReader.refresh(), "wf-wait-toggle": () => openWait(), "wf-apply-toggle": () => void applyChanges(), "wf-apply-confirm": () => void confirmApply(), "wf-zoom-in": () => setZoom(zoom + .1), "wf-zoom-out": () => setZoom(zoom - .1), "wf-zoom-reset": () => setZoom(1), "wf-zoom-fit": () => { const plane = root.querySelector<HTMLElement>(".wf-graph-plane"), viewport = element("#wf-graph-scroll"); if (plane)
                setZoom(Math.min(1, (viewport.clientWidth - 40) / plane.offsetWidth)); }, "wf-scope-refresh": () => scopeOptions() };
        handlers[button.id]?.();
        if (button.id !== "wf-more-toggle")
            show("#wf-more-menu", false);
    });
    element<HTMLSelectElement>("#wf-template-select").addEventListener("change", event => { const value = (event.target as HTMLSelectElement).value; if (value.startsWith("run:"))
        void controller.selectRun(value.slice(4));
    else if (value.startsWith("definition:"))
        void controller.selectTemplate(value.slice(11)); });
    element<HTMLSelectElement>("#wf-instance-select").addEventListener("change", event => {
        const id = (event.target as HTMLSelectElement).value || undefined;
        const instance = controller.state.run?.instances.find(instance => instance.id === id);
        selectProcess(id);
        if (instance && ["scope", "repeat", "map"].includes(instance.type)) { scopeInstanceId = id; void controller.selectScope(id); }
    });
    element<HTMLSelectElement>("#wf-attempt-select").addEventListener("change", event => { selectedAttemptId = (event.target as HTMLSelectElement).value || undefined; const run = controller.state.run; if (run && selectedInstanceId) {
        setText("#wf-process-loading", "正在读取执行尝试…");
        processReader.select({ runId: run.id, instanceId: selectedInstanceId, ...(selectedAttemptId ? { attemptId: selectedAttemptId } : {}), detail: processDetail });
    } });
    element<HTMLSelectElement>("#wf-scope-select").addEventListener("focus", scopeOptions);
    element<HTMLSelectElement>("#wf-scope-select").addEventListener("change", event => { scopeInstanceId = (event.target as HTMLSelectElement).value || undefined; void controller.selectScope(scopeInstanceId); });
    function setZoom(value: number): void { zoom = Math.min(1.8, Math.max(.3, value)); element("#wf-panel-overview").style.setProperty("zoom", String(zoom)); setText("#wf-zoom-value", `${Math.round(zoom * 100)}%`); }
    function openParameters(): void { const input = controller.input; if (!input)
        return; parameterOwner = owner(); parameterSignature = panelInputSignature(input); parameterStale = false; setHtml("#wf-parameter-fields", renderParameterFields(input.definition.parameters ?? [], input.args)); show("#wf-parameter-error", false); setText("#wf-parameter-status", controller.state.run ? "修改参数会创建独立新运行；当前运行保持原参数。" : "保存参数会创建当前项目的运行预览，点击启动后执行。"); open(parameters); render(); }
    element<HTMLFormElement>("#wf-parameters-form").addEventListener("submit", event => { event.preventDefault(); if (parameterStale)
        return; const current = lifecycle.get(parameters)!.current(), input = controller.input; if (!input)
        return; const values = new Map<string, unknown>(); for (const control of Array.from(parameters.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-parameter]")))
        values.set(control.dataset.parameter!, control.value); void perform(async () => { try {
        const args = readParameters(input.definition.parameters ?? [], values, input.args);
        await controller.createPreview(args);
        if (current())
            close(parameters);
    }
    catch (error) {
        setText("#wf-parameter-error", message(error));
        show("#wf-parameter-error", true);
    } }); });
    function modelOptions(response: ExecutionSettingsResponse, selected?: string): string { return `<option value="">继承 Codex 配置${response.effectiveDefaults?.model ? `（${escapeHtml(response.effectiveDefaults.model)}）` : ""}</option>${response.models.map(model => `<option value="${escapeHtml(model.id)}"${model.id === selected ? " selected" : ""}>${escapeHtml(model.displayName)}</option>`).join("")}`; }
    function effortOptions(response: ExecutionSettingsResponse, model: string, selected?: string): string { const efforts = response.models.find(item => item.id === model)?.supportedReasoningEfforts ?? response.models.find(item => item.id === response.effectiveDefaults?.model)?.supportedReasoningEfforts ?? []; return `<option value="">继承默认配置</option>${efforts.map(effort => `<option value="${escapeHtml(effort)}"${effort === selected ? " selected" : ""}>${escapeHtml(effort)}</option>`).join("")}`; }
    async function openSettings(): Promise<void> { open(settings); setText("#wf-settings-error", ""); show("#wf-settings-error", false); element<HTMLButtonElement>("#wf-save-settings").disabled = true; const current = lifecycle.get(settings)!.current(); try {
        const response = await controller.executionSettings();
        if (!current())
            return;
        settingsRevision = response.settings.revision;
        settingsStale = false;
        setHtml("#wf-default-model", modelOptions(response, response.settings.model));
        setHtml("#wf-default-effort", effortOptions(response, response.settings.model ?? "", response.settings.reasoningEffort));
        element<HTMLButtonElement>("#wf-save-settings").disabled = false;
    }
    catch (error) {
        if (current()) {
            setText("#wf-settings-error", message(error));
            show("#wf-settings-error", true);
        }
    } }
    element<HTMLSelectElement>("#wf-default-model").addEventListener("change", () => { const response = controller.state.settings; if (response)
        setHtml("#wf-default-effort", effortOptions(response, element<HTMLSelectElement>("#wf-default-model").value)); });
    element<HTMLFormElement>("#wf-settings-form").addEventListener("submit", event => { event.preventDefault(); if (settingsStale)
        return; const current = lifecycle.get(settings)!.current(), model = element<HTMLSelectElement>("#wf-default-model").value, effort = element<HTMLSelectElement>("#wf-default-effort").value; void perform(async () => { try {
        await controller.mutate("workflow_update_execution_settings", { revision: settingsRevision, projectPath: controller.state.project?.path, model: model || null, reasoningEffort: effort || null });
        if (current())
            close(settings);
    }
    catch (error) {
        if (current()) {
            setText("#wf-settings-error", message(error));
            show("#wf-settings-error", true);
        }
    } }); });
    function renderHistoryList():void{setHtml("#wf-history-list",controller.state.runs.map(run=>`<button type="button" class="wf-history-row" data-history-run="${escapeHtml(run.id)}"><strong>${escapeHtml(run.name??run.definition?.name??run.id)}</strong><small>${escapeHtml(statusLabels[run.status]??run.status)} · ${escapeHtml(run.createdAt)}</small></button>`).join("")||'<p class="wf-muted">当前项目暂无运行</p>');show("#wf-history-more",controller.state.runNextOffset!==undefined);}
    async function openHistory():Promise<void>{open(history);const current=lifecycle.get(history)!.current();setHtml("#wf-history-list",'<p class="wf-muted">正在读取…</p>');await perform(async()=>{await controller.refreshRuns();if(current())renderHistoryList();});}
    async function saveDefinition(): Promise<void> { const input = controller.input; if (!input)
        return; await perform(async () => { const source = controller.state.template ?? controller.state.run?.sourceDefinition; let revision = source?.revision; if (source && controller.state.run) {
        const data = await controller.request("workflow_get_template", { id: source.id });
        const latest = data.template as TemplateDefinition;
        if (latest.revision !== source.revision)
            throw new Error("库中定义已有新版，请先核对；当前运行保存的是旧定义快照。");
        revision = latest.revision;
    } await controller.mutate("workflow_save_template", { definition: input.definition, args: input.args, grants: input.grants, limits: input.limits, ...(source ? { id: source.id } : {}), ...(revision !== undefined ? { revision } : {}) }); await controller.refreshLibrary(); }); }
    async function recoveryPreview(instanceId?: string): Promise<void> { const run = controller.state.run; if (!run)
        return; recoveryTarget = instanceId; recoveryValue = undefined; open(recovery); const current = lifecycle.get(recovery)!.current(); setHtml("#wf-recovery-body", '<p class="wf-muted">正在核对持久检查点与当前文件…</p>'); element<HTMLButtonElement>("#wf-recovery-confirm").disabled = true; try {
        const data = await controller.request("workflow_preview_recovery", { id: run.id, revision: run.revision, ...(instanceId ? { instanceId } : {}) });
        if (!current() || controller.state.run?.id !== run.id)
            return;
        recoveryValue = (data.preview ?? data) as RecoveryPreview;
        setHtml("#wf-recovery-body", renderRecoveryPreview(recoveryValue));
        element<HTMLButtonElement>("#wf-recovery-confirm").disabled = !recoveryValue.canResume;
    }
    catch (error) {
        if (current())
            setHtml("#wf-recovery-body", `<div class="wf-alert">${escapeHtml(message(error))}</div>`);
    } }
    async function confirmRecovery(): Promise<void> { const run = controller.state.run, preview = recoveryValue; if (!run || !preview?.canResume)
        return; const current = lifecycle.get(recovery)!.current(); element<HTMLButtonElement>("#wf-recovery-confirm").disabled = true; await perform(async () => { await controller.mutate(recoveryTarget ? "workflow_retry_node" : "workflow_resume", { id: run.id, revision: run.revision, recoveryFingerprint: preview.fingerprint, ...(recoveryTarget ? { instanceId: recoveryTarget } : {}) }); if (current())
        close(recovery); }); }
    async function openDeletion(): Promise<void> { const input = controller.input; if (!input)
        return; deleteTarget = controller.state.run ? { kind: "run", id: controller.state.run.id, revision: controller.state.run.revision } : controller.state.template ? { kind: "definition", id: controller.state.template.id, revision: controller.state.template.revision } : undefined; if (!deleteTarget)
        return; deleteValue = undefined; open(deletion); const current = lifecycle.get(deletion)!.current(); setText("#wf-delete-preview", "正在核对删除范围…"); element<HTMLButtonElement>("#wf-delete-confirm").disabled = true; try {
        const data = await controller.request("workflow_preview_deletion", deleteTarget);
        if (!current())
            return;
        deleteValue = (data.preview ?? data) as DeletionPreview;
        setText("#wf-delete-preview", JSON.stringify(deleteValue, null, 2));
        element<HTMLButtonElement>("#wf-delete-confirm").disabled = deleteValue.canDelete === false || !!deleteValue.blockers?.length;
    }
    catch (error) {
        if (current())
            setText("#wf-delete-preview", message(error));
    } }
    async function confirmDeletion(): Promise<void> { if (!deleteTarget || !deleteValue)
        return; const current = lifecycle.get(deletion)!.current(); element<HTMLButtonElement>("#wf-delete-confirm").disabled = true; await perform(async () => { const target = deleteTarget!; await controller.mutate("workflow_delete", { ...target, fingerprint: deleteValue!.fingerprint }); if (controller.state.selectedRun === target.id || controller.state.selectedTemplate === target.id) {
        delete controller.state.run;
        delete controller.state.template;
        delete controller.state.selectedRun;
        delete controller.state.selectedTemplate;
        delete controller.state.projection;
    } await Promise.all([controller.refreshRuns(), controller.refreshLibrary()]); if (current())
        close(deletion); render(); }); }
    function openWait(): void {
        const instance = activeInstance(); if (!instance) return;
        setText("#wf-wait-prompt", instance.cursor?.message ?? instance.label);
        show("#wf-wait-error", false);
        const schema = instance.cursor?.schema as { type?: string; enum?: unknown[] } | undefined;
        let control: string;
        if (schema?.enum) control = `<select id="wf-wait-value" data-format="json" required><option value="">请选择</option>${schema.enum.map(value => `<option value="${escapeHtml(JSON.stringify(value))}">${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</option>`).join("")}</select>`;
        else if (schema?.type === "boolean") control = '<select id="wf-wait-value" data-format="json" required><option value="">请选择</option><option value="true">是 / 确认</option><option value="false">否 / 拒绝</option></select>';
        else if (schema?.type === "number" || schema?.type === "integer") control = `<input id="wf-wait-value" type="number" data-format="number"${schema.type === "number" ? ' step="any"' : ''} required>`;
        else if (schema?.type === "array" || schema?.type === "object") control = '<p class="wf-muted">此节点需要结构化结果。请在对话中提供内容，由 AI 通过工具提交。</p>';
        else control = '<textarea id="wf-wait-value" data-format="string" rows="5" required></textarea>';
        setHtml("#wf-wait-control", control); element<HTMLButtonElement>("#wf-wait-submit").disabled = schema?.type === "array" || schema?.type === "object";
        open(waitDialog);
    }
    element<HTMLFormElement>("#wf-wait-form").addEventListener("submit", event => {
        event.preventDefault(); const run = controller.state.run, instance = activeInstance(); if (!run || !instance) return;
        const current = lifecycle.get(waitDialog)!.current(), control = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#wf-wait-value"); if (!control) return;
        let value: unknown = control.value;
        try { if (control.dataset.format === "json") value = JSON.parse(control.value); else if (control.dataset.format === "number") value = Number(control.value); } catch { setText("#wf-wait-error", "请选择有效结果"); show("#wf-wait-error", true); return; }
        void perform(async () => { try { await controller.mutate("workflow_resolve_wait", { id: run.id, revision: run.revision, instanceId: instance.id, value }); if (current()) close(waitDialog); } catch (error) { if (current()) { setText("#wf-wait-error", message(error)); show("#wf-wait-error", true); } } });
    });
    async function applyChanges(): Promise<void> {
        const run = controller.state.run; if (!run) return;
        applyTarget = undefined; setText("#wf-apply-diff", "正在核对当前文件与改动…"); setText("#wf-apply-context", "");
        element<HTMLButtonElement>("#wf-apply-confirm").disabled = true; open(applyDialog);
        const current = lifecycle.get(applyDialog)!.current();
        try {
            const data = await controller.mutate("workflow_review", { id: run.id, revision: run.revision });
            if (!current()) return;
            const reviewed = parseRun(data.run);
            setText("#wf-apply-diff", reviewed.diff?.text ?? "暂无文件差异");
            const local = reviewed.grants.workspaceMode === "local";
            setText("#wf-apply-context", local ? "本地改动已立即生效，无需应用。" : "核对以下差异后，可应用到当前项目。");
            show("#wf-apply-confirm", !local);
            if (!local && reviewed.diff) { applyTarget = { id: reviewed.id, revision: reviewed.revision, fingerprint: reviewed.diff.fingerprint }; element<HTMLButtonElement>("#wf-apply-confirm").disabled = reviewed.application === "applied"; }
        } catch (error) { if (current()) setText("#wf-apply-diff", message(error)); }
    }
    async function confirmApply(): Promise<void> { if (!applyTarget)
        return; const current = lifecycle.get(applyDialog)!.current(); element<HTMLButtonElement>("#wf-apply-confirm").disabled = true; await perform(async () => { try {
        await controller.mutate("workflow_apply", { ...applyTarget! });
        if (current())
            close(applyDialog);
    }
    finally {
        element<HTMLButtonElement>("#wf-apply-confirm").disabled = false;
    } }); }
    const processTimer = setInterval(() => { if (selectedInstanceId && controller.state.connection === "connected" && !processBusy)
        void processReader.refresh(); }, 2500);
    const originalTeardown = controller.teardown.bind(controller);
    controller.teardown = async () => { clearInterval(processTimer); processReader.select(); await originalTeardown(); };
    render();
    return controller;
}
