# Hook Audit Reliability v0.2.8

- Date: `2026-06-06`
- Topic slug: `hook-audit-reliability-v0.2.8`
- Status: `Archived`
- Scope: `Feature`
- Tags: `asset-compounding`, `hook`, `audit`, `jsonl`

## Summary

本次交付把 `superpowers-asset-compounding` 的审计层从“能发现坏 JSONL”推进到“降低坏 JSONL 出现概率”。同时修正了 topic 状态脚本对 inbox/problem-only 信号的路由语义，并补齐常见 ROS/WSL/HTTP/PowerShell 命令分类与 Windows 中文输出边界。

## Delivered Scope

- `asset_hook.py` 新增 `append_jsonl_event()` 和 per-file lock，session/raw 两条 `events.jsonl` 写入路径都走锁保护追加。
- `asset_status.py --topic` 对仅匹配 problem 或 inbox 的主题返回 `not_required`，不再默认强制 requirement archive。
- `classify_command_kind()` 增加 `wsl`、`ros2`、`colcon`、`http-request` 和 `powershell-multi-command` 分类。
- `inspect_inbox_lifecycle.py` 启动时 reconfigure stdout/stderr 为 UTF-8，避免 Windows 下中文 revisit 文本因输出编码崩溃。
- 插件 manifest 和 README 升级到 `0.2.8`，说明审计可靠性和 topic 状态语义变化。

## Out of Scope

- 未修复历史已损坏的 `events.jsonl` 行，也未提供自动清洗/隔离 CLI。
- 未尝试回填历史 unknown command 分类。
- 未把所有插件脚本统一改造成共享 UTF-8 bootstrap，本轮只修复已复现的 inbox lifecycle 输出路径。

## Verification Snapshot

- RED: `test_hook_jsonl_append_helper_serializes_concurrent_writers` 先失败于缺少 `append_jsonl_event`。
- RED: `test_asset_status_treats_inbox_only_topic_as_not_requiring_archive` 先失败于 `needs_attention` / missing archive。
- RED: `test_asset_status_still_requires_archive_when_spec_plan_match_inbox_topic` 在复审时捕获到 spec+plan 同时匹配 inbox 时不能误报 `not_required`。
- RED: 扩展后的 `test_post_tool_use_classifies_common_diagnostic_commands` 先确认 WSL/ROS/colcon/curl/PowerShell multi 仍为 `unknown` 或误归类。
- RED: `test_inbox_lifecycle_script_forces_utf8_stdout_for_chinese_text` 先复现 `UnicodeEncodeError`。
- GREEN: `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` 通过，`Ran 55 tests ... OK`。
- `check_indexes.py docs/superpowers` 返回 `OK`，基础 `check_completion_gate.py . --json` 返回 `status=pass`。

## Source Documents

- Spec: None found for this topic.
- Visual: None found for this topic.
- Plan: None found for this topic.

## Related Problems

- [JSONL Hook Event Concurrent Append Corruption](../../problems/2026-06/2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md)

## Notes

- 这轮是一次审计报告驱动的插件补丁，而不是预先拆分 spec/plan 的新需求；archive 用来保留 v0.2.8 的交付边界和验证证据。
