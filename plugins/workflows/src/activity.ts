import path from "node:path";
import type { Activity } from "./types.ts";

// User-facing activity contains observed actions, never reasoning or raw argv.
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const kinds: Record<string, Activity["kind"]> = { commandExecution: "command", dynamicToolCall: "command", functionCallOutput: "command", fileChange: "files", webSearch: "search", mcpToolCall: "mcp", agentMessage: "message" };
const safeName = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && !/(?:token|secret|password|sk-|gh[pousr]_)/i.test(value) ? value : undefined;

export function commandActivityLabel(command: unknown): string {
  const first = Array.isArray(command) ? command[0] : typeof command === "string" ? command.trim().match(/^(?:[\w./-]+\s*=\s*[^\s]+\s+)*([\w./-]+)/)?.[1] : undefined;
  const executable = typeof first === "string" ? safeName(path.basename(first)) : undefined;
  if (!executable) return "执行命令";
  const args = Array.isArray(command) ? command.slice(1) : [];
  const subcommand = ["git", "npm", "pnpm", "yarn", "dotnet"].includes(executable) ? safeName(args[0]) : undefined;
  return `执行命令 · ${executable}${subcommand ? ` ${subcommand}` : ""}`;
}

export function itemActivity(value: unknown, status: Activity["status"], startedAt?: string): Activity | undefined {
  const item = object(value);
  const kind = kinds[String(item.type)];
  // Reasoning and unknown protocol items are deliberately excluded.
  if (!kind) return;
  const timestamp = new Date().toISOString();
  let label: string;
  if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") {
    const namespace = safeName(item.namespace), name = safeName(item.type === "dynamicToolCall" ? item.tool : item.name);
    label = name ? `调用原生工具 · ${namespace ? `${namespace}/` : ""}${name}` : "调用原生工具";
  } else if (kind === "command") {
    const actions = Array.isArray(item.commandActions) ? item.commandActions.map(object) : [];
    label = actions.some(action => action.type === "search") ? "搜索项目内容" : actions.some(action => action.type === "read") ? "读取项目文件" : actions.some(action => action.type === "listFiles") ? "查看项目文件" : commandActivityLabel(item.command);
  } else if (kind === "files") label = Array.isArray(item.changes) && item.changes.length ? `修改文件 · ${item.changes.length} 个` : "修改项目文件";
  else if (kind === "search") label = "搜索资料";
  else if (kind === "mcp") {
    const server = safeName(item.server), tool = safeName(item.tool);
    label = server && tool ? `调用工具 · ${server}/${tool}` : "调用已授权工具";
  } else label = item.phase === "final_answer" ? "整理任务结果" : "更新任务进展";
  return { id: typeof item.id === "string" ? item.id.slice(0, 160) : `${kind}:${timestamp}`, kind, label, status, startedAt: startedAt ?? timestamp, ...(status !== "running" ? { endedAt: timestamp } : {}) };
}
