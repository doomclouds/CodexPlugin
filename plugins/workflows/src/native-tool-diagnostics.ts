import { boundedDiagnosticText, failureDiagnosticText, safeDiagnosticName } from "./mcp-diagnostics.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const maximumCallBytes = 8192;
const maximumTotalBytes = 65_536;
const maximumCalls = 100;
const bound = (value: string) => boundedDiagnosticText(value, maximumCallBytes, "Native");

function parsedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return object(value);
  if (value.length > maximumCallBytes || !value.trimStart().startsWith("{") || Buffer.byteLength(value) > maximumCallBytes) return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function explicitFailure(value: Record<string, unknown>): boolean {
  return value.isError === true || typeof value.error === "string" && value.error.trim().length > 0 || Object.keys(object(value.error)).length > 0;
}

function functionFailure(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (explicitFailure(item)) return item;
  const output = parsedObject(item.output);
  if (explicitFailure(output)) return output;
  if (Array.isArray(item.output)) for (const value of item.output.slice(0, 8)) {
    const content = object(value);
    if (!["input_text", "inputText", "text"].includes(String(content.type))) continue;
    const envelope = parsedObject(content.text);
    if (explicitFailure(envelope)) return envelope;
  }
}

export function nativeToolItemFailed(value: unknown): boolean {
  const item = object(value);
  if (item.type === "dynamicToolCall") return item.status === "failed" || item.success === false;
  return item.type === "functionCallOutput" && functionFailure(item) !== undefined;
}

function errorFields(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [bound(value)] : [];
  const record = object(value), fields: string[] = [];
  for (const name of ["code", "message", "detail", "reason"] as const) {
    const text = record[name];
    if (typeof text === "string" && text.trim()) fields.push(`${name}: ${bound(text)}`);
    else if (name === "code" && typeof text === "number" && Number.isSafeInteger(text)) fields.push(`code: ${text}`);
  }
  return fields;
}

function structuredFields(record: Record<string, unknown>): string[] {
  const error = errorFields(record.error);
  return error.length ? error : errorFields(record);
}

function textFields(value: string): string[] {
  const first = value.trimStart()[0];
  if (first === "{" || first === "[") {
    if (value.length > maximumCallBytes || Buffer.byteLength(value) > maximumCallBytes) return ["Native tool failure text exceeds the diagnostic limit."];
    try { return structuredFields(object(JSON.parse(value))); }
    catch { return ["Native tool returned an invalid structured failure payload."]; }
  }
  if (/^[A-Za-z0-9+/=\s]{256,}$/.test(value.slice(0, maximumCallBytes))) return ["Native tool returned a non-textual failure payload."];
  return value.trim() ? [bound(value)] : [];
}

function errorMessage(item: Record<string, unknown>): string {
  if (item.type === "functionCallOutput") {
    const envelope = functionFailure(item);
    if (!envelope) return "";
    const fields = structuredFields(envelope);
    if (fields.length) return fields.join("; ");
    if (envelope === item && typeof item.output === "string") return textFields(item.output).join("; ") || "The native function explicitly reported failure without a supported error message.";
    return "The native function explicitly reported failure without a supported error message.";
  }
  const parts: string[] = [];
  if (Array.isArray(item.contentItems)) for (const value of item.contentItems.slice(0, 8)) {
    const content = object(value);
    if (["inputText", "text"].includes(String(content.type)) && typeof content.text === "string") parts.push(...textFields(content.text));
    if (parts.length >= 8) break;
  }
  return parts.slice(0, 8).join("; ") || "The native tool call failed without a supported error message.";
}

export class NativeToolFailureDiagnostics {
  private readonly seen = new Set<string>();
  private readonly redact: (value: string) => string;
  private totalBytes = 0;
  private exhausted = false;

  constructor(redact: (value: string) => string) { this.redact = redact; }

  capture(value: unknown): string | undefined {
    if (!nativeToolItemFailed(value) || this.exhausted) return;
    const item = object(value);
    const id = `${item.type}:${typeof item.id === "string" ? item.id.slice(0, 160) : "missing-id"}`;
    if (this.seen.has(id)) return;
    if (this.seen.size >= maximumCalls || this.totalBytes >= maximumTotalBytes - maximumCallBytes - 128) {
      this.exhausted = true;
      return "Native error diagnostics limit reached; further failure payloads were omitted.";
    }
    this.seen.add(id);
    const namespace = safeDiagnosticName(item.namespace), name = safeDiagnosticName(item.type === "dynamicToolCall" ? item.tool : item.name);
    const identity = name ? ` (${namespace ? `${namespace}/` : ""}${name})` : "";
    const error = failureDiagnosticText(errorMessage(item), this.redact, "Native");
    const log = bound(`Native tool call failed${identity}: ${error}`);
    this.totalBytes += Buffer.byteLength(log);
    return log;
  }
}
