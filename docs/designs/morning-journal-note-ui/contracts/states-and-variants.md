# States And Variants

Package: `morning-journal-note-ui`

## Purpose

This prototype must feel like a living morning journal, not a static poster.
States should be small, tactile, and calm. Avoid large animations or generic
dashboard transitions.

## Memory Entry State

| State | Visual treatment | Behavior |
| --- | --- | --- |
| Default | warm paper row, muted thumbnail, small mood dot | entry is clickable |
| Hover | thumbnail lifts 2px, paper warms slightly | cursor changes to pointer |
| Selected | sage outline, stronger paper surface, timeline marker filled | selected entry controls the editor title/context |
| Focus | visible sage focus ring outside row | keyboard accessible |

The selected row is `Morning clarity` by default.

## Mood Chip State

| State | Visual treatment |
| --- | --- |
| Default | compact tinted chip, low border contrast |
| Hover | warmer fill and slightly stronger border |
| Selected | sage or sunrise fill, deep ink label, subtle inset shadow |
| Focus | 2px visible focus ring with offset |

Only one mood chip is selected at a time in the reference prototype.

## Energy Slider State

- Range: `0` to `10`.
- Default value: `7`.
- Track: warm gradient from soft coral to gold to sage.
- Thumb: small paper or pearl-like circular control with visible shadow.
- Label: always show `n / 10`.

## Editor State

| State | Visual treatment | Behavior |
| --- | --- | --- |
| Empty | prompt placeholder visible, quiet paper texture | user can type |
| Focused | caret visible, editor surface brightens subtly | toolbar stays available |
| Dirty | save indicator changes to `Saving...` or `Unsaved` | simulated local state |
| Saved | save indicator returns to `Saved` | no backend persistence required |

Do not render diary body text as part of a bitmap. The writing area must be an
actual editable element.

## Flow Mode State

- Off: neutral paper toggle, label remains readable.
- On: sage fill, warm highlight dot, `Flow Mode` active.
- Reduced-motion users should not receive decorative pulsing.

## Timer State

| State | Visual treatment | Behavior |
| --- | --- | --- |
| Idle | `25:00`, start icon/button visible | click starts timer |
| Running | timer warms, pause icon/button visible | time may tick or remain simulated |
| Paused | muted timer and start icon/button | click resumes |

The timer is the visual anchor of the bottom strip.

## Responsive Variants

| Width | Layout behavior |
| --- | --- |
| `>= 1200px` | full five-region desktop layout |
| `900px - 1199px` | memory rail narrows, right panel remains visible, flow strip wraps groups |
| `600px - 899px` | editor first, memory entries become horizontal row, rhythm panel stacks below |
| `< 600px` | single column, compact top bar, bottom flow groups wrap into readable rows |

## Acceptance Checklist

- Selected, hover, focus, and active states are visible for interactive controls.
- State changes do not resize layout regions.
- Editor and controls remain real DOM elements.
- Mobile/narrow variant keeps editor as the primary workflow.
