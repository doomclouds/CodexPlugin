# Subagent Lifecycle Asset Protocol Conflict Problem

- Date: `2026-06-03`
- Topic slug: `subagent-lifecycle-asset-protocol-conflict`
- Status: `Captured`
- Scope: `Plugin`
- Tags: `codex-hooks`, `subagents`, `asset-compounding`, `superpowers`, `handoff-protocol`

## Symptom

Superpowers 子代理驱动工作流要求子代理按原生状态返回，例如 `DONE`、`DONE_WITH_CONCERNS`、`BLOCKED` 或 `NEEDS_CONTEXT`。资产复利插件同时通过 `SubagentStart` 注入 `asset_candidates` 提示，并在 `SubagentStop` 缺少该字段时 block 子代理结束，导致两个工作流都在定义子代理 handoff 形状。

## Trigger / Context

- 仓库启用了 `superpowers-asset-compounding` hooks。
- 同一轮使用 Superpowers `subagent-driven-development` 或其它有固定子代理返回格式的工作流。
- 子代理完成实现、审查或验证后没有输出 `asset_candidates`。
- hook 审计日志出现 `hookEventName=SubagentStop`、`reasonCode=missing_asset_candidates`。

## Root Cause

资产复利插件把“资产候选收集”放在子代理生命周期里，并把额外 handoff 字段提升为子代理完成条件。这个边界放错了：子代理生命周期属于具体工作流，资产复利路由属于主代理收口职责。横向插件在子代理 start/stop 阶段强加返回协议，会和任何已有子代理状态协议竞争。

## Fix

- 从 `hooks/hooks.json` 移除 `SubagentStart` 和 `SubagentStop` 注册。
- 从 `asset_hook.py` dispatcher 移除子代理生命周期处理入口，并清理子代理候选解析和缺候选续跑逻辑。
- 在 `PostToolUse` 中把 `functions.update_plan` / `update_plan` 记录为 `plan-boundary`，作为主代理阶段边界信号。
- 保留最终 `Stop` gate：由主代理基于实现结果、审查输出、验证证据、用户反馈和计划边界统一输出 `asset_gate`。
- 更新 README、技能说明、AGENTS 模板和当前仓库 `AGENTS.md`，删除子代理候选上报说明。

## Why This Fix

移除子代理生命周期 hook 比把 `SubagentStop` 降级为非阻断采集更稳。主代理本来能看到子代理结果，可以在计划更新和最终 closeout 时提取资产信号；继续在子代理 stop 上被动采集虽然不再 block，但仍然把资产复利插件耦合到子代理协议路径上。把检查点移动到主代理 `update_plan`，既保留阶段性提醒，又不污染子代理任务格式。

## Recognition Clues

- 子代理已经按工作流要求返回状态，但 hook 仍要求补充额外字段。
- `SubagentStop` hook 返回 `decision=block`，原因是缺少某个插件自定义 handoff 字段。
- 子代理任务提示中出现与主任务无关的横向插件协议，例如 `asset_candidates`。
- 用户或 reviewer 指出子代理结果状态和插件要求的结果状态互相挤占。

## Applicability / Non-Applicability

### Applies When

- 一个横向插件希望从子代理工作中收集信号，但不是该子代理工作流的所有者。
- 子代理驱动工作流已有固定 handoff 状态或 review 输出格式。
- 可以由主代理在计划边界或最终 closeout 中统一判断资产、审计或复盘路由。

### Does Not Apply When

- 子代理工作流本身明确要求某个字段，并且该字段属于该工作流的原生协议。
- hook 只是记录审计事件且不会注入提示、阻断、续跑或改变子代理输出格式。
- 主代理无法看到子代理结果，必须通过生命周期 hook 做唯一数据通道；这种情况需要先确认平台能力，而不是默认强加字段。

## Related Artifacts

- Spec: [Hook Lifecycle Asset Compounding v0.2.0 Design](../../specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md)
- Plan: [Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan](../../plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md)
- Archive: [Hook Lifecycle Asset Compounding v0.2.0 Archive](../../archives/2026-05/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-archives.md)
- Related Problems:
  - [PostCompact Hook Output Schema Problem](./2026-06-02-postcompact-hook-output-schema-problem.md)
- Code or Test:
  - [asset_hook.py](../../../../hooks/asset_hook.py)
  - [hooks.json](../../../../hooks/hooks.json)
  - [test_asset_scripts.py](../../../../tests/test_asset_scripts.py)
