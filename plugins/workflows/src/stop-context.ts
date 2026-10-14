export type WorkflowStopReason = "requested" | "panel-closed" | "lease-expired" | "service-shutdown" | "owner-exited";

export function stopSummary(reason?: WorkflowStopReason): string {
  switch (reason) {
    case "requested": return "已按停止请求中断，进度已保存。";
    case "panel-closed": return "面板已关闭，关联执行已停止，进度已保存。";
    case "lease-expired": return "面板连接已过期，关联执行已停止，进度已保存。";
    case "service-shutdown": return "执行服务正在关闭，工作流已停止，进度已保存。";
    case "owner-exited": return "上次执行进程已退出，进度已保留，尚未自动继续。";
    default: return "本节点已中断，进度保留。";
  }
}
