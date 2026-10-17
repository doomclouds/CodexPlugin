import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { validateCodeProject } from './code-project.ts';
import type { CodeProject } from './code-project.ts';
import { crc32 } from './zip.ts';

export const MAX_CODE_PROJECT_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_CODE_PROJECT_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
interface ArchiveEntry { name: string; directory: boolean; version: number; flags: number; method: number; crc: number; compressed: number; expanded: number; offset: number }

function invalid(reason: string): never { throw new Error(`Invalid Design project archive: ${reason}`); }
function bounded(bytes: Buffer, offset: number, length: number, end = bytes.length): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > end) invalid('a ZIP record exceeds its bounds.');
}
function extraFields(bytes: Buffer, offset: number, length: number): void {
  const end = offset + length;
  while (offset < end) {
    bounded(bytes, offset, 4, end);
    const type = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); offset += 4;
    bounded(bytes, offset, size, end);
    if (type === 1) invalid('ZIP64 entries are unsupported.');
    offset += size;
  }
}
function filename(bytes: Buffer): string {
  let name: string; try { name = utf8.decode(bytes); } catch { invalid('filenames must use valid UTF-8.'); }
  const parts = name!.replace(/\/$/, '').split('/');
  if (!name! || /[\\\x00-\x1f\x7f:#?%<>"|*]/u.test(name!) || parts.some(part => !part || part === '.' || part === '..')) invalid('unsafe ZIP filename.');
  return name!;
}
function endRecord(bytes: Buffer): number {
  if (bytes.length < 22) invalid('the ZIP end record is missing.');
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  return invalid('the ZIP end record is missing or has trailing bytes.');
}

/** Read only the current Design export format; no archive path is extracted or executed. */
export function parseCodeProjectArchive(input: Uint8Array): { project: CodeProject; sha256: string } {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_CODE_PROJECT_ARCHIVE_BYTES) invalid('the ZIP exceeds the 32 MiB transfer budget.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength), end = endRecord(bytes);
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) invalid('multi-disk archives are unsupported.');
  if (!count || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) invalid('empty or ZIP64 archives are unsupported.');
  bounded(bytes, directoryOffset, directorySize, end);
  if (directoryOffset + directorySize !== end || count * 46 > directorySize) invalid('the central directory is inconsistent.');
  const entries: ArchiveEntry[] = [], names = new Set<string>(); let cursor = directoryOffset, expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    bounded(bytes, cursor, 46, end);
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('the central entry signature is invalid.');
    const version = bytes.readUInt16LE(cursor + 6), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32), attrs = bytes.readUInt32LE(cursor + 38), offset = bytes.readUInt32LE(cursor + 42);
    bounded(bytes, cursor + 46, nameSize + extraSize + commentSize, end);
    if ((version !== 10 && version !== 20) || ((method === 8 || (flags & 8)) && version !== 20) || compressed === 0xffffffff || expanded === 0xffffffff || offset === 0xffffffff) invalid('ZIP64 or unsupported ZIP versions are unsupported.');
    if (bytes.readUInt16LE(cursor + 34)) invalid('multi-disk entries are unsupported.');
    if (method !== 0 && method !== 8) invalid('only stored or DEFLATE entries are supported.');
    if (flags & ~(0x800 | 8 | (method === 8 ? 6 : 0))) invalid('encrypted or unsupported ZIP flags.');
    const name = filename(bytes.subarray(cursor + 46, cursor + 46 + nameSize)), directory = name.endsWith('/'), key = name.replace(/\/$/, '').toLowerCase(), unixType = attrs >>> 16 & 0xf000;
    if (names.has(key)) invalid('duplicate or case-colliding filenames.');
    names.add(key);
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000 || (unixType === 0x4000 || Boolean(attrs & 0x10)) && !directory || unixType === 0x8000 && directory) invalid('symbolic links or inconsistent entry types.');
    if (directory && expanded !== 0) invalid('directories cannot contain data.');
    expandedTotal += expanded;
    if (expandedTotal > MAX_CODE_PROJECT_ARCHIVE_EXPANDED_BYTES) invalid('the expanded ZIP exceeds the 32 MiB budget.');
    extraFields(bytes, cursor + 46 + nameSize, extraSize);
    entries.push({ name, directory, version, flags, method, crc, compressed, expanded, offset });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) invalid('unlisted central directory data.');

  const files = new Map<string, Buffer>(); let localEnd = 0;
  for (const entry of entries.slice().sort((left, right) => left.offset - right.offset)) {
    const offset = entry.offset;
    if (offset !== localEnd) invalid('overlapping, unlisted or prefixed local data.');
    bounded(bytes, offset, 30, directoryOffset);
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 4) !== entry.version || bytes.readUInt16LE(offset + 6) !== entry.flags || bytes.readUInt16LE(offset + 8) !== entry.method) invalid('local and central ZIP headers disagree.');
    const nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    bounded(bytes, offset + 30, nameSize + extraSize + entry.compressed, directoryOffset);
    if (filename(bytes.subarray(offset + 30, offset + 30 + nameSize)) !== entry.name) invalid('local and central filenames disagree.');
    extraFields(bytes, offset + 30 + nameSize, extraSize);
    for (const [field, expected] of [[14, entry.crc], [18, entry.compressed], [22, entry.expanded]] as const) {
      const actual = bytes.readUInt32LE(offset + field);
      if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) invalid('local and central ZIP sizes or CRC disagree.');
    }
    const dataOffset = offset + 30 + nameSize + extraSize, compressed = bytes.subarray(dataOffset, dataOffset + entry.compressed);
    let data: Buffer;
    if (entry.method === 0) { if (entry.compressed !== entry.expanded) invalid('stored entry sizes disagree.'); data = compressed; }
    else {
      try {
        const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== compressed.length) invalid('unconsumed DEFLATE data.');
        data = inflated.buffer;
      } catch { invalid('invalid or oversized DEFLATE data.'); }
    }
    if (data!.length !== entry.expanded || crc32(data!) !== entry.crc) invalid('expanded entry size or CRC does not match.');
    localEnd = dataOffset + entry.compressed;
    if (entry.flags & 8) {
      bounded(bytes, localEnd, 12, directoryOffset);
      // CRC can itself equal the optional signature. Prefer a matching signed record,
      // then the ordinary unsigned descriptor rather than guessing from CRC alone.
      const matches = (at: number) => at + 12 <= directoryOffset && bytes.readUInt32LE(at) === entry.crc && bytes.readUInt32LE(at + 4) === entry.compressed && bytes.readUInt32LE(at + 8) === entry.expanded;
      if (bytes.readUInt32LE(localEnd) === 0x08074b50 && matches(localEnd + 4)) localEnd += 16;
      else if (matches(localEnd)) localEnd += 12;
      else invalid('the ZIP data descriptor is inconsistent.');
    }
    if (!entry.directory) files.set(entry.name, data!);
  }
  if (localEnd !== directoryOffset) invalid('unlisted local data before the central directory.');
  const manifest = files.get('design-project.json');
  if (!manifest || !files.has('prototype.html')) invalid('design-project.json and prototype.html are required.');
  let value: unknown;
  try { value = JSON.parse(utf8.decode(manifest)); } catch { invalid('the project manifest is not valid UTF-8 JSON.'); }
  const project = validateCodeProject(value), expected = new Set(['design-project.json', 'prototype.html']), directories = new Set(['source/']);
  for (const file of project.files) {
    const name = `source/${file.path}`, actual = files.get(name), wanted = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (!actual || !actual.equals(wanted)) invalid(`source bytes do not match the manifest: ${file.path}.`);
    expected.add(name);
    const parts = name.split('/'); for (let part = 1; part < parts.length; part++) directories.add(`${parts.slice(0, part).join('/')}/`);
  }
  for (const entry of entries) if (!(entry.directory ? directories : expected).has(entry.name)) invalid(`unexpected archive member: ${entry.name}.`);
  return { project, sha256: createHash('sha256').update(bytes).digest('hex') };
}
