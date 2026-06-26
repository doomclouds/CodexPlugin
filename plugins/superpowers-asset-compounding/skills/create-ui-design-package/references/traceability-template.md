# {{DESIGN_TITLE}} Traceability

## Source Of Truth Order

1. `assets/source/selected-ui-design.png` owns visual intent.
2. `contracts/` owns visual semantics, states, and platform constraints.
3. `design-tokens.json` owns reusable visual values.
4. `prototype/` and `assets/screenshots/` provide rendered evidence.
5. Superpowers specs and plans own implementation slice scope.

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

## AI Reading Recipes

For implementation:

1. Read `START_HERE.md`.
2. Open `assets/source/selected-ui-design.png`.
3. Read `design-tokens.json`.
4. Read `component-board.md`.
5. Read relevant files under `contracts/`.

## Coverage Audit

Every required image must be referenced by at least one Markdown file.

