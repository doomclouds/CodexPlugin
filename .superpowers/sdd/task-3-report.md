# Task 3 Report: Harden Design Package Validator

## Scope

- Implemented validator hardening in `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`
- Updated focused design-package tests in `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
- Did not modify `docs/designs/`, `docs/superpowers/`, `AGENTS.md`, or add `design_assets.py`

## Commands Run

1. Read brief and implementation/test context
   - `Get-Content -Encoding utf8 .superpowers\sdd\task-3-brief.md`
   - `Get-Content -Encoding utf8 plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py`
   - `Get-Content -Encoding utf8 plugins\superpowers-asset-compounding\tests\test_asset_scripts.py`
   - `rg -n "test_design_package_check_(requires_manifest_for_rich_assets|validates_manifest_paths_and_dimensions|requires_alpha_for_transparent_assets|requires_passed_design_qa_report|ignores_generated_frontend_dependency_dirs|passes_for_complete_reference_package|check_and_summarize_resolve_relative_package_under_repo_root)" plugins\superpowers-asset-compounding\tests\test_asset_scripts.py`
   - `rg -n "asset-manifest|design-qa|generated-options|markdown_files|check_package" plugins\superpowers-asset-compounding\tests\test_asset_scripts.py plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py`

2. RED verification before implementation
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_manifest_for_rich_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_validates_manifest_paths_and_dimensions plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_alpha_for_transparent_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_passed_design_qa_report plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_ignores_generated_frontend_dependency_dirs`
   - Result: `FAILED` with 5 failures. Four validators were missing; one placeholder scan incorrectly walked into `prototype/node_modules/.../README.md`.

3. GREEN verification after implementation
   - Same focused unittest command as above
   - Result: `OK` (`Ran 5 tests`)

4. Required design-package regression suite
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_skill_exists_with_required_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_ui_design_package_templates_define_required_handoff_contracts plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_create_scaffolds_docs_design_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_reports_missing_source_image_and_screenshots plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_second_screenshot_evidence plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_single_mixed_screenshot_file plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_generated_options plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_and_summarize_resolve_relative_package_under_repo_root`
   - Result: `OK` (`Ran 9 tests`)

5. Additional nearby design-package checks
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_reports_missing_source_image_and_screenshots plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_passes_for_complete_reference_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_second_screenshot_evidence plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_single_mixed_screenshot_file plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_generated_options plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_manifest_for_rich_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_validates_manifest_paths_and_dimensions plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_alpha_for_transparent_assets plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_requires_passed_design_qa_report plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_ignores_generated_frontend_dependency_dirs plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_and_summarize_resolve_relative_package_under_repo_root`
   - Result: `OK` (`Ran 11 tests`)

6. Review working tree
   - `git status --short`
   - `git diff -- plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
   - `git diff --stat -- plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

## File Changes

### `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py`

- Added ignored markdown directory constants and `is_ignored_markdown_path()`
- Updated `markdown_files()` to skip generated dependency/build cache folders
- Added `png_metadata()` and `parse_size()` helpers
- Added `manifest_local_path()` for package-local relative path enforcement
- Added `validate_asset_manifest()` with:
  - missing/invalid manifest detection
  - strategy validation
  - required key checks
  - final/prototype path safety and existence checks
  - PNG dimension validation
  - transparent PNG alpha validation
- Added `validate_design_qa()` with:
  - missing QA report detection when screenshots exist
  - pass-state requirement
  - evidence reference requirement
- Wired manifest and QA validators into `check_package()`

### `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- Added `write_standard_manifest_and_qa()` helper for passing-package fixtures
- Updated passing check/summarize tests to write explicit manifest and QA artifacts
- Updated dependency-noise test to use a complete QA report while keeping the `node_modules` placeholder probe
- Adjusted the missing-manifest RED/GREEN test to remove `asset-manifest.json` after scaffold creation so it exercises the intended validator path directly

## Self Review

- Kept CLI subcommands and JSON/text output contracts unchanged
- Kept changes scoped to validator/test logic only
- Confirmed ignored markdown directories fix the `prototype/node_modules/.../README.md` false positive
- Confirmed manifest path validation uses package-local relative resolution and rejects absolute/outside-package paths
- Confirmed PNG checks are metadata-based and do not require extra dependencies
- Noted one pragmatic test alignment: because Task 2 now scaffolds `asset-manifest.json` by default, the missing-manifest test now explicitly deletes it before asserting `missing_asset_manifest`

## Fix Follow-up (validator hardening review)

- Addressed review gap where non-PNG, corrupt PNG, or unreadable PNG files could bypass `target_size` and alpha checks because `png_metadata()` returning `None` produced no validator issue. The validator now reports `asset_manifest_dimension_mismatch` when the final asset is not a readable PNG.
- Addressed review gap where malformed `target_size` values silently skipped validation. The validator now reports `asset_manifest_dimension_mismatch` when `target_size` is not in `WIDTHxHEIGHT` format.
- Removed the overloaded `missing_asset_manifest` behavior tied to the scaffold default `reason` string for `asset_strategy: none`. Scaffolds now use a neutral reviewed-safe default reason (`No runtime bitmap assets are required for this package.`), so simple packages do not fail solely because the scaffold manifest exists.
- Added regression tests covering:
  - invalid/non-PNG asset payloads
  - invalid `target_size`
  - `..` and absolute-path escape attempts with `asset_manifest_path_outside_package`
  - scaffold default manifest acceptance for `asset_strategy: none`

### Additional Commands Run

7. Reviewer-requested RED verification for newly added regressions
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_invalid_png_metadata plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_invalid_target_size plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_rejects_paths_outside_package plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_accepts_scaffold_reason_for_none_strategy`
   - Result: `FAILED` with 3 failures. Invalid PNG and invalid `target_size` produced no manifest issue, and scaffold default `reason` still triggered `missing_asset_manifest`.

8. Reviewer-requested GREEN verification after fix
   - Same unittest command as above
   - Result: `OK` (`Ran 4 tests`)
