export interface WorkflowParameter {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
  description?: string;
  placeholder?: string;
  multiline?: boolean;
}
export type ParameterValues = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const parameterTypes = new Set<string>(["string", "number", "boolean", "string[]"]);

function validateType(parameter: WorkflowParameter): void {
  if (!parameterTypes.has(parameter.type)) throw new Error(`参数“${parameter.label}”使用了不支持的字段类型`);
}

function argumentObject(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("声明输入字段的工作流需要对象形式的参数");
  return args as Record<string, unknown>;
}

function valueFor(values: ParameterValues, name: string): { present: boolean; value: unknown } {
  if (values instanceof Map) return { present: values.has(name), value: values.get(name) };
  const record = values as Readonly<Record<string, unknown>>;
  return { present: Object.hasOwn(record, name), value: record[name] };
}

function parameterValue(parameter: WorkflowParameter, value: unknown): unknown {
  validateType(parameter);
  const invalid = (type: string): never => { throw new Error(`参数“${parameter.label}”必须是${type}`); };
  let parsed: unknown;
  switch (parameter.type) {
    case "string":
      if (value === undefined) parsed = undefined;
      else parsed = typeof value === "string" ? value : invalid("文本");
      break;
    case "number":
      if (value === undefined || typeof value === "string" && !value.trim()) parsed = undefined;
      else if (typeof value === "number" && Number.isFinite(value)) parsed = value;
      else if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) && Number.isFinite(Number(value))) parsed = Number(value);
      else invalid("有限数字");
      break;
    case "boolean":
      if (value === undefined) parsed = undefined;
      else if (typeof value === "boolean") parsed = value;
      else if (value === "true" || value === "false") parsed = value === "true";
      else invalid("布尔值");
      break;
    case "string[]":
      if (value === undefined) parsed = undefined;
      else if (typeof value === "string") parsed = value.replace(/\r\n?/g, "\n").split("\n").filter(line => line.length > 0);
      else if (Array.isArray(value) && value.every(item => typeof item === "string")) parsed = [...value];
      else invalid("文本列表");
      break;
  }
  if (parameter.required && (parsed === undefined || typeof parsed === "string" && !parsed.trim() || Array.isArray(parsed) && parsed.length === 0)) throw new Error(`请填写“${parameter.label}”`);
  return parsed;
}

/** Read only declared fields; preserve existing keys so switching away from JSON loses no caller input. */
export function readParameters(parameters: readonly WorkflowParameter[], values: ParameterValues, initialArgs?: unknown): Record<string, unknown> {
  const initial = argumentObject(initialArgs);
  const args = { ...initial };
  for (const parameter of parameters) {
    const supplied = valueFor(values, parameter.name);
    const raw = supplied.present ? supplied.value : Object.hasOwn(initial, parameter.name) ? initial[parameter.name] : undefined;
    const value = parameterValue(parameter, raw);
    if (value === undefined) delete args[parameter.name];
    else Object.defineProperty(args, parameter.name, { value, writable: true, configurable: true, enumerable: true });
  }
  return args;
}

/** Controls come solely from metadata: names such as URL or Bug ID do not change the declared type. */
export function renderParameterFields(parameters: readonly WorkflowParameter[], args: unknown, disabled = false): string {
  if (!parameters.length) return "";
  const initial = argumentObject(args);
  const fields = parameters.map((parameter, index) => {
    validateType(parameter);
    const id = `wf-parameter-${index}`;
    const value = Object.hasOwn(initial, parameter.name) ? initial[parameter.name] : undefined;
    const description = [parameter.description, parameter.type === "string[]" ? "每行一项，空行不计入列表。" : undefined].filter(Boolean).join(" ");
    const attributes = `id="${id}" name="${escape(parameter.name)}" class="wf-parameter-input" data-parameter="${escape(parameter.name)}" data-parameter-type="${parameter.type}"${disabled ? " disabled" : ""}${parameter.required ? ' aria-required="true"' : ""}${parameter.required && parameter.type !== "boolean" ? " required" : ""}${description ? ` aria-describedby="${id}-description"` : ""}`;
    const placeholder = parameter.placeholder === undefined ? "" : ` placeholder="${escape(parameter.placeholder)}"`;
    const label = `<label class="wf-parameter-label" for="${id}">${escape(parameter.label)}${parameter.required ? '<span class="wf-parameter-required" aria-hidden="true"> *</span>' : ""}</label>`;
    let control: string;
    if (parameter.type === "boolean") control = `<input type="checkbox" ${attributes}${value === true ? " checked" : ""}>`;
    else if (parameter.type === "string[]") control = `<textarea ${attributes}${placeholder} rows="4">${escape(Array.isArray(value) ? value.join("\n") : value ?? "")}</textarea>`;
    else if (parameter.type === "string" && parameter.multiline) control = `<textarea ${attributes}${placeholder} rows="4">${escape(value ?? "")}</textarea>`;
    else control = `<input type="${parameter.type === "number" ? "number" : "text"}" ${attributes}${placeholder}${parameter.type === "number" ? ' step="any"' : ""} value="${escape(value ?? "")}">`;
    return `<div class="wf-parameter-field" data-type="${parameter.type}">${parameter.type === "boolean" ? `<div class="wf-parameter-checkbox">${control}${label}</div>` : label + control}${description ? `<p class="wf-parameter-description" id="${id}-description">${escape(description)}</p>` : ""}</div>`;
  });
  return `<div class="wf-parameter-fields">${fields.join("")}</div>`;
}
