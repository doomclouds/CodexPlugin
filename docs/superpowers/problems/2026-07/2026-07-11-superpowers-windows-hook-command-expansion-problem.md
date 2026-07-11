# Superpowers Windows hook 命令变量展开失败

- Date: `2026-07-11`
- Topic slug: `superpowers-windows-hook-command-expansion`
- Status: `Captured`
- Scope: `Environment`
- Tags: `superpowers`, `codex`, `windows`, `powershell`, `hooks`

## Symptom

`superpowers@superpowers-dev` 在原生 Windows Codex 中没有注入
SessionStart 的 Superpowers 上下文，看起来像 hook 没有触发；直接复现时命令
报 `/hooks/run-hook.cmd` 不存在。

## Trigger / Context

- 已启用的插件通过默认 `hooks/hooks.json` 注册 SessionStart。
- 注册只写了 Bash/Claude 形式的
  `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start`，没有
  `commandWindows`。
- Codex 在 Windows 使用 PowerShell 命令语义，而 `${CLAUDE_PLUGIN_ROOT}` 不是
  `$env:CLAUDE_PLUGIN_ROOT`。

## Root Cause

插件发现和 hook 信任并非根因。默认 `hooks/hooks.json` 是 Codex 支持的插件
位置，且 Codex 也会提供兼容的 `CLAUDE_PLUGIN_ROOT` 环境变量；失败发生在
PowerShell 对命令字符串的展开阶段。`${CLAUDE_PLUGIN_ROOT}` 被当作未定义的
PowerShell 变量，路径退化为 `/hooks/run-hook.cmd`，因此 `run-hook.cmd` 和
`session-start` 从未被执行。

## Fix

- 保持 POSIX `command`，并新增 Windows 专用
  `commandWindows: & "$env:PLUGIN_ROOT\hooks\run-hook.cmd" session-start`。
- 用可追踪的覆盖 JSON 和 PowerShell 应用脚本替换仅活动插件根下的
  `hooks/hooks.json`。
- 应用前校验 manifest 的 `name == superpowers`，并将原始与应用文件、哈希和
  元数据快照到 `%USERPROFILE%\.codex\plugin-overrides`。
- 覆盖后要求重启 Codex 并在 `/hooks` 重新审核，而不是手写信任哈希。

## Why This Fix

Windows override 只修正宿主 shell 的路径展开，仍复用上游的
`run-hook.cmd`、Git Bash 选择逻辑和 `session-start` 输出协议。它比修改 skill
内容、直接编辑 `config.toml` 或伪造 trust 记录更小、更可回滚，也能在上游插件
更新覆盖缓存后通过同一个脚本重放。

## Recognition Clues

- `/hooks` 显示 Superpowers SessionStart 已注册，但新线程没有 Superpowers 上下文。
- 手工在 PowerShell 执行 `${CLAUDE_PLUGIN_ROOT}` 形式命令时路径变为
  `/hooks/run-hook.cmd`。
- 将同一输入交给 `$env:PLUGIN_ROOT\hooks\run-hook.cmd` 后退出 `0` 并返回
  `hookSpecificOutput`。
- `codex plugin list` 指向 transient marketplace 根，说明直接改缓存会被下一次
  更新覆盖，必须保留外部恢复包。

## Applicability / Non-Applicability

### Applies When

- 插件 hook 的通用命令含 Bash 风格 `${VAR}`，而 Codex 在 Windows 使用
  PowerShell 执行该命令。
- 插件可在 `hooks/hooks.json` 中提供 `commandWindows`，并且 launcher 可从
  `PLUGIN_ROOT` 调用。

### Does Not Apply When

- hook 已拥有正确的 `commandWindows` 且手工调用 launcher 已成功；不要为了
  UI 可见性问题重复覆盖。
- 失败来自 WindowsApps Python、Git Bash 缺失、trust 未审核或旧会话的失效路径；
  它们需要各自的诊断与修复。

## Related Artifacts

- Spec: [Superpowers Windows Hook Override Design](../../specs/2026-07-11-superpowers-windows-hook-override-design.md)
- Plan: [Superpowers Windows Hook Override Implementation Plan](../../plans/2026-07-11-superpowers-windows-hook-override.md)
- Archive: [Superpowers Windows Hook Override](../../archives/2026-07/2026-07-11-superpowers-windows-hook-override-archives.md)
- Related Problems:
  - [WindowsApps Python Alias Hook Hang](../2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md)
- Code or Test:
  - [Canonical hook override](../../../../tools/superpowers-hook-override/hooks.json)
  - [Application script](../../../../tools/superpowers-hook-override/apply-superpowers-codex-hook-override.ps1)
  - [Regression test](../../../../tools/superpowers-hook-override/test-superpowers-hook-override.ps1)
