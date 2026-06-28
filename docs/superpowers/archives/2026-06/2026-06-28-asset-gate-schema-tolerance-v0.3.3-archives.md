# Asset Gate Schema Tolerance v0.3.3

- Date: `2026-06-28`
- Topic slug: `asset-gate-schema-tolerance-v0.3.3`
- Status: `Archived`
- Scope: `Feature`
- Tags: `superpowers-asset-compounding`, `asset_gate`, `hooks`, `validation`

## Summary

本次归档记录 `superpowers-asset-compounding` v0.3.3 的门限输出修复：针对近期 Stop hook 多次拦截 `asset_gate` schema 的真实审计记录，插件不再只接受一种脆弱的手写形态，而是提供确定性的生成器、宽容解析常见 YAML-like 列表格式，并保持 route 枚举严格，减少模型重复写错字段格式造成的收尾噪音。

## Delivered Scope

- `asset_gate` 校验新增 `artifact-generation` 事件类型，并兼容旧的 `artifact_generation` 别名。
- 解析器支持 canonical flat 输出、常见嵌套字段、列表项、空数组/空对象/null 值归一化，以及 Markdown fence 包裹场景。
- 新增 `emit_asset_gate.py`，用于生成并自校验 canonical closeout block，减少主代理手写字段名。
- Stop hook 在遇到 invalid gate 时返回可直接填写的 flat template，而不是只报缺字段。
- `using-asset-compounding` 技能和 README 更新到 v0.3.3，明确生成器优先、宽容解析兜底、route 枚举不放宽。

## Out of Scope

- 未放宽 `asset_gate.route` 枚举，避免未知路由静默通过。
- 未改变资产写入策略、审计日志脱敏规则、SessionStart/PostToolUse 的生命周期判断。
- 未同步安装到本机插件缓存；升级后仍需要按 README 的 marketplace upgrade/add 流程刷新运行时。

## Verification Snapshot

- `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_accepts_yaml_asset_gate_lists plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_normalizes_asset_gate_aliases plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_emit_asset_gate_outputs_valid_canonical_block plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_blocks_invalid_asset_gate_without_clearing_state` -> `Ran 4 tests ... OK`
- `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> `Ran 114 tests ... OK`
- `git diff --check` -> no whitespace errors; only Windows LF-to-CRLF warnings.

## Source Documents

- Spec: None found for this topic.
- Visual: None found for this topic.
- Plan: None found for this topic.

## Related Problems

- None found for this topic.

## Notes

- 这次修复来自当前会话中的审计日志抽样与用户确认，没有独立的前置 spec/plan；归档保留为运行时修复历史，而不是补写设计文档。
