import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { RunStore } from "../src/store.ts";
import { TemplateStore } from "../src/templates.ts";
import type { WorkflowEngine } from "../src/engine.ts";
import type { WorkflowRun } from "../src/types.ts";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const wireBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function largeRun(projectPath: string, index = 1): WorkflowRun {
  const text = "D".repeat(4 * 1024 * 1024);
  const timestamp = new Date(Date.UTC(2026, 0, index)).toISOString();
  const diff = { text, files: [{ path: "source.mjs", status: "modified" as const }], fingerprint: "diff-state", previewTruncated: true, totalBytes: 29_101_930, contentSha256: "b".repeat(64) };
  const script = 'export const meta={name:"large-transport",description:"Synthetic saved record for transport testing only"}; return args;';
  return {
    id: `wf_${index.toString(16).padStart(24, "0")}`, revision: 7, createdAt: timestamp, updatedAt: timestamp,
    meta: { name: "large-transport", description: "Synthetic saved record for transport testing only" },
    script, scriptDigest: "fixture", args: { preserveControlScope: "exactly" }, projectPath,
    allowWrite: true, networkAccess: false, allowedMcpServers: [], allowedMcpTools: {}, workspaceMode: "git-worktree",
    limits: { maxReadWorkers: 1, maxCalls: 1, timeoutMs: 1000, maxTokens: 0 },
    execution: "completed", review: "ready", application: "none", progressSequence: 12,
    maintenance: { steps: [{ id: "build", command: ["node", "build.mjs"], protectedPaths: [".agents/skills"] }] },
    sourceDefinition: { id: "saved:large-transport", revision: 9 },
    tasks: [{ id: "task_1", index: 0, prompt: "transport fixture", options: {}, mode: "read", status: "completed", cached: false, output: "O".repeat(512 * 1024), attempts: [{ id: "task_1_attempt_1", status: "completed", output: "A".repeat(512 * 1024) }] }],
    logs: Array.from({ length: 256 }, (_, offset) => ({ at: timestamp, level: "info" as const, message: `${offset}:` + "L".repeat(4096), taskId: "task_1" })),
    diff,
    maintenanceReview: { base: "a".repeat(40), target: "b".repeat(40), branch: "main", diff, preparedClean: true, fingerprint: "full-state-plan", artifactFingerprint: "all-artifacts",
      artifacts: Array.from({ length: 22_547 }, (_, offset) => ({ path: `dist/dependencies/module-${String(offset).padStart(5, "0")}/runtime-artifact.mjs`, kind: "file" as const, mode: 420, size: 123, hash: "c".repeat(64) })) },
  };
}

test("default SDK stdio reads large saved runs and artifact/list pages from an independent runtime", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflows-large-stdio-")));
  const packageRoot = path.join(root, "package"), state = path.join(root, "state"), project = path.join(root, "project");
  const client = new Client({ name: "large-default-stdio-test", version: "1" });
  try {
    await mkdir(project); await cp(pluginRoot, packageRoot, { recursive: true });
    // Build a self-contained test package without replacing the published runtime.
    await build({ absWorkingDir: pluginRoot, entryPoints: ["src/index.ts"], outfile: path.join(packageRoot, "runtime/index.js"), bundle: true, platform: "node", format: "esm", target: "node22", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: "silent" });
    const store = new RunStore(state), originals: Array<{ run: WorkflowRun; hash: string }> = [];
    const definition = await new TemplateStore(store).save({ script: largeRun(project).script });
    for (let index = 1; index <= 3; index++) {
      const run = largeRun(project, index); run.sourceDefinition = { id: definition.id, revision: definition.revision }; await store.create(run);
      const bytes = await readFile(path.join(store.directory(run.id), "run.json"));
      assert.ok(bytes.length > 10 * 1024 * 1024, "The saved fixture must exceed the SDK's default 10 MiB frame bound.");
      originals.push({ run, hash: digest(bytes) });
    }
    const env = Object.fromEntries(Object.entries({ ...process.env, WORKFLOWS_DATA_DIR: state, WORKFLOWS_CODEX_COMMAND: "must-not-start-a-model-host" }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // No custom ReadBuffer or transport size override: this is the default SDK path.
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, "runtime/index.js")], cwd: root, env, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 24);
    const original = originals[0]!.run;
    let maximumWireBytes = 0;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(wireBytes(result) < 10 * 1024 * 1024);
      maximumWireBytes = Math.max(maximumWireBytes, wireBytes(result));
      return result.structuredContent as Record<string, any>;
    };
    const first = (await call("workflow_get_run", { id: original.id })).run;
    assert.deepEqual(first.args, original.args); assert.equal(first.script, original.script);
    assert.deepEqual(first.maintenance, original.maintenance); assert.equal(first.projectPath, project);
    assert.equal(first.revision, original.revision); assert.equal(first.diff.fingerprint, original.diff!.fingerprint);
    assert.ok(Buffer.byteLength(first.diff.text) <= 256 * 1024);
    assert.equal(first.transportProjection.projected, true);
    assert.equal(first.maintenanceReview.artifactCount, 22_547);
    assert.equal(first.maintenanceReview.artifactOffset, 0);
    assert.equal(first.maintenanceReview.artifacts.length, 20);
    assert.equal(first.maintenanceReview.nextArtifactOffset, 20);
    assert.equal(first.maintenanceReview.diff.text, undefined);
    const second = (await call("workflow_get_run", { id: original.id, artifactOffset: 20, artifactLimit: 200 })).run;
    assert.deepEqual(second.maintenanceReview.artifacts, original.maintenanceReview!.artifacts.slice(20, 220));
    assert.equal(second.maintenanceReview.nextArtifactOffset, 220);
    const last = (await call("workflow_get_run", { id: original.id, artifactOffset: 22_540, artifactLimit: 200 })).run;
    assert.equal(last.maintenanceReview.artifacts.length, 7); assert.equal(last.maintenanceReview.nextArtifactOffset, undefined);
    const listed = await call("workflow_list_runs", { projectPath: project, offset: 0, limit: 2 });
    assert.equal(listed.listSummary, true); assert.equal(listed.totalRuns, 3); assert.equal(listed.nextOffset, 2);
    assert.equal(listed.runs.length, 2);
    for (const summary of listed.runs) {
      assert.equal(summary.projectPath, project); assert.equal(summary.revision, 7);
      for (const field of ["script", "args", "tasks", "logs", "diff", "maintenanceReview"]) assert.equal(Object.hasOwn(summary, field), false);
      assert.deepEqual(summary.sourceDefinition, original.sourceDefinition);
    }
    const rest = await call("workflow_list_runs", { offset: 2, limit: 2 });
    assert.equal(rest.runs.length, 1); assert.equal(rest.nextOffset, undefined);
    for (const input of [{ artifactOffset: -1 }, { artifactLimit: 0 }, { artifactLimit: 201 }]) {
      assert.equal((await client.callTool({ name: "workflow_get_run", arguments: { id: original.id, ...input } })).isError, true);
    }
    for (const entry of originals) assert.equal(digest(await readFile(path.join(store.directory(entry.run.id), "run.json"))), entry.hash, "Transport views must not rewrite saved execution or review data.");
    t.diagnostic(JSON.stringify({ savedRecordBytes: (await readFile(path.join(store.directory(original.id), "run.json"))).length, maximumResponseBytes: maximumWireBytes, artifacts: 22_547, records: 3, noModelTurns: true }));
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("apply callback receives identity and reads the full saved review before projecting its response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflows-apply-full-review-"));
  const store = new RunStore(path.join(root, "state")), run = largeRun(root);
  const definition = await new TemplateStore(store).save({ script: run.script });
  run.sourceDefinition = { id: definition.id, revision: definition.revision };
  await store.create(run);
  const saved = await readFile(path.join(store.directory(run.id), "run.json"));
  let checked = false;
  // Protocol-only callback: this test does not claim to execute a real apply.
  const engine = { store, apply: async (id: string, revision: number) => {
    assert.equal(id, run.id); assert.equal(revision, run.revision);
    const full = await store.load(id);
    assert.equal(full.maintenanceReview!.artifacts.length, 22_547);
    assert.equal(Buffer.byteLength(full.diff!.text), 4 * 1024 * 1024);
    assert.equal(full.maintenanceReview!.diff.text, full.diff!.text);
    checked = true; return full;
  } } as unknown as WorkflowEngine;
  const server = createServer(engine), client = new Client({ name: "apply-full-review-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: "workflow_apply", arguments: { id: run.id, revision: run.revision } });
    assert.equal(result.isError, undefined); assert.equal(checked, true);
    assert.equal((result.structuredContent?.run as Record<string, any>).maintenanceReview.artifacts.length, 20);
    assert.ok(wireBytes(result) < 10 * 1024 * 1024);
    assert.equal(digest(await readFile(path.join(store.directory(run.id), "run.json"))), digest(saved));
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
