# Audit Report Unknown Command Archive

- Date: `2026-06-06`
- Topic slug: `audit-report-unknown-command`
- Status: `Archived`
- Scope: `Feature`
- Tags: `asset-compounding`, `audit`, `unknown-command`, `agents-md`

## Summary

本次交付让 `superpowers-asset-compounding` 的审计报告从“只知道 unknown 很多”升级为“能看出 unknown 来自哪些工具、仓库和脱敏命令聚类”。同时补充了 JSONL 健康统计、常见诊断命令分类规则，并在仓库 `AGENTS.md` 中加入托管块外的简短 Repository Guide。

## Delivered Scope

- `asset_hook_report.py` 增加 invalid JSONL 行/文件统计、unknown tool/repo 分布和脱敏 unknown command clusters。
- `asset_hook.py` 为常见诊断命令增加保守分类，包括 `file-edit`、`git-*`、`rg-search-readonly`、`powershell-readonly`、`python-unittest` 和 `codex-plugin-cli`。
- `AGENTS.md` 增加仓库级 Repository Guide，同时保持插件托管的 asset retrieval block 不变。
- 插件版本从 `0.2.6` 升级到 `0.2.7`，README 同步说明审计诊断增强。

## Out of Scope

- 未记录或输出原始命令文本、命令输出、完整 cwd、prompt 或 assistant message。
- 未尝试反推历史 unknown command hash 对应的原始命令。
- 未实现完整 audit doctor CLI 或自动 JSONL 修复/隔离流程。

## Verification Snapshot

- RED: `test_hook_report_clusters_unknown_commands_without_raw_command_text` 先失败于缺少 `invalid_json_lines`。
- RED: `test_post_tool_use_classifies_common_diagnostic_commands` 先确认常见诊断命令均为 `unknown`。
- GREEN: `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` 通过，`Ran 51 tests ... OK`。
- `ensure_agent_asset_guidance.py . --json` 返回 `needs_update=false`。
- `check_indexes.py docs/superpowers` 返回 `OK`。
- 真实审计 report 已输出 `unknown_command_tools`、`unknown_command_repos`、`unknown_command_clusters`、`invalid_json_lines=12`、`invalid_json_files=1`。

## Source Documents

- Spec: [2026-06-06-audit-report-unknown-command-design.md](../../specs/2026-06-06-audit-report-unknown-command-design.md)
- Visual: None found for this topic.
- Plan: [2026-06-06-audit-report-unknown-command-implementation-plan.md](../../plans/2026-06-06-audit-report-unknown-command-implementation-plan.md)

## Related Problems

- None.

## Notes

- 历史事件的 unknown 比例不会因新分类规则回填下降；新增分类会影响后续 hook 事件。
- 当前真实数据表明 unknown 主要来自 `Bash` 和 `CodexPlugin`，后续可基于新 cluster report 再决定是否继续扩展分类。
