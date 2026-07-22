# Asset Compounding v0.5.1 静默门限体验

- Date: `2026-07-22`
- Topic slug: `asset-compounding-v0.5.1-quiet-gate-ux`
- Status: `Archived`
- Scope: `Project`
- Tags: `asset-compounding`, `hooks`, `quiet-ux`, `privacy`, `host-verification`

## Summary

本次把资产复利收尾从面向用户暴露的协议文本改为静默、可审计的宿主交接：常规门限藏在 Markdown HTML 注释中，只有真实资产写入显示一次带路径回执；不可恢复异常继续显示原因、影响和下一步，并避免泄露非法输入或本地路径。

## Delivered Scope

- `route: none` 只输出隐藏门限；资产写入路由要求真实 `related_assets`，并只显示一条 `资产复利：已更新 ...` 回执。
- Stop 继续读取原始回复完成审计，兼容历史明文门限；缺失或无效门限最多消费一次 continuation，纠正后的有效门限可正常关闭会话。
- emitter、composer 与 Hook 拒绝换行、HTML 注释闭合和字段不一致输入；Hook 运行异常统一返回脱敏且可操作的中文提示。
- README、Skill、Hook 指导和 manifest 统一到 `0.5.1`，并明确单元测试不能替代真实宿主验收。

## Out of Scope

- 不新增资产路由、状态协议、设置、依赖或额外 Skill。
- 不取消 legacy 明文门限兼容，也不改变现有审计存储结构。
- 不处理与 quiet closeout 无关的 manifest 图标路径及默认提示数量兼容警告；这些宿主信号另行评估。

## Verification Snapshot

- 完整资产脚本套件通过：`158 tests`，仅保留 1 个既有平台限定跳过；manifest JSON 与 `git diff --check` 通过。
- 安装结果确认 `superpowers-asset-compounding@codex-plugin` 为 `0.5.1`；交互式 `/hooks` 显示 Stop Hook 已启用且 `Trusted`。
- 冷启动宿主会话 `019f8c2c-9ff4-7762-826a-4f00fd792be6` 先以 `missing_asset_gate` 阻塞，再以 `asset_gate_present` 放行；审计事件均记录 `pluginVersion: 0.5.1` 和指纹 `57b2d9b1e03b4aca`。
- 纠正交接只产生 1 条成功回执和 1 份隐藏门限；固定临时探针未进入索引、暂存或归档，核验后已精确删除。

## Source Documents

- Spec: [静默门限体验设计](../../specs/2026-07-22-asset-compounding-quiet-gate-ux-design.md)
- Visual: None found for this topic.
- Plan: [静默门限体验实施计划](../../plans/2026-07-22-asset-compounding-quiet-gate-ux.md)

## Related Problems

- None yet.

## Notes

- 宿主验证确认仅运行测试不会触发 meaningful-work 门限；计划已改为先创建受控临时资产，再验证一次 Stop 纠正流程。
- Marketplace 全量重克隆在 30 秒超时后失败；安装前改用现有干净快照 fast-forward 到已推送提交，商城来源与配置保持不变。
- 冷启动另有非阻塞 manifest 警告：包含 `..` 的 `interface.icon_small` / `interface.icon_large` 被忽略，且 `interface.defaultPrompt` 最多支持 3 项；本次不扩展到 UI metadata 修复。
