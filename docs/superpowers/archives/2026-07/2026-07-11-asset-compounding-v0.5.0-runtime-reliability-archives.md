# Superpowers Asset Compounding v0.5.0 运行时可靠性

- Date: `2026-07-11`
- Topic slug: `asset-compounding-v0.5.0-runtime-reliability`
- Status: `Archived`
- Scope: `Project`
- Tags: `superpowers`, `asset-compounding`, `hooks`, `runtime-reliability`

## Summary

本次将资产复利插件从“功能齐全但运行语义有盲区”收敛为可审计的可靠性基线：会话状态可并发安全更新并明确结束生命周期，验证结果不再把成功或失败混成 observed，Stop 只在确有收尾工作时要求核心 gate，Windows 与 POSIX 启动路径各自可追溯，报告也能定位正在运行的构建和启动器。

## Delivered Scope

- 以加锁事务和同目录原子替换保护 `state.json`，并引入 `active` / `closed` 生命周期；默认归档只搬迁 schema 2 的 closed 会话，历史 state 保守保护。
- hook 与 archive 共享会话生命周期锁；归档先 stage 快照，再在发布/删除前复核 lifecycle 和事件 hash，已重开的会话保留源数据。
- 识别嵌套结构与严格行级退出码，将验证归为 `passed`、`failed` 或 `observed`，并限制深度、节点和文本扫描；state 不保存原始工具响应、完整命令或绝对路径。
- 将 Stop 改为先判断实质工作；核心 `asset_gate` 字段持续严格，辅助字段仅在 Stop 中可补为 `none`，并移除自由文本 cleanup 关键词绕过。
- 使用 POSIX `command` 与 Windows `commandWindows` 注册；POSIX launcher 优先用宿主 `PLUGIN_ROOT` 定位 hook，不依赖 Git 的 `dirname` / `tr` 工具目录；Windows 优先直启真实 Python，保留 Git Bash 回退，并记录 `launcherKind`。
- 为 state、事件和报告补齐 `pluginVersion`、`pluginFingerprint`、启动器、验证状态及会话生命周期聚合。

## Out of Scope

- 不新增资产类型、路由枚举、第七个 skill 或 UI workflow。
- 不自动修复、删除或迁移既有审计数据；缺少 lifecycle 的 legacy state 继续受保护。
- 不把审计事件扩展为原始命令、提示词、工具输出或仓库绝对路径采集。

## Verification Snapshot

- 定向回归覆盖并发 state 事务、archive 重开竞态、closed/legacy/损坏 UTF-8 state 边界、state 脱敏、嵌套与文本退出码、Stop 核心/辅助字段、Windows launcher、无 Git 工具目录的精简 `sh.exe` launcher 和运行身份报告。
- 控制条件下的无资产 SessionStart 基准（每组 7 次）显示：去除重复 Python 预检后，Windows direct 中位 `181.5ms`，Git Bash 回退中位 `410.8ms`。
- 全量 `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` 于 2026-07-11 通过：`137 tests`；发布收尾还执行 manifest JSON、完成门禁和索引/资产校验。

## Source Documents

- Spec: [v0.5.0 运行时可靠性设计](../../specs/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-design.md)
- Visual: None found for this topic.
- Plan: [v0.5.0 运行时可靠性实施计划](../../plans/2026-07-11-asset-compounding-v0.5.0-runtime-reliability.md)

## Related Problems

- [Hook state 事务与生命周期问题](../../problems/2026-07/2026-07-11-hook-state-transaction-and-lifecycle-problem.md)
- [Hook 工具响应结果归一化问题](../../problems/2026-07/2026-07-11-hook-tool-response-outcome-normalization-problem.md)

## Notes

- 安装/升级后仍需重启 Codex 并在 `/hooks` 中信任更新后的定义，才可评价真实宿主运行行为。
