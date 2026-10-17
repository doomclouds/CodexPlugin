import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { MAX_CODE_PROJECT_ARCHIVE_BYTES } from "./project-archive.ts";
import { DesignError } from "./validation.ts";

export interface CodeProjectArchiveInput { file?: string; dataBase64?: string }
const invalid = (message: string): never => { throw new DesignError("VALIDATION", message); };
function regular(info: BigIntStats): boolean { return info.isFile() && !info.isSymbolicLink() && info.size > 0n && info.size <= BigInt(MAX_CODE_PROJECT_ARCHIVE_BYTES); }
function unchanged(first: BigIntStats, next: BigIntStats): boolean {
  return regular(next) && first.dev === next.dev && first.ino === next.ino && first.size === next.size && first.mtimeNs === next.mtimeNs && first.ctimeNs === next.ctimeNs;
}

// The final selected file is opened without following a link and checked at
// both boundaries. Reads are bounded even if a concurrent writer grows it.
async function readArchiveFile(file: string): Promise<Uint8Array> {
  if (!isAbsolute(file) || file.length > 4096 || file.includes("\0")) return invalid("Choose an absolute local Design ZIP file path.");
  if (typeof constants.O_NOFOLLOW !== "number") return invalid("This platform cannot safely open a ZIP file without following links. Select the ZIP bytes instead.");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file, { bigint: true });
    if (!regular(before)) return invalid("Design ZIP must be a nonempty regular file up to 32 MiB, outside symbolic links.");
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!unchanged(before, await handle.stat({ bigint: true }))) return invalid("The selected ZIP file changed before it could be read. Select it again.");
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true }), afterPath = await lstat(file, { bigint: true });
    if (length !== Number(before.size) || !unchanged(before, afterHandle) || !unchanged(before, afterPath)) return invalid("The selected ZIP file changed while being read. Select it again; no project was imported.");
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof DesignError) throw error;
    return invalid("The selected ZIP could not be safely read. Choose an accessible regular file up to 32 MiB, outside symbolic links.");
  } finally { await handle?.close(); }
}

export async function readCodeProjectArchiveInput(input: CodeProjectArchiveInput): Promise<Uint8Array> {
  if ((input.file !== undefined) === (input.dataBase64 !== undefined)) return invalid("Provide exactly one Design ZIP file path or canonical base64 data.");
  if (input.file !== undefined) {
    if (typeof input.file !== "string") return invalid("Choose an absolute local Design ZIP file path.");
    return readArchiveFile(input.file);
  }
  const encoded = input.dataBase64;
  if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(MAX_CODE_PROJECT_ARCHIVE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return invalid("Design ZIP data must be canonical base64 up to 32 MiB.");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > MAX_CODE_PROJECT_ARCHIVE_BYTES) return invalid("Design ZIP exceeds the 32 MiB transfer budget.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_CODE_PROJECT_ARCHIVE_BYTES || bytes.toString("base64") !== encoded) return invalid("Design ZIP data must be canonical base64 up to 32 MiB.");
  return bytes;
}
