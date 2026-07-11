# Superpowers Codex SessionStart 覆盖未加载

- Date: 2026-07-11
- Topic slug: superpowers-windows-hook-command-expansion
- Status: Captured
- Scope: Environment
- Tags: superpowers, codex, windows, hooks, manifest, runtime-cache

## Symptom

superpowers@superpowers-dev 已启用且 skill 可见，但原生 Windows Codex 的新
线程没有收到 Superpowers SessionStart 上下文；只改 marketplace 目录中的
hooks/hooks.json 后，现象完全不变。

## Trigger / Context

- 上游 v6.1.1 的 .codex-plugin/plugin.json 声明 "hooks": {}。
- codex plugin list 显示的是 marketplace 克隆，而实际 hook 运行路径位于
  %USERPROFILE%\.codex\plugins\cache\superpowers-dev\superpowers\<version>。
- 新的显式 hook 定义会因 hash 变化进入 modified 状态，未信任时 Codex 会跳过它。

## Root Cause

这是三层边界叠加，而不是单纯的 PowerShell 展开失败：

1. 上游故意用空 hooks 对象阻止 Codex 自动发现 Claude 的 hooks/hooks.json，
   因此该文件即使存在也不会注册。
2. marketplace 克隆不是实际运行时；只改它不会影响 cache 内已安装版本。
3. 若重新注册通用脚本，Windows 还需要 commandWindows，且 Codex 必须得到
   hookSpecificOutput.additionalContext 而不是依赖兼容环境变量分支。

原先观察到的 Bash 形式 CLAUDE_PLUGIN_ROOT PowerShell 展开问题是邻近兼容风险，
但在 v6.1.1 中它不是“不触发”的主根因，因为上游根本没有注册该通用 hook。

## Fix

- 显式将运行缓存的 manifest 指向 ./hooks/hooks-codex.json。
- 安装 Codex 专用 session-start-codex，固定输出正确的 hookSpecificOutput JSON，
  并在 Windows 使用 & "$env:PLUGIN_ROOT\hooks\run-codex-session-start.cmd"。
- 恢复脚本按版本优先定位实际 cache，快照 manifest 与全部 Codex hook 文件，先
  写入前置文件、最后提交 manifest，避免复制失败后注册指向不存在的 hook。
- 严格 Windows launcher 在 Git Bash 缺失时返回非零，不再让上游通用 launcher
  的静默 exit 0 伪装成“已触发但无上下文”。
- 不把 PATH 中的裸 bash 当作兼容承诺；WSL 与 WindowsApps alias 可能接受
  Windows 路径却不具备 Git-for-Windows 的运行边界，因此只接受标准 Git Bash。
- 通过 hooks/list 读取精确 currentHash 后信任同一 hook state，并以真实
  ephemeral turn/start 验证运行完成与 context 注入。

## Why This Fix

显式 Codex 配置绕开了上游的自动发现抑制，又不改动 skill 内容、Git Bash launcher
或 resume 语义。cache 路由和快照将“能手工跑”提升为“宿主真正加载且下次可重放”。
用 Codex 返回的 hash 信任定义避免复用已删除 hooks-codex.json 的旧 hash 或猜测
序列化规则。

## Recognition Clues

- hooks/list 中没有 pluginId == superpowers@superpowers-dev，但插件和 skill 均已
  启用：优先检查 manifest 是否为 hooks: {}。
- hooks/list.sourcePath 指向 cache，而已修改文件位于 .codex\.tmp\marketplaces：
  修改目标错了。
- Superpowers hook 出现但 trustStatus 为 modified 或 untrusted：先读取
  currentHash，不要沿用旧 trust record。
- 真正的 turn/start 会出现 thread-scoped hook/started 和 hook/completed；
  debug prompt-input 不执行生命周期 hook，不能作为触发验收。

## Applicability / Non-Applicability

### Applies When

- 用户明确希望恢复一个上游在 Codex 中默认禁用的 plugin SessionStart hook。
- Codex 的 plugin source 与运行 cache 路径不同，或 hook 状态和文件变更不同步。
- Windows hook 需要 PowerShell 专用命令与 Codex 专用输出协议。

### Does Not Apply When

- 用户接受上游“skills 原生发现、无 SessionStart 注入”的默认行为；不要无故重启用。
- hooks/list 已显示同一 Superpowers hook trusted 且真实生命周期已完成；问题应在
  skill 路由、桌面进程重载或用户期望的 resume 边界中继续定位。
- 目标是 asset-compounding 插件或其他 plugin；不要复用本覆盖脚本。

## Related Artifacts

- Spec: [Superpowers Windows Hook Override Design](../../specs/2026-07-11-superpowers-windows-hook-override-design.md)
- Plan: [Superpowers Windows Hook Override Implementation Plan](../../plans/2026-07-11-superpowers-windows-hook-override.md)
- Archive: [Superpowers Windows Hook Override](../../archives/2026-07/2026-07-11-superpowers-windows-hook-override-archives.md)
- Related Problems:
  - [WindowsApps Python Alias Hook Hang](../2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md)
- Code or Test:
  - [Canonical Codex hook override](../../../../tools/superpowers-hook-override/hooks-codex.json)
  - [Codex session-start payload](../../../../tools/superpowers-hook-override/session-start-codex)
  - [Application script](../../../../tools/superpowers-hook-override/apply-superpowers-codex-hook-override.ps1)
  - [Regression test](../../../../tools/superpowers-hook-override/test-superpowers-hook-override.ps1)
