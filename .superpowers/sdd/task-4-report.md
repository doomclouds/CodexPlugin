# Task 4 Report

## Summary

Implemented the asset-only helper CLI for `create-ui-design-package` by adding `design_assets.py` with `check` and `preview` subcommands, reusing `design_package.py` path resolution, package-boundary validation, manifest validation, and issue formatting helpers instead of duplicating validator logic.

## Files Changed

- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py`
- `plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md`
- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

## Commands Run

1. Read task brief:
   - `Get-Content -Encoding utf8 C:\WorkSpace\ResearchProjects\CodexPlugin\.worktrees\create-ui-design-package-hardening\.superpowers\sdd\task-4-brief.md`
2. Verified RED after adding tests:
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_check_reports_manifest_asset_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_contact_sheet_html`
3. Verified GREEN after implementation:
   - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_check_reports_manifest_asset_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_contact_sheet_html`
4. Checked patch hygiene:
   - `git diff --check -- plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md plugins/superpowers-asset-compounding/tests/test_asset_scripts.py plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py`
5. Commit:
   - `git add plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_assets.py plugins/superpowers-asset-compounding/skills/create-ui-design-package/SKILL.md plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
   - `git commit -m "feat(asset-compounding): add design package asset helper"`

## Results

- RED verification failed as expected before implementation because `design_assets.py` did not exist.
- GREEN verification passed after implementation: both Task 4 tests returned `OK`.
- `design_assets.py check` returns JSON with `status`, `package`, and `issues`.
- `design_assets.py preview` returns JSON with `status`, `package`, `issues`, and `preview`, writes the preview HTML only when `--write` is provided, and rejects output paths outside the package boundary.

## Self Review

- Reused existing helpers from `design_package.py`:
  - `resolve_package_path`
  - `validate_package_location`
  - `validate_asset_manifest`
  - `issue`
- Avoided copying manifest validation logic; the new helper only orchestrates CLI behavior and preview HTML rendering.
- Kept changes scoped to the Task 4 brief.
- Did not modify `docs/designs/`, `docs/superpowers/`, or `AGENTS.md`.

## Notes

- `git diff --check` reported only Git line-ending warnings for existing working-copy normalization behavior; no whitespace or patch-format errors were reported.

## Fix Follow-up 2026-06-27

- Addressed review finding that `design_assets.py preview` hard-coded `../../` for contact-sheet image paths. Preview HTML now computes each `<img src>` relative to the generated HTML location, so the default output at `assets/component-assets/preview/contact-sheet.html` correctly resolves package-local assets.
- Strengthened preview coverage in `test_asset_scripts.py` by asserting the exact relative `src="../paper.png"` path and by adding a regression test that keeps writing preview HTML when manifest validation reports missing asset files.
- Relaxed `preview` behavior so manifest validation issues no longer block contact-sheet generation. The JSON result still returns `issues`, while the HTML renders a validation summary plus per-asset `Ready` or problem states such as `Missing file`. Blocking package-boundary and missing-package errors still stop preview generation, and `check` behavior remains unchanged.
- Verification:
  - `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_check_reports_manifest_asset_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_contact_sheet_html plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_assets_preview_writes_html_even_with_manifest_issues plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_design_package_check_validates_manifest_paths_and_dimensions`
  - Result: `Ran 4 tests in 1.618s` / `OK`
