# PostCompact Hook Output Schema Problem

- Date: `2026-06-02`
- Topic slug: `postcompact-hook-output-schema`
- Status: `Captured`
- Scope: `Environment`
- Tags: `codex-hooks`, `postcompact`, `json-schema`, `asset-compounding`, `audit-log`

## Symptom

Codex 在上下文压缩结束后显示 `PostCompact hook (failed)`，错误为 `hook returned invalid PostCompact hook JSON output`。hook 审计日志仍然记录到了 `PostCompact` 事件，所以问题不是 hook 没运行。

## Trigger / Context

- 仓库有 `docs/superpowers`，启用了 `superpowers-asset-compounding` 插件 hooks。
- 压缩前已经有 meaningful work state，例如 `edited-files`、`verification-ran` 或 pending subagent candidates。
- `PostCompact` 分支试图返回 `hookSpecificOutput.additionalContext` 来提醒主代理恢复资产 closeout 上下文。

## Root Cause

`PostCompact` 事件不能直接复用 `SessionStart` / `SubagentStart` 风格的 `hookSpecificOutput.additionalContext` 输出。审计日志显示当时事件为 `decision=context`、`reasonCode=pending_state_restored`，这说明脚本确实返回了上下文 JSON；当前 Codex 对 PostCompact 的输出 schema 更窄，因此把这个 JSON 判为非法输出。

## Fix

- `handle_post_compact` 保留 pending state 检查和 `events.jsonl` 审计记录。
- 当存在 pending state 时，审计事件改为 `decision=recorded`、`reasonCode=pending_state_restored`。
- `PostCompact` 不再向 stdout 返回 JSON；提示职责留给 `SessionStart` compact/resume 注入和 Stop closeout gate。
- 测试改为断言 PostCompact 有 pending state 时 stdout 为空，同时审计日志包含 `pending_state_restored`。

## Why This Fix

让 PostCompact 静默记录比继续尝试不同上下文字段更稳。压缩后的上下文恢复已经有 SessionStart compact 分支和 Stop gate 兜底；PostCompact 再输出提示属于锦上添花，但它一旦违反事件 schema，就会在用户界面制造 hook failure。保留审计日志能继续支持排障，不牺牲可观察性。

## Recognition Clues

- 用户看到 `PostCompact hook (failed)` 和 `invalid PostCompact hook JSON output`。
- `events.jsonl` 中同一 session 有 `hookEventName=PostCompact`、`reasonCode=pending_state_restored`。
- 手动运行 hook 时 stdout 是纯 JSON，但真实 Codex 仍拒绝，说明问题是事件允许输出 schema，而不是 JSON 格式、编码或 PowerShell profile 污染。

## Applicability / Non-Applicability

### Applies When

- Codex lifecycle hook 在某个事件里返回了其它事件可用的 JSON 结构。
- hook 审计日志已写入成功，但 Codex 仍提示该事件 JSON output invalid。
- 需要在 compaction 前后保留状态，但不一定需要可见上下文注入。

### Does Not Apply When

- hook stderr 显示 `Invalid hook JSON`，那是 stdin 解析失败。
- stdout 前面混入 profile 输出、日志文本或 BOM 以外的非 JSON 内容。
- `SessionStart`、`SubagentStart` 等明确支持 `hookSpecificOutput.additionalContext` 的事件正常工作。

## Related Artifacts

- Spec: [Hook Lifecycle Asset Compounding v0.2.0 Design](../../specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md)
- Plan: [Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan](../../plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md)
- Archive: [Hook Lifecycle Asset Compounding v0.2.0 Archive](../../archives/2026-05/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-archives.md)
- Related Problems:
  - None yet.
- Code or Test:
  - [asset_hook.py](../../../../hooks/asset_hook.py)
  - [test_asset_scripts.py](../../../../tests/test_asset_scripts.py)
