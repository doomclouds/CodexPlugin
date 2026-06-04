# Stop Plan Boundary Closeout Noise Problem

- Date: `2026-06-03`
- Topic slug: `stop-plan-boundary-closeout-noise`
- Status: `Captured`
- Scope: `Feature`
- Tags: `hooks`, `stop`, `plan-boundary`, `asset-gate`

## Symptom

在纯头脑风暴或分段设计确认中，主代理每次结束回复都被 Stop hook 要求补 `asset_gate`。用户看到多次 `Stop hook (blocked)`，反馈 closeout gate 触发太频繁。

## Trigger / Context

- 仓库存在 `docs/superpowers/`，因此 asset-compounding hooks 生效。
- 主代理使用 `functions.update_plan` / `update_plan` 维护 brainstorming checklist。
- 某个 plan step 变为 `completed`，但本轮没有实现、验证、提交、资产写入或稳定问题结论。

## Root Cause

`PostToolUse` 把所有 plan update 都记录为 `plan-boundary`，并在看到 completed step 时设置 `assetGateDue=true`。`Stop` 之后使用通用 `has_meaningful_work()` 判断是否必须要求 `asset_gate`，而该函数把单独的 `plan-boundary` 也视为 meaningful work。结果是设计对话中的普通 checklist 进度被误判为硬 closeout 边界。

## Fix

- 新增 `has_stop_closeout_work()`，Stop 只把 `plan-boundary` 以外的硬信号作为阻断依据。
- 保留 `plan-boundary` 和 `assetGateDue` 状态，用于下一次计划更新时提醒主代理，但不在 Stop 上强制阻断。
- 增加回归测试：只有 plan-boundary 的 Stop 不输出 block，且仍保留 `assetGateDue` 和 `meaningfulWorkSignals=["plan-boundary"]`。

## Why This Fix

直接移除 `update_plan` 监听会丢掉计划边界提醒；直接清空 `assetGateDue` 又会漏掉真正完成计划步骤后的下一步提醒。把 Stop 硬门禁和 plan-boundary 软提醒拆开，能保留阶段性提示，同时避免纯设计对话被反复拦截。

## Recognition Clues

- Stop hook 频繁要求 `asset_gate`，但本轮只发生了 `update_plan`，没有 `apply_patch`、验证命令、git closeout 或资产文件写入。
- `_hook/events.jsonl` 里 `PostToolUse` 的 `signalsAdded` 只有 `plan-boundary`。
- 触发场景常见于 brainstorming、spec 分段确认、纯讨论式任务，而不是实现完成或验证完成。

## Applicability / Non-Applicability

### Applies When

- Stop block 的唯一工作信号是 `plan-boundary`。
- 用户反馈 closeout gate 在设计/讨论阶段过度触发。
- 希望保留 update-plan checkpoint 的 reminder，但不让它变成每轮 final 的强制门禁。

### Does Not Apply When

- 本轮有真实编辑、验证、提交、merge、资产文件变更或子代理候选信号。
- 用户明确要求在每个计划步骤完成后都写 `asset_gate`。
- Stop block 来自上一轮未清理的 verification 或 asset file signal；那应检查 closeout state 清理逻辑。

## Related Artifacts

- Spec: [Hook 生命周期资产复利 v0.2.0 设计草案](../../specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md)
- Plan: [Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan](../../plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md)
- Archive: [Hook 生命周期资产复利 v0.2.0](../../archives/2026-05/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-archives.md)
- Related Problems:
  - [Subagent Lifecycle Asset Protocol Conflict Problem](./2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md)
- Code or Test:
  - [hooks/asset_hook.py](../../../../hooks/asset_hook.py)
  - [tests/test_asset_scripts.py](../../../../tests/test_asset_scripts.py)
