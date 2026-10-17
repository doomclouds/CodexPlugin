import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodeProjectStore, codeFileHash, createCodeTemplate, summarizeCodeFiles } from "../src/code-project.ts";
import type { CodeProject } from "../src/code-project.ts";
import { exportCodeProject } from "../src/code-export.ts";

async function workspace(run: (store: CodeProjectStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "design-archive-store-"));
  try { await run(new CodeProjectStore({ dataDir: join(directory, "private") }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function sourceProject(store: CodeProjectStore) {
  let project = await store.create({ name: "原始中文 React 工程", template: "react" });
  project = await store.update(project.id, project.revision, {
    files: [
      { path: "src/Read.tsx", content: "export default function Read(){return <h1 data-design-id=\"reading-title\">独立阅读页</h1>}", expectedHash: null },
      { path: "assets/sample.png", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+B+ioAAAAASUVORK5CYII=", encoding: "base64", expectedHash: null },
      { path: "docs/notice.txt", content: "微型 PNG 用于字节往返测试，不作为视觉质量验收。\n", expectedHash: null }
    ],
    pages: [...project.pages, { id: "page_read", name: "阅读页", entry: "src/Read.tsx", route: "/read" }],
    defaultPageId: "page_read",
    viewports: [...project.viewports, { id: "read_phone", name: "阅读页手机", width: 360, height: 780, pageId: "page_read" }],
    designSystem: { components: [{ name: "Reading", path: "src/Read.tsx", exportName: "default", usage: "<Reading/>" }], notes: "保留真正源码、组件登记和用户说明。" },
    comments: [{ id: "comment_read", file: "src/Read.tsx", sourceId: "source_existing_marker", text: "保留此原始评论，不猜改锚点。", status: "open", createdAt: project.createdAt }]
  });
  return project;
}
async function withProtocol(store: CodeProjectStore, run: (client: Client) => Promise<void>) {
  const { createDesignServer } = await import("../src/server.ts");
  const instance = await createDesignServer({ codeStore: store, panelHtml: "<!doctype html><div>Archive protocol test</div>" });
  const client = new Client({ name: "project-archive-store-test", version: "1" }); const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide); await client.connect(clientSide);
  try { await run(client); } finally { await client.close(); await instance.dispose(); }
}
function preserved(project: CodeProject) {
  const { id, name, revision, createdAt, updatedAt, ...source } = project; return source;
}

test("importProject preserves current source metadata as a new revision-one project without a private connection or original history", async () => workspace(async (store, directory) => {
  const source = await sourceProject(store), input = structuredClone(source), inputBefore = JSON.stringify(input);
  const external = join(directory, "connected"); await mkdir(external);
  for (const file of source.files) { const path = join(external, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(file.content, file.encoding)); }
  await store.connectSource(source.id, source.revision, external);
  const originalRecord = await readFile(join(store.dataDir, source.id + ".json"), "utf8"); assert.ok(JSON.parse(originalRecord).sourceLink);
  const started = Date.now(), imported = await store.importProject(input, "独立导入副本"), ended = Date.now();
  assert.notEqual(imported.id, source.id); assert.equal(imported.name, "独立导入副本"); assert.equal(imported.revision, 1);
  assert.equal(imported.createdAt, imported.updatedAt); assert.ok(Date.parse(imported.createdAt) >= started && Date.parse(imported.createdAt) <= ended);
  assert.deepEqual(preserved(imported), preserved(source)); assert.deepEqual(summarizeCodeFiles(imported), summarizeCodeFiles(source));
  assert.equal(JSON.stringify(input), inputBefore); assert.equal(await readFile(join(store.dataDir, source.id + ".json"), "utf8"), originalRecord);
  assert.equal((await store.sourceStatus(imported.id)).connected, false);
  const record = JSON.parse(await readFile(join(store.dataDir, imported.id + ".json"), "utf8"));
  assert.equal(Object.hasOwn(record, "sourceLink"), false); assert.equal(record.snapshots.length, 1); assert.deepEqual(record.undo, []); assert.deepEqual(record.redo, []);
  assert.deepEqual(await store.history(imported.id), { revision: 1, versions: [{ revision: 1, createdAt: imported.createdAt, operation: "import" }], canUndo: false, canRedo: false });
  imported.files[0]!.content = "caller mutation"; assert.deepEqual(preserved(await store.get(imported.id)), preserved(source));
}));

test("an unregistered valid project imports independently and its first later edit can undo to the imported source", async () => workspace(async store => {
  const source = createCodeTemplate("Archived source name", "html"); source.revision = 45; source.createdAt = source.updatedAt = "2024-01-01T00:00:00.000Z";
  const imported = await store.importProject(source); assert.equal(imported.name, source.name); assert.notEqual(imported.createdAt, source.createdAt);
  await assert.rejects(store.undo(imported.id, 1), /No source change/);
  const updated = await store.update(imported.id, 1, { name: "A later real edit" }); assert.equal(updated.revision, 2);
  const undone = await store.undo(imported.id, 2); assert.equal(undone.name, source.name); assert.deepEqual(preserved(undone), preserved(source));
  assert.equal((await store.list()).projects.length, 1);
}));

test("importProject rejects private fields, unsupported formats and invalid references before creating any project", async () => workspace(async store => {
  const source = createCodeTemplate("Untrusted archive metadata", "html");
  const invalid = [
    { ...source, sourceLink: { directory: "PRIVATE_PATH_SENTINEL", baseline: {} } },
    { ...source, history: [] }, { current: source, version: 1 }, { ...source, schemaVersion: 1 },
    { ...source, defaultPageId: "missing_page" },
    { ...source, pages: source.pages.map(page => ({ ...page, entry: "missing.html" })) },
    { ...source, comments: [{ id: "missing_comment", file: "missing.txt", text: "Invalid source", status: "open", createdAt: source.createdAt }] },
    { ...source, viewports: [{ id: "wrong_page", name: "Wrong", width: 360, height: 780, pageId: "missing_page" }] },
    { ...source, designSystem: { ...source.designSystem, components: [{ name: "Missing", path: "missing.tsx" }] } }
  ];
  for (const value of invalid) await assert.rejects(store.importProject(value));
  await assert.rejects(store.importProject(source, "   "));
  assert.deepEqual((await store.list()).projects, []);
}));

test("archive input reads exact canonical bytes from a selected regular file or base64", async () => workspace(async (_store, directory) => {
  const { readCodeProjectArchiveInput } = await import("../src/project-archive-input.ts");
  const bytes = Buffer.from("actual input bytes; ZIP structure belongs to the archive parser"), file = join(directory, "selected.zip"); await writeFile(file, bytes);
  assert.deepEqual(Buffer.from(await readCodeProjectArchiveInput({ file })), bytes);
  assert.deepEqual(Buffer.from(await readCodeProjectArchiveInput({ dataBase64: bytes.toString("base64") })), bytes);
}));

test("archive input rejects ambiguous, noncanonical, oversized and linked inputs without following or allocating unbounded data", async () => workspace(async (_store, directory) => {
  const { readCodeProjectArchiveInput } = await import("../src/project-archive-input.ts"), { MAX_CODE_PROJECT_ARCHIVE_BYTES } = await import("../src/project-archive.ts");
  const file = join(directory, "selected.zip"), link = join(directory, "linked.zip"), large = join(directory, "too-large.zip"); await writeFile(file, "actual file"); await symlink(file, link); await writeFile(large, ""); await truncate(large, MAX_CODE_PROJECT_ARCHIVE_BYTES + 1);
  for (const input of [{}, { file, dataBase64: "YQ==" }, { file: "relative.zip" }, { file: directory }, { file: link }, { file: large }, { file: file + "\0" }]) await assert.rejects(readCodeProjectArchiveInput(input));
  for (const dataBase64 of ["", "YQ", "YQ==\n", "YQ__", "AB==", "data:application/zip;base64,YQ==", "A".repeat(Math.ceil(MAX_CODE_PROJECT_ARCHIVE_BYTES / 3) * 4 + 4)]) await assert.rejects(readCodeProjectArchiveInput({ dataBase64 }));
  assert.equal(await readFile(file, "utf8"), "actual file");
}));

test("archive input detects an actual same-length file change after reading from its opened handle", async context => workspace(async (_store, directory) => {
  const { readCodeProjectArchiveInput } = await import("../src/project-archive-input.ts");
  const file = join(directory, "changing.zip"); await writeFile(file, "first archive bytes");
  const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe), read = prototype.read; await probe.close();
  let changed = false;
  context.mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
    const result = await Reflect.apply(read, this, args) as { bytesRead: number };
    if (!changed && result.bytesRead > 0) { changed = true; await writeFile(file, "other archive bytes"); }
    return result;
  });
  await assert.rejects(readCodeProjectArchiveInput({ file }), /changed while being read/); assert.equal(changed, true);
  assert.equal(await readFile(file, "utf8"), "other archive bytes");
}));

test("the real MCP archive importer preserves exported source and verifies the original archive identity for bytes and local paths", async () => workspace(async (store, directory) => {
  const source = await sourceProject(store), sourceDirectory = join(directory, "private-connected-source"); await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "index.html"), source.files.find(file => file.path === "index.html")!.content);
  await store.connectSource(source.id, source.revision, sourceDirectory);
  const before = await readFile(join(store.dataDir, source.id + ".json"), "utf8"); assert.ok(JSON.parse(before).sourceLink);
  const exported = await exportCodeProject(source, "zip"), bytes = Buffer.from(exported.dataBase64, "base64"), sha = createHash("sha256").update(bytes).digest("hex");
  const file = join(directory, "actual-project.zip"); await writeFile(file, bytes);
  await withProtocol(store, async client => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === "design_code_import_project"); assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.oneOf, [{ required: ["file"] }, { required: ["dataBase64"] }]);
    assert.equal((tool.inputSchema.properties?.expectedSha256 as { pattern: string }).pattern, "^[a-fA-F0-9]{64}$");
    const imported: CodeProject[] = [];
    for (const input of [{ dataBase64: exported.dataBase64, name: "ZIP 字节副本", expectedSha256: sha.toUpperCase() }, { file, expectedSha256: sha }]) {
      const response = await client.callTool({ name: "design_code_import_project", arguments: input }); assert.notEqual(response.isError, true, JSON.stringify(response));
      const result = response.structuredContent as { project: CodeProject; files: ReturnType<typeof summarizeCodeFiles>; importedFrom: { projectId: string; revision: number }; archiveSha256: string };
      assert.equal(result.archiveSha256, sha); assert.deepEqual(result.importedFrom, { projectId: source.id, revision: source.revision });
      assert.equal(result.project.revision, 1); assert.notEqual(result.project.id, source.id); assert.deepEqual(preserved(result.project), preserved(source));
      assert.deepEqual(result.files, summarizeCodeFiles(source)); assert.equal((await store.sourceStatus(result.project.id)).connected, false);
      const serialized = JSON.stringify(response); assert.equal(serialized.includes(sourceDirectory), false); assert.equal(serialized.includes(file), false); assert.doesNotMatch(serialized, /sourceLink|baseline|snapshots/);
      assert.equal((await store.history(result.project.id)).versions[0]!.operation, "import"); imported.push(result.project);
    }
    assert.notEqual(imported[0]!.id, imported[1]!.id); assert.equal(imported[0]!.name, "ZIP 字节副本"); assert.equal(imported[1]!.name, source.name);
  });
  assert.equal(await readFile(join(store.dataDir, source.id + ".json"), "utf8"), before);
}));

test("MCP rejects invalid archive requests and a mismatched expected checksum without creating a copy or modifying the source", async () => workspace(async (store, directory) => {
  const source = await sourceProject(store), before = await readFile(join(store.dataDir, source.id + ".json"), "utf8"), exported = await exportCodeProject(source, "zip");
  const file = join(directory, "actual-project.zip"); await writeFile(file, Buffer.from(exported.dataBase64, "base64"));
  await withProtocol(store, async client => {
    for (const input of [{}, { file, dataBase64: exported.dataBase64 }, { dataBase64: exported.dataBase64, expectedSha256: "0".repeat(64) }, { dataBase64: exported.dataBase64, expectedSha256: "not-a-sha256" }, { dataBase64: exported.dataBase64, name: "  " }, { dataBase64: "YQ==\n" }, { dataBase64: exported.dataBase64, projectId: source.id }]) {
      const response = await client.callTool({ name: "design_code_import_project", arguments: input }); assert.equal(response.isError, true, "Invalid import must not succeed");
      if (!Object.keys(input).length || "file" in input && "dataBase64" in input) assert.match(JSON.stringify(response), /exactly one/);
      assert.equal((await store.list()).projects.length, 1);
    }
  });
  assert.equal(await readFile(join(store.dataDir, source.id + ".json"), "utf8"), before);
}));
