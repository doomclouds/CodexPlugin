# Task 2 报告：Update Manifest Scaffold, Schema, Skill Gates, And Templates

## 实现内容
- 扩展 `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
  - `PACKAGE_FILES` 新增 `asset-manifest.json`
  - `PACKAGE_DIRS` 新增：
    - `assets/component-assets`
    - `assets/component-assets/raw`
    - `assets/component-assets/preview`
    - `prototype/src/assets/generated`
  - `create_package()` 在写完 `design-tokens.json` 后生成默认 `asset-manifest.json`
    - `design_slug`
    - `source_image`
    - `asset_strategy = "none"`
    - `reason`
    - `assets = []`
- 更新 `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
  - 增加 `asset-manifest.json` 相关 hard gates
  - 新增 “Inventory and prepare runtime assets” 工作流步骤
  - 重新编号后续步骤
  - 补充 `references/asset-manifest-schema.md` 到引用列表
- 更新模板与参考文档
  - `references/start-here-template.md`
  - `references/visual-source-template.md`
  - `references/subagent-task-pack-template.md`
  - `references/component-board-template.md`
  - `references/prototype-implementation-template.md`
  - `references/traceability-template.md`
  - `references/visual-fidelity-checklist-template.md`
  - 新增 `references/asset-manifest-schema.md`
- 更新 `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
  - 扩展 `test_ui_design_package_skill_exists_with_required_metadata`
  - 扩展 `test_ui_design_package_templates_define_required_handoff_contracts`
  - 扩展 `test_design_package_create_scaffolds_docs_design_package`
  - 新增对 `asset-manifest.json` 默认值、`assets/component-assets/*`、`prototype/src/assets/generated` 的断言

## 测试与结果

### Brief 指定测试
- 命令：
  - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package`
- 结果：`OK`（3/3）

## 文件变更
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/start-here-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-source-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/subagent-task-pack-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/component-board-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/prototype-implementation-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/traceability-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/visual-fidelity-checklist-template.md`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/references/asset-manifest-schema.md`
- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

## 自检
- 只修改了 Task 2 允许范围内的脚本、模板、schema、测试文件。
- 没有触碰 `docs/designs/`、`docs/superpowers/` 的内容。
- 默认 scaffold 已经能产出 `asset-manifest.json` 和新的 runtime asset 目录结构。
- 模板里已补齐 manifest gate、runtime asset gate、以及视觉源审批元数据。

## Commit
- `669ef32`
- Message: `feat(asset-compounding): add design package asset manifest gate`

## Concerns
- 当前 worktree 里仍有用户侧未跟踪的 `docs/designs/`、`docs/superpowers/inbox/`、`docs/superpowers/plans/`、`docs/superpowers/specs/` 文件，我没有动它们。
- 仓库里其余更深层的 manifest validation 测试不在本次 brief 指定验证命令内，本次只确认了 Task 2 覆盖的 scaffold / schema / template gates。
