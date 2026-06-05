import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const sourceRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(sourceRoot, "..", "..");
const outputDir = resolve(repoRoot, "plugins", "codex-deep-research", "bin");
const outputMjs = resolve(outputDir, "codex-deep-research.mjs");
const outputCmd = resolve(outputDir, "codex-deep-research.cmd");

await mkdir(outputDir, { recursive: true });

await build({
  entryPoints: [resolve(sourceRoot, "runner", "src", "cli.ts")],
  outfile: outputMjs,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  banner: {
    js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});

await writeFile(
  outputCmd,
  [
    "@echo off",
    "setlocal",
    'node "%~dp0codex-deep-research.mjs" %*',
    "",
  ].join("\r\n"),
  "utf8",
);
