import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { gitCommand } from "./submodules.ts";

interface DirectoryIdentity { path: string; dev: string; ino: string }
export interface LocalGitScope {
  project: DirectoryIdentity;
  entry?: { dev: string; ino: string; kind: "directory" | "file" | "link" | "other" };
  git?: DirectoryIdentity;
  common?: DirectoryIdentity;
  state: "absent" | "contained" | "restricted";
  writableRoots: string[];
}

const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
async function identity(name: string): Promise<DirectoryIdentity> {
  const canonical = await realpath(name), stat = await lstat(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Local Git write scope requires real directories");
  return { path: canonical, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

// This is an internal capability for newly previewed local write plans. It can
// reopen only this project's own .git, never a shared worktree/common directory.
export async function captureLocalGitScope(cwd: string): Promise<LocalGitScope> {
  const requested = await lstat(cwd, { bigint: true });
  if (!requested.isDirectory() || requested.isSymbolicLink() || await realpath(cwd) !== path.resolve(cwd)) throw new Error("Local Git write scope requires the unchanged canonical project directory without symbolic links");
  const project = await identity(cwd), roots = [project.path];
  if (project.path !== path.resolve(cwd) || project.dev !== requested.dev.toString() || project.ino !== requested.ino.toString()) throw new Error("Local project directory identity changed while capturing Git write scope");
  let stat;
  try { stat = await lstat(path.join(project.path, ".git"), { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { project, state: "absent", writableRoots: roots };
    throw error;
  }
  const entry: NonNullable<LocalGitScope["entry"]> = { dev: stat.dev.toString(), ino: stat.ino.toString(), kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
  const restricted: LocalGitScope = { project, entry, state: "restricted", writableRoots: roots };
  // A Git file may point at shared metadata outside this project. Ordinary
  // source editing remains available, but no metadata write grant is inferred.
  if (entry.kind !== "directory") return restricted;
  try {
    const [actualName, commonName, topName] = await Promise.all([
      gitCommand(project.path, ["rev-parse", "--absolute-git-dir"]),
      gitCommand(project.path, ["rev-parse", "--git-common-dir"]),
      gitCommand(project.path, ["rev-parse", "--show-toplevel"]),
    ]);
    const [git, common, top] = await Promise.all([
      identity(actualName.trim()), identity(path.resolve(project.path, commonName.trim())), realpath(topName.trim()),
    ]);
    const metadata = path.join(project.path, ".git");
    if (top !== project.path || !within(metadata, git.path) || !within(metadata, common.path)) return { ...restricted, git, common };
    return { project, entry, git, common, state: "contained", writableRoots: [...roots, metadata] };
  } catch { return restricted; }
}

export async function validateLocalGitScope(scope: LocalGitScope): Promise<void> {
  const current = await captureLocalGitScope(scope.project.path);
  if (JSON.stringify(current) !== JSON.stringify(scope)) throw new Error("Local project Git metadata identity or writable scope changed before worker dispatch. Create a new preview after checking the project.");
}
