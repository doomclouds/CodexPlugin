import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version.ts';

export interface CodexModel { id: string; displayName: string; isDefault: boolean; supportedReasoningEfforts?: string[] }
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const MAX_BYTES = 4 * 1024 * 1024;
const disabledFeatures = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'multi_agent_v2', 'hooks', 'skill_mcp_dependency_install', 'skill_search', 'memories', 'shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'image_generation', 'code_mode', 'code_mode_host', 'sleep_tool', 'goals', 'in_app_browser', 'workspace_dependencies', 'recommended_plugins', 'tool_suggest'];

export class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private stopped = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closeOperation?: Promise<void>;
  private readonly timeoutMs: number;
  onnotification: (method: string, params: ObjectValue) => void = () => {};
  onfailure: (error: Error) => void = () => {};
  constructor(command: string, cwd: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    const args = ['app-server', '--stdio', '-c', 'web_search="disabled"', '-c', 'agents.enabled=false'];
    for (const feature of disabledFeatures) args.push('-c', `features.${feature}=false`);
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.stopped = true;
      const error = new Error('The local Codex app-server exited.');
      this.rejectPending(error);
      this.onfailure(error);
      resolve();
    }));
    // Diagnostics can contain credentials or unrelated private paths. Never forward them.
    this.child.stderr.on('data', () => {});
    this.child.once('error', () => { const error = new Error('Could not start the local Codex CLI. Check that Codex is installed and available.'); this.rejectPending(error); this.onfailure(error); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES) { this.protocolFailure('Codex protocol output exceeded its size limit.'); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.protocolFailure('Codex returned malformed protocol output.'); return; }
      }
    });
    this.child.stdin.on('error', () => {});
  }
  private rejectPending(error: Error): void { for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); } this.pending.clear(); }
  private protocolFailure(message: string): void { const error = new Error(message); this.rejectPending(error); this.onfailure(error); void this.close(); }
  private receive(input: unknown): void {
    const message = object(input);
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      // The raw RPC error may contain authorization headers. Expose only the method/code.
      if (message.error) pending.reject(new Error(`Local Codex request failed (code ${typeof message.error.code === 'number' ? message.error.code : 'unknown'}).`));
      else pending.resolve(message.result);
    } else if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Design generation does not allow tools, approvals or additional input.' } });
        this.protocolFailure('Codex requested an unsupported tool or approval. Generation stopped.');
      } else this.onnotification(message.method, object(message.params));
    }
  }
  send(message: object): void { if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method: string, params: object): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('The local Codex connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Local Codex ${method} timed out.`)); }, Math.min(this.timeoutMs, 30_000));
      this.pending.set(id, { resolve, reject, timer }); this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'codex_design', title: 'Design', version: VERSION }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closeOperation = (async () => {
      if (this.stopped) return;
      this.child.stdin.end(); this.child.kill('SIGTERM');
      const force = setTimeout(() => { if (!this.stopped) this.child.kill('SIGKILL'); }, 1500);
      try { await this.closed; } finally { clearTimeout(force); }
    })(); return this.closeOperation;
  }
}


export class CodexModelCatalog {
  private readonly sessions = new Set<Session>();
  private disposed = false;
  private readonly command: string;
  private readonly timeoutMs: number;
  constructor(command = 'codex', timeoutMs = 30000) { this.command = command; this.timeoutMs = timeoutMs; }
  private assertOpen(): void { if (this.disposed) throw new Error('The Codex model catalog is disposed.'); }
  private session(cwd: string): Session { const session = new Session(this.command, cwd, this.timeoutMs); this.sessions.add(session); void session.closed.then(() => this.sessions.delete(session)); return session; }
  async listModels(): Promise<{ models: CodexModel[]; accountType?: string }> {
    this.assertOpen();
    const cwd = await mkdtemp(join(tmpdir(), 'codex-design-catalog-')); const session = this.session(cwd);
    try {
      await session.initialize();
      const account = object(object(await session.request('account/read', { refreshToken: false })).account);
      const models: CodexModel[] = []; let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = object(await session.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid model catalog.');
        for (const raw of result.data) {
          const model = object(raw);
          if (typeof model.id !== 'string' || !model.id || model.id.length > 200 || typeof model.displayName !== 'string' || model.displayName.length > 300 || typeof model.isDefault !== 'boolean') throw new Error('Codex returned an invalid model catalog entry.');
          const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((v: unknown) => object(v).reasoningEffort).filter((v: unknown): v is string => typeof v === 'string') : undefined;
          models.push({ id: model.id, displayName: model.displayName, isDefault: model.isDefault, ...(efforts ? { supportedReasoningEfforts: efforts } : {}) });
        }
        cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (cursor && seenCursors.has(cursor) || models.length > 2000) throw new Error('Codex model catalog pagination exceeded its limit.');
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return { models, ...(['chatgpt', 'apiKey', 'chatgptAuthTokens'].includes(account.type) ? { accountType: account.type } : {}) };
    } finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.sessions].map(session => session.close())); }
}
