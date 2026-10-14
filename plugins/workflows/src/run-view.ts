import type { WorkflowRun } from "./types.ts";

const KiB = 1024;
const maximumBytes = 3 * 1024 * KiB;
const maximumDiffBytes = 256 * KiB;
const maximumLogBytes = 128 * KiB;
const maximumNewControlBytes = 2 * 1024 * KiB;
const controlKeys = ["id", "revision", "meta", "script", "args", "projectPath", "allowWrite", "networkAccess", "allowedMcpServers", "allowedMcpTools", "workspaceMode", "workspace", "workspacePath", "maintenance", "nodeSettings", "limits", "executionSettings", "sourceDefinition", "execution", "review", "application", "deletionPending", "deletionTarget", "scriptDigest", "contextDigest", "workspaceCheckpoint"];

export class TransportProjectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "TransportProjectionError"; this.code = code; }
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function prefix(value: string, limit: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit) return value;
  let end = Math.max(0, limit);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

function serializedRun(run: WorkflowRun): string {
  try { return JSON.stringify(run); }
  catch { throw new TransportProjectionError("RUN_NOT_SERIALIZABLE", "The workflow record is not JSON serializable; the stored record was not changed."); }
}

function pageNumber(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (name === "artifactLimit" ? 1 : 0) || result > maximum) throw new TransportProjectionError("INVALID_ARTIFACT_PAGE", `${name} is outside its supported integer range.`);
  return result;
}

function controlPlane(source: RecordValue): RecordValue {
  // Authorization and replay inputs remain exact. A large control plane must
  // fail visibly rather than return an apparently editable weakened plan.
  return Object.fromEntries(controlKeys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}

/** Call before a plan mutation. It validates size without changing its inputs. */
export function assertControlPlaneTransportable(value: RecordValue): void {
  let size: number;
  try { size = bytes(controlPlane(value)); }
  catch { throw new TransportProjectionError("CONTROL_PLANE_NOT_SERIALIZABLE", "Workflow script, input or execution scope is not JSON serializable."); }
  if (size > maximumNewControlBytes) throw new TransportProjectionError("CONTROL_PLANE_TOO_LARGE", "Workflow script, input or execution scope exceeds the 2 MiB plan transport budget. Move large content to project files or artifacts and pass their references; authorization fields will not be silently truncated.");
}

/** A view-only JSON projection. Never persist it or use it as an apply journal. */
export function projectRunForTransport(run: WorkflowRun, options: { artifactOffset?: number; artifactLimit?: number } = {}): RecordValue {
  const artifactOffset = pageNumber(options.artifactOffset, 0, Number.MAX_SAFE_INTEGER, "artifactOffset");
  const artifactLimit = pageNumber(options.artifactLimit, 20, 200, "artifactLimit");
  const serialized = serializedRun(run);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (bytes(controlPlane(run as unknown as RecordValue)) > maximumBytes) throw new TransportProjectionError("CONTROL_PLANE_TOO_LARGE", "Workflow script, input or execution scope exceeds 3 MiB. These fields were not truncated; read or revise the complete stored plan before retrying.");
  const view = JSON.parse(serialized) as RecordValue;
  const fields = new Set<string>();
  const mark = (field: string) => { fields.add(field); };
  const text = (record: RecordValue, key: string, limit: number, field: string) => {
    if (typeof record[key] === "string" && Buffer.byteLength(record[key], "utf8") > limit) { record[key] = prefix(record[key], limit); mark(field); }
  };
  const diff = object(view.diff);
  const limitDiff = (limit: number) => {
    if (!diff || typeof diff.text !== "string" || Buffer.byteLength(diff.text, "utf8") <= limit) return;
    diff.text = prefix(diff.text, limit);
    diff.previewTruncated = true;
    mark("diff.text");
  };
  limitDiff(maximumDiffBytes);
  const review = object(view.maintenanceReview);
  if (review) {
    const artifacts = Array.isArray(review.artifacts) ? review.artifacts : [];
    review.artifactCount = artifacts.length;
    review.artifactOffset = artifactOffset;
    review.artifacts = artifacts.slice(artifactOffset, artifactOffset + artifactLimit);
    if (artifactOffset + artifactLimit < artifacts.length) review.nextArtifactOffset = artifactOffset + artifactLimit;
    else delete review.nextArtifactOffset;
    if (artifactOffset !== 0 || artifacts.length > artifactLimit) mark("maintenanceReview.artifacts");
    const duplicate = object(review.diff);
    if (duplicate && Object.hasOwn(duplicate, "text")) { delete duplicate.text; mark("maintenanceReview.diff.text"); }
  }
  const tasks = Array.isArray(view.tasks) ? view.tasks.map(object).filter((value): value is RecordValue => !!value) : [];
  const attempts = tasks.flatMap(task => Array.isArray(task.attempts) ? task.attempts.map(object).filter((value): value is RecordValue => !!value) : []);
  const outputCount = Math.max(1, (Object.hasOwn(view, "result") ? 1 : 0) + tasks.filter(task => Object.hasOwn(task, "output")).length + attempts.filter(attempt => Object.hasOwn(attempt, "output")).length);
  const allOutputFields: Array<{ record: RecordValue; key: string; field: string }> = [];
  const activities: Array<{ record: RecordValue; field: string }> = [];
  const previews = new WeakSet<RecordValue>();
  const boundOutput = (record: RecordValue, key: string, limit: number, field: string) => {
    if (!Object.hasOwn(record, key)) return;
    const value = record[key], existing = object(value);
    if (bytes(value) <= limit) return;
    const original = existing && previews.has(existing) ? existing.originalBytes as number : bytes(value);
    const json = existing && previews.has(existing) ? existing.jsonPreview as string : JSON.stringify(value);
    const preview = { transportPreview: true, previewTruncated: true, originalBytes: original, jsonPreview: "" };
    const overhead = bytes(preview);
    // JSON escaping can expand one byte to six. The preview is deliberately
    // recognizable as incomplete data, never an apparent original result.
    preview.jsonPreview = prefix(json, Math.max(0, Math.floor((limit - overhead) / 6)));
    record[key] = preview;
    previews.add(preview);
    mark(field);
  };
  const recent = (items: unknown[], limit: number): unknown[] => {
    const result: unknown[] = [];
    let size = 2;
    for (let index = items.length - 1; index >= 0; index--) {
      const next = bytes(items[index]) + (result.length ? 1 : 0);
      if (size + next > limit) break;
      result.push(items[index]); size += next;
    }
    return result.reverse();
  };
  const limitLogs = (limit: number) => {
    if (!Array.isArray(view.logs)) return;
    const logs = view.logs;
    for (const entry of logs) { const log = object(entry); if (log) text(log, "message", 16 * KiB, "logs"); }
    const selected = recent(logs, limit);
    if (selected.length !== logs.length) { view.logs = selected; mark("logs"); }
  };
  limitLogs(maximumLogBytes);
  text(view, "error", 16 * KiB, "error");
  if (Object.hasOwn(view, "result")) allOutputFields.push({ record: view, key: "result", field: "result" });
  tasks.forEach((task, index) => {
    const base = `tasks[${index}]`;
    text(task, "prompt", Math.min(8 * KiB, Math.max(64, Math.floor(256 * KiB / Math.max(1, tasks.length)))), `${base}.prompt`);
    text(task, "error", 4 * KiB, `${base}.error`);
    if (Object.hasOwn(task, "output")) allOutputFields.push({ record: task, key: "output", field: `${base}.output` });
    if (Array.isArray(task.attempts)) task.attempts.forEach((value, attemptIndex) => {
      const attempt = object(value);
      if (!attempt) return;
      const field = `${base}.attempts[${attemptIndex}]`;
      text(attempt, "error", 4 * KiB, `${field}.error`);
      if (Object.hasOwn(attempt, "output")) allOutputFields.push({ record: attempt, key: "output", field: `${field}.output` });
      if (Array.isArray(attempt.activities)) activities.push({ record: attempt, field: `${field}.activities` });
    });
  });
  for (const entry of allOutputFields) boundOutput(entry.record, entry.key, Math.min(32 * KiB, Math.max(128, Math.floor(512 * KiB / outputCount))), entry.field);
  for (const entry of activities) {
    const current = entry.record.activities as unknown[];
    const selected = recent(current, Math.max(2, Math.floor(256 * KiB / Math.max(1, activities.length))));
    if (selected.length !== current.length) { entry.record.activities = selected; mark(entry.field); }
  }
  const metadata = () => {
    if (!fields.size) return;
    view.transportProjection = { projected: true, fields: [...fields], originalBytes, projectedBytes: 0, fullRecordRetained: true };
    const meta = view.transportProjection as RecordValue;
    for (let pass = 0; pass < 3; pass++) { const size = bytes(view); if (meta.projectedBytes === size) break; meta.projectedBytes = size; }
  };
  metadata();
  if (bytes(view) > maximumBytes) {
    // A dense history gets a smaller preview, while task/attempt identities,
    // statuses, options, file manifests and every authorization field stay exact.
    limitDiff(64 * KiB);
    limitLogs(32 * KiB);
    tasks.forEach((task, index) => text(task, "prompt", Math.max(64, Math.floor(64 * KiB / Math.max(1, tasks.length))), `tasks[${index}].prompt`));
    for (const entry of allOutputFields) boundOutput(entry.record, entry.key, Math.max(128, Math.floor(128 * KiB / outputCount)), entry.field);
    for (const entry of activities) if ((entry.record.activities as unknown[]).length) { entry.record.activities = []; mark(entry.field); }
    metadata();
  }
  if (bytes(view) > maximumBytes) throw new TransportProjectionError("RUN_PROJECTION_TOO_LARGE", "Complete task identities, options or review manifests exceed the 3 MiB transport budget. The complete record and its authorization fields were not changed.");
  return view;
}
