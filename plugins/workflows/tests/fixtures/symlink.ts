import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

export async function requireFileSymlinks(t: TestContext, directory: string): Promise<boolean> {
  const probe = await mkdtemp(path.join(directory, "file-symlink-probe-"));
  try {
    await writeFile(path.join(probe, "target.txt"), "Real file-symlink probe\n");
    const link = path.join(probe, "link.txt");
    try { await symlink("target.txt", link, "file"); }
    catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("Windows denied the real file-symlink capability probe (EPERM).");
      return false;
    }
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(link, "utf8"), "Real file-symlink probe\n");
    return true;
  } finally { await rm(probe, { recursive: true, force: true }); }
}
