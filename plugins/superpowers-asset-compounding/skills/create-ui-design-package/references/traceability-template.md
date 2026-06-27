# {{DESIGN_TITLE}} Traceability

## Source Of Truth Order

1. `assets/source/selected-ui-design.png` owns visual intent.
2. `contracts/` owns visual semantics, states, and platform constraints.
3. `design-tokens.json` owns reusable visual values.
4. `asset-manifest.json` owns package-local runtime asset inventory and strategy.
5. `prototype/` and `assets/screenshots/` provide rendered evidence.
6. Superpowers specs and plans own implementation slice scope.

## Design Graph

```text
docs/designs/{{DESIGN_SLUG}}/
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
| Primary UI fidelity | `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | `assets/screenshots/implementation-desktop.png` |

## Asset-to-contract mapping

| Asset or package | Contract source | Notes |
| --- | --- | --- |
| `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | Visual truth for layout, hierarchy, and spacing. |
| `design-tokens.json` | `contracts/design-tokens.md` | Reusable values that implementation should consume. |
| `asset-manifest.json` | `references/asset-manifest-schema.md` | Runtime asset inventory and path gate. |
| `component-board.md` | `contracts/component-contracts.md` | Selected component patterns and variants. |

## Implementation touchpoints

- Record the exact files, components, or routes that implement the design package.
- Record where screenshots are captured and where contract evidence lives.

## Open questions

- Record unresolved decisions, missing references, or platform conflicts before the next revision.

## AI Reading Recipes

For implementation:

1. Read `START_HERE.md`.
2. Open `assets/source/selected-ui-design.png`.
3. Read `design-tokens.json`.
4. Read `component-board.md`.
5. Read relevant files under `contracts/`.

## Coverage Audit

Every required image must be referenced by at least one Markdown file.
