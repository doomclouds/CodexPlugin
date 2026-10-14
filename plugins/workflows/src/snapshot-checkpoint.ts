import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./types.ts";
import { gitCommand, readGitIndexState } from "./submodules.ts";

const maxFiles = 100000;
const maxBytes = 2 * 1024 * 1024 * 1024;
const maxFileBytes = 512 * 1024 * 1024;

async function assertOwnedGit(root: string): Promise<void> {
  const metadata = path.join(root, ".git");
  const entry = await lstat(metadata);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(metadata) !== metadata) throw new Error("Snapshot Git metadata must remain an independent owned directory");
  const [actual, common, top] = await Promise.all([
    gitCommand(root, ["rev-parse", "--absolute-git-dir"]),
    gitCommand(root, ["rev-parse", "--git-common-dir"]),
    gitCommand(root, ["rev-parse", "--show-toplevel"]),
  ]);
  if (await realpath(actual.trim()) !== metadata || await realpath(path.resolve(root, common.trim())) !== metadata || await realpath(top.trim()) !== root) throw new Error("Snapshot Git metadata or working tree redirects outside its independent directory");
  let parent = metadata;
  for (const name of ["objects", "info"]) {
    parent = path.join(parent, name);
    let info;
    try { info = await lstat(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("Snapshot Git object storage must remain owned directories");
  }
  const alternates = path.join(parent, "alternates");
  let info;
  try { info = await lstat(alternates); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("Snapshot Git cannot share alternate object storage");
  const descriptor = await open(alternates, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await descriptor.stat();
    if (!opened.isFile() || opened.size > 65536 || info.dev !== opened.dev || info.ino !== opened.ino || await realpath(alternates) !== alternates) throw new Error("Snapshot Git cannot share alternate object storage");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536 || buffer.subarray(0, bytesRead).toString("utf8").trim()) throw new Error("Snapshot Git cannot share alternate object storage");
    const after = await descriptor.stat(), current = await lstat(alternates);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Snapshot Git alternate storage changed during validation");
  } finally { await descriptor.close(); }
}

// Unlike the application diff, recovery must cover ignored build products and
// Git metadata too. A cached verification describes this whole retained tree.
export async function snapshotFingerprint(workspace: Workspace, signal?: AbortSignal): Promise<string> {
  const original = await lstat(workspace.root);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Snapshot checkpoint requires an owned directory");
  const root = await realpath(workspace.root);
  await assertOwnedGit(root);
  const digest = createHash("sha256");
  let files = 0, directories = 0, bytes = 0;
  const append = (value: unknown) => { digest.update(JSON.stringify(value)); digest.update("\n"); };
  const owned = (filename: string) => filename === root || filename.startsWith(root + path.sep);
  const visit = async (relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error("Snapshot checkpoint exceeds 64 directory levels");
    const filename = relative ? path.join(root, relative) : root;
    const before = await lstat(filename);
    const mode = before.mode & 0o777;
    if (before.isSymbolicLink()) {
      const target = await readlink(filename);
      if (path.isAbsolute(target) || !owned(path.resolve(path.dirname(filename), target))) throw new Error("Snapshot checkpoint cannot follow an external symbolic link");
      const resolved = await realpath(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(path.dirname(filename), target); throw error; });
      if (!owned(resolved)) throw new Error("Snapshot checkpoint symbolic link chain escapes its workspace");
      if (++files > maxFiles) throw new Error("Snapshot checkpoint exceeds 100000 files");
      const after = await lstat(filename);
      if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || target !== await readlink(filename)) throw new Error("Snapshot symbolic link changed during checkpoint hashing");
      append([relative, "link", mode, target]);
    } else if (before.isDirectory()) {
      if (++directories > maxFiles) throw new Error("Snapshot checkpoint exceeds 100000 directories");
      if (await realpath(filename) !== filename) throw new Error("Snapshot checkpoint directory ownership changed");
      const names = (await readdir(filename)).sort();
      append([relative, "directory", mode]);
      for (const name of names) await visit(path.join(relative, name), depth + 1);
      const after = await lstat(filename);
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(filename) !== filename || JSON.stringify(names) !== JSON.stringify((await readdir(filename)).sort())) throw new Error("Snapshot directory changed during checkpoint hashing");
    } else if (before.isFile()) {
      bytes += before.size;
      if (++files > maxFiles || before.size > maxFileBytes || bytes > maxBytes) throw new Error("Snapshot checkpoint exceeds its bounded 100000-file, 512 MiB per file or 2 GiB total limit");
      const descriptor = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await descriptor.stat();
        if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || await realpath(filename) !== filename) throw new Error("Snapshot file ownership changed while opening it");
        // Git refreshes inode/mtime caches inside the index during harmless
        // read diagnostics. Cache validity follows staged entries, not those
        // bookkeeping bytes; stage/blob/mode/path changes still invalidate it.
        const index = relative === path.join(".git", "index") ? await readGitIndexState(root) : undefined;
        const content = createHash("sha256");
        if (!index) for await (const chunk of descriptor.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); content.update(chunk as Buffer); }
        const after = await descriptor.stat(), current = await lstat(filename);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || current.isSymbolicLink() || await realpath(filename) !== filename) throw new Error("Snapshot file changed during checkpoint hashing");
        append(index ? [relative, "git-index", mode, index] : [relative, "file", mode, before.size, content.digest("hex")]);
      } finally { await descriptor.close(); }
    } else throw new Error("Snapshot checkpoint contains an unsupported filesystem entry");
  };
  await visit("", 0);
  await assertOwnedGit(root);
  const current = await lstat(workspace.root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || await realpath(workspace.root) !== root) throw new Error("Snapshot root changed during checkpoint hashing");
  return `snapshot-v1:${digest.digest("hex")}`;
}
