# Create UI Design Package Workflow Hardening Archive

- Date: `2026-06-27`
- Topic slug: `create-ui-design-package-workflow-hardening`
- Status: `Archived`
- Scope: `Plugin skill`
- Tags: `asset-compounding`, `ui-design`, `asset-manifest`, `visual-qa`, `validator`

## Summary

Hardened `create-ui-design-package` from a visual-first checklist into a staged, validator-backed design package workflow. Rich UI packages now have explicit asset manifest, package-local runtime asset, dependency hygiene, and rendered QA evidence requirements before a package can pass validation.

## Delivered Scope

- Added `asset-manifest.json` package creation and schema guidance.
- Updated skill hard gates and templates so approved source images are treated as visual truth, not runtime sprite sheets.
- Extended package validation for manifest paths, dimensions, alpha requirements, design QA reports, and ignored generated frontend directories.
- Added a design asset helper for manifest checks and preview contact sheets.
- Preserved simple UI compatibility with `asset_strategy: none`.
- Revalidated the morning journal design package against the hardened workflow.

## Out of Scope

- Product Design plugin internals were not changed.
- Hooks do not automatically generate design packages or images.
- Production application code was not modified.

## Verification Snapshot

- `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> pass.
- `python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs\designs\morning-journal-note-ui --json` -> pass.
- `python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_assets.py check . docs\designs\morning-journal-note-ui --json` -> pass.

## Source Documents

- Spec: [Create UI Design Package Workflow Hardening Design](../../specs/2026-06-27-create-ui-design-package-workflow-hardening-design.md)
- Plan: [Create UI Design Package Workflow Hardening Implementation Plan](../../plans/2026-06-27-create-ui-design-package-workflow-hardening.md)
- Related design package: [Morning Journal Note UI](../../../designs/morning-journal-note-ui/START_HERE.md)

## Related Problems

- Inbox promoted: [Create UI Design Package Asset Workflow Gaps](../../inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md)

## Notes

This archive intentionally links the design package instead of copying its visual source, screenshots, and contracts.
