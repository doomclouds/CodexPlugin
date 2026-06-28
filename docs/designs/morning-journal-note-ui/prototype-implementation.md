# Morning Journal Note UI Prototype Implementation

- Implementation mode: `reference`
- Code path: `prototype/`
- Date: `2026-06-27`

## Current status

React reference prototype is implemented and rendered QA evidence has been
captured.

## Implementation scope

Build a Vite + React reference prototype that faithfully composes the approved
source design from:

- React components for layout, text, controls, and states
- `design-tokens.json` values translated into CSS variables or equivalent
- generated atomic bitmap assets from `prototype/src/assets/generated/`

The prototype must not use `assets/source/selected-ui-design.png` as a runtime
background. That image is reference evidence only.

## Run command

```powershell
Set-Location docs/designs/morning-journal-note-ui/prototype
npm install
npm run dev
```

## Expected implementation files

Recommended structure:

```text
prototype/src/
  App.jsx
  main.jsx
  styles.css
  assets/generated/
```

If the implementation chooses a different structure, record the final paths in
`traceability.md`.

## Required component implementation

- `AppShell`
- `TopBar`
- `MemoryTrail`
- `WritingSanctuary`
- `RhythmPanel`
- `FlowStrip`

Each component must map back to `component-board.md` and
`contracts/component-contracts.md`.

## Screenshot capture instructions

- Capture the desktop screenshot after the prototype is fully rendered and interactive.
- Capture the mobile or narrow screenshot after resizing to the target viewport.
- Store the images in `assets/screenshots/` with stable filenames before marking the work done.

## Rendered screenshots

- Desktop screenshot: `assets/screenshots/implementation-desktop.png`
- Mobile or narrow screenshot: `assets/screenshots/implementation-mobile.png`
- Desktop QA comparison: `assets/screenshots/qa-comparison-desktop.png`

## Known deviations

- Right-panel section rhythm is slightly tighter than the source mock so the
  desktop viewport keeps all ritual sections and the flow strip visible.
- Exact display serif may use a local fallback when `Cormorant Garamond` is not
  available.

## Deviations approved

- Approved as P3 follow-up polish in `design-qa.md`; no P0/P1/P2 fidelity issues
  remain.

## Blocked

- None.
