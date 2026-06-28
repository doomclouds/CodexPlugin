# Design Tokens

Package: `morning-journal-note-ui`

## Source

Use `../design-tokens.json` as the machine-readable token source. This document
explains how implementation should apply those values.

## Color Usage

| Token group | Usage |
| --- | --- |
| `color.canvas.*` | full app background, warm desk atmosphere, paper planes |
| `color.ink.*` | primary text, secondary labels, muted metadata |
| `color.sage.*` | selected/focus states, calm progress, active toggles |
| `color.sunrise.*` | warm highlights, timer, positive emphasis |
| `color.gold.*` | energy slider, small glints, progress accents |
| `color.coral.*` | mood accents and small warm status details |
| `color.cool.*` | rare contrast details only; never dominate the screen |

Do not replace the palette with framework defaults.

## Typography Usage

- `font.display`: title, prompt heading, expressive diary headings.
- `font.ui`: controls, chips, rail labels, body UI.
- `font.editor`: editable writing surface.
- `type.display.*`: top title and prompt hierarchy.
- `type.body.*`: editor and panel copy.
- `type.label.*`: metadata, chips, section labels.

No negative letter spacing. Use `letterSpacing: 0` for most text.

## Spacing Usage

- `space.1-3`: internal control and chip spacing.
- `space.4-6`: panel padding and list rhythm.
- `space.7-8`: region gaps and outer app breathing room.

Keep spacing stable. Hover/focus states must not change region dimensions.

## Shape Usage

- `radius.panel`: large paper panels.
- `radius.card`: memory rows, note sections, thumbnails.
- `radius.control`: buttons, chips, compact controls.
- `radius.round`: avatar, slider thumb, circular markers.

Cards should stay within 4-8px unless the element is naturally round or pill-like.

## Elevation Usage

- `shadow.paper`: default layered paper.
- `shadow.lift`: hover or selected paper note.
- `shadow.float`: only for high-priority surfaces such as the central editor.
- `shadow.inset`: pressed controls and text areas.

Shadows should remain warm and soft.

## Asset Token Usage

`design-tokens.json` includes asset aliases that map to
`asset-manifest.json`. Implementation should import from
`prototype/src/assets/generated/` and keep the manifest names intact.

## Acceptance Checklist

- React/CSS references token values or equivalent CSS custom properties.
- Color usage follows semantic intent, not arbitrary hex copying.
- Typography hierarchy matches source image rhythm.
- Asset aliases resolve to generated atomic assets, not the full source mock.
