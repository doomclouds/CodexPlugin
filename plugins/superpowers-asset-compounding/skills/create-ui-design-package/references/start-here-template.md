# {{DESIGN_TITLE}} Start Here

- Design slug: `{{DESIGN_SLUG}}`
- Package mode: `{{MODE}}`
- Source package: `{{SOURCE_PACKAGE}}`
- Date: `{{DATE}}`

## Goal

Implement the UI from this design package with visual fidelity to the approved source image.

## Required Source Image

- `assets/source/selected-ui-design.png`

## Required Reading Order

1. `visual-source.md`
2. `design-tokens.json`
3. `asset-manifest.json`
4. `component-board.md`
5. `contracts/`
6. `subagent-task-pack.md`
7. `visual-fidelity-checklist.md`
8. `prototype/src/assets/generated/`

## Required Reading

- Asset manifest: `asset-manifest.json`
- Runtime asset directory: `prototype/src/assets/generated/`

## Hard Rules

- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- If a required design detail is missing, stop and report the gap.
- Do not mark DONE without screenshots.
- Do not mark DONE without completing `visual-fidelity-checklist.md`.
- Do not use `assets/source/selected-ui-design.png` as a live app background.
- Do not crop final runtime assets from the full-screen source mock.
- If the UI needs bitmap textures, photos, decorations, or avatars, complete `asset-manifest.json` before image-to-code.

## Validation

Run:

```powershell
python <skill>\scripts\design_package.py check . docs/designs/{{DESIGN_SLUG}} --json
```
