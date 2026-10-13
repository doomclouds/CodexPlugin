import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { checkPluginPortability, formatPortabilityIssue } from "../check-plugin-portability.mjs";

async function fixture(t) {
  const outer = await mkdtemp(path.join(tmpdir(), "plugin-portability-"));
  const root = path.join(outer, "plugin");
  const options = { authorHome: path.join(outer, "synthetic-home"), authorCwd: path.join(outer, "synthetic-repo"), temporaryDirectory: path.join(outer, "synthetic-temp") };
  const put = async (name, content) => { const filename = path.join(root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, content); };
  await put("package.json", JSON.stringify({ name: "portable-fixture", type: "module", dependencies: { "declared-package": "1.0.0" } }));
  t.after(() => rm(outer, { recursive: true, force: true }));
  return { root, outer, options, put, check: () => checkPluginPortability(root, options) };
}

test("contained references remain portable when the entire plugin moves outside its original repository", async t => {
  const { root, outer, options, put, check } = await fixture(t);
  await put("skills/demo/SKILL.md", '[Runtime](<references/runtime notes.md> "Guide")\n![Asset][icon]\n[icon]: assets/icon.svg\n');
  await put("skills/demo/references/runtime notes.md", "[Helper](../scripts/helper.js)\n");
  await put("skills/demo/scripts/helper.js", "export const value = 1;\n");
  await put("skills/demo/assets/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put("README.md", '[Runtime](skills/demo/references/runtime%20notes.md)\n<img src="skills/demo/assets/icon.svg">\n');
  await put("src/index.ts", 'import { value } from "./helper.js"; export { value };\n');
  await put("src/helper.ts", "export const value = 1;\n");
  await put("tsconfig.json", JSON.stringify({ extends: "./config/base.json" }));
  await put("config/base.json", JSON.stringify({ extends: "./shared.json" }));
  await put("config/shared.json", "{}\n");
  assert.deepEqual((await check()).issues, []);
  const moved = path.join(outer, "unrelated", "moved-plugin");
  await mkdir(path.dirname(moved));
  await cp(root, moved, { recursive: true });
  await rm(root, { recursive: true });
  assert.deepEqual((await checkPluginPortability(moved, options)).issues, []);
});

test("inline, reference, autolink, and HTML file targets must exist", async t => {
  const { put, check } = await fixture(t);
  await put("skills/demo/SKILL.md", '[Inline](references/missing.md)\n[Reference][missing]\n[missing]: references/missing-ref.md\n<file:///missing/file.md>\n<img src="assets/missing.svg">\n[Unresolved][not-defined]\n');
  const result = await check();
  assert.ok(result.issues.filter(issue => issue.code === "missing-file-reference").length >= 3);
  assert.ok(result.issues.some(issue => issue.code === "absolute-file-reference"));
  assert.ok(result.issues.some(issue => issue.code === "undefined-markdown-reference"));
});

test("recursive Markdown references cannot escape the current skill even into the same plugin", async t => {
  const { put, check } = await fixture(t);
  await put("skills/one/SKILL.md", "[Runtime](references/runtime.md)\n");
  await put("skills/one/references/runtime.md", "[Outside][outside]\n[outside]: ../../two/SKILL.md\n");
  await put("skills/two/SKILL.md", "Another skill\n");
  const result = await check();
  assert.ok(result.issues.some(issue => issue.file === "skills/one/references/runtime.md" && issue.code === "file-reference-escapes-skill"));
});

test("plugin README cannot reference parent engineering files", async t => {
  const { outer, put, check } = await fixture(t);
  await writeFile(path.join(outer, "engineering.md"), "Private engineering fixture\n");
  await put("README.md", "[Design](../engineering.md)\n");
  assert.ok((await check()).issues.some(issue => issue.code === "file-reference-escapes-plugin"));
});

test("a symlink cannot make an outside file a contained skill asset", async t => {
  const { root, outer, put, check } = await fixture(t);
  await writeFile(path.join(outer, "outside.md"), "Outside\n");
  await put("skills/demo/SKILL.md", "[Linked](references/linked.md)\n");
  await mkdir(path.join(root, "skills/demo/references"));
  await symlink(path.join(outer, "outside.md"), path.join(root, "skills/demo/references/linked.md"));
  const result = await check();
  assert.ok(result.issues.some(issue => issue.code === "symbolic-link-escapes-plugin"));
  assert.ok(result.issues.some(issue => issue.code === "file-reference-escapes-skill"));
});

test("relative JSON inheritance is checked recursively and cannot escape the plugin", async t => {
  const { outer, put, check } = await fixture(t);
  await writeFile(path.join(outer, "outside.json"), "{}\n");
  await put("tsconfig.json", JSON.stringify({ extends: "./config/base.json" }));
  await put("config/base.json", JSON.stringify({ extends: "../../outside.json" }));
  assert.ok((await check()).issues.some(issue => issue.file === "config/base.json" && issue.code === "file-reference-escapes-plugin"));
  await put("config/base.json", JSON.stringify({ extends: ["./missing.json"] }));
  assert.ok((await check()).issues.some(issue => issue.code === "missing-file-reference"));
});

test("synthetic personal directories and escaped source-map values are rejected without exposing content", async t => {
  const { put, check } = await fixture(t);
  const name = "fixture-" + randomBytes(8).toString("hex");
  await put("src/local.js", `export const location = ${JSON.stringify("/Users/" + name + "/secret-project")};\n`);
  await put("runtime/code.map", JSON.stringify({ version: 3, sources: ["C:\\Users\\" + name + "\\source.ts"], sourcesContent: [] }));
  const result = await check();
  assert.ok(result.issues.some(issue => /personal-home-path/.test(issue.code)));
  assert.ok(result.issues.some(issue => /windows-home-path/.test(issue.code)));
  assert.equal(result.issues.map(formatPortabilityIssue).join("\n").includes(name), false);
  await put("src/local.js", `export const location = "\\x2fhome\\x2f${name}\\x2fproject";\n`);
  assert.ok((await check()).issues.some(issue => issue.code === "quoted-personal-home-path"));
});

test("HTTP URLs containing filesystem-looking segments and dynamic standard directories are allowed", async t => {
  const { options, put, check } = await fixture(t);
  const remote = "https://example.test/Users/fictional/project";
  await put("README.md", `[Remote](${remote})\n<https://example.test/home/fictional/docs>\n`);
  await put("src/portable.js", `import { homedir, tmpdir } from "node:os"; export const roots = [homedir(), tmpdir(), process.cwd(), "${remote}", "https://example.test${options.authorHome}"];\n`);
  await put("mcp.json", JSON.stringify({ args: ["${PLUGIN_ROOT}/runtime/index.js"] }));
  assert.deepEqual((await check()).issues, []);
});

test("literal imports and URL assets are checked, while quoted code-generation text is not an import", async t => {
  const { outer, put, check } = await fixture(t);
  await writeFile(path.join(outer, "outside.js"), "export default 1;\n");
  await put("src/index.js", 'import value from "../../outside.js"; export default value;\n');
  assert.ok((await check()).issues.some(issue => issue.code === "file-reference-escapes-plugin"));
  await put("src/index.js", 'const note = "\'import\' and \'export\' are words"; const code = `require("not-a-real-dependency").${note}`; const fixture = new URL("fixture.txt", import.meta.url); export { code, fixture };\n');
  await put("src/fixture.txt", "Asset fixture\n");
  assert.deepEqual((await check()).issues, []);
  await put("src/index.js", 'const run = () => require("../../outside.js"); export { run };\n');
  assert.ok((await check()).issues.some(issue => issue.code === "file-reference-escapes-plugin"));
});

test("global skill dependencies are rejected, including symbolic environment paths", async t => {
  const { put, check } = await fixture(t);
  await put("skills/demo/SKILL.md", "Read `$CODEX_HOME/skills/another/SKILL.md` and [External](skill://other/guide).\n");
  const result = await check();
  assert.ok(result.issues.some(issue => issue.code === "global-skill-directory-reference"));
  assert.ok(result.issues.some(issue => issue.code === "external-skill-reference"));
});

test("Emscripten virtual HOME is allowed only in the exact published vendor context", async t => {
  const { options, put, check, root } = await fixture(t);
  const context = 'const environment = { USER: "web_user", LOGNAME: "web_user", PATH: "/", PWD: "/", HOME: "/home/web_user" };\n';
  await put("runtime/script-worker.js", context);
  assert.deepEqual((await check()).issues, []);
  await put("src/unrelated.js", context);
  assert.ok((await check()).issues.some(issue => issue.file === "src/unrelated.js" && /personal-home-path/.test(issue.code)));
  await rm(path.join(root, "src/unrelated.js"));
  await put("runtime/script-worker.js", 'export const accidental = "/home/web_user";\n');
  assert.ok((await check()).issues.length > 0);
  await put("runtime/script-worker.js", context);
  assert.ok((await checkPluginPortability(root, { ...options, authorHome: "/home/web_user" })).issues.some(issue => /current-machine-path/.test(issue.code)));
});

test("unknown or malformed source maps are reported rather than claimed as fully parsed", async t => {
  const { put, check } = await fixture(t);
  await put("runtime/unknown.map", JSON.stringify({ version: 999 }));
  assert.ok((await check()).warnings.some(issue => issue.code === "unrecognized-source-map-format"));
  await put("runtime/unknown.map", "invalid-json");
  assert.ok((await check()).issues.some(issue => issue.code === "invalid-source-map"));
});
