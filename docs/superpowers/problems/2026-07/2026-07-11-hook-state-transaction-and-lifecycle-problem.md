# Hook state 并发更新与生命周期误判

- Date: `2026-07-11`
- Topic slug: `hook-state-transaction-and-lifecycle`
- Status: `Captured`
- Scope: `Project`
- Tags: `hooks`, `state`, `concurrency`, `lifecycle`, `archive`, `privacy`

## Symptom

同一会话的多个 hook 进程可能互相覆盖 `state.json`，导致验证证据或信号丢失，极端时出现 JSON 解析失败；归档若在会话重开后仍删除源目录会丢掉新事件；旧 state 还可能把 cwd、完整验证命令或 bootstrap 绝对路径留在本地数据中。

## Trigger / Context

- 同一 session 的 PostToolUse、Stop 或 compact 生命周期并发或紧邻触发，并且都执行 read-modify-write。
- 归档在 snapshot 与源删除之间遇到 PostToolUse / SessionStart 重开，或历史 state 使用未知 schema。

## Root Cause

旧实现只为 `events.jsonl` 追加加锁，`state.json` 仍是无锁读取、修改、写回；多个进程可从同一旧快照写出不同结果。state 没有可信 schema/lifecycle 判定，归档也未与 hook 共享互斥边界；同时把仅适合瞬时处理的 cwd、命令和 bootstrap 路径直接持久化。

## Fix

- 通过共享文件锁包装完整的 state load、mutate、same-directory temporary write、fsync 和 `os.replace` 事务。
- 将新 state 升级到 schema 2，写入 `active` / `closed` 与 `closedAtUtc`；SessionStart/PostToolUse 重开，所有允许的 Stop 分支关闭。
- 报告仅将 schema 2 的 `closed` state 视为可归档；缺生命周期、损坏、未知 schema 或损坏 UTF-8 state 一律保守视为 legacy/current。
- hook 与 archive 共用会话生命周期锁；archive stage 完后在最终短锁窗口重新校验 state/hash，再发布 archive 并删除源。
- 将 state 降为脱敏摘要：repo name/hash、命令 kind/hash/length 和已知相对 bootstrap 目录；清除 raw cwd、命令、路径和错误文本。
- 用并发、reopen、archive 重开竞态、closed/legacy 和损坏 state 定向测试固定边界。

## Why This Fix

只给 JSONL 追加加锁不能保护独立的 read-modify-write state，也不能让 archive 知道源会话是否已重开。原子替换防止半写文件，生命周期锁把 hook 与最终删除串成可验证边界；schema 2 判定和脱敏摘要既不误迁移旧数据，也不把瞬时敏感上下文留到磁盘。

## Recognition Clues

- `state.json` 出现额外 JSON 内容、解析失败，或本应同时存在的 verification evidence / signal 少了一项。
- archive snapshot 成功后 source 又出现 active state 或新 events，或 legacy state 声称 `closed` 却没有 schema 2。
- state 文件里出现完整仓库路径、secret-bearing 命令、`agentsFile` 或异常原文。
- 复现时，只要两个进程同时载入同一 session state，就能观察到最后写入者覆盖先前更新。

## Applicability / Non-Applicability

### Applies When

- 多进程 hook 或 CLI 工具要更新同一个 JSON 状态文件。
- 会话归档、清理或恢复行为依赖“当前/已结束”的生命周期判断。

### Does Not Apply When

- 数据是仅追加的 JSONL 且不需要 read-modify-write；该场景仍应使用追加锁，但不需要 state 事务。
- 历史数据没有可信 lifecycle；不要为了归档方便把它强制当作 closed。

## Related Artifacts

- Spec: [v0.5.0 运行时可靠性设计](../../specs/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-design.md)
- Plan: [v0.5.0 运行时可靠性实施计划](../../plans/2026-07-11-asset-compounding-v0.5.0-runtime-reliability.md)
- Archive: [v0.5.0 运行时可靠性归档](../../archives/2026-07/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-archives.md)
- Related Problems:
  - [JSONL 并发追加损坏问题](../2026-06/2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md)
- Code or Test:
  - [asset_hook.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook.py)
  - [asset_hook_report.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook_report.py)
  - [state transaction tests](../../../../plugins/superpowers-asset-compounding/tests/test_asset_scripts.py)
