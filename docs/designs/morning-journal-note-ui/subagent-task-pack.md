# Morning Journal Note UI Subagent Task Pack

Design slug: `morning-journal-note-ui`

You must implement the UI from this design package.

## Required inputs

- Source image: `assets/source/selected-ui-design.png`
- Tokens: `design-tokens.json`
- Asset manifest: `asset-manifest.json`
- Component board: `component-board.md`
- Contracts: `contracts/`
- Prototype path: `prototype/`

## Required reading order

1. `START_HERE.md`
2. `visual-source.md`
3. `design-tokens.json`
4. `asset-manifest.json`
5. `component-board.md`
6. `contracts/`
7. `prototype-implementation.md`
8. `visual-fidelity-checklist.md`

## Hard rules

- Match the approved source image before adding extra behavior.
- Use `design-tokens.json` for colors, type, spacing, and shape.
- Use `asset-manifest.json` and `prototype/src/assets/generated/` for runtime
  bitmap assets.
- Do not use `assets/source/selected-ui-design.png` as a runtime background or
  as a hidden screenshot layer.
- Do not crop new runtime assets from the full source mock.
- Do not invent colors, spacing, typography, layout regions, component density, or interaction states.
- Do not use framework default colors or spacing when they conflict with the package.
- If a required visual detail is missing, return:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

## Implementation tasks

1. Build the Vite React UI in `prototype/src/`.
2. Translate `design-tokens.json` into CSS variables or typed constants.
3. Compose the five-region desktop layout from contracts:
   `TopBar`, `MemoryTrail`, `WritingSanctuary`, `RhythmPanel`, `FlowStrip`.
4. Wire local state for selected memory, mood, energy, editor text, save status,
   flow mode, and timer start/pause.
5. Implement responsive behavior for desktop and narrow/mobile viewports.
6. Run the prototype and capture required screenshots.
7. Complete `visual-fidelity-checklist.md` with actual pass/fail evidence.

## Acceptance criteria

- Desktop viewport visually matches the approved source proportions and mood.
- Runtime UI is componentized React, not a flat screenshot.
- Generated assets render at intended sizes with no obvious stretching.
- Editor is editable and word count/save state respond to input.
- Interactive controls have hover/focus/selected states.
- Narrow screenshot shows no text overlap.

## DONE requires

- Implementation file paths
- Desktop screenshot path
- Mobile, narrow, or no-color screenshot path
- Completed `visual-fidelity-checklist.md`
- Known deviations
- Tests or preview command
