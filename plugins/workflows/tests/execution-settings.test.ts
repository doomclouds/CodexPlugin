import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import { ExecutionSettingsStore, parseExecutionEnvironment, resolveExecutionSettings, validateExplicitModelSettings } from "../src/execution-settings.ts";
import type { ExecutionEnvironment } from "../src/execution-settings.ts";

const environment: ExecutionEnvironment = {
  defaults: { model: "model-a", reasoningEffort: "medium" },
  models: [
    { id: "model-a", displayName: "A", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    { id: "model-b", displayName: "B", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" },
  ],
};

test("execution settings use independent CAS storage and retain clearing semantics", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { root, async acquireNamed(name: string) { await mkdir(root, { recursive: true }); return lockfile.lock(path.join(root, name), { realpath: false, retries: { retries: 20, minTimeout: 5 } }); } };
  const first = new ExecutionSettingsStore(storage), second = new ExecutionSettingsStore(storage);
  assert.deepEqual(await first.get(), { revision: 0 });
  assert.deepEqual(await first.update({ revision: 0, model: "model-b", reasoningEffort: "high" }), { revision: 1, model: "model-b", reasoningEffort: "high" });
  await assert.rejects(second.update({ revision: 0, model: "model-a" }), /changed/);
  const updates = await Promise.allSettled([first, second].map(store => store.update({ revision: 1, model: "model-a" })));
  assert.equal(updates.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(await first.update({ revision: 2 }), { revision: 3 });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "settings.json"), "utf8")), { revision: 3 });
});

test("model settings preserve declared layer precedence without inventing supported efforts", () => {
  assert.deepEqual(resolveExecutionSettings(environment, []), { model: "model-a", reasoningEffort: "medium", source: "codex-config" });
  assert.deepEqual(resolveExecutionSettings(environment, [{ settings: { model: "model-b", reasoningEffort: "high" }, source: "workflow-settings" }]), { model: "model-b", reasoningEffort: "high", source: "workflow-settings" });
  assert.throws(() => resolveExecutionSettings(environment, [{ settings: { model: "model-b" }, source: "workflow-settings" }]), /unsupported/);
  assert.throws(() => validateExplicitModelSettings({ model: "invented" }, environment), /unavailable/);
  assert.throws(() => validateExplicitModelSettings({ model: "model-b", reasoningEffort: "low" }, environment), /unsupported/);
});

test("the native model catalogue is parsed with its real configured default", () => {
  const parsed = parseExecutionEnvironment({ model: "native-model", model_reasoning_effort: "high" }, [{ id: "model-id", model: "native-model", displayName: "Model", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }]);
  assert.equal(parsed.defaults.model, "model-id");
  assert.equal(parsed.defaults.reasoningEffort, "high");
  assert.throws(() => parseExecutionEnvironment({}, []));
});
