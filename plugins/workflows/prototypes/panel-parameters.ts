import type { DefinitionParameter } from "../src/definition.ts";
export type WorkflowParameter = DefinitionParameter;
export type ParameterValues = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
function object(value: unknown): Record<string, unknown> { if (value === undefined)
    return {}; if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("工作流参数必须是对象"); return value as Record<string, unknown>; }
function readValue(parameter: WorkflowParameter, raw: unknown): unknown {
    const fail = (): never => { throw new Error(`参数“${parameter.label ?? parameter.name}”格式不正确`); };
    if (raw === undefined || raw === "" && parameter.type !== "string") {
        if (parameter.required && parameter.default === undefined)
            throw new Error(`请填写“${parameter.label ?? parameter.name}”`);
        return parameter.default;
    }
    let value: unknown = raw;
    if (parameter.type === "number" || parameter.type === "integer") {
        value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
        if (typeof value !== "number" || !Number.isFinite(value) || parameter.type === "integer" && !Number.isSafeInteger(value))
            fail();
    }
    else if (parameter.type === "boolean") {
        if (raw === "true" || raw === "false")
            value = raw === "true";
        if (typeof value !== "boolean")
            fail();
    }
    else if (parameter.type === "array" || parameter.type === "object") {
        if (typeof raw === "string") {
            try {
                value = JSON.parse(raw);
            }
            catch {
                fail();
            }
        }
        if (parameter.type === "array" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value))
            fail();
    }
    else if (typeof value !== "string" || parameter.required && !value.trim())
        fail();
    if (parameter.enum && !parameter.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
        fail();
    return value;
}
export function readParameters(parameters: readonly WorkflowParameter[], values: ParameterValues, initialArgs?: unknown): Record<string, unknown> {
    const initial = object(initialArgs), args = { ...initial };
    for (const parameter of parameters) {
        const present = values instanceof Map ? values.has(parameter.name) : Object.hasOwn(values, parameter.name);
        const raw = present ? values instanceof Map ? values.get(parameter.name) : (values as Record<string, unknown>)[parameter.name] : initial[parameter.name];
        const value = readValue(parameter, raw);
        if (value === undefined)
            delete args[parameter.name];
        else
            Object.defineProperty(args, parameter.name, { value, writable: true, configurable: true, enumerable: true });
    }
    return args;
}
export function renderParameterFields(parameters: readonly WorkflowParameter[], args?: unknown, disabled = false): string {
    const initial = object(args);
    return parameters.map((parameter, index) => {
        const id = `wf-parameter-${index}`, value = Object.hasOwn(initial, parameter.name) ? initial[parameter.name] : parameter.default;
        const attributes = `id="${id}" data-parameter="${escape(parameter.name)}" data-parameter-type="${parameter.type}"${disabled ? " disabled" : ""}${parameter.required ? " required" : ""}`;
        let control: string;
        if (parameter.enum)
            control = `<select ${attributes}>${parameter.required ? "" : '<option value="">未设置</option>'}${parameter.enum.map(item => `<option value="${escape(typeof item === "string" ? item : JSON.stringify(item))}"${JSON.stringify(item) === JSON.stringify(value) ? " selected" : ""}>${escape(typeof item === "string" ? item : JSON.stringify(item))}</option>`).join("")}</select>`;
        else if (parameter.type === "boolean")
            control = `<select ${attributes}><option value="">未设置</option><option value="true"${value === true ? " selected" : ""}>是</option><option value="false"${value === false ? " selected" : ""}>否</option></select>`;
        else if (parameter.type === "object" || parameter.type === "array")
            control = `<div id="${id}" class="wf-structured-parameter"><small>${value === undefined ? "尚未配置。请在对话中让 AI 填写此结构化参数。" : "此结构化参数由 AI 维护，修改请在对话中说明。"}</small>${value === undefined ? "" : `<details><summary>查看当前值</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`}</div>`;
        else
            control = `<input ${attributes} type="${parameter.type === "number" || parameter.type === "integer" ? "number" : "text"}"${parameter.type === "number" ? ' step="any"' : ""} value="${escape(value ?? "")}">`;
        return `<div class="wf-field"><label for="${id}">${escape(parameter.label ?? parameter.name)}${parameter.required ? " *" : ""}</label>${control}${parameter.description ? `<small>${escape(parameter.description)}</small>` : ""}</div>`;
    }).join("");
}
