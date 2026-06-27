# {{DESIGN_TITLE}} Component Board

Design slug: `{{DESIGN_SLUG}}`

## Purpose

Capture selected visual and interaction direction in text-native form so implementation subagents do not infer component details from pixels alone.

## Rendered Scenes

| Scene | Asset | Contract | Purpose |
| --- | --- | --- | --- |
| Approved source | `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | Source of truth |

## Rendered Components

| Component | Asset | Contract |
| --- | --- | --- |
| Primary component | `assets/component-assets/` | `contracts/component-contracts.md` |

## Package-local Runtime Assets

- List any bitmap assets required by `asset-manifest.json`.
- Keep final paths in sync with `assets/component-assets/` and `prototype/src/assets/generated/`.
- Use this section to record why each asset exists and which contract it supports.

## Key component examples

- Record the primary component examples that best capture the intended design language.
- Include the visual elements a subagent must inspect before inventing new UI.

## State and variant examples

- Record hover, focus, pressed, disabled, empty, loading, error, and responsive variants that the implementation must preserve.

## Design Decisions

- Record component density, hierarchy, spacing rhythm, and state treatment.
