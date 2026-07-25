# Asset Compounding v0.5.1 / v0.5.2 静默门限体验

- Date: `2026-07-22`
- Topic slug: `asset-compounding-v0.5.1-quiet-gate-ux`
- Status: `Archived`
- Scope: `Project`
- Tags: `asset-compounding`, `hooks`, `quiet-ux`, `internal-gate`, `privacy`

## Summary

本需求先在 v0.5.1 用 Markdown HTML 注释隐藏常规门限；宿主实测发现注释仍可能作为“注释内容”显示后，v0.5.2 将门限彻底移出最终回复，改由最后一次 `emit_asset_gate.py` 工具调用输出、`PostToolUse` 内部采集、`Stop` 校验。常规收尾不再污染用户对话，真实资产写入仍只显示一次带路径回执，不可恢复异常继续显性告知。

## Delivered Scope

- `route: none` 不产生用户可见文本；资产写入路由要求真实 `related_assets`，最终回复只显示一条 `资产复利：已更新 ...` 回执。
- `PostToolUse` 只在成功执行 `emit_asset_gate.py` 时提取、校验并暂存门限字段；响应遍历受深度、节点数和字符数限制，原始工具响应不会落盘。
- `Stop` 优先校验内部暂存门限，同时兼容历史回复内的明文或 HTML 注释门限；会话关闭后清除暂存数据。
- README、Skill、Hook 指导、manifest 和测试统一到 `0.5.2`。

## Out of Scope

- 不新增资产路由、状态协议、设置、依赖或额外 Skill。
- 不取消 legacy 回复内门限兼容，也不改变现有审计目录结构。
- 不处理与 quiet closeout 无关的 manifest 图标路径及默认提示数量兼容警告；这些宿主信号另行评估。

## Verification Snapshot

- v0.5.2 完整资产脚本套件通过：`158 tests`，仅保留 1 个既有平台限定跳过；`git diff --check` 通过。
- 回归测试覆盖 emitter 纯门限输出、`PostToolUse` 内部采集、`Stop` 使用 `gateSource: tool` 放行，以及最终回复不包含 `asset_gate`。
- 安装结果确认 `superpowers-asset-compounding@codex-plugin` 为 `0.5.1`；交互式 `/hooks` 显示 Stop Hook 已启用且 `Trusted`。
- 冷启动宿主会话 `019f8c2c-9ff4-7762-826a-4f00fd792be6` 先以 `missing_asset_gate` 阻塞，再以 `asset_gate_present` 放行；审计事件均记录 `pluginVersion: 0.5.1` 和指纹 `57b2d9b1e03b4aca`。
- v0.5.2 仍需在推送并更新本地插件后重启 Codex，通过 `/hooks` 与真实会话确认宿主运行时行为。

## Source Documents

- Spec: [静默门限体验设计](../../specs/2026-07-22-asset-compounding-quiet-gate-ux-design.md)
- Visual: None found for this topic.
- Plan: [静默门限体验实施计划](../../plans/2026-07-22-asset-compounding-quiet-gate-ux.md)

## Related Problems

- None yet.

## Notes

- 宿主验证确认仅运行测试不会触发 meaningful-work 门限；计划已改为先创建受控临时资产，再验证一次 Stop 纠正流程。
- v0.5.2 的根因修正是停止把内部协议搭载在任何最终回复文本中；即使是 Markdown 注释，也不能假定所有宿主都会隐藏。
- Marketplace 全量重克隆在 30 秒超时后失败；安装前改用现有干净快照 fast-forward 到已推送提交，商城来源与配置保持不变。
- 冷启动另有非阻塞 manifest 警告：包含 `..` 的 `interface.icon_small` / `interface.icon_large` 被忽略，且 `interface.defaultPrompt` 最多支持 3 项；本次不扩展到 UI metadata 修复。
