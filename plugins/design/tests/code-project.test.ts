import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODE_PROJECT_LIMITS, CodeProjectStore, codeFileHash, createCodeTemplate, summarizeCodeFiles, validateCodePath, validateCodeProject } from "../src/code-project.ts";
import type { CodeFile, CodeProjectUpdate } from "../src/code-project.ts";
import { DesignError } from "../src/model.ts";

const hasCode = (code: DesignError["code"]) => (error: unknown): boolean => error instanceof DesignError && error.code === code;
async function workspace(run: (store: CodeProjectStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-code-project-"));
  try { await run(new CodeProjectStore({ dataDir: join(directory, "data") }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("HTML and React templates contain real source, state handlers, components and deterministic file hashes", async () => {
  await workspace(async (store, directory) => {
    for (const template of ["html", "react"] as const) {
      const first = await store.create({ name: "真实源码模板", template });
      assert.deepEqual(validateCodeProject(first), first);
      assert.ok(first.files.some((file) => file.path === first.entry));
      assert.ok(first.designSystem.components.length > 0);
      const scripts = first.files.filter((file) => /\.(?:js|tsx)$/.test(file.path)).map((file) => file.content).join("\n");
      assert.ok(template === "react" ? scripts.includes("useState") : scripts.includes("addEventListener"));
      assert.deepEqual(await new CodeProjectStore({ dataDir: store.dataDir }).get(first.id), first);
      const summaries = summarizeCodeFiles(first);
      assert.equal(summaries.length, first.files.length); assert.match(summaries[0]!.sha256, /^[a-f0-9]{64}$/);
      assert.equal(summaries[0]!.sha256, codeFileHash(first.files[0]!));
    }
    assert.equal((await store.list()).length, 2);
    assert.ok((await readdir(join(directory, "data"))).every((name) => name.endsWith(".json")));
  });
});

test("file hash and project revision checks make an entire source update atomic", async () => {
  await workspace(async (store) => {
    const first = await store.create({ name: "CAS", template: "html" });
    const file = first.files.find((value) => value.path === "app.js")!;
    const updated = await store.update(first.id, 1, { files: [{ path: file.path, content: file.content + "\n// Authored source.", expectedHash: codeFileHash(file) }], name: "源码已保存" });
    assert.equal(updated.revision, 2); assert.equal(updated.name, "源码已保存");
    await assert.rejects(store.update(first.id, 1, { name: "过期覆盖" }), hasCode("REVISION_CONFLICT"));
    await assert.rejects(store.update(first.id, 2, { name: "不能部分保存", files: [{ path: "new.js", content: "export const added = true;", expectedHash: null }, { path: file.path, content: "must not replace", expectedHash: codeFileHash(file) }] }), hasCode("REVISION_CONFLICT"));
    assert.deepEqual(await store.get(first.id), updated);
    await assert.rejects(store.update(first.id, 2, { files: [{ path: file.path, content: "x" }] } as CodeProjectUpdate), hasCode("VALIDATION"));
    await assert.rejects(store.update(first.id, 2, { files: [{ path: "APP.js", content: "x", expectedHash: null }] }), hasCode("VALIDATION"));
    const third = await store.update(first.id, 2, { files: [{ path: "alternate.html", content: "<!doctype html><h1>Alternate</h1>", expectedHash: null }, { path: "index.html", expectedHash: codeFileHash(updated.files.find((item) => item.path === "index.html")!) }], entry: "alternate.html" });
    assert.equal(third.entry, "alternate.html"); assert.ok(!third.files.some((value) => value.path === "index.html"));
  });
});

test("source history survives reopening and restores exact authored files with monotonically new revisions", async () => {
  await workspace(async (store) => {
    const first = await store.create({ name: "A", template: "react" });
    const source = first.files.find((file) => file.path === "src/App.tsx")!;
    const second = await store.update(first.id, 1, { files: [{ path: source.path, content: source.content.replace("Good work.", "A new direction."), expectedHash: codeFileHash(source) }] });
    assert.notEqual(codeFileHash(second.files.find((file) => file.path === source.path)!), codeFileHash(source));
    assert.deepEqual((await store.undo(first.id, 2)).files, first.files);
    const reopened = new CodeProjectStore({ dataDir: store.dataDir });
    assert.deepEqual((await reopened.redo(first.id, 3)).files, second.files);
    const restored = await reopened.restore(first.id, 4, 1);
    assert.equal(restored.revision, 5); assert.deepEqual(restored.files, first.files);
    assert.equal((await reopened.history(first.id)).at(-1)?.restoredFrom, 1);
  });
});

test("two actual worker processes cannot overwrite each other's source changes", async () => {
  await workspace(async (store) => {
    const first = await store.create({ name: "Workers", template: "html" }); const source = first.files[0]!;
    const url = new URL("../src/code-project.ts", import.meta.url).href;
    const script = `const {CodeProjectStore}=await import(${JSON.stringify(url)});const store=new CodeProjectStore({dataDir:process.argv[1]});try{await store.update(process.argv[2],1,{files:[{path:process.argv[3],content:'<!doctype html><h1>'+process.argv[5]+'</h1>',expectedHash:process.argv[4]}]});process.stdout.write('saved')}catch(error){process.stdout.write(error.code)}`;
    const worker = (name: string) => new Promise<string>((resolve, reject) => { const processChild = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, store.dataDir, first.id, source.path, codeFileHash(source), name], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; processChild.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); }); processChild.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); }); processChild.on("error", reject); processChild.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr))); });
    assert.deepEqual((await Promise.all([worker("Left"), worker("Right")])).sort(), ["REVISION_CONFLICT", "saved"]);
    assert.equal((await store.get(first.id)).revision, 2);
  });
});

test("read-only directory import ignores reserved trees and symlinks without executing source", async () => {
  await workspace(async (store, directory) => {
    const source = join(directory, "source"); await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "node_modules")); await mkdir(join(source, ".codex"));
    await writeFile(join(source, "index.html"), '<!doctype html><script type="module" src="src/never.js"></script>');
    await writeFile(join(source, "src", "never.js"), "throw new Error('This source must not execute during import');");
    await writeFile(join(source, "node_modules", "ignored.js"), "private module"); await writeFile(join(source, ".codex", "auth.json"), '{"doNotRead":true}'); await writeFile(join(source, ".env"), "SECRET=not-source");
    const outside = join(directory, "outside.js"); await writeFile(outside, "outside content"); await symlink(outside, join(source, "leak.js")); await symlink(join(source, "src"), join(source, "linked"), "dir");
    const project = await store.importDirectory({ name: "只读导入", directory: source });
    assert.deepEqual(project.files.map((file) => file.path), ["index.html", "src/never.js"]);
    assert.equal(project.revision, 1); assert.equal(project.entry, "index.html");
    assert.equal(await readFile(join(source, "src", "never.js"), "utf8"), project.files[1]!.content);
    assert.equal((await store.history(project.id))[0]!.operation, "import");
    await symlink(source, join(directory, "linked-root"), "dir");
    await assert.rejects(store.importDirectory({ name: "No links", directory: join(directory, "linked-root") }), hasCode("VALIDATION"));
  });
});

test("path, text, metadata, binary and count budgets are enforced while browser source remains unrestricted", () => {
  for (const path of ["../outside.js", "/tmp/a.js", "a\\b.js", "a/../b.js", "node_modules/a.js", ".git/config.json", ".codex/auth.json", ".agents/skills/a.js", "x/%2fetc.js", "x//a.js", "program.exe", "CON.js", "x/NUL.html", "x/a*.js"]) assert.throws(() => validateCodePath(path), hasCode("VALIDATION"));
  const document = createCodeTemplate("Boundary", "html");
  const scripts = document.files.find((file) => file.path === "app.js")!; scripts.content = "window.example = () => import('./uninstalled.js'); fetch('/explicit-runtime-action');";
  assert.doesNotThrow(() => validateCodeProject(document));
  scripts.content = "x".repeat(CODE_PROJECT_LIMITS.textBytes + 1); assert.throws(() => validateCodeProject(document), hasCode("VALIDATION"));
  const base64Source: CodeFile = { path: "source.js", encoding: "base64", content: Buffer.from("alert(1)").toString("base64") };
  assert.throws(() => codeFileHash(base64Source), hasCode("VALIDATION"));
  const assets = createCodeTemplate("Assets", "html"); assets.files.push({ path: "assets/pixel.png", encoding: "base64", content: "iVBORw0KGgo=" }); assert.doesNotThrow(() => validateCodeProject(assets));
  assets.files.at(-1)!.content = "bad!"; assert.throws(() => validateCodeProject(assets), hasCode("VALIDATION"));
  assets.files.at(-1)!.content = Buffer.from("MZ executable disguised as image").toString("base64"); assert.throws(() => validateCodeProject(assets), hasCode("VALIDATION"));
  const tooMany = createCodeTemplate("Files", "html"); for (let index = 0; index < 500; index++) tooMany.files.push({ path: `extra/${index}.js`, content: "", encoding: "utf8" }); assert.throws(() => validateCodeProject(tooMany), hasCode("VALIDATION"));
});

test("directory export preserves external edits and rejects symlink targets and manifests", async () => {
  await workspace(async (store, directory) => {
    const first = await store.create({ name: "Export", template: "react" }); const target = join(directory, "export");
    const result = await store.exportDirectory(first.id, target, { expectedRevision: 1 }); assert.equal(result.revision, 1); assert.equal(result.files.length, first.files.length);
    const external = "// External work must remain untouched.\n";
    await writeFile(join(target, "src", "App.tsx"), external);
    await assert.rejects(store.exportDirectory(first.id, target, { expectedRevision: 1 }), hasCode("REVISION_CONFLICT"));
    assert.equal(await readFile(join(target, "src", "App.tsx"), "utf8"), external);
    await writeFile(join(target, "src", "App.tsx"), first.files.find((file) => file.path === "src/App.tsx")!.content);
    const source = first.files.find((file) => file.path === "src/main.tsx")!;
    const second = await store.update(first.id, 1, { files: [{ path: source.path, content: source.content + "\n// Updated entry.", expectedHash: codeFileHash(source) }] });
    await store.exportDirectory(first.id, target, { expectedRevision: 2 });
    assert.equal(await readFile(join(target, source.path), "utf8"), second.files.find((file) => file.path === source.path)!.content);
    const outside = join(directory, "outside.json"); await writeFile(outside, "CANARY-not-a-manifest"); await rm(join(target, ".design-code-export.json")); await symlink(outside, join(target, ".design-code-export.json"));
    await assert.rejects(store.exportDirectory(first.id, target, { expectedRevision: 2 }), (error: unknown) => error instanceof DesignError && error.code === "VALIDATION" && !error.message.includes("CANARY"));
    const target2 = join(directory, "symlink-export"); await mkdir(target2); await symlink(outside, join(target2, "index.html"));
    await assert.rejects(store.exportDirectory(first.id, target2, { expectedRevision: 2 }), hasCode("VALIDATION"));
    assert.equal(await readFile(outside, "utf8"), "CANARY-not-a-manifest");
  });
});
