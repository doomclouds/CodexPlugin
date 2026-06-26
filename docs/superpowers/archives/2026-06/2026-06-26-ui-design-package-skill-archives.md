# UI Design Package Skill

- Date: `2026-06-26`
- Topic slug: `ui-design-package-skill`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `ui-design`, `imagegen`, `product-design`, `subagent`

## Summary

Added a visual-first UI design package skill that creates `docs/designs/<slug>/` packages from approved UI source images, reference implementations, screenshots, design tokens, contracts, and subagent task packs. The package integrates with Superpowers specs, plans, subagent execution, and archive/problem closeout so UI implementation work has a stable visual source of truth.

## Delivered Scope

- Added `create-ui-design-package` with ImageGen/Product Design orchestration guidance and hard gates.
- Added templates for design briefs, visual sources, visual decision logs, prototype evidence, subagent task packs, fidelity checklists, traceability, component boards, and token schema.
- Added `design_package.py create/check/summarize` for package scaffolding, validation, and status reporting.
- Added `docs/designs/` to bootstrap and AGENTS retrieval guidance.
- Updated plugin README and manifest metadata to expose UI design package workflows.

## Out of Scope

- No automatic ImageGen file-path control beyond package ingest requirements.
- No production UI code generation by default.
- No automatic visual pixel diff in the first release.
- No automatic hook-driven design package creation.

## Verification Snapshot

- `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> 121 tests passed.
- `python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json` -> valid JSON.
- `git diff --check` -> passed.
- `design_package.py create` smoke test -> created `docs/designs/smoke-dashboard`.
- `design_package.py check` smoke test -> returned `needs_attention` and blocked incomplete package without approved source image and rendered screenshots.
- `bootstrap_asset_compounding.py --write --json` smoke test -> created `docs/designs` and inserted AGENTS guidance that mentions design packages.

## Source Documents

- Spec: [UI Design Package Skill Design](../../specs/2026-06-26-ui-design-package-skill-design.md)
- Visual: None found for this topic.
- Plan: [UI Design Package Skill Implementation Plan](../../plans/2026-06-26-ui-design-package-skill.md)

## Related Problems

- None.

## Notes

- UI design packages live in `docs/designs/`; Superpowers specs, plans, archives, problems, and inbox notes remain in their existing asset directories.
