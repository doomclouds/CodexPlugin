import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  absWorkingDir: pluginRoot,
  entryPoints: ["src/index.ts"],
  outfile: "runtime/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "info",
});

const packageDirectories = new Set();
for (const input of Object.keys(built.metafile.inputs)) {
  const normalized = input.replaceAll("\\", "/");
  const start = normalized.lastIndexOf("node_modules/");
  if (start < 0) continue;
  const prefix = normalized.slice(0, start + "node_modules/".length);
  const segments = normalized.slice(prefix.length).split("/");
  const packageName = segments.slice(0, segments[0].startsWith("@") ? 2 : 1).join("/");
  packageDirectories.add(path.resolve(pluginRoot, prefix, packageName));
}

const notices = [];
for (const directory of [...packageDirectories].sort()) {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    try {
      const license = await readFile(path.join(directory, filename), "utf8");
      notices.push(`${pkg.name}@${pkg.version}\n${license.trim()}`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await writeFile(path.join(pluginRoot, "runtime", "third-party-licenses.txt"), notices.join("\n\n---\n\n") + "\n");
