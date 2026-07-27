# Stop Plan Boundary Closeout Noise Problem

- Date: `2026-06-03`
- Topic slug: `stop-plan-boundary-closeout-noise`
- Status: `Captured`
- Scope: `Feature`
- Tags: `hooks`, `stop`, `plan-boundary`, `asset-gate`

## Symptom

在头脑风暴、分段设计或持续实现中，主代理几乎每次结束回复都被 Stop hook 要求补 `asset_gate`。同一任务已经给过有效 gate 后，后续 merge/push 仍可能再次触发，用户看到多次 `Stop hook (blocked)`。

## Trigger / Context

- 仓库存在 `docs/superpowers/`，因此 asset-compounding hooks 生效。
- 主代理使用 `functions.update_plan` / `update_plan` 维护 brainstorming checklist。
- 计划仍有 `pending` / `in_progress` 项，但某个中间步骤已完成，或本轮刚发生编辑、验证。
- 2026-07-27 的 OpenCoWork 审计确认：单个长任务跨多个 assistant turn 时，Stop 把中间编辑、验证和计划进度反复当成独立 closeout；有效 gate 后的 git 收尾也会再次进入 gate 流程。

## Root Cause

Hook 混淆了 assistant turn 边界和任务边界：

- `PostToolUse` 看到任意 completed step 就设置 `assetGateDue=true`，没有判断整个计划是否完成。
- 编辑和验证信号既表示“已有待判断证据”，又被 Stop 直接当成“现在必须收口”。
- 有效 gate 会清理信号，但没有保留“当前边界已满足”，所以紧随其后的 git 收尾可能再次触发。
- skill 的前瞻式描述（“可能产生可复用资产”）让头脑风暴阶段也容易主动进入路由。

结果是 `idle / pending / due / satisfied` 四种语义被压成一个布尔式 “meaningful work”，普通中间回合因此被误判为硬 closeout。

## Fix

- 编辑、验证和资产变更只积累 pending evidence，不直接让 Stop 阻断。
- 只有“整个计划已完成且存在 pending evidence”或显式 commit/closeout 才设置 `assetGateDue=true`。
- Stop 仅在 `due` 时要求 gate；任务仍在进行时静默放行并保留 pending evidence。
- 有效 gate 标记当前边界为 `satisfied`；没有新增工作时，后续 merge/push 不重复要求 gate。
- skill 只在真实任务边界、已接受需求或稳定复用证据出现后触发，明确排除 ongoing brainstorming 和 intermediate plan steps。
- 回归测试覆盖进行中任务静默、完整计划一次 gate、无效中间 gate 不阻断，以及 gate 后 push 不重复触发。

## Why This Fix

修复放在共享 hook 状态判断，而不是添加 “brainstorm mode”、自然语言关键词或调用点特判。这样保留编辑、验证和计划证据，也只在能够从工具事实确认的任务边界收口；状态满足后保留一个布尔标记即可避免 git 后续重复，不需要新增配置或路由类型。

## Recognition Clues

- Stop 在计划仍有 `pending` / `in_progress` 项时，因一次编辑、验证或 completed intermediate step 要求 gate。
- `events.jsonl` 中同一长任务连续出现 `missing_asset_gate` / `asset_gate_present`，而不是只在最终边界出现一次。
- 有效 gate 后没有新编辑或验证，单纯 git merge/push 又触发一次 gate。
- 触发场景常见于 brainstorming、spec 分段确认和跨多轮实现，而不是已经确认的任务完成边界。

## Applicability / Non-Applicability

### Applies When

- 用户反馈 closeout gate 在设计、讨论或持续实现阶段过度触发。
- 一个任务跨多个 assistant turn，需要保留 pending evidence 直到真正收口。
- 需要区分证据出现、gate 到期和 gate 已满足，而不引入新的交互模式。

### Does Not Apply When

- 整个计划已完成且已有待判断证据，或已经执行 commit 等显式 closeout；这些场景应进入 `due`。
- gate 到期后仍缺少或提供了无效 gate；Stop 保留一次纠正机会是预期行为。
- 已满足 gate 后又出现新的编辑、验证或资产变更；新证据应重新打开 pending 状态。

## Related Artifacts

- Spec: [Hook 生命周期资产复利 v0.2.0 设计草案](../../specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md)
- Plan: [Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan](../../plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md)
- Archive: [Hook 生命周期资产复利 v0.2.0](../../archives/2026-05/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-archives.md)
- Related Problems:
  - [Subagent Lifecycle Asset Protocol Conflict Problem](./2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md)
- Code or Test:
  - [hooks/asset_hook.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook.py)
  - [tests/test_asset_scripts.py](../../../../plugins/superpowers-asset-compounding/tests/test_asset_scripts.py)
