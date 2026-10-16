export const statusLabels: Record<string, string> = {
    planned: "尚未激活", ready: "等待执行", running: "运行中", completed: "已完成", failed: "失败", skipped: "未进入",
    paused: "已暂停", pausing: "正在暂停", waiting: "等待确认", cancelled: "已取消", stopped: "已停止", stopping: "正在停止",
    interrupted: "已中断", unknown: "结果待核实", draft: "待开始", preparing: "正在准备", mixed: "多个实例状态不同",
};
export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function elapsedLabel(startedAt?: string, endedAt?: string, now = Date.now()): string {
    if (!startedAt || !Number.isFinite(Date.parse(startedAt)))
        return "";
    const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
