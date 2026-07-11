# Hook 工具响应验证结果被错误归为 observed

- Date: `2026-07-11`
- Topic slug: `hook-tool-response-outcome-normalization`
- Status: `Captured`
- Scope: `Project`
- Tags: `hooks`, `verification`, `tool-response`, `normalization`, `privacy`

## Symptom

运行审计中已有验证命令的成功或失败结果，却全部显示为 `observed`；state 只留下泛化的验证信号，报告无法区分真正通过、失败和未知响应。

## Trigger / Context

- 工具响应把 `exit_code` / `returnCode` 放在嵌套 mapping、list 项或文本内容里，而不是顶层字段。
- 文本输出用独立的 `Exit code: 1` 或 `Return code: 0` 行表达进程结果。

## Root Cause

旧解析器只读取顶层 dict 值；Codex 工具响应经常包在内容数组或 result 对象中，因此真实退出码未被识别。缺失退出码后仍使用与已运行验证相同的信号，掩盖了结果不确定性。

## Fix

- 以固定深度遍历 mapping 和 list，接受 `exit_code`、`exitCode`、`returncode`、`returnCode`。
- 对文本仅接受完整行级的 `Exit code: 整数` / `Return code: 整数`，并记录来源为 top-level、nested、text 或 unknown。
- 将结果映射为 `passed`、`failed`、`observed`，分别产生 `verification-ran`、`verification-failed`、`verification-observed`。
- 只保存结果、来源和脱敏命令摘要，不保存原始响应、命令输出或提示词。

## Why This Fix

有边界的结构遍历覆盖已观察到的响应形态，同时避免从任意文本中猜测数字或把整段工具输出写入审计。unknown 保持诚实，而不是伪装成已验证。

## Recognition Clues

- 报告的 `verification_observed` 持续增长，却没有匹配的 passed 或 failed。
- 事件没有 `exitCode` 或 `exitCodeSource`，但响应包装中实际含有 exit/return code。
- 同一测试命令的结果在工具外部已知，却无法在 hook state 或报告中区分。

## Applicability / Non-Applicability

### Applies When

- hook 需要从受控的结构化工具响应中提取进程退出状态。
- 响应协议允许顶层、嵌套和单独状态行等有限包装形式。

### Does Not Apply When

- 需要解释任意测试框架的自然语言失败详情；这应由专用测试解析器处理。
- 需要采集原始工具输出；审计隐私边界仍禁止把它写入事件或报告。

## Related Artifacts

- Spec: [v0.5.0 运行时可靠性设计](../../specs/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-design.md)
- Plan: [v0.5.0 运行时可靠性实施计划](../../plans/2026-07-11-asset-compounding-v0.5.0-runtime-reliability.md)
- Archive: [v0.5.0 运行时可靠性归档](../../archives/2026-07/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-archives.md)
- Related Problems:
  - None.
- Code or Test:
  - [asset_hook.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook.py)
  - [verification normalization tests](../../../../plugins/superpowers-asset-compounding/tests/test_asset_scripts.py)
