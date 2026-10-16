import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { parseFragment } from "parse5";

// This checks concrete Markdown/HTML references, JSON inheritance, and literal JS imports.
// Text and quoted-string scans are not an evaluator for arbitrary computed JavaScript paths.
const textExtensions = new Set([".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc", ".map", ".html", ".htm", ".css", ".scss", ".txt", ".yaml", ".yml", ".toml", ".xml", ".svg", ".sh", ".ps1", ".cmd", ".bat", ".cs", ".fs", ".csproj", ".props", ".targets"]);
const codeExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, "")]));
const isInside = (root, target) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const externalUrl = value => /^(?:https?|mailto|data|ui|mcp|plugin|codex):/i.test(value) || value.startsWith("//");
const absoluteFile = value => /^(?:file:|~[\\/]|[a-z]:[\\/]|\\\\)/i.test(value) || path.isAbsolute(value);
const normalizeLabel = label => label.replace(/\\([\\[\]])/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();

function position(text, offset) {
  const before = text.slice(0, offset);
  const last = before.lastIndexOf("\n");
  return { line: (before.match(/\n/g)?.length ?? 0) + 1, column: offset - last };
}

function maskCode(text) {
  const lines = text.split(/(?<=\n)/);
  let fence;
  let output = "";
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      output += line.replace(/[^\n]/g, " ");
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    } else if (marker) {
      fence = marker[1];
      output += line.replace(/[^\n]/g, " ");
    } else output += line;
  }
  return output.replace(/(`+)([\s\S]*?)\1/g, value => value.replace(/[^\n]/g, " "));
}

function htmlDecode(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function markdownReferences(text) {
  const source = maskCode(text);
  const links = [];
  const definitions = new Map();
  const reference = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\n]+)>|(\S+))/gm;
  for (const match of source.matchAll(reference)) {
    const destination = match[2] ?? match[3];
    const entry = { destination, offset: match.index + match[0].lastIndexOf(destination), kind: "reference" };
    definitions.set(normalizeLabel(match[1]), entry);
    links.push(entry);
  }
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "[" || source[start - 1] === "\\") continue;
    let depth = 1, end = start + 1;
    for (; end < source.length && depth; end++) {
      if (source[end] === "\\") { end++; continue; }
      if (source[end] === "[") depth++;
      else if (source[end] === "]") depth--;
    }
    if (depth) continue;
    const label = source.slice(start + 1, end - 1);
    if (source[end] === ":") { start = end; continue; }
    if (source[end] === "(") {
      let cursor = end + 1;
      while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++;
      const offset = cursor;
      let destination = "";
      if (source[cursor] === "<") {
        const close = source.indexOf(">", cursor + 1);
        if (close < 0) continue;
        destination = source.slice(cursor + 1, close);
      } else {
        let parentheses = 0;
        while (cursor < source.length) {
          const char = source[cursor];
          if (char === "\\" && cursor + 1 < source.length) { destination += source.slice(cursor, cursor + 2); cursor += 2; continue; }
          if (char === "(" ) parentheses++;
          if (char === ")") { if (parentheses === 0) break; parentheses--; }
          if (/\s/.test(char) && parentheses === 0) break;
          destination += char; cursor++;
        }
      }
      if (destination) links.push({ destination, offset, kind: "inline" });
    } else if (source[end] === "[") {
      const close = source.indexOf("]", end + 1);
      if (close < 0) continue;
      const entry = definitions.get(normalizeLabel(source.slice(end + 1, close) || label));
      if (!entry) links.push({ destination: undefined, offset: start, kind: "missing-reference" });
      start = close;
    } else {
      // A shortcut is a link only when its reference definition exists.
      const entry = definitions.get(normalizeLabel(label));
      if (entry) links.push({ ...entry, offset: start });
    }
  }
  for (const match of source.matchAll(/<([^<>\n]+)>/g)) {
    const value = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^(?:[./~]|[a-z]:[\\/])/.test(value) || /\.(?:md|markdown|png|svg|pdf|txt|js|ts|html|json|wasm|sh|ps1)$/i.test(value)) links.push({ destination: value, offset: match.index + 1, kind: "autolink" });
  }
  links.push(...htmlReferences(source));
  return links;
}

function htmlReferences(text, depth = 0) {
  const links = [];
  // HTML raw-text elements must be parsed as HTML. A JS comparison such as a<b
  // is not an opening tag whose attributes extend to a later `.href = value`.
  function visit(node) {
    for (const attr of node.attrs ?? []) {
      if (!["href", "src", "srcset"].includes(attr.name)) continue;
      const value = attr.value;
      const location = node.sourceCodeLocation?.attrs?.[attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name];
      const destinations = attr.name === "srcset" && !/^data:/i.test(value) ? value.split(",").map(part => part.trim().split(/\s+/)[0]) : [value];
      for (const destination of destinations) if (destination) links.push({ destination, offset: location?.startOffset ?? node.sourceCodeLocation?.startOffset ?? 0, kind: "html" });
    }
    if (node.tagName === "script" && depth < 4) {
      const type = node.attrs?.find(attr => attr.name === "type")?.value ?? "";
      if (["", "module", "text/javascript", "application/javascript"].includes(type)) {
        const start = node.sourceCodeLocation?.startTag?.endOffset, end = node.sourceCodeLocation?.endTag?.startOffset;
        if (start !== undefined && end !== undefined) {
          const source = text.slice(start, end), imports = literalImports(source, false);
          for (const link of imports.links) links.push({ ...link, offset: start + link.offset });
          for (const literal of imports.literals) if (/^\s*<(?:[a-z]|!doctype)/i.test(literal.value)) {
            for (const link of htmlReferences(literal.value, depth + 1)) links.push({ ...link, offset: start + literal.offset });
          }
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(parseFragment(text, { sourceCodeLocationInfo: true }));
  return links;
}

function decodeQuoted(raw) {
  let value = "";
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "\\") { value += raw[index]; continue; }
    const next = raw[++index];
    if (next === "\n") continue;
    if (next === "\r") { if (raw[index + 1] === "\n") index++; continue; }
    const escape = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
    if (escape[next]) { value += escape[next]; continue; }
    const suffix = raw.slice(index);
    const hex = suffix.match(/^(?:x([0-9a-f]{2})|u([0-9a-f]{4})|u\{([0-9a-f]{1,6})\})/i);
    if (hex) { const number = parseInt(hex[1] ?? hex[2] ?? hex[3], 16); value += number <= 0x10ffff ? String.fromCodePoint(number) : ""; index += hex[0].length - 1; continue; }
    const octal = suffix.match(/^[0-7]{1,3}/);
    if (octal) { value += String.fromCharCode(parseInt(octal[0], 8)); index += octal[0].length - 1; continue; }
    value += next ?? "";
  }
  return value;
}

function quotedTokens(text) {
  const tokens = [];
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (!['"', "'", "`"].includes(quote)) continue;
    const start = index++;
    const body = index;
    while (index < text.length && text[index] !== quote) { if (text[index] === "\\") index++; index++; }
    if (index < text.length) tokens.push({ value: decodeQuoted(text.slice(body, index)), offset: start });
  }
  return tokens;
}

function maskUrls(text) {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+|\b(?:mailto|data):[^\s"'`<>]+/gi, value => /^file:/i.test(value) ? value : " ".repeat(value.length));
}

function personalPaths(text, roots) {
  const source = maskUrls(text);
  const matches = [];
  const patterns = [
    ["personal-home-path", /\/(?:Users|home)\/[^/\\\s\x00-\x1f"'`<>:]+/g],
    ["windows-home-path", /(?<![a-z0-9])[a-z]:[\\/]+(?:Users|Documents(?: and |%20and%20)Settings)[\\/]+[^/\\\s\x00-\x1f"'`<>:]+/gi],
    ["mac-temporary-path", /\/(?:private\/)?var\/folders(?:\/[^\s"'`<>]*)?/g],
  ];
  for (const [code, expression] of patterns) for (const match of source.matchAll(expression)) matches.push({ code, offset: match.index, value: match[0] });
  for (const root of roots) {
    if (!root || root.length <= 1) continue;
    for (const variant of new Set([root, root.replaceAll("\\", "/"), root.replaceAll("\\", "\\\\")])) {
      let offset = 0;
      while ((offset = source.indexOf(variant, offset)) >= 0) {
        const next = source[offset + variant.length];
        if (!next || /[\\/\s\x00-\x1f"'`<>?#)]/.test(next)) matches.push({ code: "current-machine-path", offset, value: variant });
        offset += variant.length;
      }
    }
  }
  return matches;
}

function literalImports(text, typed = false) {
  if (!typed) {
    const links = [], literals = [];
    let ast;
    try { ast = parse(text, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true }); }
    catch { return { links, literals, parsed: false }; }
    const add = (node, kind = "import") => { if (node?.type === "Literal" && typeof node.value === "string") links.push({ destination: node.value, offset: node.start, kind }); };
    const visit = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "Literal" && typeof node.value === "string") literals.push({ value: node.value, offset: node.start });
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) add(node.source);
      if (node.type === "ImportExpression") add(node.source);
      if (node.type === "CallExpression" && (node.callee?.type === "Identifier" && node.callee.name === "require" || node.callee?.type === "MemberExpression" && node.callee.object?.name === "require" && node.callee.property?.name === "resolve")) add(node.arguments?.[0]);
      if (node.type === "NewExpression" && node.callee?.name === "URL" && node.arguments?.[1]?.type === "MemberExpression" && node.arguments[1].object?.type === "MetaProperty" && node.arguments[1].object.meta?.name === "import" && node.arguments[1].property?.name === "url") add(node.arguments[0], "url");
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
        else if (value?.type) visit(value);
      }
    };
    visit(ast);
    return { links, literals, parsed: true };
  }
  // This bounded lexer skips comments and string contents, including vendor code-generation strings.
  // It does not evaluate interpolated templates, computed import arguments, or arbitrary JavaScript.
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const offset = index, char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (text.startsWith("//", index)) { index = text.indexOf("\n", index + 2); if (index < 0) break; continue; }
    if (text.startsWith("/*", index)) { const end = text.indexOf("*/", index + 2); if (end < 0) break; index = end + 2; continue; }
    if (['"', "'", "`"].includes(char)) {
      const start = ++index;
      while (index < text.length && text[index] !== char) { if (text[index] === "\\") index++; index++; }
      const raw = text.slice(start, index++);
      tokens.push({ type: char === "`" && raw.includes("${") ? "computed" : "string", value: decodeQuoted(raw), offset });
    } else if (/[a-z_$]/i.test(char)) {
      index++;
      while (/[a-z0-9_$]/i.test(text[index] ?? "") && index < text.length) index++;
      tokens.push({ type: "identifier", value: text.slice(offset, index), offset });
    } else { tokens.push({ type: "punctuation", value: char, offset }); index++; }
  }
  const links = [];
  const add = (token, kind = "import") => { if (token?.type === "string") links.push({ destination: token.value, offset: token.offset, kind }); };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (token.value === "require" || token.value === "import") {
      const open = tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "resolve" ? index + 3 : index + 1;
      if (tokens[open]?.value === "(") { add(tokens[open + 1]); continue; }
    }
    if (["import", "export"].includes(token.value) && tokens[index + 1]?.value !== ".") {
      if (token.value === "import" && tokens[index + 1]?.type === "string") { add(tokens[index + 1]); continue; }
      for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 200); cursor++) {
        if ([";", "="].includes(tokens[cursor].value)) break;
        if (tokens[cursor].value === "from") { add(tokens[cursor + 1]); break; }
      }
    }
    if (token.value === "new" && tokens[index + 1]?.value === "URL" && tokens[index + 2]?.value === "(" && tokens[index + 4]?.value === "," && tokens.slice(index + 5, index + 10).map(value => value.value).join("") === "import.meta.url") add(tokens[index + 3], "url");
  }
  return { links, literals: quotedTokens(text), parsed: true };
}

export function formatPortabilityIssue(issue) {
  return `${issue.file}:${issue.line}:${issue.column} ${issue.code}`;
}

function normalizeLocalRoot(value) {
  // These are source identities used for text matching, not paths to open on
  // this host. A supplied foreign absolute path must keep its original flavor.
  if (path.posix.isAbsolute(value) && !value.startsWith("//")) return path.posix.normalize(value);
  if (path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1) return path.win32.normalize(value);
  return path.resolve(value);
}

export async function checkPluginPortability(pluginRoot, options = {}) {
  const root = await realpath(pluginRoot);
  const localRoots = [options.authorHome ?? homedir(), options.authorCwd ?? process.cwd(), options.temporaryDirectory ?? tmpdir(), options.repositoryRoot].filter(Boolean).map(normalizeLocalRoot);
  const issues = [];
  const warnings = [];
  const files = [];
  const visited = new Set();
  const add = (file, text, offset, code, warning = false) => {
    const relative = path.relative(root, file).replaceAll(path.sep, "/") || ".";
    (warning ? warnings : issues).push({ file: relative, ...position(text, offset), code });
  };
  const skillScope = file => {
    const relative = path.relative(root, file).split(path.sep);
    return relative[0] === "skills" && relative.length >= 3 ? path.join(root, "skills", relative[1]) : undefined;
  };
  async function walk(directory) {
    const canonical = await realpath(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const target = await realpath(filename).catch(() => undefined);
      if (!target) { add(filename, "", 0, "broken-symbolic-link"); continue; }
      if (!isInside(root, target)) { add(filename, "", 0, "symbolic-link-escapes-plugin"); continue; }
      const scope = skillScope(filename);
      if (scope && entry.isSymbolicLink() && !isInside(await realpath(scope), target)) { add(filename, "", 0, "symbolic-link-escapes-skill"); continue; }
      const info = await lstat(filename);
      const resolved = info.isSymbolicLink() ? await stat(filename) : info;
      if (resolved.isDirectory()) await walk(filename);
      else if (resolved.isFile()) files.push(filename);
    }
  }
  await walk(root);
  const packageFilename = path.join(root, "package.json");
  let declaredPackages = new Set();
  try { const pkg = JSON.parse(await readFile(packageFilename, "utf8")); declaredPackages = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]); }
  catch (error) { if (error.code !== "ENOENT") add(packageFilename, "", 0, "invalid-package-json"); }
  const checkedLinks = new Set();
  async function checkReference(filename, text, link, scope, allowPackage = false) {
    const key = `${filename}\0${link.offset}\0${link.destination}`;
    if (checkedLinks.has(key)) return;
    checkedLinks.add(key);
    if (link.destination === undefined) { add(filename, text, link.offset, "undefined-markdown-reference"); return; }
    let destination = htmlDecode(link.destination).replace(/\\([\\()\[\] ])/g, "$1");
    if (/^skill:/i.test(destination)) { add(filename, text, link.offset, "external-skill-reference"); return; }
    if (externalUrl(destination) || destination.startsWith("#")) return;
    if (absoluteFile(destination)) { add(filename, text, link.offset, "absolute-file-reference"); return; }
    if (allowPackage && !destination.startsWith(".")) {
      const name = destination.startsWith("@") ? destination.split("/").slice(0, 2).join("/") : destination.split("/")[0];
      if (builtins.has(destination) || destination.startsWith("node:") || declaredPackages.has(name)) return;
      add(filename, text, link.offset, "undeclared-package-reference"); return;
    }
    destination = destination.split(/[?#]/, 1)[0];
    if (!destination) return;
    try { destination = decodeURIComponent(destination); } catch { add(filename, text, link.offset, "invalid-file-reference-encoding"); return; }
    if (absoluteFile(destination)) { add(filename, text, link.offset, "absolute-file-reference"); return; }
    const target = path.resolve(path.dirname(filename), destination.replaceAll("\\", path.sep));
    const boundary = scope ?? root;
    if (!isInside(boundary, target)) { add(filename, text, link.offset, scope ? "file-reference-escapes-skill" : "file-reference-escapes-plugin"); return; }
    let canonical = await realpath(target).catch(() => undefined);
    if (!canonical && allowPackage) {
      const candidates = [".js", ".ts", ".mjs", ".cjs", ".json", ".tsx", ".jsx"].map(extension => target + extension);
      if (/\.tsx?$/.test(filename)) {
        if (target.endsWith(".js")) candidates.unshift(target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx");
        if (target.endsWith(".mjs")) candidates.unshift(target.slice(0, -4) + ".mts");
        if (target.endsWith(".cjs")) candidates.unshift(target.slice(0, -4) + ".cts");
      }
      for (const candidate of candidates) {
        canonical = await realpath(candidate).catch(() => undefined);
        if (canonical) break;
      }
    }
    if (!canonical) { add(filename, text, link.offset, "missing-file-reference"); return; }
    if (!isInside(await realpath(boundary), canonical)) add(filename, text, link.offset, scope ? "file-reference-escapes-skill" : "file-reference-escapes-plugin");
  }
  for (const filename of files) {
    const extension = path.extname(filename).toLowerCase();
    const relative = path.relative(root, filename).replaceAll(path.sep, "/");
    const data = await readFile(filename);
    const text = data.toString("utf8");
    const binary = data.includes(0) && !textExtensions.has(extension);
    for (const finding of personalPaths(text, localRoots)) add(filename, text, finding.offset, binary ? `binary-${finding.code}` : finding.code);
    const imports = codeExtensions.has(extension) ? literalImports(text, [".ts", ".tsx"].includes(extension)) : undefined;
    if (imports && !imports.parsed) add(filename, text, 0, "unparsed-javascript-references");
    if (!binary && (codeExtensions.has(extension) || [".json", ".jsonc", ".map", ".html", ".htm"].includes(extension))) {
      for (const token of imports?.literals ?? quotedTokens(text)) {
        for (const finding of personalPaths(token.value, localRoots)) add(filename, text, token.offset, "quoted-" + finding.code);
      }
    }
    const scope = skillScope(filename);
    if ([".md", ".markdown"].includes(extension)) {
      for (const link of markdownReferences(text)) await checkReference(filename, text, link, scope);
      if (scope) {
        const globalSkill = /(?:~[\\/]|\$\{?HOME\}?[\\/]|%USERPROFILE%[\\/])(?:\.codex|\.agents)[\\/]skills[\\/]|\$\{?CODEX_HOME\}?[\\/]skills[\\/]/g;
        for (const match of text.matchAll(globalSkill)) add(filename, text, match.index, "global-skill-directory-reference");
      }
    } else if ([".html", ".htm", ".svg"].includes(extension)) {
      for (const link of htmlReferences(text)) await checkReference(filename, text, link, scope);
    }
    for (const link of imports?.links ?? []) await checkReference(filename, text, link, undefined, link.kind !== "url");
    if ([".json", ".map"].includes(extension)) {
      let json;
      try { json = JSON.parse(text); } catch { add(filename, text, 0, extension === ".map" ? "invalid-source-map" : "invalid-json"); continue; }
      if (extension === ".map" && (json.version !== 3 || !Array.isArray(json.sources))) add(filename, text, 0, "unrecognized-source-map-format", true);
      if (typeof json.extends === "string" || Array.isArray(json.extends)) {
        for (const value of typeof json.extends === "string" ? [json.extends] : json.extends) {
          if (typeof value !== "string") { add(filename, text, 0, "invalid-json-extends"); continue; }
          const offset = Math.max(0, text.indexOf(JSON.stringify(value)));
          await checkReference(filename, text, { destination: value, offset, kind: "extends" }, undefined, !value.startsWith(".") && !absoluteFile(value));
        }
      }
    }
  }
  const unique = list => [...new Map(list.map(issue => [formatPortabilityIssue(issue), issue])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
  return { issues: unique(issues), warnings: unique(warnings), filesChecked: files.length };
}

const calledDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (calledDirectly) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) { console.error("Usage: node scripts/check-plugin-portability.mjs <plugin-directory>"); process.exitCode = 2; }
  else {
    const result = await checkPluginPortability(pluginRoot);
    for (const issue of result.issues) console.error(formatPortabilityIssue(issue));
    for (const issue of result.warnings) console.error(formatPortabilityIssue(issue));
    if (result.issues.length) process.exitCode = 1;
    else console.log(`Plugin portability passed: ${result.filesChecked} files checked.`);
  }
}
