import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export type ExportFormat = 'html' | 'zip' | 'png' | 'pdf';
export interface ExportIdentity { projectId: string; revision: number; pageId: string; format: ExportFormat }
export interface ExportArtifactMetadata extends ExportIdentity {
  artifactId: string; expiresAt: string; sha256: string; filename: string; mimeType: string; bytes: number;
}
export interface InlineExportArtifact extends ExportArtifactMetadata { delivery: 'inline'; dataBase64: string }
export interface StoredExportArtifact extends ExportArtifactMetadata { delivery: 'artifact' }
export type ExportArtifact = InlineExportArtifact | StoredExportArtifact;
export interface SavedExportArtifact extends ExportArtifactMetadata { path: string }
interface RecordEntry extends ExportArtifactMetadata {
  buffer: Buffer; expires: number; saving?: Promise<SavedExportArtifact>; saved?: SavedExportArtifact;
}
type ArtifactErrorCode = 'EXPORT_ARTIFACT_EXPIRED' | 'EXPORT_ARTIFACT_UNAVAILABLE' | 'EXPORT_ARTIFACT_LIMIT' | 'EXPORT_ARTIFACT_DISPOSED' | 'EXPORT_SAVE_FAILED';
export class ExportArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.code = code; this.name = 'ExportArtifactError'; }
}
export const EXPORT_ARTIFACT_LIMITS = { ttlMs: 10 * 60 * 1000, entries: 16, bytes: 64 * 1024 * 1024, artifactBytes: 32 * 1024 * 1024 } as const;
// Base64 is included in both MCP text and structured content. Keep their combined wire payload below the SDK default 10 MiB read buffer.
export const EXPORT_INLINE_MAX_BYTES = 3 * 1024 * 1024;
const mimeTypes: Record<ExportFormat, string> = { html: 'text/html', zip: 'application/zip', png: 'image/png', pdf: 'application/pdf' };
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const artifactPattern = /^export_[a-f0-9]{32}$/;

/** Server-owned immutable bytes. Expiry or capacity eviction never triggers another export. */
export class ExportArtifacts {
  private readonly records = new Map<string, RecordEntry>();
  private readonly unavailable = new Map<string, 'expired' | 'capacity'>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly directory: string;
  private readonly sweep: ReturnType<typeof setInterval>;
  private totalBytes = 0;
  private disposed = false;

  constructor(options: { dataDir: string; ttlMs?: number; maxBytes?: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = options.ttlMs ?? EXPORT_ARTIFACT_LIMITS.ttlMs;
    this.maxBytes = options.maxBytes ?? EXPORT_ARTIFACT_LIMITS.bytes;
    this.maxEntries = options.maxEntries ?? EXPORT_ARTIFACT_LIMITS.entries;
    if (!path.isAbsolute(options.dataDir) || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > EXPORT_ARTIFACT_LIMITS.ttlMs || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > EXPORT_ARTIFACT_LIMITS.bytes || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > EXPORT_ARTIFACT_LIMITS.entries) throw new Error('Invalid bounded export artifact cache options.');
    this.directory = path.join(options.dataDir, 'exports');
    this.now = options.now ?? Date.now;
    this.sweep = setInterval(() => this.prune(), Math.min(this.ttlMs, 60_000));
    this.sweep.unref();
  }

  get usage(): { entries: number; bytes: number } { return { entries: this.records.size, bytes: this.totalBytes }; }

  register(identity: ExportIdentity, file: { filename: string; mimeType: string; dataBase64: string }): ExportArtifact {
    this.assertOpen(); this.prune();
    if (!idPattern.test(identity.projectId) || !idPattern.test(identity.pageId) || !Number.isSafeInteger(identity.revision) || identity.revision < 1 || !Object.hasOwn(mimeTypes, identity.format) || file.mimeType !== mimeTypes[identity.format] || !file.filename || file.filename.length > 200 || path.basename(file.filename) !== file.filename || /[\\\x00-\x1f]/.test(file.filename) || !file.filename.endsWith('.' + identity.format)) throw new Error('Invalid generated export identity or filename.');
    if (typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(EXPORT_ARTIFACT_LIMITS.artifactBytes / 3) * 4 || file.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) throw new Error('Invalid export bytes or export exceeds the 32 MiB transfer budget.');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    if (bytes.length > EXPORT_ARTIFACT_LIMITS.artifactBytes || bytes.toString('base64') !== file.dataBase64) throw new Error('Invalid export bytes or export exceeds the 32 MiB transfer budget.');
    if (bytes.length > this.maxBytes) throw new ExportArtifactError('EXPORT_ARTIFACT_LIMIT', 'This export exceeds the artifact cache byte budget. No fallback artifact was retained.');
    while (this.records.size >= this.maxEntries || this.totalBytes + bytes.length > this.maxBytes) {
      const oldest = [...this.records.values()].find(record => !record.saving);
      if (!oldest) throw new ExportArtifactError('EXPORT_ARTIFACT_LIMIT', 'The export cache is occupied by saves in progress. Wait for them to finish before exporting again.');
      this.remove(oldest, 'capacity');
    }
    let artifactId: string;
    do { artifactId = 'export_' + randomUUID().replaceAll('-', ''); } while (this.records.has(artifactId) || this.unavailable.has(artifactId));
    const expires = this.now() + this.ttlMs, metadata = { ...identity, artifactId, expiresAt: new Date(expires).toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), filename: file.filename, mimeType: file.mimeType, bytes: bytes.length };
    this.records.set(artifactId, { ...metadata, buffer: bytes, expires }); this.totalBytes += bytes.length;
    return bytes.length <= EXPORT_INLINE_MAX_BYTES ? { ...metadata, delivery: 'inline', dataBase64: file.dataBase64 } : { ...metadata, delivery: 'artifact' };
  }

  async save(artifactId: string): Promise<SavedExportArtifact> {
    this.assertOpen(); this.prune();
    const record = this.records.get(artifactId);
    if (!artifactPattern.test(artifactId) || !record) {
      if (this.unavailable.get(artifactId) === 'expired') throw new ExportArtifactError('EXPORT_ARTIFACT_EXPIRED', 'This export artifact expired. Explicitly export again to create a new snapshot.');
      throw new ExportArtifactError('EXPORT_ARTIFACT_UNAVAILABLE', 'This export artifact is unavailable, was evicted by the cache budget, or belongs to another server session. Explicitly export again to create a new snapshot.');
    }
    if (record.expires <= this.now()) throw new ExportArtifactError('EXPORT_ARTIFACT_EXPIRED', 'This export artifact expired. A save already in progress may finish, but no new save will start.');
    if (record.saved) return { ...record.saved };
    if (!record.saving) {
      // Pin bytes during a save, including when TTL elapses. New exports cannot exceed the budget.
      record.saving = this.write(record).then(saved => { record.saved = saved; return saved; }).finally(() => { record.saving = undefined; this.prune(); });
    }
    return { ...await record.saving };
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.sweep); this.records.clear(); this.unavailable.clear(); this.totalBytes = 0; }

  private assertOpen(): void { if (this.disposed) throw new ExportArtifactError('EXPORT_ARTIFACT_DISPOSED', 'The export artifact server session is closed.'); }
  private prune(): void { if (this.disposed) return; const now = this.now(); for (const record of this.records.values()) if (record.expires <= now && !record.saving) this.remove(record, 'expired'); }
  private remove(record: RecordEntry, reason: 'expired' | 'capacity'): void {
    this.records.delete(record.artifactId); this.totalBytes -= record.buffer.length; this.unavailable.set(record.artifactId, reason);
    // Tombstones contain no source bytes and are bounded independently of active artifacts.
    while (this.unavailable.size > 128) this.unavailable.delete(this.unavailable.keys().next().value!);
  }
  private async write(record: RecordEntry): Promise<SavedExportArtifact> {
    const target = path.join(this.directory, `${record.artifactId}-${randomUUID()}-${record.filename}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined, created = false;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); this.assertOpen();
      const info = await lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The plugin export directory must be a real directory.');
      handle = await open(target, 'wx', 0o600); created = true; this.assertOpen();
      await handle.writeFile(record.buffer); await handle.sync(); await handle.close(); handle = undefined;
      const { buffer: _buffer, expires: _expires, saving: _saving, saved: _saved, ...metadata } = record;
      return { ...metadata, path: target };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await unlink(target).catch(() => {});
      if (error instanceof ExportArtifactError) throw error;
      throw new ExportArtifactError('EXPORT_SAVE_FAILED', 'The exact export snapshot could not be saved. Its artifact remains available until expiry or cache eviction; retry with the same artifactId.', { cause: error });
    }
  }
}
