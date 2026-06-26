# Task 2 报告：设计包模板补齐

## 实现内容
- 新增 TDD 测试 `test_ui_design_package_templates_define_required_handoff_contracts`，检查 `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/` 下 10 个模板文件是否存在且包含：
  - 通用 token `{{DESIGN_SLUG}}`
  - `start-here-template.md`、`design-brief-template.md`、`visual-source-template.md`、`visual-decision-log-template.md`、`prototype-implementation-template.md`、`subagent-task-pack-template.md`、`visual-fidelity-checklist-template.md`、`traceability-template.md`、`component-board-template.md`、`design-tokens-schema.md` 的必需锚点术语
- 新建 10 个模板文件：
  - `start-here-template.md`
  - `design-brief-template.md`
  - `visual-source-template.md`
  - `visual-decision-log-template.md`
  - `prototype-implementation-template.md`
  - `subagent-task-pack-template.md`
  - `visual-fidelity-checklist-template.md`
  - `traceability-template.md`
  - `component-board-template.md`
  - `design-tokens-schema.md`
- 模板内容严格对应 brief 指定文本，包含：
  - 必要文件引用 (`assets/source/selected-ui-design.png` 等)
  - 关键硬规则（不瞎编、缺失阻塞、需截图后再 DONE 等）
  - Visual fidelity / 交付清单 / 跟踪关系 / tokens schema 的结构声明

## 测试与结果

### RED 阶段
- 命令：
  - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts`
- 结果：`FAILED`
- 失败原因：
  - `start-here-template.md` 不存在（`assertTrue(path.is_file())` 未通过）

### GREEN 阶段
- 命令：
  - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts`
- 结果：`OK`（1/1）

### 完整验证
- 命令：
  - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`
- 结果：`Ran 113 tests in 18.994s`，`OK`
- 命令：
  - `git diff --check`
- 结果：无错误（仅提示行尾归一化提示，非 diff 错误）

## 自检结果
- 已确认：
  - 仅修改了任务指定范围文件（`tests` + `references/*`）与本任务报告文件。
  - 模板都保留了 `{{DESIGN_SLUG}}` 及各文件必需关键术语，满足测试覆盖。
  - 所有关键约束均未被破坏（未触及实现脚本或其他能力模块）。
- 未引入额外脚本或外部依赖。

## Commit
- `204dbd7`  
  Message: `feat(asset-compounding): add ui design package templates`

## Concerns
- 无阻塞问题；仅有 Git 的行尾归一化提示（`LF will be replaced by CRLF`）属于环境提示，不影响功能。

## Task 2 修复补充

### 修复内容
- 补齐 `design-brief-template.md` 的 `Primary job` 和 `Platform constraints` 说明。
- 补齐 `visual-source-template.md` 的 `Approval notes`。
- 补齐 `visual-decision-log-template.md` 的 `Retained decisions`、`Rejected decisions`、`Next revision direction`。
- 补齐 `prototype-implementation-template.md` 的 `Screenshot capture instructions`、`Deviations approved`、`Blocked` 字段。
- 补齐 `component-board-template.md` 的 `Key component examples` 和 `State and variant examples`。
- 补齐 `traceability-template.md` 的 `Asset-to-contract mapping`、`Implementation touchpoints`、`Open questions`。
- 扩展 `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py` 中的 `test_ui_design_package_templates_define_required_handoff_contracts`，让它覆盖上述字段。

### 测试命令与结果
- 命令：`$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts`
- 结果：先失败，失败点为 `visual-source-template.md` 缺少 `Approval notes`；修复后再次运行通过。
- 命令：`$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`
- 结果：`Ran 113 tests in 19.627s`，`OK`
- 命令：`git diff --check`
- 结果：无 diff 错误；仅有若干 `LF will be replaced by CRLF` 环境警告。
