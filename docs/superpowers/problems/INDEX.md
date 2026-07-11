# Superpowers Problem Index

## 2026-07

- [2026-07-11-hook-state-transaction-and-lifecycle-problem.md](./2026-07/2026-07-11-hook-state-transaction-and-lifecycle-problem.md): 多个 hook 进程更新同一 state 时必须以事务锁和明确生命周期避免丢更新与归档误判。
- [2026-07-11-hook-tool-response-outcome-normalization-problem.md](./2026-07/2026-07-11-hook-tool-response-outcome-normalization-problem.md): 退出码可能嵌套在工具响应中，必须有边界地归一化为 passed、failed 或 observed。

## 2026-06

- [2026-06-13-windowsapps-python-alias-hook-hang-problem.md](./2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md): Windows hook 不能裸调用 `python`，否则 WindowsApps alias 可能让 hook 卡在脚本启动层且没有审计失败事件。
- [2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md](./2026-06/2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md): 多个 hook 进程并发追加同一个 `events.jsonl` 时必须加锁，否则少量审计事件会变成无法解析的 JSONL 碎片。
- [2026-06-03-stop-plan-boundary-closeout-noise-problem.md](./2026-06/2026-06-03-stop-plan-boundary-closeout-noise-problem.md): Stop hook 不应把单独的 `plan-boundary` checklist 进度当成硬 closeout 信号，否则 brainstorming/design 分段确认会反复要求 `asset_gate`。
- [2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md](./2026-06/2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md): 子代理生命周期 hook 不应强加资产复利 handoff 字段，资产信号应由主代理在计划边界和最终 closeout 中收拢。
- [2026-06-02-postcompact-hook-output-schema-problem.md](./2026-06/2026-06-02-postcompact-hook-output-schema-problem.md): PostCompact hook 不能复用 SessionStart 风格的 `additionalContext` 输出，pending state 应只写审计日志而不向 stdout 返回 JSON。
