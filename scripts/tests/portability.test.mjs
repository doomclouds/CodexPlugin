import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { checkPluginPortability, formatPortabilityIssue } from "../check-plugin-portability.mjs";

const exec = promisify(execFile);

async function skillValidatorFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-skill-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content) => { const filename = path.join(root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, content); };
  await put(".agents/plugins/marketplace.json", JSON.stringify({ plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }));
  await put("plugins/demo/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "demo", version: "1.0.0" }));
  await put("scripts/check-plugin-portability.mjs", `export { checkPluginPortability, formatPortabilityIssue } from ${JSON.stringify(new URL("../check-plugin-portability.mjs", import.meta.url).href)};\n`);
  const validator = path.join(root, "scripts", "validate-plugins.mjs");
  await copyFile(new URL("../validate-plugins.mjs", import.meta.url), validator);
  return {
    writeSkill: content => put("plugins/demo/skills/demo/SKILL.md", content),
    writeMcp: servers => put("plugins/demo/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: servers })),
    writeOverlay: overlay => put("plugins/demo/.codex-plugin/plugin.json", JSON.stringify(overlay)),
    validate: () => exec(process.execPath, [validator], { cwd: root, timeout: 10000, windowsHide: true }),
  };
}

test("native plugin validation rejects unsupported stdio fields before publication", async t => {
  const { writeMcp, validate } = await skillValidatorFixture(t);
  const server = { type: "stdio", command: "node", args: [], cwd: "${PLUGIN_ROOT}" };
  await writeMcp({ demo: server });
  assert.match((await validate()).stdout, /Validated demo:/);
  // This was accepted by our package check but rejected by the desktop loader.
  await writeMcp({ demo: { ...server, env_vars: ["CODEX_APP_TOOLS_PIPE_PATH"] } });
  await assert.rejects(validate(), error => error.code === 1 && /Unsupported native stdio field: env_vars/.test(error.stderr));
});

test("Codex environment overlay supplements only a declared native stdio server", async t => {
  const { writeMcp, writeOverlay, validate } = await skillValidatorFixture(t);
  await writeMcp({ demo: { type: "stdio", command: "node" } });
  const server = { command: "node", env_vars: ["CODEX_APP_TOOLS_PIPE_PATH"] };
  await writeOverlay({ name: "demo", mcpServers: { demo: server } });
  assert.match((await validate()).stdout, /Validated demo:/);
  await writeOverlay({ name: "demo", mcpServers: { missing: server } });
  await assert.rejects(validate(), error => error.code === 1 && /must refer to a native stdio server/.test(error.stderr));
});

for (const [format, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`plugin validation accepts ${format} skill metadata`, async t => {
    const { writeSkill, validate } = await skillValidatorFixture(t);
    await writeSkill(["---", "name: demo", "description: A reusable fixture skill.", "---", "# Demo", ""].join(newline));
    assert.match((await validate()).stdout, /Validated demo:/);
  });

  test(`plugin validation rejects malformed ${format} skill metadata`, async t => {
    const { writeSkill, validate } = await skillValidatorFixture(t);
    for (const metadata of [
      ["name: demo", "description: Fixture skill.", "---"],
      ["---", "name: wrong", "description: Fixture skill.", "---"],
      ["---", "description: Fixture skill.", "---"],
      ["---", "name: demo", "---"],
    ]) {
      await writeSkill([...metadata, "# Demo", ""].join(newline));
      await assert.rejects(validate(), error => error.code === 1 && /AssertionError/.test(error.stderr));
    }
  });
}

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

test("transitive JavaScript and TypeScript imports stay inside their own skill without restricting ordinary plugin imports", async t => {
  const { put, check } = await fixture(t);
  await put("skills/demo/SKILL.md", "[Helper](scripts/run.js)\n[Typed helper](scripts/run.ts)\n");
  await put("skills/demo/references/helper.js", "export const value = 1;\n");
  await put("runtime/shared.js", "export const shared = 2;\n");
  await put("src/plugin.ts", 'import { shared } from "../runtime/shared.js"; export { shared };\n');
  for (const extension of ["js", "ts"]) await put(`skills/demo/scripts/run.${extension}`, 'import { value } from "../references/helper.js"; export { value };\n');
  assert.deepEqual((await check()).issues, []);
  for (const extension of ["js", "ts"]) await put(`skills/demo/scripts/run.${extension}`, 'import { shared } from "../../../runtime/shared.js"; export { shared };\n');
  assert.deepEqual((await check()).issues.map(issue => [issue.file, issue.code]), [
    ["skills/demo/scripts/run.js", "file-reference-escapes-skill"],
    ["skills/demo/scripts/run.ts", "file-reference-escapes-skill"],
  ]);
});

test("plugin README cannot reference parent engineering files", async t => {
  const { outer, put, check } = await fixture(t);
  await writeFile(path.join(outer, "engineering.md"), "Private engineering fixture\n");
  await put("README.md", "[Design](../engineering.md)\n");
  assert.ok((await check()).issues.some(issue => issue.code === "file-reference-escapes-plugin"));
});

test(`a ${process.platform === "win32" ? "directory junction" : "file symlink"} cannot make an outside file a contained skill asset`, async t => {
  const { root, outer, put, check } = await fixture(t);
  const windows = process.platform === "win32";
  const outside = path.join(outer, windows ? "outside" : "outside.md");
  if (windows) {
    await mkdir(outside);
    await writeFile(path.join(outside, "asset.md"), "Outside\n");
  } else await writeFile(outside, "Outside\n");
  await put("skills/demo/SKILL.md", `[Linked](references/${windows ? "linked/asset.md" : "linked.md"})\n`);
  await mkdir(path.join(root, "skills/demo/references"));
  await symlink(outside, path.join(root, "skills/demo/references", windows ? "linked" : "linked.md"), windows ? "junction" : "file");
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

test("TypeScript nested templates do not turn UI labels and generated code into literal imports", async t => {
  const { put, check } = await fixture(t);
  await put("src/panel.ts", String.raw`
type Mode = "source-import" | "source";
export function markup(enabled: boolean): string {
  const input = \`<input placeholder="index.html or src/main.tsx">\`;
  return \`<section>\${enabled ? \`\${input}<button data-action="source-import"\${enabled ? " disabled" : ""}>\${enabled ? "import" : "source-import"}</button>\` : \`<textarea placeholder="import('generated-package')">\${"export from"}</textarea>\`}</section>\`;
}
const generated: string = \`require("generated-package"); \${true ? \`import("still-generated");\` : ""}\`;
`.replaceAll("\\`", "`").replaceAll("\\${", "${"));
  assert.deepEqual((await check()).issues, []);
});

test("actual imports in nested TypeScript template expressions remain checked with their source locations", async t => {
  const { put, check } = await fixture(t);
  await put("src/panel.ts", [
    "const label: string = 'source-import';",
    "export const panel = `outer ${true ? `nested ${",
    "  import('./missing-module.js')",
    "}` : ''}`;",
  ].join("\n"));
  const issues = (await check()).issues;
  assert.ok(issues.some(issue => issue.file === "src/panel.ts" && issue.line === 3 && issue.code === "missing-file-reference"));
  assert.equal(issues.some(issue => issue.code === "undeclared-package-reference"), false);
});

test("TSX and JSX syntax distinguishes labels from actual expression imports", async t => {
  const { put, check } = await fixture(t);
  await put("src/view.tsx", 'const label: string = "source-import"; export const view = <button title={"import(\\\"generated-package\\\")"}>{label}</button>;\n');
  await put("src/plain.jsx", 'export const text = <div>import("generated-package")</div>;\n');
  assert.deepEqual((await check()).issues, []);
  await put("src/view.tsx", 'export const view = <button onClick={() => import("missing-real-package")}>source-import</button>;\n');
  const issues = (await check()).issues;
  assert.ok(issues.some(issue => issue.file === "src/view.tsx" && issue.code === "undeclared-package-reference"));
  assert.equal(issues.some(issue => issue.code === "unparsed-javascript-references"), false);
});

test("TypeScript type imports, require imports and static template resources retain strict file and package checks", async t => {
  const { put, check } = await fixture(t);
  await put("src/types.ts", [
    'import type { Missing } from "./missing-types.js";',
    'type Shape = import("missing-type-package").Shape;',
    'import dependency = require("missing-require-package");',
    'export { Missing } from "./missing-export.js";',
    'const asset: URL = new URL("./missing.wasm", import.meta.url);',
    'const lazy = import(`./missing-template.js`);',
  ].join("\n"));
  const issues = (await check()).issues;
  assert.deepEqual(issues.map(issue => [issue.line, issue.code]), [
    [1, "missing-file-reference"], [2, "undeclared-package-reference"], [3, "undeclared-package-reference"],
    [4, "missing-file-reference"], [5, "missing-file-reference"], [6, "missing-file-reference"],
  ]);
});

test("invalid TypeScript fails closed and escaped personal paths in template text remain rejected", async t => {
  const { put, check } = await fixture(t);
  await put("src/broken.ts", "const broken: = 1;");
  assert.ok((await check()).issues.some(issue => issue.file === "src/broken.ts" && issue.code === "unparsed-javascript-references"));
  await put("src/broken.ts", String.raw`const directory: string = \`\x2fhome\x2ffixture-person\x2fproject\${true ? \`/child\` : ""}\`;`.replaceAll("\\`", "`").replaceAll("\\${", "${"));
  assert.ok((await check()).issues.some(issue => issue.file === "src/broken.ts" && issue.code === "quoted-personal-home-path"));
});

test("escaped personal paths in Babel directive prologues are checked using their decoded values", async t => {
  const { put, check } = await fixture(t);
  await put("src/directive.ts", String.raw`"\x2fhome\x2ffixture-person\x2fprivate-project"; export const ok = 1;`);
  const issues = (await check()).issues;
  assert.ok(issues.some(issue => issue.file === "src/directive.ts" && issue.line === 1 && issue.code === "quoted-personal-home-path"));
  assert.equal(issues.map(formatPortabilityIssue).join("\n").includes("fixture-person"), false);
});

test("erased TypeScript wrappers cannot hide actual imports, require calls or URL assets", async t => {
  const { put, check } = await fixture(t);
  await put("src/wrapped.ts", [
    'const nested: string = `outer ${true ? `nested ${import(("missing-real-package" as string)!)}` : ""}`;',
    'require(("missing-require-package" satisfies string)!);',
    'new URL((<string>"./missing-assertion.wasm"), import.meta.url);',
    'new URL("./missing-base.wasm" as string, (import.meta.url as string)!);',
    'new (URL as typeof URL)("./missing-object.wasm", (import.meta as ImportMeta).url);',
    '(require as typeof require).resolve(("missing-resolve-package" as const));',
    '(require as typeof require)("missing-callee-package" as string);',
    'const generated: string = `import("generated-package" as string);`;',
  ].join("\n"));
  assert.deepEqual((await check()).issues.map(issue => [issue.line, issue.code]), [
    [1, "undeclared-package-reference"], [2, "undeclared-package-reference"], [3, "missing-file-reference"],
    [4, "missing-file-reference"], [5, "missing-file-reference"], [6, "undeclared-package-reference"], [7, "undeclared-package-reference"],
  ]);
});
test("HTML parsing distinguishes JavaScript comparisons from actual resource attributes", async t => {
  const { put, check } = await fixture(t);
  await put("runtime/panel.html", '<!doctype html><script>function scan(a,b){if(a<b){const link=document.createElement("a");link.href=b;link.download="file";}}</script>');
  assert.deepEqual((await check()).issues, []);
  await put("runtime/panel.html", '<script>const markup = \'<img src="missing.png">\';</script>');
  assert.ok((await check()).issues.some(issue => issue.code === "missing-file-reference"));
  await put("runtime/panel.html", '<script>import "./missing.js";</script>');
  assert.ok((await check()).issues.some(issue => issue.code === "missing-file-reference"));
});
test("HTML raw-text scanning preserves template, SVG and malformed-tag resource checks", async t => {
  const { put, check } = await fixture(t);
  for (const markup of ['<template><img src="missing.png"></template>', '<svg><image href="missing.png"/></svg>', '<img src="missing.png" @click="handler">', '<script src="missing.js"></script>']) {
    await put("runtime/panel.html", markup);
    assert.ok((await check()).issues.some(issue => issue.code === "missing-file-reference"), markup);
  }
});

test("global skill dependencies are rejected, including symbolic environment paths", async t => {
  const { put, check } = await fixture(t);
  await put("skills/demo/SKILL.md", "Read `$CODEX_HOME/skills/another/SKILL.md` and [External](skill://other/guide).\n");
  const result = await check();
  assert.ok(result.issues.some(issue => issue.code === "global-skill-directory-reference"));
  assert.ok(result.issues.some(issue => issue.code === "external-skill-reference"));
});

test("all bundled personal HOME values and source-root paths are rejected", async t => {
  const { options, put, check, root } = await fixture(t);
  await put("runtime/vendor.js", 'const environment = { USER: "web_user", LOGNAME: "web_user", PATH: "/", PWD: "/", HOME: "/home/web_user" };\n');
  assert.ok((await check()).issues.some(issue => issue.file === "runtime/vendor.js" && issue.code === "personal-home-path"));
  await rm(path.join(root, "runtime/vendor.js"));
  for (const authorCwd of ["/srv/portable-fixture", String.raw`Z:\portable-fixture`]) {
    await put("src/source-root.js", `export const source = ${JSON.stringify(authorCwd + "/source.js")};\n`);
    assert.ok((await checkPluginPortability(root, { ...options, authorCwd })).issues.some(issue => issue.file === "src/source-root.js" && /current-machine-path/.test(issue.code)));
  }
});

test("unknown or malformed source maps are reported rather than claimed as fully parsed", async t => {
  const { put, check } = await fixture(t);
  await put("runtime/unknown.map", JSON.stringify({ version: 999 }));
  assert.ok((await check()).warnings.some(issue => issue.code === "unrecognized-source-map-format"));
  await put("runtime/unknown.map", "invalid-json");
  assert.ok((await check()).issues.some(issue => issue.code === "invalid-source-map"));
});
