import { lstat, readlink, realpath } from "node:fs/promises";
import referencePath from "node:path";

export interface ReferenceFileSystem {
  realpath(filename: string): Promise<string>;
  lstat(filename: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(filename: string): Promise<string>;
}

export function isWindowsNamedPipe(value: string): boolean {
  return /^\\\\[^\\]+\\pipe(?:\\|$)/i.test(value.replaceAll("/", "\\"));
}

export async function resolveReferencePath(filename: string, filesystem: ReferenceFileSystem = { realpath, lstat, readlink }): Promise<string | undefined> {
  const visited = new Set<string>();
  let current = filename;
  for (let depth = 0; depth < 40; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    try { return await filesystem.realpath(current); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (["ENOENT", "ENOTDIR"].includes(code)) return undefined;
      if (!["EACCES", "EPERM"].includes(code) || !(await filesystem.lstat(current)).isSymbolicLink()) throw error;
      // Windows application aliases can reject realpath on the alias while
      // exposing a readable link target. Resolve that target, never waive access
      // errors or assume that an unreadable link is outside the owned run.
      const target = await filesystem.readlink(current);
      current = referencePath.isAbsolute(target) ? target : referencePath.resolve(await filesystem.realpath(referencePath.dirname(current)), target);
    }
  }
  throw Object.assign(new Error("Cannot safely resolve a cyclic or excessive MCP reference link chain"), { code: "ELOOP" });
}
