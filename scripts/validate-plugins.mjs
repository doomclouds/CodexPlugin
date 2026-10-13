import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async relative => JSON.parse(await readFile(path.join(root, relative), "utf8"));
async function readOptionalJson(relative) {
  try { return await readJson(relative); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
const marketplace = await readJson(".agents/plugins/marketplace.json");
const pluginDirs = (await readdir(path.join(root, "plugins"), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name);

function contained(base, relative) {
  assert.ok(relative.startsWith("./"), `Expected ./ path: ${relative}`);
  const resolved = path.resolve(base, relative);
  const remainder = path.relative(base, resolved);
  assert.ok(remainder && !remainder.startsWith("..") && !path.isAbsolute(remainder), `Path escapes root: ${relative}`);
  return resolved;
}

assert.equal(new Set(marketplace.plugins.map(entry => entry.name)).size, marketplace.plugins.length, "Duplicate marketplace name");
for (const name of pluginDirs) {
  const directory = path.join(root, "plugins", name);
  const manifest = await readJson(`plugins/${name}/plugin.json`);
  const pkg = await readOptionalJson(`plugins/${name}/package.json`);
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, name);
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  if (pkg) assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const listing = manifest.extensions?.["com.openai"]?.interface;
  if (listing) {
    assert.ok(listing.shortDescription?.length <= 30, "Listing subtitle exceeds 30 characters");
    for (const key of ["logo", "logoDark", "composerIcon"]) {
      if (!listing[key]) continue;
      const icon = await readFile(contained(directory, listing[key]));
      assert.ok(icon.length <= 5 * 1024 * 1024, "Product icon exceeds 5 MiB");
      if (listing[key].endsWith(".png")) {
        assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Invalid PNG icon");
        const width = icon.readUInt32BE(16), height = icon.readUInt32BE(20);
        assert.ok(width === height && width >= 48 && width <= 4096, "Icon must be square and 48-4096 px");
      }
    }
  }

  const entry = marketplace.plugins.find(plugin => plugin.name === name);
  assert.ok(entry, `${name} is absent from the marketplace`);
  assert.equal(contained(root, entry.source.path), directory);
  assert.equal(entry.source.source, "local");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.ok(entry.policy.authentication && entry.category);

  const mcp = await readOptionalJson(`plugins/${name}/mcp.json`);
  if (mcp) {
    assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    for (const server of Object.values(mcp.mcpServers)) {
      if (server.type === "stdio") {
        assert.ok(server.command);
        if (server.cwd) {
          assert.ok(server.cwd === "${PLUGIN_ROOT}" || server.cwd.startsWith("${PLUGIN_DATA}/") || server.cwd === "${PLUGIN_DATA}" || server.cwd.startsWith("${PLUGIN_ROOT}/") || server.cwd.startsWith("./"));
          if (server.cwd.startsWith("./")) contained(directory, server.cwd);
          else if (server.cwd.startsWith("${PLUGIN_ROOT}/")) contained(directory, server.cwd.replace("${PLUGIN_ROOT}/", "./"));
        }
        for (const argument of server.args ?? []) {
          if (argument.startsWith("${PLUGIN_ROOT}/")) {
            await access(contained(directory, argument.replace("${PLUGIN_ROOT}/", "./")));
          }
        }
      } else {
        assert.ok(["streamable-http", "sse"].includes(server.type), "Unknown MCP transport");
        assert.ok(new URL(server.url).protocol === "https:" || new URL(server.url).protocol === "http:");
      }
    }
  }

  let skillDirectories;
  try { skillDirectories = await readdir(path.join(directory, "skills"), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; skillDirectories = []; }
  for (const skill of skillDirectories) {
    if (!skill.isDirectory()) continue;
    const content = await readFile(path.join(directory, "skills", skill.name, "SKILL.md"), "utf8");
    assert.ok(content.startsWith("---\n"), "Skill needs YAML frontmatter");
    assert.match(content, new RegExp(`\\nname: ${skill.name}\\n`));
    assert.match(content, /\ndescription: .+/);
  }
  console.log(`Validated ${name}: manifest, marketplace, component paths, skill metadata.`);
}
