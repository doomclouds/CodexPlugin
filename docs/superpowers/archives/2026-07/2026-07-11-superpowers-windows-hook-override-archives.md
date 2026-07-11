# Superpowers Windows Hook Override

- Date: 2026-07-11
- Topic slug: superpowers-windows-hook-override
- Status: Archived
- Scope: Environment
- Tags: superpowers, codex, windows, hooks, runtime-cache, recovery

## Summary

本次为 superpowers@superpowers-dev 恢复了用户明确要求的 Windows Codex
SessionStart hook。v6.1.1 上游默认不在 Codex 注册该 hook；本地恢复层改为显式
指向 Codex 专用配置，并确保修改的是实际运行的插件缓存而非 marketplace 克隆。

## Delivered Scope

- 提供 hooks-codex.json、固定 hookSpecificOutput 负载的 session-start-codex
  和严格的 Windows launcher；只接受 Git for Windows Bash，WSL/WindowsApps
  别名与缺失 Git Bash 都明确失败，不再静默退出 0。
- 应用脚本会从 marketplace 根自动解析同版本运行缓存，先原子安装全部 Codex
  前置文件、最后提交 manifest 指针，并将原始/应用状态快照到
  %USERPROFILE%\.codex\plugin-overrides。
- 以 Codex hooks/list 的实际 currentHash 作为信任依据，并完成真实 turn/start
  生命周期验证。

## Out of Scope

- 不把 resume 加回 matcher，也不修改上游 Superpowers 仓库。
- 不替用户强制重启已经运行的 Codex 桌面进程。
- 不把该恢复层包装成通用 marketplace 安装器。

## Verification Snapshot

- 恢复工具的 fake-plugin 回归测试经过红绿循环后通过，覆盖 manifest、快照、
  cache 路由、无 hooks 属性兼容、前置文件先写、真实 Windows launcher JSON
  输出和错误插件拒绝。
- hooks/list 显示缓存路径的 Superpowers hook 已启用、trusted，当前 hash 为
  sha256:f2c617c2939e7cfcea6bc872ff37d049b5e90beff002210d49ba00f8a31b04d6。
- 真实 ephemeral turn/start 产生完成态 thread-scoped SessionStart hook，
  耗时 416ms，注入 context 长度 3313。

## Source Documents

- Spec: [Superpowers Windows Hook Override Design](../../specs/2026-07-11-superpowers-windows-hook-override-design.md)
- Visual: None found for this topic.
- Plan: [Superpowers Windows Hook Override Implementation Plan](../../plans/2026-07-11-superpowers-windows-hook-override.md)

## Related Problems

- [Superpowers Codex SessionStart 覆盖未加载](../../problems/2026-07/2026-07-11-superpowers-windows-hook-command-expansion-problem.md)

## Notes

- 该恢复层刻意覆盖上游“Codex 不注册 SessionStart”的默认选择；未来插件升级后可
  重放仓库内工具，再用 /hooks 或等价的 hooks/list 审核运行时定义。
- 已重启的既有任务属于 resume，而 matcher 有意不包含 resume；验收须使用新任务、
  /clear 或 compaction。
