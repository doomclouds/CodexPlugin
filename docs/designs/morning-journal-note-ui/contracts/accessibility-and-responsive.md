# Accessibility And Responsive

Package: `morning-journal-note-ui`

## Accessibility Contract

- Use semantic controls for buttons, toggles, sliders, checkboxes, and editable
  text.
- Every icon-only command needs an accessible label and hover tooltip.
- Focus rings must be visible against warm paper surfaces.
- Text contrast must remain readable on generated bitmap textures.
- Interactive controls need at least a 36px target on desktop and 40px on
  narrow touch layouts.
- Do not encode state with color alone; selected rows and chips also need
  outline, fill, or shape differences.

## Keyboard Contract

- Tab order follows the visual flow: TopBar, MemoryTrail, editor, RhythmPanel,
  FlowStrip.
- Arrow keys are optional for memory/mood groups, but Tab and Enter/Space must
  work.
- Editor focus must not trap the user; Escape or Tab should move away normally.
- Slider must be keyboard-adjustable.

## Reduced Motion

- Respect `prefers-reduced-motion`.
- Decorative shimmer, pulsing timer, or background drift should be disabled or
  reduced.
- Essential state changes should still be visible without motion.

## Responsive Contract

The desktop source is `1536x1024`, but the prototype must not break below that
size.

| Breakpoint | Required behavior |
| --- | --- |
| `>= 1200px` | full desktop layout with left rail, center editor, right panel, bottom strip |
| `900px - 1199px` | narrower rails, same region order, flow strip can wrap |
| `600px - 899px` | top bar compact, memory as horizontal row, rhythm panel below editor |
| `< 600px` | single column, no overlapping text, editor remains prominent |

## Text Containment

- Buttons and chips must not clip text.
- Long entry titles should ellipsize after one line in rails.
- Editor body wraps naturally.
- Bottom strip groups may wrap, but should keep each group internally aligned.

## Screenshot Requirements

Before marking fidelity complete, capture:

- desktop: `assets/screenshots/implementation-desktop.png`
- narrow/mobile: `assets/screenshots/implementation-mobile.png`

## Acceptance Checklist

- Keyboard, focus, and screen-reader labels are represented in the React UI.
- No visible text overlaps at desktop or narrow widths.
- Reduced-motion path avoids decorative movement.
- Screenshots prove the responsive layout.
