import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileRecord, Workspace } from "./types.ts";

interface Temporary { path: string; target: string; expected: FileRecord; dev?: number; ino?: number }
interface Registry { project: string; files: Temporary[] }
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const registryPath = (transaction: string) => path.join(transaction, "project-temporaries.json");
async function safeParents(root: string, name: string) {
  let parent = root;
  for (const segment of name.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, segment); const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || !(await realpath(parent)).startsWith(root + path.sep)) throw new Error("Unsafe project temporary parent");
  }
}
function targetPath(root: string, file: Temporary) {
  if (path.isAbsolute(file.path) || path.isAbsolute(file.target) || file.target.split(/[\\/]/).some(part => !part || part === ".." || part === ".git") || file.path.slice(0, file.target.length) !== file.target || !/^\.wf-[a-f0-9]{16}\.tmp$/.test(file.path.slice(file.target.length))) throw new Error("Invalid project temporary ownership record");
  const result = path.resolve(root, file.path);
  if (!result.startsWith(root + path.sep)) throw new Error("Project temporary escaped its project");
  return result;
}
async function readRegistry(transaction: string): Promise<Registry | undefined> {
  try {
    const parent = await lstat(transaction);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid project temporary transaction directory");
    const filename = registryPath(transaction), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Invalid project temporary registry");
    const record = JSON.parse(await readFile(filename, "utf8")) as Registry;
    if (typeof record.project !== "string" || !Array.isArray(record.files)) throw new Error("Invalid project temporary registry");
    return record;
  } catch (error) { if (absent(error)) return undefined; throw error; }
}
export async function trackProjectTemporary(transaction: string, project: string, file: Temporary) {
  const record = await readRegistry(transaction) ?? { project, files: [] };
  if (record.project !== project) throw new Error("Project temporary registry belongs to another project");
  targetPath(project, file);
  const index = record.files.findIndex(item => item.path === file.path);
  if (index < 0) record.files.push(file); else record.files[index] = file;
  const filename = registryPath(transaction), temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}
export async function inspectProjectTemporaryFiles(workspace: Workspace, remove = false) {
  const owned: Array<{ path: string; bytes: number }> = [], blocked: Array<{ path: string; message: string }> = [];
  const transaction = path.join(path.dirname(workspace.root), "apply-transaction");
  let registry: Registry | undefined;
  try { const parent = await lstat(transaction); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe application transaction"); registry = await readRegistry(transaction); }
  catch (error) { if (absent(error)) return { owned, blocked }; return { owned, blocked: [{ path: registryPath(transaction), message: "原子写入临时文件记录无法安全读取，不能确认彻底清理。" }] }; }
  let root: string;
  try { root = await realpath(workspace.original); } catch (error) { if (absent(error)) return { owned, blocked }; throw error; }
  if (root !== path.resolve(workspace.original) || registry && registry.project !== root) return { owned, blocked: [{ path: workspace.original, message: "项目目录已变化，无法确认原子临时文件归属。" }] };
  const known = new Set<string>();
  for (const file of registry?.files ?? []) {
    let filename = file.path;
    try {
      filename = targetPath(root, file); known.add(filename); await safeParents(root, file.path);
      const info = await lstat(filename);
      if (info.dev !== file.dev || info.ino !== file.ino || !(info.isFile() || info.isSymbolicLink()) || (info.isSymbolicLink() ? "link" : "file") !== file.expected.kind || sha(info.isSymbolicLink() ? await readlink(filename) : await readFile(filename)) !== file.expected.hash) throw new Error("Temporary file ownership or contents changed");
      owned.push({ path: filename, bytes: info.size });
      if (remove) { await safeParents(root, file.path); const current = await lstat(filename); if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("Temporary file changed before removal"); await rm(filename); }
    } catch (error) { if (!absent(error)) blocked.push({ path: filename, message: "原子临时文件无法证明归属或已被修改，需先核对后清理。" }); }
  }
  // Old releases did not journal temporary names. Detect ambiguous candidates
  // only beside the exact reviewed targets; never scavenge a project by glob.
  try {
    const journalFile = path.join(transaction, "journal.json"), info = await lstat(journalFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Invalid application journal");
    const journal = JSON.parse(await readFile(journalFile, "utf8")) as { files?: Array<{ path: string }> };
    for (const file of journal.files ?? []) {
      const probe: Temporary = { path: `${file.path}.wf-0000000000000000.tmp`, target: file.path, expected: { kind: "file", hash: "", mode: 0 } };
      const filename = targetPath(root, probe); await safeParents(root, probe.path);
      for (const name of await readdir(path.dirname(filename))) if (name.startsWith(path.basename(file.path) + ".wf-") && /^\.wf-[a-f0-9]{16}\.tmp$/.test(name.slice(path.basename(file.path).length))) {
        const candidate = path.join(path.dirname(filename), name);
        if (!known.has(candidate)) blocked.push({ path: candidate, message: "发现历史版本未记录归属的临时文件；不能自动删除可能属于用户的文件。" });
      }
    }
  } catch (error) { if (!absent(error)) blocked.push({ path: transaction, message: "应用事务记录无法安全核对，不能确认项目临时文件清理。" }); }
  return { owned, blocked };
}
