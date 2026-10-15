import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertControlPlaneTransportable, projectRunForTransport, TransportProjectionError } from "../src/run-view.ts";
import type { WorkflowRun } from "../src/types.ts";

const KiB = 1024;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function fixture(): WorkflowRun {
  return {
    id: "wf_" + "a".repeat(24), revision: 68, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:01Z",
    meta: { name: "transport-fixture", description: "Transport projection without a model" },
    script: 'export const meta={name:"transport-fixture",description:"Transport projection without a model"}; return args;', scriptDigest: "s".repeat(64), args: { task: "inspect" }, projectPath: path.join(tmpdir(), "workflows-run-view-project"),
    allowWrite: true, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "git-worktree",
    maintenance: { steps: [{ id: "build", command: ["node", "build.mjs"], protectedPaths: [".agents/skills"] }] }, nodeSettings: {},
    limits: { maxReadWorkers: 2, maxCalls: 24, timeoutMs: 3600000, maxTokens: 0 }, execution: "completed", review: "ready", application: "none", tasks: [], logs: [],
  };
}

test("small workflow transport views preserve the original JSON shape and control plane", () => {
  const run = fixture();
  run.tasks.push({ id: "task_1", index: 0, prompt: "Inspect a small task", options: {}, mode: "read", status: "completed", cached: false, output: { ok: true }, attempts: [] });
  run.logs.push({ at: run.updatedAt, level: "info", message: "Finished" });
  assert.deepEqual(projectRunForTransport(run), run);
});

test("large maintenance reviews are paged and deduplicated below the MCP frame budget without mutating persisted evidence", () => {
  const run = fixture();
  run.diff = { text: "diff data\n".repeat(430000), files: [{ path: "source.ts", status: "modified" }], fingerprint: "d".repeat(64), previewTruncated: true, totalBytes: 19000000, contentSha256: "c".repeat(64) };
  run.maintenanceReview = { base: "b".repeat(40), target: "t".repeat(40), branch: "main", diff: { ...run.diff }, preparedClean: true, artifactFingerprint: "a".repeat(64), fingerprint: "r".repeat(64), artifacts: Array.from({ length: 22547 }, (_, index) => ({ path: `node_modules/package-${index}/generated-result.js`, size: 12345, hash: "f".repeat(64), kind: "file", mode: 0o644 })) };
  const original = JSON.stringify(run);
  const projected = projectRunForTransport(run);
  const review = projected.maintenanceReview as Record<string, unknown>;
  const diff = projected.diff as Record<string, unknown>;
  assert.equal(review.artifactCount, 22547);
  assert.equal(review.artifactOffset, 0);
  assert.equal(review.nextArtifactOffset, 20);
  assert.deepEqual(review.artifacts, run.maintenanceReview.artifacts.slice(0, 20));
  assert.equal(Object.hasOwn(review.diff as object, "text"), false);
  assert.ok(Buffer.byteLength(diff.text as string) <= 256 * KiB);
  assert.equal(diff.previewTruncated, true);
  assert.equal(diff.fingerprint, run.diff.fingerprint);
  assert.equal(diff.totalBytes, run.diff.totalBytes);
  assert.equal(diff.contentSha256, run.diff.contentSha256);
  assert.equal(review.fingerprint, run.maintenanceReview.fingerprint);
  assert.equal(review.artifactFingerprint, run.maintenanceReview.artifactFingerprint);
  assert.deepEqual(projected.maintenance, run.maintenance);
  assert.deepEqual(projected.args, run.args);
  assert.equal(projected.script, run.script);
  assert.ok(jsonBytes(projected) <= 3 * 1024 * KiB);
  assert.ok(jsonBytes({ content: [{ type: "text", text: JSON.stringify({ run: projected }) }], structuredContent: { run: projected } }) < 10 * 1024 * KiB);
  const metadata = projected.transportProjection as { projected: boolean; fields: string[]; originalBytes: number; projectedBytes: number };
  assert.equal(metadata.projected, true);
  assert.ok(metadata.fields.includes("diff.text"));
  assert.ok(metadata.fields.includes("maintenanceReview.artifacts"));
  assert.equal(metadata.originalBytes, Buffer.byteLength(original));
  assert.equal(metadata.projectedBytes, jsonBytes(projected));
  assert.equal(JSON.stringify(run), original);
});

test("artifact pages preserve exact identities, total counts and terminal pagination", () => {
  const run = fixture();
  const diff = { text: "", files: [], fingerprint: "d" };
  run.maintenanceReview = { base: "b", target: "t", branch: "main", diff, preparedClean: true, artifactFingerprint: "a", fingerprint: "r", artifacts: Array.from({ length: 230 }, (_, index) => ({ path: `generated/${index}.bin`, size: index, hash: `hash-${index}`, mode: 0o644, kind: "file" })) };
  const page = projectRunForTransport(run, { artifactOffset: 20, artifactLimit: 200 }).maintenanceReview as Record<string, unknown>;
  assert.equal(page.artifactCount, 230);
  assert.equal(page.artifactOffset, 20);
  assert.equal(page.nextArtifactOffset, 220);
  assert.deepEqual(page.artifacts, run.maintenanceReview.artifacts.slice(20, 220));
  const last = projectRunForTransport(run, { artifactOffset: 220, artifactLimit: 200 }).maintenanceReview as Record<string, unknown>;
  assert.equal(last.artifactCount, 230);
  assert.equal(Object.hasOwn(last, "nextArtifactOffset"), false);
  assert.deepEqual(last.artifacts, run.maintenanceReview.artifacts.slice(220));
  for (const options of [{ artifactOffset: -1 }, { artifactOffset: 0.5 }, { artifactLimit: 0 }, { artifactLimit: 201 }, { artifactLimit: NaN }]) assert.throws(() => projectRunForTransport(run, options), /INVALID_ARTIFACT_PAGE/);
});

test("UTF-8 diff previews preserve complete code points and existing full-content metadata", () => {
  const run = fixture();
  run.diff = { text: "中文😀".repeat(100000), files: [], fingerprint: "original", totalBytes: 1000000, contentSha256: "full-content-hash" };
  const diff = projectRunForTransport(run).diff as Record<string, unknown>;
  assert.ok(Buffer.byteLength(diff.text as string) <= 256 * KiB);
  assert.ok(!(diff.text as string).includes("\ufffd"));
  assert.ok(run.diff.text.startsWith(diff.text as string));
  assert.equal(diff.previewTruncated, true);
  assert.equal(diff.totalBytes, run.diff.totalBytes);
  assert.equal(diff.contentSha256, run.diff.contentSha256);
  assert.equal(diff.fingerprint, run.diff.fingerprint);
});

test("large task prompts, results, attempt activities and recent logs stay bounded and visibly incomplete", () => {
  const run = fixture();
  run.result = { complete: true, detail: "result ".repeat(100000) };
  run.tasks = Array.from({ length: 100 }, (_, index) => ({ id: `task_${index + 1}`, index, prompt: "Prompt detail ".repeat(2000), mode: "read", options: { mode: "read" }, status: "completed", cached: false, output: { items: "result\n".repeat(5000) }, attempts: [{ id: `attempt_${index}`, status: "completed", output: "attempt result ".repeat(3000), activities: Array.from({ length: 50 }, (_, event) => ({ id: `event_${event}`, kind: "files", label: "Reading source", status: "completed", startedAt: run.createdAt })) }] })) as WorkflowRun["tasks"];
  run.logs = Array.from({ length: 1000 }, (_, index) => ({ at: run.updatedAt, level: "info", message: `Log ${index} ` + "detail ".repeat(50) }));
  const original = JSON.stringify(run);
  const projected = projectRunForTransport(run);
  const tasks = projected.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks.length, run.tasks.length);
  assert.equal(tasks[0]?.id, run.tasks[0]?.id);
  assert.deepEqual(tasks[0]?.options, run.tasks[0]?.options);
  assert.equal(tasks[0]?.status, "completed");
  assert.equal((tasks[0]?.output as Record<string, unknown>).transportPreview, true);
  assert.equal((projected.result as Record<string, unknown>).originalBytes, jsonBytes(run.result));
  assert.ok(jsonBytes(projected.logs) <= 128 * KiB);
  assert.equal((projected.logs as Array<{ message: string }>).at(-1)?.message, run.logs.at(-1)?.message);
  assert.ok(jsonBytes(projected) <= 3 * 1024 * KiB);
  assert.equal(projected.script, run.script);
  assert.deepEqual(projected.maintenance, run.maintenance);
  assert.deepEqual(projected.nodeSettings, run.nodeSettings);
  assert.equal(JSON.stringify(run), original);
});

test("oversized control planes and indispensable manifests return diagnostic errors instead of weakened authorization", () => {
  const control = fixture();
  control.args = { requiredInput: "x".repeat(3 * 1024 * KiB) };
  const original = JSON.stringify(control);
  assert.throws(() => projectRunForTransport(control), (error: unknown) => error instanceof TransportProjectionError && error.code === "CONTROL_PLANE_TOO_LARGE");
  assert.equal(JSON.stringify(control), original);
  const manifest = fixture();
  manifest.diff = { text: "", fingerprint: "unchanged", files: Array.from({ length: 12000 }, (_, index) => ({ path: `source/${"segment/".repeat(35)}${index}.ts`, status: "modified" })) };
  assert.throws(() => projectRunForTransport(manifest), /RUN_PROJECTION_TOO_LARGE/);
  assert.equal(manifest.diff.files.length, 12000);
  assert.equal(manifest.diff.fingerprint, "unchanged");
});

test("new plan preflight reserves transport room without changing or executing the supplied plan", () => {
  const run = fixture();
  const source = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  assert.doesNotThrow(() => assertControlPlaneTransportable(source));
  const large = { ...source, args: { required: "x".repeat(2 * 1024 * KiB) } };
  const original = JSON.stringify(large);
  let mutations = 0;
  assert.throws(() => { assertControlPlaneTransportable(large); mutations++; }, /CONTROL_PLANE_TOO_LARGE.*project files or artifacts/);
  assert.equal(mutations, 0, "The caller can reject before applying any mutation.");
  assert.equal(JSON.stringify(large), original);
  const cyclic = { ...source, args: {} as Record<string, unknown> };
  cyclic.args.self = cyclic.args;
  assert.throws(() => assertControlPlaneTransportable(cyclic), /CONTROL_PLANE_NOT_SERIALIZABLE/);
});

test("checkpoint references and state remain exact while checkpoint diagnostics use a bounded preview", () => {
  const run = fixture();
  run.nodeCheckpoint = { id: "cp_" + "a".repeat(24), sequence: 23, createdAt: "2026-10-15T00:00:00.000Z", digest: "b".repeat(64), reason: "node", completedTasks: 7 };
  run.checkpointState = { status: "failed", error: "检查点错误😀".repeat(100000) };
  const original = JSON.stringify(run);
  const projected = projectRunForTransport(run);
  assert.deepEqual(projected.nodeCheckpoint, run.nodeCheckpoint);
  const state = projected.checkpointState as Record<string, unknown>;
  assert.equal(state.status, "failed"); assert.ok(Buffer.byteLength(state.error as string) <= 4 * KiB);
  assert.ok(!(state.error as string).includes("\ufffd")); assert.ok(run.checkpointState.error!.startsWith(state.error as string));
  assert.ok((projected.transportProjection as { fields: string[] }).fields.includes("checkpointState.error"));
  assert.equal(JSON.stringify(run), original);
  assertControlPlaneTransportable(run as unknown as Record<string, unknown>);
});

test("oversized checkpoint identity fails control transport instead of dropping integrity metadata", () => {
  const run = fixture();
  run.nodeCheckpoint = { id: "cp_" + "x".repeat(3 * 1024 * KiB), sequence: 1, createdAt: "2026-10-15T00:00:00.000Z", digest: "b".repeat(64), reason: "node", completedTasks: 0 };
  const original = JSON.stringify(run);
  assert.throws(() => assertControlPlaneTransportable(run as unknown as Record<string, unknown>), /CONTROL_PLANE_TOO_LARGE/);
  assert.throws(() => projectRunForTransport(run), /CONTROL_PLANE_TOO_LARGE/);
  assert.equal(JSON.stringify(run), original);
});
