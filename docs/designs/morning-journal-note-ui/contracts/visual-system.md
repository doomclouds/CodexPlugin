# Visual System

Package: `morning-journal-note-ui`

## Visual Direction

`Sunlit Memory Flow` is a tactile, warm, personal morning journal interface.
It should feel like opening a private writing desk at sunrise, not like using a
generic productivity dashboard.

The design combines:

- implementable app regions from the third visual direction
- sunrise paper/stationery material feeling from the first visual direction
- generated atomic bitmap assets for texture, memory, and decoration
- React/CSS components for actual UI, controls, text, and state

## Palette Contract

Use `design-tokens.json` as the implementation source. The dominant impression
must be warm ivory and sunrise paper, with sage and peach accents.

Required color behavior:

- background: warm desk/paper atmosphere, not flat white
- primary text: deep graphite
- secondary text: muted brown/gray
- selected states: sage outline/fill with warm paper backing
- warm highlights: sunrise/gold/coral
- cool accents: muted cyan/lavender, only as small mood/status details

Avoid:

- dominant blue neon/glass treatment
- purple gradient UI theme
- pure gray SaaS surfaces
- high-contrast black/white dashboard styling

## Material Contract

Bitmap assets are required for:

- sunlit desk background
- paper texture
- note slip backgrounds
- memory photo thumbnails
- transparent stationery/botanical decorations
- profile avatar

Do not replace these with CSS-only approximations. CSS may add shadows,
overlays, blend modes, and panel structure, but not fake the asset subject.

## Typography Contract

- Use an elegant serif for brand/title and the main prompt heading.
- Use a refined sans-serif for controls, labels, body UI, and editor text.
- Body/editor text should remain around 15-16px with generous line height.
- No negative letter spacing.
- Do not use exaggerated handwriting fonts for editable text.

## Shape And Elevation Contract

- Card-like surfaces use 4-8px radius.
- Pill controls are allowed only for toggles, timer buttons, and compact command
  controls.
- Shadows should feel like layered paper on a desk:
  soft, warm, and broad rather than dark or floating.
- No nested card-heavy SaaS layout. Paper notes can overlap visually, but their
  component boundaries must remain clear.

## Acceptance Checklist

- Warm tactile paper feeling is visible before reading text.
- Center editor dominates the composition.
- Memory rail and rhythm panel add color and personality without clutter.
- Bitmap assets appear intentional and high quality.
- The UI is recognizably the approved source image, not a generic journal app.
