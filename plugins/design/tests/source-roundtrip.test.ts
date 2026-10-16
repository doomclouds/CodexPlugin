import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodeProjectStore, codeFileHash, createCodeTemplate } from "../src/code-project.ts";
import type { CodeProject, SourceComparison } from "../src/code-project.ts";
import { createDesignServer } from "../src/server.ts";
import { compileCodeProject } from "../src/code-preview.ts";

const directoryHashes = (comparison: SourceComparison) => Object.fromEntries(comparison.files.map(file => [file.path, file.directoryHash]));
async function workspace(run: (directory: string, store: CodeProjectStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "design-source-roundtrip-"));
  try { await run(directory, new CodeProjectStore({ dataDir: join(directory, "private") })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function mcp(store: CodeProjectStore) {
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>Source protocol test</div>" });
  const client = new Client({ name: "source-roundtrip-test", version: "1" }); const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => { const result = await raw(name, args); assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent as any; };
  return { call, raw, close: async () => { await client.close(); await instance.dispose(); } };
}

test("real MCP imports a source directory, writes back safely, pulls external work and rejects stale conflict choices", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source);
  await writeFile(join(source, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>原始标题</h1><script src="app.js"></script></body></html>');
  await writeFile(join(source, "styles.css"), "h1{color:#345}"); await writeFile(join(source, "app.js"), "window.realSource = 1;");
  await writeFile(join(source, "LICENSE"), "Unmanaged license must remain"); await writeFile(join(source, "picture.png"), Buffer.from("iVBORw0KGgo=", "base64"));
  const protocol = await mcp(store);
  try {
    let project = (await protocol.call("design_code_import_directory", { name: "真实目录往返", directory: source })).project as CodeProject;
    assert.equal((await protocol.call("design_code_source_status", { projectId: project.id })).directory, await realpath(source));
    assert.deepEqual((await readdir(source)).sort(), ["LICENSE", "app.js", "index.html", "picture.png", "styles.css"]);
    assert.ok(!JSON.stringify(project).includes(directory)); assert.ok(!("sourceLink" in project));
    const cssBefore = await lstat(join(source, "styles.css")); const heading = project.files.find(file => file.path === "index.html")!;
    project = (await protocol.call("design_code_update", { projectId: project.id, expectedRevision: project.revision, changes: { files: [{ path: heading.path, expectedHash: codeFileHash(heading), content: heading.content.replace("原始标题", "Design 中的标题") }] } })).project;
    await protocol.call("design_code_write_directory", { projectId: project.id, expectedRevision: project.revision, directory: source });
    assert.match(await readFile(join(source, "index.html"), "utf8"), /Design 中的标题/);
    assert.equal((await lstat(join(source, "styles.css"))).mtimeMs, cssBefore.mtimeMs); assert.equal(await readFile(join(source, "LICENSE"), "utf8"), "Unmanaged license must remain");
    await writeFile(join(source, "styles.css"), "h1{color:#246}");
    let comparison = await protocol.call("design_code_compare_source", { projectId: project.id }) as SourceComparison;
    assert.equal(comparison.files.find(file => file.path === "styles.css")!.status, "directory");
    project = (await protocol.call("design_code_pull_source", { projectId: project.id, expectedRevision: project.revision, paths: ["styles.css"], expectedDirectoryHashes: directoryHashes(comparison) })).project;
    assert.equal(project.files.find(file => file.path === "styles.css")!.content, "h1{color:#246}");
    const app = project.files.find(file => file.path === "app.js")!;
    project = (await protocol.call("design_code_update", { projectId: project.id, expectedRevision: project.revision, changes: { files: [{ path: app.path, expectedHash: codeFileHash(app), content: "window.realSource = 2;" }] } })).project;
    await writeFile(join(source, "app.js"), "window.externalWork = 3;");
    comparison = await protocol.call("design_code_compare_source", { projectId: project.id }) as SourceComparison;
    assert.equal(comparison.files.find(file => file.path === "app.js")!.status, "conflict");
    const push = await protocol.raw("design_code_push_source", { projectId: project.id, expectedRevision: project.revision, paths: ["app.js"], expectedDirectoryHashes: directoryHashes(comparison) }); assert.equal(push.isError, true);
    const inspected = await protocol.call("design_code_read_source_difference", { projectId: project.id, file: "app.js" });
    assert.equal(inspected.projectFile.content, "window.realSource = 2;"); assert.equal(inspected.directoryFile.content, "window.externalWork = 3;");
    await writeFile(join(source, "app.js"), "window.externalWork = 4;");
    const stale = await protocol.raw("design_code_resolve_source", { projectId: project.id, expectedRevision: project.revision, file: "app.js", expectedProjectHash: inspected.difference.projectHash, expectedDirectoryHash: inspected.difference.directoryHash, choice: "project" }); assert.equal(stale.isError, true);
    assert.equal(await readFile(join(source, "app.js"), "utf8"), "window.externalWork = 4;");
    const latest = await protocol.call("design_code_read_source_difference", { projectId: project.id, file: "app.js" });
    project = (await protocol.call("design_code_resolve_source", { projectId: project.id, expectedRevision: project.revision, file: "app.js", expectedProjectHash: latest.difference.projectHash, expectedDirectoryHash: latest.difference.directoryHash, choice: "directory" })).project;
    assert.equal(project.files.find(file => file.path === "app.js")!.content, "window.externalWork = 4;");
    const exported = await protocol.call("design_code_export", { projectId: project.id, format: "zip" });
    assert.ok(!Buffer.from(exported.dataBase64, "base64").includes(Buffer.from(directory)));
    assert.equal((await protocol.call("design_code_compare_source", { projectId: project.id })).files.every((file: any) => file.status === "synced"), true);
  } finally { await protocol.close(); }
}));

test("source links preserve BOM bytes, handle additions and deletions, reject changed comparisons and do not follow replacement symlinks", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); const bom = Buffer.from("\uFEFF<!doctype html><h1>原始</h1>"); await writeFile(join(source, "index.html"), bom);
  let project = await store.importDirectory({ name: "Byte fidelity", directory: source }); assert.equal(codeFileHash(project.files[0]!), (await store.compareSource(project.id)).files[0]!.directoryHash);
  assert.deepEqual(Buffer.from(project.files[0]!.content), bom);
  await writeFile(join(source, "extra.css"), "body{margin:0}"); let comparison = await store.compareSource(project.id);
  project = await store.pullSource(project.id, project.revision, ["extra.css"], undefined, directoryHashes(comparison));
  await rm(join(source, "extra.css")); comparison = await store.compareSource(project.id); project = await store.pullSource(project.id, project.revision, ["extra.css"], undefined, directoryHashes(comparison)); assert.ok(!project.files.some(file => file.path === "extra.css"));
  const entry = project.files[0]!; project = await store.update(project.id, project.revision, { files: [{ path: entry.path, expectedHash: codeFileHash(entry), content: entry.content + "\n<p>Project work</p>" }] });
  comparison = await store.compareSource(project.id); await writeFile(join(source, "index.html"), "<h1>Concurrent external save</h1>");
  await assert.rejects(store.pushSource(project.id, project.revision, [entry.path], undefined, directoryHashes(comparison)), /conflict|comparison/i); assert.match(await readFile(join(source, "index.html"), "utf8"), /Concurrent external/);
  const outside = join(directory, "outside.html"); await writeFile(outside, "OUTSIDE"); await rm(join(source, "index.html")); await symlink(outside, join(source, "index.html"));
  comparison = await store.compareSource(project.id); assert.equal(comparison.files.find(file => file.path === entry.path)!.status, "conflict");
  await assert.rejects(store.pullSource(project.id, project.revision, [entry.path], undefined, directoryHashes(comparison)), /Unsafe source path/); assert.equal(await readFile(outside, "utf8"), "OUTSIDE");
}));

test("a real mid-write permission failure retains MCP recovery details, survives reopening and preserves later manual edits", async context => workspace(async (directory, store) => {
  if (process.getuid?.() === 0) { context.skip("Root bypasses directory permission failures"); return; }
  const source = join(directory, "source"); const locked = join(source, "locked"); await mkdir(locked, { recursive: true });
  await writeFile(join(source, "a.html"), "<h1>Before</h1>"); await writeFile(join(locked, "b.css"), "body{color:black}");
  let project = await store.importDirectory({ name: "Partial write", directory: source });
  project = await store.update(project.id, project.revision, { files: project.files.map(file => ({ path: file.path, expectedHash: codeFileHash(file), content: file.content + "\n/* authored change */" })) });
  const comparison = await store.compareSource(project.id); await chmod(locked, 0o500); const protocol = await mcp(store);
  try {
    const failed = await protocol.raw("design_code_push_source", { projectId: project.id, expectedRevision: project.revision, paths: ["a.html", "locked/b.css"], expectedDirectoryHashes: directoryHashes(comparison) }); assert.equal(failed.isError, true);
    const error = (failed.structuredContent as any).error; assert.equal(error.code, "EXPORT_PARTIAL"); assert.equal(error.directory, await realpath(source)); assert.deepEqual(error.filesWritten, ["a.html"]); assert.deepEqual(error.pendingFiles, ["locked/b.css"]); assert.ok(error.operationId);
    const reopened = new CodeProjectStore({ dataDir: store.dataDir }); assert.equal((await reopened.sourceStatus(project.id)).operation!.phase, "partial");
    await writeFile(join(source, "a.html"), "<h1>Manual work after failure</h1>"); await chmod(locked, 0o700);
    const rechecked = await reopened.recheckSource(project.id); assert.equal(rechecked.files.find(file => file.path === "a.html")!.status, "directory");
    project = await reopened.pullSource(project.id, project.revision, ["a.html"], undefined, directoryHashes(rechecked));
    const pending = await reopened.compareSource(project.id); await reopened.pushSource(project.id, project.revision, ["locked/b.css"], undefined, directoryHashes(pending));
    assert.equal(await readFile(join(source, "a.html"), "utf8"), "<h1>Manual work after failure</h1>"); assert.match(await readFile(join(locked, "b.css"), "utf8"), /authored change/);
    assert.equal((await reopened.sourceStatus(project.id)).operation!.phase, "completed");
  } finally { await chmod(locked, 0o700); await protocol.close(); }
}));

test("a connected directory identity cannot be silently replaced", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Original</h1>"); const project = await store.importDirectory({ name: "Identity", directory: source });
  await rename(source, join(directory, "old-source")); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Different directory</h1>");
  await assert.rejects(store.compareSource(project.id), /identity changed/); assert.equal(await readFile(join(source, "index.html"), "utf8"), "<h1>Different directory</h1>");
}));

test("an ordinary React source directory compiles before and after same-project external editing, and stale one-sided pulls are rejected", async () => workspace(async (directory, store) => {
  const source = join(directory, "react-project"); await mkdir(join(source, "src"), { recursive: true });
  const template = createCodeTemplate("React source", "react");
  for (const file of template.files) await writeFile(join(source, file.path), file.content);
  let project = await store.importDirectory({ name: "Imported React", directory: source }); const originalId = project.id;
  assert.equal((await compileCodeProject(project)).diagnostics.filter(item => item.level === "error").length, 0);
  const app = project.files.find(file => file.path === "src/App.tsx")!;
  project = await store.update(project.id, project.revision, { files: [{ path: app.path, expectedHash: codeFileHash(app), content: app.content.replace("给想法一点空间。", "让真实工程持续编辑。") }] });
  let comparison = await store.compareSource(project.id); await store.pushSource(project.id, project.revision, [app.path], undefined, directoryHashes(comparison)); assert.match(await readFile(join(source, app.path), "utf8"), /让真实工程持续编辑/);
  await writeFile(join(source, "styles.css"), "body{margin:0;color:#123}"); comparison = await store.compareSource(project.id);
  await writeFile(join(source, "styles.css"), "body{margin:0;color:#456}");
  await assert.rejects(store.pullSource(project.id, project.revision, ["styles.css"], undefined, directoryHashes(comparison)), /inspected comparison/);
  comparison = await store.compareSource(project.id); project = await store.pullSource(project.id, project.revision, ["styles.css"], undefined, directoryHashes(comparison));
  assert.equal(project.id, originalId); assert.equal(project.files.find(file => file.path === "styles.css")!.content, "body{margin:0;color:#456}");
  assert.equal((await compileCodeProject(project)).diagnostics.filter(item => item.level === "error").length, 0);
}));

test("explicit connection to an empty directory pushes additions and deletions without leaking private paths or rewriting unchanged files", async () => workspace(async (directory, store) => {
  const source = join(directory, "connected"); await mkdir(source); let project = await store.create({ name: "Connected source", template: "html" });
  const status = await store.connectSource(project.id, project.revision, source); assert.equal(status.connected, true); assert.deepEqual(await readdir(source), []);
  let comparison = await store.compareSource(project.id); await store.pushSource(project.id, project.revision, comparison.files.map(file => file.path), undefined, directoryHashes(comparison));
  project = await store.update(project.id, project.revision, { files: [{ path: "extra.css", expectedHash: null, content: "body{color:#123}" }] });
  comparison = await store.compareSource(project.id); await store.pushSource(project.id, project.revision, ["extra.css"], undefined, directoryHashes(comparison));
  const extra = project.files.find(file => file.path === "extra.css")!; project = await store.update(project.id, project.revision, { files: [{ path: extra.path, expectedHash: codeFileHash(extra) }] });
  comparison = await store.compareSource(project.id); await store.pushSource(project.id, project.revision, ["extra.css"], undefined, directoryHashes(comparison));
  assert.ok(!(await readdir(source)).includes("extra.css")); assert.ok(!JSON.stringify(await store.get(project.id)).includes(directory));
  const reopened = new CodeProjectStore({ dataDir: store.dataDir }); assert.equal((await reopened.sourceStatus(project.id)).directory, await realpath(source));
}));

test("the ignored display limit cannot hide an unsafe tracked symlink from source synchronization", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Tracked source</h1>");
  for (let index = 0; index < 205; index++) await writeFile(join(source, `a${String(index).padStart(3, "0")}.unsupported`), "Unmanaged file");
  const project = await store.importDirectory({ name: "Large ignore report", directory: source }); const outside = join(directory, "outside.html"); await writeFile(outside, "KEEP OUTSIDE");
  await rm(join(source, "index.html")); await symlink(outside, join(source, "index.html"));
  const comparison = await store.compareSource(project.id); assert.equal(comparison.ignored!.length, 200); assert.ok(!comparison.ignored!.some(item => item.path === "index.html"));
  assert.equal(comparison.files.find(file => file.path === "index.html")!.status, "conflict");
  await assert.rejects(store.pullSource(project.id, project.revision, ["index.html"], undefined, directoryHashes(comparison)), /Unsafe source path/);
  assert.equal((await store.get(project.id)).files[0]!.content, "<h1>Tracked source</h1>"); assert.equal(await readFile(outside, "utf8"), "KEEP OUTSIDE");
}));

test("more than one thousand historical path additions and deletions do not accumulate invalid private baseline tombstones", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Durable project</h1>");
  let project = await store.importDirectory({ name: "Source churn", directory: source });
  for (let cycle = 0; cycle < 4; cycle++) {
    const paths = Array.from({ length: 300 }, (_, index) => `batch-${cycle}-${index}.css`);
    for (const path of paths) await writeFile(join(source, path), "body{margin:0}");
    let comparison = await store.compareSource(project.id); project = await store.pullSource(project.id, project.revision, paths, undefined, directoryHashes(comparison));
    for (const path of paths) await rm(join(source, path));
    comparison = await store.compareSource(project.id); project = await store.pullSource(project.id, project.revision, paths, undefined, directoryHashes(comparison));
    assert.equal((await store.compareSource(project.id)).files.length, 1);
  }
  const reopened = new CodeProjectStore({ dataDir: store.dataDir }); assert.equal((await reopened.get(project.id)).files.length, 1); assert.equal((await reopened.sourceStatus(project.id)).connected, true);
}));

test("two-sided identical edits still require an explicit inspected resolution and do not rewrite a matching disk file", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Before</h1>"); let project = await store.importDirectory({ name: "Explicit agreement", directory: source });
  const file = project.files[0]!; const content = "<h1>Both independently changed</h1>"; project = await store.update(project.id, project.revision, { files: [{ path: file.path, expectedHash: codeFileHash(file), content }] }); await writeFile(join(source, file.path), content);
  const comparison = await store.compareSource(project.id); const state = comparison.files[0]!; assert.equal(state.status, "conflict");
  await assert.rejects(store.pushSource(project.id, project.revision, [file.path], undefined, directoryHashes(comparison)), /conflict/);
  const before = await lstat(join(source, file.path)); await store.pushSource(project.id, project.revision, [file.path], { path: file.path, projectHash: state.projectHash, directoryHash: state.directoryHash });
  assert.equal((await lstat(join(source, file.path))).mtimeMs, before.mtimeMs); assert.equal((await store.compareSource(project.id)).files[0]!.status, "synced");
}));

test("a batch whose intermediate baseline exceeds the budget is rejected before any directory write", async () => workspace(async (directory, store) => {
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "index.html"), "<h1>Entry</h1>"); await writeFile(join(source, "z_remove.css"), "body{color:black}");
  let project = await store.importDirectory({ name: "Intermediate budget", directory: source }); const old = project.files.find(file => file.path === "z_remove.css")!;
  // Seed a valid private baseline representing unresolved files deleted on both
  // sides over earlier sessions; they must remain conflicts until reviewed.
  const filename = join(store.dataDir, `${project.id}.json`); const record = JSON.parse(await readFile(filename, "utf8"));
  for (let index = 0; index < 998; index++) record.sourceLink.baseline[`previous-${index}.css`] = { projectHash: "a".repeat(64), directoryHash: "a".repeat(64) };
  await writeFile(filename, JSON.stringify(record));
  project = await store.update(project.id, project.revision, { files: [{ path: "a_add.css", content: "body{color:green}", expectedHash: null }, { path: old.path, expectedHash: codeFileHash(old) }] });
  const comparison = await store.compareSource(project.id);
  await assert.rejects(store.pushSource(project.id, project.revision, ["a_add.css", old.path], undefined, directoryHashes(comparison)), /journal step would exceed/);
  assert.ok(!(await readdir(source)).includes("a_add.css")); assert.equal(await readFile(join(source, old.path), "utf8"), old.content); assert.equal((await store.get(project.id)).revision, project.revision);
}));
