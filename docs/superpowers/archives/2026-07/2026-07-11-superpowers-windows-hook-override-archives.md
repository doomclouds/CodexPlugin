# Superpowers Windows Hook Override

- Date: `2026-07-11`
- Topic slug: `superpowers-windows-hook-override`
- Status: `Archived`
- Scope: `Environment`
- Tags: `superpowers`, `codex`, `windows`, `hooks`, `recovery`

## Summary

本次为 `superpowers@superpowers-dev` 补齐了原生 Windows Codex 的
SessionStart 注册兼容层。上游保留原有 skill 与 launcher，只用
`commandWindows` 让 Codex 在 PowerShell 中通过 `$env:PLUGIN_ROOT` 找到
`run-hook.cmd`，同时保留仓库内恢复工具和缓存更新之外的本地快照。

## Delivered Scope

- 提供跨平台 `hooks.json`：POSIX 使用 `sh` + `$PLUGIN_ROOT`，Windows 使用
  `commandWindows` + `$env:PLUGIN_ROOT`。
- 提供带 manifest 名称校验、原子替换和 SHA-256 元数据的应用脚本；每次覆盖均在
  `%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev` 写入原始与应用快照。
- 提供临时 fake-plugin 回归脚本和更新后重应用说明，避免把恢复办法留在瞬时
  marketplace/cache 目录里。

## Out of Scope

- 不修改 Superpowers 的 skill 内容、`session-start` 实现或 Git Bash launcher。
- 不伪造 `/hooks` 信任哈希，也不删除旧 `hooks-codex.json` 信任记录。
- 不将该外部插件覆盖包作为自动安装器或 marketplace 更新替代品。

## Verification Snapshot

- 受控复现证明旧 `${CLAUDE_PLUGIN_ROOT}` 注册在 Windows PowerShell 中解析为
  `/hooks/run-hook.cmd` 并在 launcher 前失败。
- 活动插件的 Windows override 手工接收 SessionStart JSON 后退出 `0`，返回
  `hookSpecificOutput.hookEventName == SessionStart`，上下文长度 `3276`。
- `test-superpowers-hook-override.ps1` 通过，验证快照、替换和错误 manifest 拒绝。
- 全量 `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`
  通过：`137 tests`。

## Source Documents

- Spec: [Superpowers Windows Hook Override Design](../../specs/2026-07-11-superpowers-windows-hook-override-design.md)
- Visual: None found for this topic.
- Plan: [Superpowers Windows Hook Override Implementation Plan](../../plans/2026-07-11-superpowers-windows-hook-override.md)

## Related Problems

- [Superpowers Windows hook 命令变量展开失败](../../problems/2026-07/2026-07-11-superpowers-windows-hook-command-expansion-problem.md)

## Notes

- 覆盖文件改变后必须重启 Codex，并在 `/hooks` 审核并信任新的
  `superpowers@superpowers-dev:hooks/hooks.json:session_start` 定义。
