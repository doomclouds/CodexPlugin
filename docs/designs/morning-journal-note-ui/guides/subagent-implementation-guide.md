# Subagent Implementation Guide

Package: `morning-journal-note-ui`

## Mission

Build the `Morning Journal Note UI` React reference prototype from the approved
design package. Your goal is visual fidelity first, local interaction second.

## Reading Order

1. `START_HERE.md`
2. `visual-source.md`
3. `assets/source/selected-ui-design.png`
4. `design-tokens.json`
5. `asset-manifest.json`
6. `component-board.md`
7. `contracts/`
8. `prototype-implementation.md`
9. `visual-fidelity-checklist.md`

## Build Rules

- Implement inside `prototype/src/`.
- Use existing Vite/React setup in `prototype/`.
- Import assets from `prototype/src/assets/generated/`.
- Use `@phosphor-icons/react` if icons are needed and already available.
- Keep CSS precise and component-scoped enough to review.
- Preserve small radii and tactile paper shadows.
- Avoid generic SaaS cards, blue default controls, and flat gray panels.

## Suggested Component Breakdown

| Component | Job |
| --- | --- |
| `AppShell` | background, grid, responsive shell, decorative placement |
| `TopBar` | title, date, flow toggle, save status, avatar |
| `MemoryTrail` | six selectable memory entries |
| `WritingSanctuary` | prompt header, editable editor, toolbar, word count |
| `RhythmPanel` | mood, energy, intention, gratitude, focus |
| `FlowStrip` | timer, focus sound, flow state, progress, quote |

## Local State

Use React state for:

- selected memory id
- selected mood
- energy value
- editor text
- save status
- flow mode enabled
- timer running/paused
- checked focus rows

No backend is required.

## Return Evidence

When implementation is done, return:

- changed implementation files
- preview command used
- desktop screenshot path
- narrow/mobile screenshot path
- completed checklist summary
- known deviations and why they are acceptable or blocked
