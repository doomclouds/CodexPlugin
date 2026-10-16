import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { mountEditor, type EditorBridge } from "./editor.ts";
import "./editor.css";

const root = document.getElementById("design-editor");
if (!root) throw new Error("Design editor root is missing");

function unpack(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("MCP 服务返回了无效结果。");
  const result = value as Record<string, unknown>;
  const content = Array.isArray(result.content) ? result.content as { type?: string; text?: string }[] : [];
  if (result.isError) throw new Error(content.filter(block => block.type === "text").map(block => block.text).join("\n") || "MCP 工具调用失败。");
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
  for (const block of content) if (block.type === "text" && block.text) {
    try { const data: unknown = JSON.parse(block.text); if (data && typeof data === "object") return data as Record<string, unknown>; }
    catch { /* Plain text tool results are not structured documents. */ }
  }
  return result;
}

const previewToken = (globalThis as typeof globalThis & { __DESIGN_PREVIEW_TOKEN__?: string }).__DESIGN_PREVIEW_TOKEN__;
if (window.parent === window && previewToken) {
  const bridge: EditorBridge = {
    async callTool(name, args) {
      const response = await fetch("/tool", { method: "POST", headers: { "content-type": "application/json", "x-design-preview": previewToken }, body: JSON.stringify({ name, arguments: args }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result && "error" in result ? String(result.error) : `本地预览请求失败：${response.status}`);
      return unpack(result);
    },
    async prompt() { return { sent: false, reason: "这是开发预览，没有当前聊天宿主。请复制提示词到 Codex 聊天，再通过真实 Design 工具继续。" }; },
    async download(file) {
      const blob = file.dataBase64 !== undefined ? new Blob([Uint8Array.from(atob(file.dataBase64), char => char.charCodeAt(0))], { type: file.mimeType }) : new Blob([file.text ?? ""], { type: file.mimeType });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { saved: true };
    },
    async openLink(url) { const anchor = document.createElement("a"); anchor.href = url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.click(); return { opened: true }; },
  };
  const editor = mountEditor(root, bridge);
  void editor.connected();
  window.addEventListener("pagehide", () => { void editor.teardown(); });
} else {
  const app = new App({ name: "Design", version: "0.1.1" }, { availableDisplayModes: ["fullscreen"] }, { autoResize: true });
  const editor = mountEditor(root, {
    async callTool(name, args) { return unpack(await app.callServerTool({ name, arguments: args }, { timeout: name === "design_list_models" ? 30000 : 120000 })); },
    async prompt(text, context) {
      const capabilities = app.getHostCapabilities();
      if (!capabilities?.message?.text) return { sent: false, reason: "当前宿主未声明发送聊天消息的能力。请复制完整提示词回到当前聊天。" };
      try {
        if (capabilities.updateModelContext?.text && context !== undefined) await app.updateModelContext({ content: [{ type: "text", text: `当前 Design 编辑器上下文：\n${JSON.stringify(context, null, 2)}` }] });
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: context !== undefined && !capabilities.updateModelContext?.text ? `${text}\n\nDesign 上下文：\n${JSON.stringify(context, null, 2)}` : text }] });
        if (result.isError) return { sent: false, reason: "宿主拒绝了聊天消息。请复制提示词回到当前聊天。" };
        return { sent: true };
      } catch (error) { return { sent: false, reason: `未能向当前聊天发送需求：${error instanceof Error ? error.message : String(error)}。请复制下方提示词。` }; }
    },
    async download(file) {
      if (!app.getHostCapabilities()?.downloadFile) return { saved: false, unsupported: true };
      try {
        const resource = { uri: `file:///${encodeURIComponent(file.filename)}`, mimeType: file.mimeType, ...(file.dataBase64 !== undefined ? { blob: file.dataBase64 } : { text: file.text ?? "" }) };
        const result = await app.downloadFile({ contents: [{ type: "resource", resource }] });
        return result.isError ? { saved: false, reason: "宿主未完成下载，可能已被取消。" } : { saved: true };
      } catch (error) { return { saved: false, reason: `下载失败：${error instanceof Error ? error.message : String(error)}` }; }
    },
    async openLink(url) {
      if (!app.getHostCapabilities()?.openLinks) return { opened: false, reason: "当前宿主未声明打开外部链接的能力。请导出 HTML 后测试此链接。" };
      try { const result = await app.openLink({ url }); return result.isError ? { opened: false, reason: "宿主未打开此链接。" } : { opened: true }; }
      catch (error) { return { opened: false, reason: `打开链接失败：${error instanceof Error ? error.message : String(error)}` }; }
    },
  });
  let pendingProjectId = "";
  function hostContext(context: Record<string, unknown>) {
    if (context.theme === "light" || context.theme === "dark") {
      applyDocumentTheme(context.theme);
      document.documentElement.dataset.hostTheme = context.theme;
    }
    const styles = context.styles as { variables?: Parameters<typeof applyHostStyleVariables>[0]; css?: { fonts?: string } } | undefined;
    if (styles?.variables) applyHostStyleVariables(styles.variables);
    if (styles?.css?.fonts) applyHostFonts(styles.css.fonts);
  }
  app.onhostcontextchanged = hostContext;
  app.ontoolinput = input => { if (typeof input.arguments?.projectId === "string") { pendingProjectId = input.arguments.projectId; void editor.setProjectId(pendingProjectId); } };
  app.ontoolresult = result => editor.receive(result);
  app.onteardown = async () => { await editor.teardown(); return {}; };
  window.addEventListener("pagehide", () => { void editor.teardown(); });
  if (window.parent !== window) {
    editor.connecting();
    app.connect().then(async () => {
      const context = app.getHostContext(); if (context) hostContext(context);
      document.documentElement.dataset.designHostConnected = "true";
      await editor.connected();
      if (pendingProjectId) await editor.setProjectId(pendingProjectId);
    }).catch(error => editor.disconnected(error));
  }
}
