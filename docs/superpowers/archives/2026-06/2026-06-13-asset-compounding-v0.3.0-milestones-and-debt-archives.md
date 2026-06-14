# Asset Compounding v0.3.0 Milestones and Technical Debt

- Date: `2026-06-13`
- Topic slug: `asset-compounding-v0.3.0-milestones-and-debt`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `milestones`, `technical-debt`, `scripts`, `skills`

## Summary

本次归档完成 `superpowers-asset-compounding` v0.3.0：插件从只覆盖 archives/problems/inbox 的需求与问题资产，扩展到项目级 milestone 账本和 technical-debt 记录，并把状态检查、索引同步、topic status 与 closeout required actions 统一交给脚本处理。技能负责语义边界，脚本负责机械状态，这条边界在本轮落成。

## Delivered Scope

- 新增 `manage-superpowers-milestone` 技能、README/CHECKLIST 模板、`milestone_assets.py` facade 和 `checks/milestone_checks.py`，支持 milestone 创建、slice 更新、进度重算、索引同步和校验。
- 新增 `manage-technical-debt` 技能、technical-debt 模板、`technical_debt_assets.py` facade 和 `checks/technical_debt_checks.py`，支持 debt 创建、状态更新、关闭、闭环 archive 校验、重复 slug 和必填元数据检查。
- 拆分脚本职责到 `asset_core/*` 与 `checks/*`，让 `check_indexes.py`、`check_completion_gate.py`、`asset_status.py`、`asset_closeout.py` 继续作为稳定 CLI facade。
- 扩展 `asset_status.py`、`asset_closeout.py`、`find_related_assets.py` 和 `suggest_asset_route.py`，让 milestone 与 technical-debt 作为 related assets、required actions 和 `update-existing` 信号出现，但不扩展 `asset_gate.route` 枚举。
- 更新 manifest、README、技能说明、bootstrap 和仓库检索锚点到 `0.3.0`；AGENTS managed block 现在包含英文 `Milestone Navigation` 与 `Technical Debt Navigation` 语义说明；本仓库发布流程改为远端 marketplace 同步，旧 `local-home` cache sync 流程标记为 deprecated。
- 2026-06-14 follow-up：发布 `0.3.1`，把 AGENTS managed block 改为版本化整体替换，补充项目上下文边界、milestone/technical-debt 完成后状态回填导航，并让 `docs/milestones/` 与 `docs/technical-debt/` 写入同样触发自动 guidance refresh。

## Out of Scope

- 未新增 `asset_gate.route` 值，milestone/debt 不成为新的 route 类型。
- 未让 hooks 自动写 milestone 或 technical-debt 文档。
- 未执行本地 `sync_local_plugin_cache.py` / cache smoke；该流程已按用户要求弃用，远端 marketplace 同步等待分支合并并推送后执行。
- 未删除全局 `~/.codex` 里的 legacy local-plugin 同步脚本；它不属于本仓库源码。

## Verification Snapshot

- Source tests: `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> `Ran 91 tests ... OK`.
- Manifest JSON: `python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json` -> valid JSON with `"version": "0.3.0"`.
- Skill validation: both `manage-superpowers-milestone` and `manage-technical-debt` passed `quick_validate.py`.
- Diff hygiene: `git diff --check` passed; only Windows LF/CRLF working-copy warnings appeared during some checks.
- Remote marketplace sync: deferred until this branch is merged and pushed; post-merge command is `codex plugin marketplace upgrade codex-plugin` followed by `codex plugin add superpowers-asset-compounding@codex-plugin`.
- Legacy local cache sync: skipped by release policy; `sync_local_plugin_cache.py` / `local-home` cache smoke is deprecated for this repository flow.
- 2026-06-14 follow-up: `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> `Ran 92 tests ... OK`.
- 2026-06-14 follow-up: `python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json` -> valid JSON with `"version": "0.3.1"`.
- 2026-06-14 follow-up: `ensure_agent_asset_guidance.py . --json` -> `managed_block_version == expected_version == 0.3.1` and `managed_block_stale == false`.
- 2026-06-14 follow-up: `git diff --check` passed; only Windows LF/CRLF working-copy warnings appeared.

## Source Documents

- Spec: [Asset Compounding v0.3.0 Milestones and Technical Debt Design](../../specs/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt-design.md)
- Visual: None found for this topic.
- Plan: [Asset Compounding v0.3.0 Milestones and Technical Debt Implementation Plan](../../plans/2026-06-13-asset-compounding-v0.3.0-milestones-and-debt.md)

## Related Problems

- None.

## Notes

- Milestone 划分规则保持弹性：战略意义优先于硬性 slice 数量，小 milestone 可以成立，但必须说明战略意义。
- Technical debt 不分大小类，统一通过状态、优先级、revisit trigger、resolution criteria 和 closure archive 管理。
- Task 6 复核中发现 `README.md` milestone slug 为空会导致 closeout scope 泄漏，本轮已修复为从 milestone 目录名派生 slug。
- Final review 发现 milestone `Deferred` / `Split` slice 会掉出 summary counts，本轮已补齐模板、重算、校验和索引同步语义。
- 用户反馈两个新 skill 需要更强 SOP 约束；本轮已要求 milestone 文档写清 target stage、acceptance criteria 与 slice boundary，并要求 technical-debt 文档写清 debt 原因、发现方式、当前影响和 initial resolution direction。
- 用户补充 OpenHarnessTS 的 `AGENTS.md` 有 milestone 与 technical-debt 导航样例；本轮已将对应英文导航写入 managed guidance 模板、当前仓库 AGENTS、两个新 skill 的完成前检查要求，并加入旧目录-only managed block 的刷新回归测试。
- 2026-06-14 用户审查确认：AGENTS 托管块需要版本号并由脚本按版本整体替换，而不是靠英文/中文 heading 逐项检测；本轮 `0.3.1` 已落地。
- 2026-06-14 用户继续指出 milestone/debt 导航必须说明完成后回填状态；本轮已把 slice 完成/延期/拆分后的 milestone checklist/index 更新，以及 debt 解决/关闭/保留后的 status/index 更新写入托管导航和 writer skills。
