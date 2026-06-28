# Morning Journal Note UI Traceability

## Source Of Truth Order

1. `assets/source/selected-ui-design.png` owns visual intent.
2. `contracts/` owns visual semantics, states, and platform constraints.
3. `design-tokens.json` owns reusable visual values.
4. `prototype/` and `assets/screenshots/` provide rendered evidence.
5. Superpowers specs and plans own implementation slice scope.

## Design Graph

```text
docs/designs/morning-journal-note-ui/
  START_HERE.md
    -> visual-source.md
    -> design-tokens.json
    -> component-board.md
    -> contracts/
    -> subagent-task-pack.md
```

## Requirement Matrix

| Requirement | Source image area | Contract | Screenshot evidence |
| --- | --- | --- | --- |
| Primary UI fidelity | full approved source | `contracts/visual-system.md` | `assets/screenshots/implementation-desktop.png` |
| Five-region layout | top bar, left rail, editor, right panel, bottom strip | `contracts/layout-and-regions.md` | `assets/screenshots/qa-comparison-desktop.png` |
| Component behavior | memory rows, editor, mood, energy, flow strip | `contracts/component-contracts.md` | `prototype/src/App.jsx` |
| Interaction states | selected, hover, focus, dirty/saved, timer | `contracts/states-and-variants.md` | `prototype/src/App.jsx` |
| Responsive behavior | compact source adaptation | `contracts/accessibility-and-responsive.md` | `assets/screenshots/implementation-mobile.png` |
| Asset composition | generated atomic asset board | `asset-manifest.json` | `prototype/src/assets/generated/` |

## Asset-to-contract mapping

| Asset or package | Contract source | Notes |
| --- | --- | --- |
| `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | Visual truth for layout, hierarchy, and spacing. |
| `assets/component-assets/preview/contact-sheet.html` | `component-board.md` | Human-readable preview of generated runtime assets. |
| `assets/component-assets/sunlit-desk-bg-1536x1024.png` | `contracts/layout-and-regions.md` | Runtime background material. |
| `assets/component-assets/paper-texture-warm-ivory-1024.png` | `contracts/component-contracts.md` | Center editor and paper surface material. |
| `assets/component-assets/note-slip-*.png` | `contracts/component-contracts.md` | Rhythm panel note surfaces. |
| `assets/component-assets/memory-*.png` | `contracts/component-contracts.md` | Memory rail thumbnails. |
| `assets/component-assets/*-512.png` | `contracts/visual-system.md` | Transparent stationery and botanical accents. |
| `assets/component-assets/avatar-warm-160.png` | `contracts/component-contracts.md` | TopBar profile avatar. |
| `design-tokens.json` | `contracts/design-tokens.md` | Reusable values that implementation should consume. |
| `component-board.md` | `contracts/component-contracts.md` | Selected component patterns and variants. |

## Implementation touchpoints

- React app: `prototype/src/App.jsx`
- Styling and responsive layout: `prototype/src/styles.css`
- Runtime asset copies: `prototype/src/assets/generated/`
- Desktop screenshot: `assets/screenshots/implementation-desktop.png`
- Mobile screenshot: `assets/screenshots/implementation-mobile.png`
- QA comparison: `assets/screenshots/qa-comparison-desktop.png`
- QA report: `design-qa.md`

## Open questions

- None blocking current reference implementation.

## AI Reading Recipes

For implementation:

1. Read `START_HERE.md`.
2. Open `assets/source/selected-ui-design.png`.
3. Read `design-tokens.json`.
4. Read `component-board.md`.
5. Read relevant files under `contracts/`.

## Coverage Audit

Every required generated runtime asset is referenced by `asset-manifest.json` and
at least one contract or board document.
