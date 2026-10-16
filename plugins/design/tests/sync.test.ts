import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesignStore } from "../src/store.ts";
import { importProject, ProjectSyncError, readProject, writeProjectLocked } from "../src/sync.ts";
import type { DesignDocument } from "../src/model.ts";

async function workspace(run: (store: DesignStore, directory: string, document: DesignDocument) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "codex-design-sync-"));
  try {
    const store = new DesignStore({ dataDir: join(temporary, "store") });
    const document = await store.create({ name: "同步工程", template: "landing" });
    const directory = join(temporary, "source");
    await writeProjectLocked(document, directory);
    await run(store, directory, document);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function button(document: DesignDocument) { return document.artboards[0]!.nodes.find((node) => node.type === "component")!; }
function changeText(html: string, nodeId: string, value: string): string {
  const pattern = new RegExp(`(<button[^>]*data-node-id="${nodeId}"[^>]*>)[^<]*(</button>)`);
  assert.ok(pattern.test(html));
  return html.replace(pattern, `$1${value}$2`);
}
async function editHtml(directory: string, document: DesignDocument, value: string): Promise<string> {
  const content = changeText(await readFile(join(directory, "index.html"), "utf8"), button(document).id, value);
  await writeFile(join(directory, "index.html"), content);
  return content;
}

test("real HTML and JSON imports continuously round-trip with new revisions, tokens and components intact", async () => {
  await workspace(async (store, directory, first) => {
    await editHtml(directory, first, "从源码修改按钮");
    const changed = await readProject(store, { projectId: first.id, directory });
    assert.deepEqual(changed.changedFiles, ["index.html"]);
    const imported = await importProject(store, { projectId: first.id, expectedRevision: 1, directory });
    assert.equal(imported.document.revision, 2);
    assert.equal(button(imported.document).text, "从源码修改按钮");
    assert.deepEqual(imported.document.designSystem, first.designSystem);
    let status = await readProject(store, { projectId: first.id, directory });
    assert.deepEqual(status.changedFiles, []); assert.deepEqual(status.conflicts, []);
    const json = JSON.parse(await readFile(join(directory, "design.json"), "utf8")) as DesignDocument;
    assert.equal(json.revision, 2); json.name = "再次从 JSON 修改";
    await writeFile(join(directory, "design.json"), JSON.stringify(json, null, 2));
    const third = await importProject(store, { projectId: first.id, expectedRevision: 2, directory });
    assert.equal(third.document.revision, 3); assert.equal(third.document.name, "再次从 JSON 修改");
    assert.equal(button(third.document).text, "从源码修改按钮");
    assert.deepEqual(third.document.designSystem, first.designSystem);
    await writeProjectLocked(third.document, directory);
    status = await readProject(store, { projectId: first.id, directory });
    assert.equal(status.baseRevision, 3); assert.deepEqual(status.changedFiles, []);
    const noChange = await importProject(store, { projectId: first.id, expectedRevision: 3, directory });
    assert.equal(noChange.document.revision, 3);
  });
});

test("simultaneous JSON and HTML edits require an explicit source and preserve files until resolved", async () => {
  await workspace(async (store, directory, first) => {
    const html = await editHtml(directory, first, "选择 HTML 内容");
    const json = { ...first, name: "选择 JSON 内容" };
    const jsonText = JSON.stringify(json, null, 2);
    await writeFile(join(directory, "design.json"), jsonText);
    const status = await readProject(store, { projectId: first.id, directory });
    assert.equal(status.changedFiles.length, 2); assert.equal(status.conflicts.length, 1);
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_CONFLICT");
    assert.equal((await store.get(first.id)).revision, 1);
    assert.equal(await readFile(join(directory, "index.html"), "utf8"), html);
    assert.equal(await readFile(join(directory, "design.json"), "utf8"), jsonText);
    const chosen = await importProject(store, { projectId: first.id, expectedRevision: 1, directory, source: "html" });
    assert.equal(chosen.document.name, first.name);
    assert.equal(button(chosen.document).text, "选择 HTML 内容");
    assert.deepEqual((await readProject(store, { projectId: first.id, directory })).changedFiles, []);
  });
});

test("canvas changes after export conflict with both stale and current caller revisions", async () => {
  await workspace(async (store, directory, first) => {
    const html = await editHtml(directory, first, "外部编辑");
    await store.apply(first.id, 1, [{ op: "replace", path: "/name", value: "并发画布修改" }]);
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "REVISION_CONFLICT");
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 2, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_CONFLICT");
    assert.equal((await store.get(first.id)).name, "并发画布修改");
    assert.equal(await readFile(join(directory, "index.html"), "utf8"), html);
    const state = await readProject(store, { projectId: first.id, directory });
    assert.equal(state.revision, 2); assert.equal(state.baseRevision, 1); assert.ok(state.conflicts.length > 0);
  });
});

test("directory lock serializes two importers and prevents a duplicate stale application", async () => {
  await workspace(async (store, directory, first) => {
    await editHtml(directory, first, "只导入一次");
    const results = await Promise.allSettled([importProject(store, { projectId: first.id, expectedRevision: 1, directory }), importProject(new DesignStore({ dataDir: store.dataDir }), { projectId: first.id, expectedRevision: 1, directory })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.get(first.id)).revision, 2);
  });
});

test("symlink sources, manifests and directories are rejected without saving canvas changes", async () => {
  for (const name of ["design.json", "index.html", "design-export.json"]) {
    await workspace(async (store, directory, first) => {
      const source = join(directory, name), outside = join(directory, "..", `outside-${name}`);
      await rename(source, outside); await symlink(outside, source, "file");
      await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_VALIDATION");
      assert.equal((await store.get(first.id)).revision, 1);
    });
  }
  await workspace(async (store, directory, first) => {
    const linked = `${directory}-link`; await symlink(directory, linked, "dir");
    await assert.rejects(readProject(store, { projectId: first.id, directory: linked }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_VALIDATION");
  });
});

test("invalid source metadata and oversized source files cannot be acknowledged or imported", async () => {
  await workspace(async (store, directory, first) => {
    const incoming = { ...first, name: "伪造基础信息", createdAt: "2020-01-01T00:00:00.000Z" };
    await writeFile(join(directory, "design.json"), JSON.stringify(incoming));
    const manifest = await readFile(join(directory, "design-export.json"), "utf8");
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_CONFLICT");
    assert.equal((await store.get(first.id)).revision, 1);
    assert.equal(await readFile(join(directory, "design-export.json"), "utf8"), manifest);
    await truncate(join(directory, "design.json"), 32 * 1024 * 1024 + 1);
    await assert.rejects(readProject(store, { projectId: first.id, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_VALIDATION");
  });
});

test("source changes after canvas commit produce an explicit partial result and remain untouched", async () => {
  await workspace(async (store, directory, first) => {
    await editHtml(directory, first, "已核对并导入的内容");
    const manifest = await readFile(join(directory, "design-export.json"), "utf8");
    const replace = store.replace.bind(store);
    let newestHtml = "";
    store.replace = async (id, revision, document) => {
      const saved = await replace(id, revision, document);
      newestHtml = await editHtml(directory, first, "保存期间出现的新编辑");
      return saved;
    };
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_PARTIAL" && error.partial && error.savedRevision === 2 && error.message.includes("revision 2"));
    const saved = await store.get(first.id);
    assert.equal(saved.revision, 2); assert.equal(button(saved).text, "已核对并导入的内容");
    assert.equal(await readFile(join(directory, "index.html"), "utf8"), newestHtml);
    assert.equal(await readFile(join(directory, "design-export.json"), "utf8"), manifest);
  });
});

test("HTML changes with no representable Design changes are preserved and never acknowledged", async () => {
  await workspace(async (store, directory, first) => {
    const filename = join(directory, "index.html");
    const html = (await readFile(filename, "utf8")).replace("</body>", '<p id="externally-added">外部新增内容</p></body>');
    const manifest = await readFile(join(directory, "design-export.json"), "utf8");
    await writeFile(filename, html);
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && ["SYNC_CONFLICT", "SYNC_VALIDATION"].includes(error.code));
    assert.equal((await store.get(first.id)).revision, 1);
    assert.equal(await readFile(filename, "utf8"), html);
    assert.equal(await readFile(join(directory, "design-export.json"), "utf8"), manifest);
  });
});

test("a canvas edit after import commit is preserved and reported as partial synchronization", async () => {
  await workspace(async (store, directory, first) => {
    await editHtml(directory, first, "本次导入");
    const replace = store.replace.bind(store);
    store.replace = async (id, revision, document) => {
      const saved = await replace(id, revision, document);
      await store.apply(id, saved.revision, [{ op: "replace", path: "/name", value: "保存期间的画布编辑" }]);
      return saved;
    };
    await assert.rejects(importProject(store, { projectId: first.id, expectedRevision: 1, directory }), (error: unknown) => error instanceof ProjectSyncError && error.code === "SYNC_PARTIAL" && error.partial && error.savedRevision === 2 && error.message.includes("revision 3"));
    const latest = await store.get(first.id);
    assert.equal(latest.revision, 3); assert.equal(latest.name, "保存期间的画布编辑");
    assert.equal(button(latest).text, "本次导入");
    const state = await readProject(store, { projectId: first.id, directory });
    assert.equal(state.revision, 3); assert.equal(state.baseRevision, 2); assert.ok(state.conflicts.length > 0);
  });
});
