import { build } from "esbuild";
import { readFile, writeFile, rm } from "node:fs/promises";
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
await rm(path.join(pluginRoot, "runtime", "script-worker.js"), { force: true });

const uiBuild = await build({
  absWorkingDir: pluginRoot,
  entryPoints: ["prototypes/app-bridge.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  metafile: true,
});
await writeFile(path.join(pluginRoot, "runtime", "launcher.mjs"), await readFile(path.join(pluginRoot, "src", "launcher.mjs")));
const canvasTexture = await readFile(path.join(pluginRoot, "assets", "workflow-canvas.png"));
const panelFragment = (await readFile(path.join(pluginRoot, "prototypes", "workflow-panel.html"), "utf8")).replaceAll("\r\n", "\n").replaceAll("../assets/workflow-canvas.png", `data:image/png;base64,${canvasTexture.toString("base64")}`);
const iconSource = (await readFile(path.join(pluginRoot, "prototypes", "icons.css"), "utf8")).replaceAll("\r\n", "\n");
const iconPaths = [...new Set([...iconSource.matchAll(/\.\.\/assets\/icons\/([a-z0-9-]+\.svg)/g)].map(match => match[1]))];
let iconStyles = iconSource;
for (const filename of iconPaths) {
  const bytes = await readFile(path.join(pluginRoot, "assets", "icons", filename));
  iconStyles = iconStyles.replaceAll(`../assets/icons/${filename}`, `data:image/svg+xml;base64,${bytes.toString("base64")}`);
}
const bridge = uiBuild.outputFiles[0].text.replaceAll("</script", "<\\/script");
await writeFile(path.join(pluginRoot, "runtime", "panel.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflows</title><style>:root{color-scheme:light dark}body{margin:0}</style></head><body>${panelFragment}<style>${iconStyles}</style><script>${bridge}</script></body></html>`);

const packageDirectories = new Set();
for (const input of [...Object.keys(built.metafile.inputs), ...Object.keys(uiBuild.metafile.inputs)]) {
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
      notices.push(`${pkg.name}@${pkg.version}\n${license.trim().replaceAll("\r\n", "\n")}`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await writeFile(path.join(pluginRoot, "runtime", "third-party-licenses.txt"), notices.join("\n\n---\n\n") + "\n");
