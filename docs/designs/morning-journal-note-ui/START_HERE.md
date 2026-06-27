# Morning Journal Note UI Start Here

- Design slug: `morning-journal-note-ui`
- Package mode: `new`
- Source package: `none`
- Date: `2026-06-27`
- Prototype mode: `reference`

## Goal

Implement a React reference prototype that faithfully recreates the approved
`Sunlit Memory Flow` morning journal UI.

The experience should feel like a warm personal morning writing desk: tactile
paper, sunrise light, memory photos, soft stationery details, and a clear
writing flow. It must not regress into a flat SaaS dashboard or a screenshot
background with fake interaction.

## Required Source Image

- Approved source: `assets/source/selected-ui-design.png`
- Current source candidate history:
  - `assets/generated-options/v4-sunlit-memory-flow.png`
- Asset manifest:
  - `asset-manifest.json`
- Asset preview:
  - `assets/components/asset-samples/asset-samples-preview.png`

## Required Reading Order

1. `visual-source.md`
2. `asset-manifest.json`
3. `design-tokens.json`
4. `component-board.md`
5. `contracts/visual-system.md`
6. `contracts/layout-and-regions.md`
7. `contracts/component-contracts.md`
8. `contracts/states-and-variants.md`
9. `contracts/interaction-flows.md`
10. `contracts/accessibility-and-responsive.md`
11. `subagent-task-pack.md`
12. `visual-fidelity-checklist.md`

## Implementation Boundary

- Build under `prototype/`.
- Do not modify production plugin code.
- Use React components and CSS for UI structure, text, layout, state, and
  interaction.
- Use generated bitmap assets only for material, photo, avatar, background, and
  decoration roles documented in `asset-manifest.json`.
- Do not use `assets/source/selected-ui-design.png` as the live app background.
  It is the comparison target, not an implementation shortcut.
- Do not crop final assets from the full-screen source mock.

## Hard Rules

- Do not invent colors, spacing, typography, layout regions, component density,
  or interaction states.
- Do not use framework default colors or spacing when they conflict with
  `design-tokens.json`.
- Do not add new app regions beyond the source image.
- Do not replace generated assets with CSS art, handcrafted SVGs, emoji, text
  glyphs, placeholder boxes, or div-drawn decorations.
- If a required design detail is missing, stop and report the gap.
- Do not mark DONE without desktop and narrow screenshots.
- Do not mark DONE without completing `visual-fidelity-checklist.md`.

## Validation

Run after the prototype and screenshots exist:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\create-ui-design-package\scripts\design_package.py check . docs/designs/morning-journal-note-ui --json
```
