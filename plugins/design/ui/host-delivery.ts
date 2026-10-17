import type { App } from '@modelcontextprotocol/ext-apps';

export interface HostPromptIntent { isCurrent(): boolean }
export interface HostPromptResult { status: 'sent' | 'not-sent' | 'unknown' | 'cancelled'; reason?: string }
type MessageHost = Pick<App, 'getHostCapabilities' | 'sendMessage'>;
type DisplayHost = Pick<App, 'requestDisplayMode'>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function current(intent?: HostPromptIntent) { try { return intent?.isCurrent() ?? true; } catch { return false; } }

/** Send one complete request without changing the host's persistent model context. */
export async function deliverHostPrompt(host: MessageHost, text: string, intent?: HostPromptIntent, timeoutMs = 30_000): Promise<HostPromptResult> {
  if (!current(intent)) return { status: 'cancelled', reason: '当前项目或编辑器已变化，未发送旧需求。' };
  try {
    if (!host.getHostCapabilities()?.message?.text) return { status: 'not-sent', reason: '当前宿主未声明发送聊天消息的能力。完整需求已保留，可复制到当前聊天。' };
  } catch (error) { return { status: 'not-sent', reason: `尚未发送：无法确认宿主能力（${errorMessage(error)}）。完整需求已保留。` }; }
  // There must be no awaited operation between this ownership check and ui/message.
  if (!current(intent)) return { status: 'cancelled', reason: '当前项目或编辑器已变化，未发送旧需求。' };
  try {
    const result = await host.sendMessage({ role: 'user', content: [{ type: 'text', text }] }, { timeout: timeoutMs });
    return result.isError
      ? { status: 'not-sent', reason: '宿主明确报告需求未送达。完整需求已保留，可核对后手动发送。' }
      : { status: 'sent' };
  } catch (error) {
    // A timeout, protocol error or lost connection cannot establish non-delivery.
    // Never retry here: the host may already have accepted the original message.
    return { status: 'unknown', reason: `投递结果未知：${errorMessage(error)}。宿主可能已收到需求；请先查看当前聊天，避免重复发送。完整需求已保留。` };
  }
}

export interface HostDisplayResult { status: 'changed' | 'not-changed' | 'unknown' | 'cancelled'; mode?: 'inline' | 'fullscreen' | 'pip'; reason?: string }
export async function requestHostDisplayMode(host: DisplayHost, mode: 'inline' | 'fullscreen', intent?: HostPromptIntent): Promise<HostDisplayResult> {
  if (!current(intent)) return { status: 'cancelled' };
  try {
    const result = await host.requestDisplayMode({ mode }, { timeout: 30_000 });
    return result.mode === mode ? { status: 'changed', mode: result.mode } : { status: 'not-changed', mode: result.mode, reason: '宿主保留了当前显示方式。可继续使用当前工作区。' };
  } catch (error) { return { status: 'unknown', reason: `显示切换未确认：${errorMessage(error)}。可继续使用当前工作区。` }; }
}
