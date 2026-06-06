# Superpowers Problem Index

## 2026-06

- [2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md](./2026-06/2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md): 多个 hook 进程并发追加同一个 `events.jsonl` 时必须加锁，否则少量审计事件会变成无法解析的 JSONL 碎片。
- [2026-06-03-stop-plan-boundary-closeout-noise-problem.md](./2026-06/2026-06-03-stop-plan-boundary-closeout-noise-problem.md): Stop hook 不应把单独的 `plan-boundary` checklist 进度当成硬 closeout 信号，否则 brainstorming/design 分段确认会反复要求 `asset_gate`。
- [2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md](./2026-06/2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md): 子代理生命周期 hook 不应强加资产复利 handoff 字段，资产信号应由主代理在计划边界和最终 closeout 中收拢。
- [2026-06-02-postcompact-hook-output-schema-problem.md](./2026-06/2026-06-02-postcompact-hook-output-schema-problem.md): PostCompact hook 不能复用 SessionStart 风格的 `additionalContext` 输出，pending state 应只写审计日志而不向 stdout 返回 JSON。
