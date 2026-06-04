# Hook 生命周期资产复利 v0.2.0

- Date: `2026-05-31`
- Topic slug: `hook-lifecycle-asset-compounding-v0.2.0`
- Status: `Archived`
- Scope: `Plugin`
- Tags: `hooks`, `asset-compounding`, `subagents`, `closeout`, `codex-plugin`

## Summary

本归档记录 `superpowers-asset-compounding` v0.2.0 的第一版 hook 生命周期改造：插件不再只依赖长篇 `AGENTS.md` 规则提醒主代理，而是通过 Codex hooks 在关键生命周期里注入精简协议、收集子代理资产候选、记录工具事实，并在当前 turn 收尾前要求主代理补充 `asset_gate`。

这版仍保留现有 writer skills 作为唯一资产写入路径。hooks 只做上下文注入、候选收集、状态记录和一次性 closeout 续跑，不在后台静默写 archive/problem/inbox。

## Delivered Scope

- 新增插件内置 `hooks/hooks.json`，注册 `SessionStart`、`SubagentStart`、`SubagentStop`、`PostToolUse`、`Stop`、`PreCompact`、`PostCompact`。
- 新增 `hooks/asset_hook.py`，支持 stdin JSON 解析、`PLUGIN_DATA` 状态文件、仓库 `docs/superpowers` 检测、子代理候选解析、工具事实记录、Stop closeout gate 和 compaction 状态恢复。
- `UserPromptSubmit` 未进入资产生命周期主链路，避免按用户自然语言 prompt 触发不可控注入。
- 子代理协议采用“只上报、不写资产”的否定模式，并在缺少 `asset_candidates` 时最多要求继续一次。
- `Stop` 在 meaningful work 缺少 `asset_gate` 时最多要求主代理继续一次，避免无限循环。
- 版本从 `0.1.4` 升级到 `0.2.0`，manifest 显式声明插件 hooks。
- README 增加 hook 生命周期、`/hooks` trust review、子代理候选上报和 Stop closeout gate 说明。
- `agents-asset-guidance-template.md` 缩减为仓库级检索锚点和 hook 接管说明，不再向 `AGENTS.md` 注入大段 routing/completion gate 规则。
- 测试覆盖 hook 配置、SessionStart 注入、SubagentStart/Stop、PostToolUse 状态、Stop gate、PostCompact 恢复，以及 Windows/PowerShell stdin BOM 输入。
- 2026-06-01 follow-up：`PostToolUse` 在检测到真实写入 `docs/superpowers` 资产后，会自动调用 bootstrap，补齐标准目录并创建或刷新仓库级 `AGENTS.md` managed retrieval block；只读资产搜索仍不会触发写文件。
- 2026-06-03 v0.2.4 follow-up：移除 `SubagentStart` / `SubagentStop` hook 注册和子代理 `asset_candidates` 强制协议，避免与 Superpowers 子代理原生 `Status` handoff 冲突。
- 2026-06-03 v0.2.4 follow-up：`PostToolUse` 增加 `functions.update_plan` / `update_plan` matcher，把主代理计划更新记录为 `plan-boundary`，由最终 `Stop` gate 统一收拢资产复利判断。
- 2026-06-03 v0.2.4 follow-up：刷新 README、`using-asset-compounding`、`compound-development-asset`、AGENTS 模板和 LightRAGNet 当前 `AGENTS.md`，将导航说明从子代理候选上报改为主代理计划边界和 closeout gate。
- 2026-06-03 v0.2.5 follow-up：当 `update_plan` 包含 completed step 时写入 `assetGateDue`；下一次计划更新会返回轻量 reminder，要求主代理在开始下一个计划任务前运行资产复利 gate，但不阻断工具执行。

## Out of Scope

- 本次没有自动写入 archive/problem/inbox；资产写入仍由主代理调用现有 writer skills。
- 本次没有缩减 LightRAGNet 的 `AGENTS.md` 大段资产规则；该 cleanup 应在 hooks 经实际使用验证后单独执行。
- 本次没有证明普通 `PreToolUse`、`PostToolUse` 或 `Stop` 是否会在子代理内部执行；设计中保留了后续实测项。
- 本次没有加入 `UserPromptSubmit` 资产逻辑；该 hook 仅作为未来 prompt 风险审查预留。

## Verification Snapshot

- RED：`python -m unittest tests.test_asset_scripts.AssetScriptTests` 首次失败，原因是 `hooks/hooks.json` 和 `hooks/asset_hook.py` 不存在。
- GREEN：`python -m unittest tests.test_asset_scripts.AssetScriptTests` 通过，`35` tests OK。
- BOM 回归 RED：`test_hook_accepts_utf8_bom_input` 失败，错误为 `Unexpected UTF-8 BOM`。
- BOM 回归 GREEN：`test_hook_accepts_utf8_bom_input` 通过。
- Full tests：`python -m unittest discover -s tests` 通过，`36` tests OK。
- Hook command smoke：通过 `hooks.json` 同形态命令读取 `PLUGIN_ROOT` 并处理 PowerShell 管道 stdin，返回 `SessionStart` additionalContext。
- Cache sync：`sync_local_plugin_cache.py superpowers-asset-compounding` 成功同步到 `0.2.0` cache。
- Plugin validation：`validate_local_plugin.py superpowers-asset-compounding` 返回 `OK: local plugin is valid`。
- Follow-up RED：新增 `test_post_tool_use_does_not_count_dotnet_build_version_as_verification`，先确认 `dotnet build --version` 会误写 `verification-ran`。
- Follow-up GREEN：`PostToolUse` 改为结构化识别 `dotnet test/build`、`npm test/run build/run typecheck` 与 `git commit/push/merge`，排除 `dotnet build --version`；source/cache 全量测试均为 `37` tests OK。
- Real subagent smoke：实际 explorer 子代理只读检查 hooks 配置，未在任务提示中要求 `asset_candidates`，最终 handoff 自动包含 `asset_candidates - none`。
- v0.2.1 RED：补充跨 turn 状态污染、同一子代理重复 continuation、只读 `docs/superpowers` 搜索误标资产变更、失败验证只记 `observed` 的回归测试，确认四个场景均能复现。
- v0.2.1 GREEN：hook 状态在 `asset_gate` 收口后清理 closeout signals；同一子代理缺候选只续跑一次；只读资产搜索不再触发 `assetFilesChanged`；验证证据记录 `exitCode`，失败验证使用 `verification-failed` signal。
- v0.2.1 Release：manifest 升级到 `0.2.1`，source/cache 全量测试均为 `41` tests OK，插件验证返回 `OK: local plugin is valid`。
- v0.2.2 RED：新增 hook usage event 与 report 汇总测试，先确认缺少 `events.jsonl` 和 `asset_hook_report.py`。
- v0.2.2 GREEN：hook 追加脱敏 `events.jsonl`，记录 hook event、decision、reason code、command kind、exit code、signals、candidate count、repo hash/name；不记录 prompt、diff、命令输出、完整命令或完整仓库路径。
- v0.2.2 Release：新增 `hooks/asset_hook_report.py` 汇总 stop blocks、asset_gate、子代理候选、验证失败/通过和 command kinds；manifest 升级到 `0.2.2`，source 全量测试为 `43` tests OK。
- 2026-06-01 RED：新增 `test_post_tool_use_bootstraps_guidance_when_first_asset_is_written`，确认首次写入 `docs/superpowers` 资产后不会自动生成 `AGENTS.md`。
- 2026-06-01 GREEN：`PostToolUse` 在 `asset_files_changed` 为 true 时调用 `bootstrap_asset_compounding.bootstrap(..., write=True)`；目标测试通过，只读 `rg docs/superpowers` 回归测试通过。
- 2026-06-01 Full tests：`python -m unittest tests.test_asset_scripts` 通过，`44` tests OK。
- 2026-06-01 Cache smoke：同步到 `local-home/superpowers-asset-compounding/0.2.2` cache 后，用 cache hook 在临时仓库触发首次资产写入，确认生成 `AGENTS.md`、`problems/` 和 `inbox/`。
- 2026-06-01 Plugin validation：`validate_local_plugin.py superpowers-asset-compounding` 返回 `OK: local plugin is valid`。
- v0.2.3 Audit finding：本地 `events.jsonl` 共 959 条，其中 `PostToolUse` 910 条，`commandKind=unknown` 842 条；审计日志缺少耗时和本次工具信号，无法单独定位 hook 卡住。
- v0.2.3 RED：新增 stdin 不关闭超时测试、`tool_input.cmd` 命令识别测试和审计字段测试，覆盖 `durationMs`、`signalsAdded`、`assetFilesChangedThisTool`、命令 hash/length。
- v0.2.3 GREEN：`asset_hook.py` 增加 stdin 读取超时边界和 `_hook/events.jsonl` 原始失败事件；`PostToolUse` 审计补充耗时、进程号、命令存在性、命令 hash/length、本次信号和本次资产写入标记；manifest 升级到 `0.2.3`。
- v0.2.3 Release：source 全量测试 `45` tests OK；同步到 `local-home/superpowers-asset-compounding/0.2.3` cache；插件验证返回 `OK: local plugin is valid`；cache hook smoke 确认 `tool_input.cmd` 被识别为 `dotnet-test` 并写出 `durationMs`、`commandHash`、`signalsAdded` 和 `assetFilesChangedThisTool`。
- v0.2.4 RED：新增/调整测试，确认 hook 配置仍注册 `SubagentStart` / `SubagentStop`、子代理 start 会注入 `asset_candidates` 协议、子代理 stop 缺候选会 block、`functions.update_plan` 不产生 `plan-boundary`。
- v0.2.4 GREEN：移除子代理生命周期 hook 注册和 dispatcher 入口，清理子代理候选解析/续跑运行时代码；`PostToolUse` 对 `functions.update_plan` / `update_plan` 写入 `plan-boundary` signal，source 全量测试 `43` tests OK。
- v0.2.4 Release：manifest 升级到 `0.2.4`；同步到 `local-home/superpowers-asset-compounding/0.2.4` cache；插件验证返回 `OK: local plugin is valid`；cache hook 配置确认只保留 `PostToolUse` update-plan matcher，不含 `SubagentStart` / `SubagentStop`。
- v0.2.5 RED：新增 completed plan step due/reminder/clear 测试，确认当前只记录 `plan-boundary`，不写 `assetGateDue`，也不会在下一次计划更新前提醒主代理运行 asset gate。
- v0.2.5 GREEN：`PostToolUse` 对 completed plan step 设置 `assetGateDue=true`；后续计划更新在 due 存在时返回 `systemMessage` 提醒主代理先运行资产复利 gate；`asset_gate` 收口后清理 `assetGateDue`。
- v0.2.5 Release：source 全量测试 `45` tests OK；archive/problem/index 校验通过；同步到 `local-home/superpowers-asset-compounding/0.2.5` cache；插件验证返回 `OK: local plugin is valid`；cache smoke 确认 completed plan step -> `assetGateDue=true`、下一次 `update_plan` -> reminder、Stop `asset_gate` -> `assetGateDue=false`。

## Source Documents

- Spec: [Hook 生命周期资产复利 v0.2.0 设计草案](../../specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md)
- Visual: None found for this topic.
- Plan: [Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan](../../plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md)

## Related Problems

- None at archive time.

## Notes

- `asset_hook.py` 使用 `utf-8-sig` 读取 stdin，是为了兼容 Windows/PowerShell 管道可能带 BOM 的情况。
- `sync_local_plugin_cache.py` 和 `validate_local_plugin.py` 不应并行跑；validate 可能在 cache manifest 写入前读取到半同步状态并误报 `missing_cache_manifest` / `cache_stale`。先 sync 完成，再顺序 validate。
- 插件 hooks 升级后需要在 Codex 中通过 `/hooks` review/trust 当前 hook definition；当前会话不会自动信任新 hooks。
- `PostToolUse` 不应通过简单 substring 判定验证命令；查询型命令如 `dotnet build --version` 只能说明工具存在，不应触发 `verification-ran` 或 Stop closeout gate。
- closeout state 必须在主代理输出 `asset_gate` 后清理，否则上一 turn 的验证或编辑信号会污染下一 turn 的只读回答。
- 使用数据采集应保持结构化和脱敏：足够支撑误拦/漏拦分析，但不能保存 prompt、diff、命令输出、完整命令或完整路径。
- 首次资产写入和仓库级检索导航必须绑定在 `PostToolUse` 的真实资产写入信号上，而不是 `SessionStart`；这样能自动补齐 `AGENTS.md`，同时避免用户只是打开仓库时产生无意义脏文件。
- Hook 审计日志需要能诊断性能和挂起：至少记录 `durationMs`、进程号、命令 hash/length、`signalsAdded`、`assetFilesChangedThisTool`，并为 stdin 超时这类无法解析标准 event 的失败写 `_hook/events.jsonl`。
- 子代理生命周期不适合承载资产复利协议；否则会和 Superpowers 等子代理驱动工作流自己的 handoff 状态格式竞争。资产复利应由主代理在计划边界和最终 `asset_gate` 统一判断。
