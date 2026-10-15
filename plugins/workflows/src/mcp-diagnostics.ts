// Project errors only; omit recognized credential and input details from messages.
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const maximumTextBytes = 8192;
const maximumCallBytes = 8192;
const maximumTotalBytes = 65_536;
const maximumCalls = 100;
export const safeDiagnosticName = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && !/(?:token|secret|password|sk-|gh[pousr]_)/i.test(value) ? value : undefined;
const safeName = safeDiagnosticName;
const sensitiveAssignment = /(?:\\*["'])?\b(?:api[-_ ]?key|(?:aws[-_ ]?)?(?:access|refresh|session|id)[-_ ]?token|session[-_ ]?(?:id|key)|token|password|passwd|secret|client[-_ ]?secret|private[-_ ]?key|(?:aws[-_ ]?)?(?:secret[-_ ]?)?access[-_ ]?key(?:[-_ ]?id)?|credentials?|authorization|authentication|auth|(?:set[-_ ]?|session[-_ ]?)?cookies?)\b(?:\\*["'])?\s*[:=]/i;
const inputAssignment = /(?:\\*["'])?\b(?:arguments|args|prompt|input|payload|params)\b(?:\\*["'])?\s*[:=]/i;

export function boundedDiagnosticText(value: string, bytes: number, source: "MCP" | "Native" = "MCP"): string {
  const truncated = ` [${source} error diagnostics truncated.]`;
  const clipped = value.length > bytes;
  const sample = clipped ? value.slice(0, bytes) : value;
  const buffer = Buffer.from(sample);
  if (!clipped && buffer.length <= bytes) return sample;
  let end = Math.max(0, bytes - Buffer.byteLength(truncated));
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + truncated;
}
const bounded = (value: string, bytes: number) => boundedDiagnosticText(value, bytes);

export function failureDiagnosticText(value: string, redact: (value: string) => string, source: "MCP" | "Native" = "MCP"): string {
  // Bound before redaction, and bound again in case redaction expands a match.
  let error = boundedDiagnosticText(value, maximumCallBytes, source).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const sensitiveDetails = error.search(sensitiveAssignment), inputDetails = error.search(inputAssignment);
  // Omit the remainder of echoed assignments rather than guessing value ends.
  if (sensitiveDetails >= 0 && (inputDetails < 0 || sensitiveDetails <= inputDetails)) error = error.slice(0, sensitiveDetails) + `[${source} sensitive details omitted.]`;
  else if (inputDetails >= 0) error = error.slice(0, inputDetails) + `[${source} input details omitted.]`;
  return boundedDiagnosticText(redact(error), maximumCallBytes, source);
}

export function mcpItemFailed(value: unknown): boolean {
  const item = object(value);
  return item.type === "mcpToolCall" && (item.status === "failed" || item.error !== undefined && item.error !== null || object(item.result).isError === true);
}

function errorFields(value: unknown): string[] {
  if (typeof value === "string") return [bounded(value, maximumTextBytes)];
  const record = object(value);
  const fields: string[] = [];
  for (const name of ["code", "message", "detail", "reason"] as const) {
    const text = record[name];
    if (typeof text === "string" && text.trim()) fields.push(`${name}: ${bounded(text, maximumTextBytes)}`);
    else if (name === "code" && typeof text === "number" && Number.isSafeInteger(text)) fields.push(`code: ${text}`);
  }
  return fields;
}

function structuredError(value: unknown): string[] {
  const record = object(value);
  // Explicit, shallow paths support common envelopes without walking tool data.
  const candidates = [record.error, object(record.data).error, object(record.value).error];
  for (const candidate of candidates) {
    const fields = errorFields(candidate);
    if (fields.length) return fields;
  }
  return errorFields(record);
}

function textError(value: string): string[] {
  const sample = value.slice(0, maximumTextBytes);
  const first = sample.trimStart()[0];
  if (first === "{" || first === "[") {
    // Never parse a large payload or dump arbitrary structured data as text.
    if (value.length > maximumTextBytes || Buffer.byteLength(sample) > maximumTextBytes) return ["MCP error text exceeds the diagnostic limit."];
    try { return structuredError(JSON.parse(value)); }
    catch { return ["MCP returned an invalid structured error payload."]; }
  }
  if (/^[A-Za-z0-9+/=\s]{256,}$/.test(sample)) return ["MCP returned a non-textual error payload."];
  return sample.trim() ? [bounded(value, maximumTextBytes)] : [];
}

function errorMessage(item: Record<string, unknown>): string {
  const transport = errorFields(item.error);
  if (transport.length) return transport.join("; ");
  const result = object(item.result);
  const structured = structuredError(result.structuredContent);
  if (structured.length) return structured.join("; ");
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (let index = 0; index < Math.min(result.content.length, 8); index++) {
      const block = object(result.content[index]);
      if (block.type === "text" && typeof block.text === "string") parts.push(...textError(block.text));
      if (parts.length >= 8) break;
    }
    if (parts.length) return parts.slice(0, 8).join("; ");
  }
  return "The MCP call failed without a supported error message.";
}

export class McpFailureDiagnostics {
  private readonly seen = new Set<string>();
  private readonly redact: (value: string) => string;
  private totalBytes = 0;
  private exhausted = false;

  constructor(redact: (value: string) => string) { this.redact = redact; }

  capture(value: unknown): string | undefined {
    if (!mcpItemFailed(value) || this.exhausted) return;
    const item = object(value);
    const id = typeof item.id === "string" ? item.id.slice(0, 160) : "missing-id";
    if (this.seen.has(id)) return;
    if (this.seen.size >= maximumCalls || this.totalBytes >= maximumTotalBytes - maximumCallBytes - 128) {
      this.exhausted = true;
      return "MCP error diagnostics limit reached; further error payloads were omitted.";
    }
    this.seen.add(id);
    const message = failureDiagnosticText(errorMessage(item), this.redact);
    const server = safeName(item.server), tool = safeName(item.tool);
    const identity = server && tool ? ` (${server}/${tool})` : "";
    const log = bounded(`MCP tool call failed${identity}: ${message}`, maximumCallBytes);
    this.totalBytes += Buffer.byteLength(log);
    return log;
  }
}
