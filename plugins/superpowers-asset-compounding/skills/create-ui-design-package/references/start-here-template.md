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
3. `component-board.md`
4. `contracts/`
5. `subagent-task-pack.md`
6. `visual-fidelity-checklist.md`

## Hard Rules

- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- If a required design detail is missing, stop and report the gap.
- Do not mark DONE without screenshots.
- Do not mark DONE without completing `visual-fidelity-checklist.md`.

## Validation

Run:

```powershell
python <skill>\scripts\design_package.py check . docs/designs/{{DESIGN_SLUG}} --json
```
