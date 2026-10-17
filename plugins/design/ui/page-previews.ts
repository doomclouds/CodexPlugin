export const PAGE_PREVIEW_LIMITS = { concurrent: 2, liveFrames: 4, cacheBytes: 64 * 1024 * 1024 } as const;
export interface PagePreviewResource { projectId: string; revision: number; pageId: string; html: string; sources: unknown[] }
export const pagePreviewKey = (projectId: string, revision: number, pageId: string) => `${projectId}:${revision}:${pageId}`;
export function previewResourceBytes(value: PagePreviewResource, registryOnly = false): number {
  const { html, ...registry } = value;
  return new TextEncoder().encode(JSON.stringify(registry)).byteLength + (registryOnly ? 0 : new TextEncoder().encode(html).byteLength);
}
export class PreviewBudgetError extends Error { constructor(message = "预览缓存超过 64 MiB 预算。请减少显示页面或选择较小的源码与资源。") { super(message); this.name = "PreviewBudgetError"; } }
export class PreviewStaleError extends Error { constructor() { super("页面请求已属于旧项目或修订，未缓存其结果。"); this.name = "PreviewStaleError"; } }
export function limitLiveBoards<T>(items: T[]): { allowed: T[]; rejected: T[] } { return { allowed: items.slice(0, PAGE_PREVIEW_LIMITS.liveFrames), rejected: items.slice(PAGE_PREVIEW_LIMITS.liveFrames) }; }
interface Entry<T> { value: T; registryOnly: boolean; bytes: number }
interface Job<T> { key: string; scope: string; priority: number; registryOnly: boolean; load: () => Promise<T>; promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

export class PagePreviewPool<T extends PagePreviewResource> {
  private scope = "";
  private entries = new Map<string, Entry<T>>();
  private protectedKeys = new Set<string>();
  private jobs = new Map<string, Job<T>>();
  private queue: Job<T>[] = [];
  private active = 0;
  private bytes = 0;
  private maxBytes: number;
  private concurrency: number;
  private onEvict?: (key: string, value: T, reason: "delete" | "budget" | "scope") => void;
  constructor(options: { maxBytes?: number; concurrency?: number; onEvict?: (key: string, value: T, reason: "delete" | "budget" | "scope") => void } = {}) {
    this.maxBytes = options.maxBytes ?? PAGE_PREVIEW_LIMITS.cacheBytes; this.concurrency = options.concurrency ?? PAGE_PREVIEW_LIMITS.concurrent; this.onEvict = options.onEvict;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > PAGE_PREVIEW_LIMITS.cacheBytes || !Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > PAGE_PREVIEW_LIMITS.concurrent) throw new Error("Invalid page preview budget.");
  }
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    for (const job of this.queue) { job.reject(new PreviewStaleError()); if (this.jobs.get(`${job.scope}\0${job.key}`) === job) this.jobs.delete(`${job.scope}\0${job.key}`); }
    this.queue = []; for (const key of [...this.entries.keys()]) this.delete(key, "scope"); this.protectedKeys.clear();
    // Old running RPCs keep their slots until they actually settle.
  }
  setProtected(keys: Iterable<string>): void { this.protectedKeys = new Set(keys); }
  private read(key: string, full: boolean): T | undefined {
    const entry = this.entries.get(key); if (!entry || full && entry.registryOnly) return;
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  get(key: string): T | undefined { return this.read(key, true); }
  getRegistry(key: string): T | undefined { return this.read(key, false); }
  values(): Array<{ key: string; value: T; registryOnly: boolean }> { return [...this.entries].map(([key, entry]) => ({ key, value: entry.value, registryOnly: entry.registryOnly })); }
  put(key: string, value: T, options: { registryOnly?: boolean } = {}): void {
    if (pagePreviewKey(value.projectId, value.revision, value.pageId) !== key) throw new PreviewStaleError();
    const registryOnly = options.registryOnly === true, stored = registryOnly ? { ...value, html: "" } : value, bytes = previewResourceBytes(stored, registryOnly), previous = this.entries.get(key);
    if (bytes > this.maxBytes) throw new PreviewBudgetError("此页 HTML 与源码注册表单独超过预览缓存预算，未缓存或实例化。请减少源码、内嵌资源或页面规模。");
    let required = this.bytes - (previous?.bytes ?? 0) + bytes;
    const victims: string[] = [];
    for (const [candidate, entry] of this.entries) { if (required <= this.maxBytes) break; if (candidate === key || this.protectedKeys.has(candidate)) continue; victims.push(candidate); required -= entry.bytes; }
    if (required > this.maxBytes) throw new PreviewBudgetError("当前显示页面已占用预览缓存预算，未逐出可见板。请减少选择的页面后重试。");
    for (const victim of victims) this.delete(victim, "budget");
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    this.entries.set(key, { value: stored, registryOnly, bytes }); this.bytes += bytes;
  }
  delete(key: string, reason: "delete" | "budget" | "scope" = "delete"): void { const entry = this.entries.get(key); if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; this.onEvict?.(key, entry.value, reason); } }
  stats() { return { active: this.active, queued: this.queue.length, cachedBytes: this.bytes, cachedEntries: this.entries.size }; }
  request(key: string, load: () => Promise<T>, options: { scope?: string; priority?: "visible" | "background"; registryOnly?: boolean } = {}): Promise<T> {
    const scope = options.scope ?? this.scope; if (scope !== this.scope) return Promise.reject(new PreviewStaleError());
    const cached = options.registryOnly ? this.getRegistry(key) : this.get(key); if (cached) return Promise.resolve(cached);
    const jobId = `${scope}\0${key}`, existing = this.jobs.get(jobId);
    if (existing) { if (options.priority !== "background") existing.priority = 0; if (!options.registryOnly) existing.registryOnly = false; this.pump(); return existing.promise; }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const job: Job<T> = { key, scope, priority: options.priority === "background" ? 1 : 0, registryOnly: !!options.registryOnly, load, promise, resolve, reject };
    this.jobs.set(jobId, job); this.queue.push(job); this.pump(); return promise;
  }
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority); const job = this.queue.shift()!;
      if (job.scope !== this.scope) { job.reject(new PreviewStaleError()); continue; }
      this.active++;
      void Promise.resolve().then(job.load).then(value => {
        if (job.scope !== this.scope) throw new PreviewStaleError();
        this.put(job.key, value, { registryOnly: job.registryOnly }); return job.registryOnly ? this.getRegistry(job.key)! : value;
      }).then(value => { this.finish(job); job.resolve(value); this.pump(); }, error => { this.finish(job); job.reject(error); this.pump(); });
    }
  }
  private finish(job: Job<T>): void { this.active--; const id = `${job.scope}\0${job.key}`; if (this.jobs.get(id) === job) this.jobs.delete(id); }
}
