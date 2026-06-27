# {{DESIGN_TITLE}} Subagent Task Pack

Design slug: `{{DESIGN_SLUG}}`

You must implement the UI from this design package.

## Required inputs

- Source image: `assets/source/selected-ui-design.png`
- Asset manifest: `asset-manifest.json`
- Tokens: `design-tokens.json`
- Component board: `component-board.md`
- Contracts: `contracts/`

## Required reading order

1. `START_HERE.md`
2. `visual-source.md`
3. `design-tokens.json`
4. `component-board.md`
5. `contracts/`
6. `visual-fidelity-checklist.md`

## Hard rules

- Match the approved source image before adding extra behavior.
- Use `design-tokens.json` for colors, type, spacing, and shape.
- Use package-local runtime assets from paths listed in `asset-manifest.json`.
- The approved source image is visual reference only.
- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- Do not use framework default colors or spacing when they conflict with the package.
- If a required visual detail is missing, return:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

## DONE requires

- Implementation file paths
- Desktop screenshot path
- Mobile, narrow, or no-color screenshot path
- Completed `visual-fidelity-checklist.md`
- Known deviations
- Tests or preview command
