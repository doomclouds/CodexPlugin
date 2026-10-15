import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mountPanel, PanelDialogLifecycle, panelInputSignature, panelSelectionOwner } from "../prototypes/panel.ts";
import type { ToolCaller, WorkflowRun } from "../prototypes/panel.ts";
import { projectFixtureResponse } from "./panel-project-fixture.ts";

class Surface extends EventTarget {
  open = false;
  closed = 0;
  show(): void { this.open = true; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.closed++; queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  getBoundingClientRect() { return { left: 100, right: 300, top: 100, bottom: 300 }; }
}
function point(surface: EventTarget, name: string, x: number, y: number): void {
  surface.dispatchEvent(Object.assign(new Event(name), { clientX: x, clientY: y }));
}

test("native select and keyboard clicks cannot dismiss a dialog without a matching backdrop press", () => {
  const dialog = new Surface(), lifecycle = new PanelDialogLifecycle(dialog);
  dialog.showModal(); lifecycle.opened();
  point(dialog, "pointerdown", 150, 150);
  point(dialog, "click", 350, 350);
  point(dialog, "click", 0, 0);
  assert.equal(dialog.open, true);
  assert.equal(dialog.closed, 0);
  point(dialog, "pointerdown", 350, 350);
  dialog.dispatchEvent(new Event("pointercancel"));
  point(dialog, "click", 350, 350);
  assert.equal(dialog.open, true);
  point(dialog, "pointerdown", 350, 350);
  point(dialog, "click", 350, 350);
  assert.equal(dialog.open, false, "An actual backdrop click must still close the dialog.");
});

test("a delayed save belongs to its original dialog opening", async () => {
  const dialog = new Surface(), lifecycle = new PanelDialogLifecycle(dialog);
  dialog.showModal(); lifecycle.opened();
  const original = lifecycle.current();
  assert.equal(original(), true);
  dialog.close();
  dialog.showModal(); lifecycle.opened();
  const reopened = lifecycle.current();
  await Promise.resolve();
  assert.equal(original(), false);
  assert.equal(reopened(), true, "A queued close event from the prior opening cannot invalidate the new one.");
  dialog.close(); await Promise.resolve();
  assert.equal(reopened(), false);
});

function run(id = "demo"): WorkflowRun {
  return { id, revision: 1, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z", meta: { name: "demo", description: "Read-only fixture", parameters: [{ name: "message", label: "Message", type: "string" }] }, script: "return args;", args: { message: "initial" }, projectPath: "/project", allowWrite: false, execution: "draft", application: "none", review: "unavailable", tasks: [], logs: [], limits: { maxReadWorkers: 1, maxCalls: 2, timeoutMs: 30000, maxTokens: 0 } };
}

test("selection identity stays stable across projections while input identity excludes run progress", () => {
  const current = run();
  assert.equal(panelSelectionOwner({ selectedRun: current.id, selectedTemplate: undefined }), "run:demo");
  assert.equal(panelSelectionOwner({ selectedRun: undefined, selectedTemplate: "saved:demo" }), "definition:saved:demo");
  assert.equal(panelInputSignature(current), panelInputSignature({ ...current, revision: 9, progressSequence: 100, execution: "running" }));
  assert.notEqual(panelInputSignature(current), panelInputSignature({ ...current, args: { message: "updated" } }));
});

// This fixture exercises the actual mount/render handlers. It only supplies the
// DOM surfaces they mutate; browser focus, native menus and layout have separate
// browser coverage rather than being reimplemented here.
class ElementSurface extends Surface {
  id: string;
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  hidden = false;
  disabled = false;
  checked = false;
  textContent = "";
  value = "";
  options: ElementSurface[] = [];
  scrollTop = 0;
  private markup = "";
  fields: ElementSurface[] = [];
  constructor(id: string) { super(); this.id = id; }
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    if (this.id === "wf-parameter-fields") this.fields = [...value.matchAll(/data-parameter="([^"]+)"[^>]*value="([^"]*)"/g)].map(match => { const field = new ElementSurface(match[1]!); field.dataset.parameter = match[1]!; field.dataset.parameterType = "string"; field.value = match[2]!; return field; });
    if (this.id.includes("model") || this.id.includes("effort")) this.value = [...value.matchAll(/<option value="([^"]*)"([^>]*)>/g)].find(match => match[2]!.includes("selected"))?.[1] ?? "";
  }
  setAttribute() {}
  focus() {}
  contains(value: unknown): boolean { return value === this; }
  querySelector(): undefined { return undefined; }
  querySelectorAll(selector: string): ElementSurface[] { return selector === "[data-parameter]" ? this.fields : []; }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function mounted(t: test.TestContext) {
  const ids = [...(await readFile(new URL("../prototypes/workflow-panel.html", import.meta.url), "utf8")).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
  const elements = new Map(ids.map(id => [id, new ElementSurface(id)]));
  const root = elements.get("workflow-panel-prototype")!;
  const dialogs = [...elements.values()].filter(element => element.id.endsWith("-dialog"));
  root.querySelector = ((selector: string) => selector.startsWith("#") ? elements.get(selector.slice(1)) : undefined) as typeof root.querySelector;
  root.querySelectorAll = (selector: string) => selector === "dialog" ? dialogs : selector === "dialog[open]" ? dialogs.filter(dialog => dialog.open) : [];
  const document = new EventTarget();
  Object.assign(document, { activeElement: null, visibilityState: "visible" });
  const originals = new Map(["document", "HTMLElement", "Element", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ document, HTMLElement: ElementSurface, Element: ElementSurface, Node: ElementSurface })) Object.defineProperty(globalThis, key, { value, configurable: true });
  let current = run(), settingsRevision = 1;
  const models = ["model-a", "model-b"].map(id => ({ id, displayName: id, supportedReasoningEfforts: ["max", "high"], defaultReasoningEffort: "max" }));
  const settings = () => ({ settings: { revision: settingsRevision, model: "model-a", reasoningEffort: "max" }, models, source: "codex-config", mainAgentContextAvailable: false, codexDefaults: { model: "model-a", reasoningEffort: "max" }, defaultsStatus: { available: true }, effectiveDefaults: { model: "model-a", reasoningEffort: "max" } });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const replies = new Map<string, (args: Record<string, unknown>) => ReturnType<ToolCaller>>();
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args });
    const reply = replies.get(name);
    if (reply) return reply(args);
    if (name === "workflow_panel_lease") return { structuredContent: { leaseId: "lease" } };
    if (name === "workflow_get_projects") return projectFixtureResponse();
    if (name === "workflow_list_runs") return { structuredContent: { runs: [current] } };
    if (name === "workflow_list_templates") return { structuredContent: { templates: [] } };
    if (name === "workflow_get_execution_settings") return { structuredContent: settings() };
    if (name === "workflow_get_run") return { structuredContent: { run: current } };
    throw new Error(`Unexpected mutation: ${name}`);
  };
  let panel: ReturnType<typeof mountPanel> | undefined;
  t.after(async () => { await panel?.teardown(); await settle(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  panel = mountPanel(root as unknown as HTMLElement, caller);
  await panel.connected();
  return { panel, calls, replies, element: (id: string) => elements.get(id)!, update: (value: Partial<WorkflowRun>) => { current = { ...current, ...value }; }, settingsRevision: () => { settingsRevision++; }, settings };
}

test("poll progress preserves an open parameter draft; real input changes are fenced until reopened", async t => {
  const f = await mounted(t);
  const parameters = f.element("wf-parameters-dialog"), fields = f.element("wf-parameter-fields");
  f.element("wf-parameters-toggle").dispatchEvent(new Event("click"));
  assert.equal(parameters.open, true);
  const field = fields.fields[0]!;
  assert.ok(field, "The rendered parameter should be editable.");
  field.value = "user draft";
  f.update({ revision: 2, progressSequence: 50 });
  await f.panel.refresh();
  assert.equal(parameters.open, true);
  assert.equal(fields.fields[0], field);
  assert.equal(field.value, "user draft");
  assert.equal(f.element("wf-save-parameters").disabled, false);
  f.update({ revision: 3, args: { message: "external update" } });
  await f.panel.refresh();
  assert.equal(parameters.open, true);
  assert.equal(field.value, "user draft");
  assert.equal(f.element("wf-save-parameters").disabled, true);
  assert.match(f.element("wf-parameter-status").textContent, /后台更新/);
  f.element("wf-parameters-form").dispatchEvent(new Event("submit", { cancelable: true }));
  assert.equal(parameters.open, true);
  parameters.close(); await settle();
  f.element("wf-parameters-toggle").dispatchEvent(new Event("click"));
  assert.equal(fields.fields[0]!.value, "external update");
});

test("polling a newer default settings revision preserves an open model choice and fences stale save", async t => {
  const f = await mounted(t);
  const dialog = f.element("wf-settings-dialog"), model = f.element("wf-default-model");
  f.element("wf-settings-toggle").dispatchEvent(new Event("click"));
  model.value = "model-b"; model.dispatchEvent(new Event("change"));
  f.settingsRevision(); await f.panel.refreshExecutionSettings();
  assert.equal(dialog.open, true);
  assert.equal(model.value, "model-b");
  assert.equal(f.element("wf-save-settings").disabled, true);
  assert.match(f.element("wf-settings-status").textContent, /后台更新/);
  f.element("wf-settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  assert.equal(dialog.open, true);
  assert.equal(f.calls.some(call => call.name === "workflow_update_execution_settings"), false);
  f.element("wf-refresh-settings").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(model.value, "model-a");
  assert.equal(f.element("wf-save-settings").disabled, false);
});

test("an accepted summary projection keeps an editor open while full details are temporarily missing", async t => {
  const f = await mounted(t);
  const parameters = f.element("wf-parameters-dialog"), fields = f.element("wf-parameter-fields");
  f.element("wf-parameters-toggle").dispatchEvent(new Event("click"));
  const field = fields.fields[0]!; field.value = "kept across projection";
  let reply!: (value: Awaited<ReturnType<ToolCaller>>) => void;
  f.replies.set("workflow_start", async () => ({ structuredContent: { operationAccepted: true, listSummary: true, run: { ...run(), revision: 2 } } }));
  f.replies.set("workflow_get_run", () => new Promise(resolve => { reply = resolve; }));
  const saving = f.panel.perform("start", true);
  await settle();
  assert.equal(f.panel.selected, undefined);
  assert.equal(f.panel.selectedSummary?.id, "demo");
  assert.equal(parameters.open, true);
  assert.equal(fields.fields[0], field);
  assert.equal(field.value, "kept across projection");
  assert.equal(f.element("wf-save-parameters").disabled, true);
  reply({ structuredContent: { run: { ...run(), revision: 2 } } });
  await saving;
  assert.equal(parameters.open, true);
  assert.equal(field.value, "kept across projection");
  assert.equal(f.element("wf-save-parameters").disabled, false);
});

test("switching to another run still closes its editor and loads the new default inputs", async t => {
  const f = await mounted(t);
  f.element("wf-parameters-toggle").dispatchEvent(new Event("click"));
  f.element("wf-parameter-fields").fields[0]!.value = "old draft";
  f.panel.receive({ structuredContent: { run: { ...run("other"), args: { message: "other default" } } } });
  await settle();
  assert.equal(f.element("wf-parameters-dialog").open, false);
  assert.equal(f.element("wf-parameter-fields").fields[0]!.value, "other default");
});

test("without an open or staged editor a new input version loads its current defaults", async t => {
  const f = await mounted(t);
  f.update({ revision: 2, args: { message: "new default" } });
  await f.panel.refresh();
  f.element("wf-parameters-toggle").dispatchEvent(new Event("click"));
  assert.equal(f.element("wf-parameter-fields").fields[0]!.value, "new default");
  assert.equal(f.element("wf-save-parameters").disabled, false);
});

test("a settings save completing after cancel and reopen cannot close the new dialog", async t => {
  const f = await mounted(t);
  const dialog = f.element("wf-settings-dialog");
  let reply!: (value: Awaited<ReturnType<ToolCaller>>) => void;
  f.replies.set("workflow_update_execution_settings", () => new Promise(resolve => { reply = resolve; }));
  f.element("wf-settings-toggle").dispatchEvent(new Event("click"));
  f.element("wf-default-effort").value = "high";
  f.element("wf-default-effort").dispatchEvent(new Event("change"));
  f.element("wf-settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  assert.equal(f.panel.state.settingsBusy, true);
  dialog.close(); await settle();
  f.element("wf-settings-toggle").dispatchEvent(new Event("click"));
  reply({ structuredContent: f.settings() });
  await settle();
  assert.equal(dialog.open, true);
  assert.equal(f.panel.state.settingsBusy, false);
});

test("updating a run's saved definition uses its recorded origin revision rather than overwriting a newer library version", async t => {
  const f = await mounted(t);
  f.panel.receive({ structuredContent: { run: { ...run(), sourceDefinition: { id: "saved:demo", revision: 1 } } } });
  f.replies.set("workflow_list_templates", async () => ({ structuredContent: { templates: [{ id: "saved:demo", source: "saved", revision: 3, name: "demo", description: "Newer library definition" }] } }));
  f.replies.set("workflow_save_template", async () => ({ isError: true, content: [{ type: "text", text: "Workflow definition changed. Load it before saving." }] }));
  await f.panel.refreshTemplates();
  assert.match(f.element("wf-save-definition").innerHTML, /更新库中工作流/);
  f.element("wf-save-definition").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(f.calls.find(call => call.name === "workflow_save_template")?.args.revision, 1);
  assert.match(f.panel.state.error, /载入当前定义/);
  f.panel.receive({ structuredContent: { run: run("unrelated") } });
  assert.match(f.element("wf-save-definition").innerHTML, /保存到工作流库/);
});
