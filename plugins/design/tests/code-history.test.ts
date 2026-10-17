import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodeProjectStore, CODE_PROJECT_LIMITS } from "../src/code-project.ts";
import { createDesignServer } from "../src/server.ts";

async function workspace(run: (store: CodeProjectStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "design-code-history-"));
  try { await run(new CodeProjectStore({ dataDir: join(directory, "private") }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("history availability follows actual stacks across undo, redo, restore, reopening and a new edit branch", async () => workspace(async store => {
  let project = await store.create({ name: "History availability", template: "html" });
  const flags = async () => { const state = await store.history(project.id); assert.equal(state.revision, project.revision); return [state.canUndo, state.canRedo]; };
  assert.deepEqual(await flags(), [false, false]);
  project = await store.update(project.id, project.revision, { name: "Edited" }); assert.deepEqual(await flags(), [true, false]);
  project = await store.undo(project.id, project.revision); assert.deepEqual(await flags(), [false, true]);
  const reopened = new CodeProjectStore({ dataDir: store.dataDir }); assert.deepEqual(await reopened.history(project.id), await store.history(project.id));
  project = await reopened.redo(project.id, project.revision); assert.deepEqual(await flags(), [true, false]);
  project = await store.restore(project.id, project.revision, 1); assert.deepEqual(await flags(), [true, false]);
  assert.equal((await store.history(project.id)).versions.at(-1)!.restoredFrom, 1);
  project = await store.undo(project.id, project.revision); assert.deepEqual(await flags(), [true, true]);
  project = await store.update(project.id, project.revision, { name: "New branch" }); assert.deepEqual(await flags(), [true, false]);
  await assert.rejects(store.redo(project.id, project.revision), /No source change is available to redo/);
  assert.deepEqual(await flags(), [true, false]);
}));

test("history pruning reports an empty undo stack even while many retained versions remain", async () => workspace(async store => {
  let project = await store.create({ name: "Pruned history", template: "html" });
  for (let index = 0; index < CODE_PROJECT_LIMITS.history + 5; index++) project = await store.update(project.id, project.revision, { name: `Revision ${index}` });
  let state = await store.history(project.id); assert.equal(state.versions.length, CODE_PROJECT_LIMITS.history); assert.equal(state.canUndo, true); assert.equal(state.canRedo, false);
  let undos = 0;
  while (state.canUndo && undos < CODE_PROJECT_LIMITS.history + 1) { project = await store.undo(project.id, project.revision); state = await store.history(project.id); assert.equal(state.revision, project.revision); undos++; }
  assert.ok(undos > 0 && undos <= CODE_PROJECT_LIMITS.history); assert.equal(state.canUndo, false); assert.equal(state.canRedo, true); assert.ok(state.versions.length > 1);
  await assert.rejects(store.undo(project.id, project.revision), /No source change is available to undo/);
  project = await store.redo(project.id, project.revision); state = await store.history(project.id); assert.equal(state.canUndo, true);
  project = await store.update(project.id, project.revision, { name: "New branch after pruning" }); state = await store.history(project.id); assert.equal(state.canRedo, false); assert.equal(state.revision, project.revision);
}));

test("MCP history for fresh and imported projects exposes metadata only and no private source connection", async () => workspace(async (store, directory) => {
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>History contract test</div>" });
  const client = new Client({ name: "code-history-test", version: "1" }); const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  try {
    const created = await store.create({ name: "Fresh", template: "react" }); const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>PRIVATE_SOURCE_SENTINEL</h1>");
    const imported = await store.importDirectory({ name: "Imported", directory: source }); assert.equal((await store.sourceStatus(imported.id)).connected, true);
    for (const project of [created, imported]) {
      const response = await client.callTool({ name: "design_code_history", arguments: { projectId: project.id } }); assert.notEqual(response.isError, true);
      const state = response.structuredContent as Record<string, unknown>; assert.deepEqual(Object.keys(state).sort(), ["canRedo", "canUndo", "revision", "versions"]);
      assert.equal(state.revision, 1); assert.equal(state.canUndo, false); assert.equal(state.canRedo, false);
      const versions = state.versions as Record<string, unknown>[]; assert.equal(versions.length, 1); assert.deepEqual(Object.keys(versions[0]!).sort(), ["createdAt", "operation", "revision"]);
      assert.equal(versions[0]!.operation, project.id === created.id ? "create" : "import");
      const serialized = JSON.stringify(response); assert.ok(!serialized.includes(directory)); assert.ok(!serialized.includes("PRIVATE_SOURCE_SENTINEL")); assert.ok(!serialized.includes("sourceLink")); assert.ok(!serialized.includes("snapshots"));
    }
  } finally { await client.close(); await instance.dispose(); }
}));
