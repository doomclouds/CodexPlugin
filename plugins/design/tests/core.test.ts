import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESIGN_LIMITS, DesignError, validateDocument } from "../src/model.ts";
import type { DesignNode } from "../src/model.ts";
import { applyPatches, findNode } from "../src/operations.ts";
import { DesignStore } from "../src/store.ts";
import { createTemplate, TEMPLATE_NAMES } from "../src/templates.ts";

async function withStore(run: (store: DesignStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-design-core-"));
  try { await run(new DesignStore({ dataDir: directory }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const rectangle = (id = "node_rectangle"): DesignNode => ({ id, name: "矩形", type: "rectangle", x: 0, y: 0, width: 100, height: 100, style: { fill: "$color.primary" }, children: [] });
const codeIs = (code: DesignError["code"]) => (error: unknown): boolean => error instanceof DesignError && error.code === code;

test("all templates are real valid documents with reusable components and independent IDs", () => {
  for (const name of TEMPLATE_NAMES) {
    const document = createTemplate("设计工程", name);
    assert.deepEqual(validateDocument(document), document);
    assert.ok(document.artboards.length >= 1);
    assert.ok(document.designSystem.components.length > 0);
    assert.ok(Object.keys(document.designSystem.tokens).length > 0);
  }
  assert.notEqual(createTemplate("A").id, createTemplate("A").id);
});

test("storage location is explicit and never resolves a relative directory from the host working directory", () => {
  assert.throws(() => new DesignStore({ dataDir: "relative-projects" }), codeIs("VALIDATION"));
  assert.ok(new DesignStore({ dataDir: join(tmpdir(), "design-absolute") }).dataDir.startsWith(tmpdir()));
});

test("store persists atomic revisions and rejects stale revisions without changing disk", async () => {
  await withStore(async (store, directory) => {
    const first = await store.create({ name: "初始设计", template: "blank" });
    const second = await store.apply(first.id, 1, [{ op: "replace", path: "/name", value: "修改设计" }, { op: "add", path: "/artboards/0/nodes/-", value: rectangle() }]);
    assert.equal(second.revision, 2);
    assert.equal(second.artboards[0]?.nodes.length, 1);
    const reopened = new DesignStore({ dataDir: directory });
    assert.deepEqual(await reopened.get(first.id), second);
    const stored = await readFile(join(directory, `${first.id}.json`), "utf8");
    await assert.rejects(store.apply(first.id, 1, [{ op: "replace", path: "/name", value: "过期覆盖" }]), codeIs("REVISION_CONFLICT"));
    await assert.rejects(store.apply(first.id, 2, [{ op: "replace", path: "/name", value: "必须回滚" }, { op: "replace", path: "/artboards/0/width", value: -1 }]), codeIs("VALIDATION"));
    assert.equal(await readFile(join(directory, `${first.id}.json`), "utf8"), stored);
    assert.equal((await store.list())[0]?.name, "修改设计");
  });
});

test("undo, redo and restore survive process restart and create monotonic revisions", async () => {
  await withStore(async (store, directory) => {
    const first = await store.create({ name: "A" });
    await store.apply(first.id, 1, [{ op: "replace", path: "/name", value: "B" }]);
    const third = await store.undo(first.id, 2);
    assert.equal(third.name, "A"); assert.equal(third.revision, 3);
    const reopened = new DesignStore({ dataDir: directory });
    const fourth = await reopened.redo(first.id, 3);
    assert.equal(fourth.name, "B"); assert.equal(fourth.revision, 4);
    const restored = await reopened.restore(first.id, 4, 1);
    assert.equal(restored.name, "A"); assert.equal(restored.revision, 5);
    assert.equal((await reopened.history(first.id)).at(-1)?.restoredFrom, 1);
    await assert.rejects(reopened.redo(first.id, 5), codeIs("VALIDATION"));
    assert.equal((await reopened.get(first.id)).revision, 5);
  });
});

test("independent processes serialize updates and exactly one stale writer is rejected", async () => {
  await withStore(async (store, directory) => {
    const first = await store.create({ name: "Concurrent" });
    const storeUrl = new URL("../src/store.ts", import.meta.url).href;
    const script = `const { DesignStore } = await import(${JSON.stringify(storeUrl)}); const s = new DesignStore({dataDir:process.argv[1]}); try { const d = await s.apply(process.argv[2],1,[{op:'replace',path:'/name',value:process.argv[3]}]); process.stdout.write('ok:'+d.revision); } catch (e) { process.stdout.write(e.code); }`;
    const worker = (name: string): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, directory, first.id, name], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
    assert.deepEqual((await Promise.all([worker("Left"), worker("Right")])).sort(), ["REVISION_CONFLICT", "ok:2"]);
    assert.equal((await store.get(first.id)).revision, 2);
  });
});

test("JSON pointers support escaping and insertion while rejecting metadata and prototype writes", () => {
  const document = createTemplate("安全设计");
  const withToken = applyPatches(document, [{ op: "add", path: "/designSystem/tokens/color.secondary", value: "#ff00ff" }, { op: "add", path: "/artboards/0/nodes/0", value: rectangle() }]);
  assert.equal(findNode(withToken, "node_rectangle")?.path, "/artboards/0/nodes/0");
  for (const path of ["/id", "/revision", "/createdAt", "/updatedAt", "/schemaVersion", "/artboards/0/id", "/__proto__/polluted", "/artboards/00/name", "/artboards/0/nodes/~2"]) assert.throws(() => applyPatches(document, [{ op: "replace", path, value: "bad" }]), codeIs("VALIDATION"));
  const replacement = structuredClone(withToken.artboards[0]);
  assert.ok(replacement); replacement.id = "different_board";
  assert.throws(() => applyPatches(withToken, [{ op: "replace", path: "/artboards/0", value: replacement }]), codeIs("VALIDATION"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("explicit array replacements can reorder and group nodes without changing identified object IDs", () => {
  const document = createTemplate("重排与组合");
  const first = rectangle("node_first"), second = rectangle("node_second");
  document.artboards[0]!.nodes = [first, second];
  const reordered = applyPatches(document, [{ op: "replace", path: "/artboards/0/nodes", value: [second, first] }]);
  assert.deepEqual(reordered.artboards[0]!.nodes.map((node) => node.id), ["node_second", "node_first"]);
  const group = { ...rectangle("node_group"), type: "frame" as const, children: [first, second] };
  const grouped = applyPatches(document, [{ op: "replace", path: "/artboards/0/nodes", value: [group] }]);
  assert.equal(grouped.artboards[0]!.nodes[0]!.children[1]!.id, "node_second");
  assert.throws(() => applyPatches(document, [{ op: "replace", path: "/artboards/0/nodes/0", value: { ...first, id: "node_other" } }]), codeIs("VALIDATION"));
  assert.throws(() => applyPatches(document, [{ op: "replace", path: "/artboards/0/nodes", value: [first, first] }]), codeIs("VALIDATION"));
});

test("document validation rejects unsafe properties, nonfinite values, missing references and ID collisions", () => {
  const document = createTemplate("安全设计");
  const duplicate = structuredClone(document); duplicate.artboards.push(structuredClone(duplicate.artboards[0]!));
  assert.throws(() => validateDocument(duplicate), codeIs("VALIDATION"));
  const infinite = structuredClone(document); infinite.artboards[0]!.width = Infinity;
  assert.throws(() => validateDocument(infinite), codeIs("VALIDATION"));
  const missing = structuredClone(document); missing.artboards[0]!.nodes.push({ ...rectangle(), assetId: "missing_asset" });
  assert.throws(() => validateDocument(missing), codeIs("VALIDATION"));
  const token = structuredClone(document); token.artboards[0]!.background = "$color.missing";
  assert.throws(() => validateDocument(token), codeIs("VALIDATION"));
  const malicious = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  Object.defineProperty(malicious, "__proto__", { value: { polluted: true }, enumerable: true });
  assert.throws(() => validateDocument(malicious), codeIs("VALIDATION"));
  const accessor = { ...document }; Object.defineProperty(accessor, "name", { get() { throw new Error("must not execute"); }, enumerable: true });
  assert.throws(() => validateDocument(accessor), codeIs("VALIDATION"));
});

test("components and tokens cannot form direct or indirect cycles", () => {
  const document = createTemplate("组件系统");
  const component = document.designSystem.components[0]!;
  component.node = { ...rectangle("node_component_cycle"), type: "component", componentId: component.id };
  assert.throws(() => validateDocument(document), codeIs("VALIDATION"));
  const indirect = createTemplate("间接循环");
  const first = indirect.designSystem.components[0]!;
  first.node.children.push({ ...rectangle("node_ref_b"), type: "component", componentId: "component_b" });
  indirect.designSystem.components.push({ id: "component_b", name: "B", node: { ...rectangle("node_ref_a"), type: "component", componentId: first.id } });
  assert.throws(() => validateDocument(indirect), codeIs("VALIDATION"));
  const tokens = createTemplate("变量循环"); tokens.designSystem.tokens["color.primary"] = "$color.secondary"; tokens.designSystem.tokens["color.secondary"] = "$color.primary";
  assert.throws(() => validateDocument(tokens), codeIs("VALIDATION"));
});

test("assets are bounded raster data with verified signatures and interactions reject script URLs", () => {
  const document = createTemplate("资源验证");
  document.assets.push({ id: "asset_png", name: "pixel.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" });
  assert.equal(validateDocument(document).assets.length, 1);
  document.assets[0]!.mimeType = "image/jpeg";
  assert.throws(() => validateDocument(document), codeIs("VALIDATION"));
  const unsafe = createTemplate("恶意交互"); unsafe.artboards[0]!.nodes.push({ ...rectangle(), interaction: { action: "url", target: "javascript:alert(1)" } });
  assert.throws(() => validateDocument(unsafe), codeIs("VALIDATION"));
  const style = createTemplate("恶意样式"); style.artboards[0]!.nodes.push({ ...rectangle(), style: { fill: "url(https://example.com/pixel)" } });
  assert.throws(() => validateDocument(style), codeIs("VALIDATION"));
  const nested = createTemplate("嵌套预算"); let current = rectangle("node_root"); nested.artboards[0]!.nodes.push(current);
  for (let index = 0; index <= DESIGN_LIMITS.depth; index++) { const next = rectangle(`node_depth_${index}`); current.children.push(next); current = next; }
  assert.throws(() => validateDocument(nested), codeIs("VALIDATION"));
});
