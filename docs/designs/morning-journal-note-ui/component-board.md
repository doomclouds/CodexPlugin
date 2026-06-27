# Morning Journal Note UI Component Board

Design slug: `morning-journal-note-ui`

## Purpose

Capture the selected visual and interaction direction in text-native form so
implementation subagents can build the React prototype without inferring
component details from pixels alone.

## Rendered Scenes

| Scene | Asset | Contract | Purpose |
| --- | --- | --- | --- |
| Approved desktop source | `assets/source/selected-ui-design.png` | `contracts/visual-system.md` | Visual source of truth for layout, hierarchy, density, and mood. |
| Generated asset board | `assets/components/asset-samples/asset-samples-preview.png` | `asset-manifest.json` | Shows the bitmap assets available for implementation. |

## Rendered Components

| Component | Primary asset inputs | Contract |
| --- | --- | --- |
| `AppShell` | `sunlit-desk-bg-1536x1024.png`, `botanical-corner-512.png` | `contracts/layout-and-regions.md` |
| `TopBar` | `avatar-warm-160.png` | `contracts/component-contracts.md` |
| `MemoryTrail` | six `memory-*-320x220.png` thumbnails | `contracts/component-contracts.md` |
| `WritingSanctuary` | `paper-texture-warm-ivory-1024.png`, `pressed-flower-tape-512.png` | `contracts/component-contracts.md` |
| `RhythmPanel` | `note-slip-small-360x180.png`, `note-slip-360x220.png`, `note-slip-tall-360x260.png`, transparent decorations | `contracts/component-contracts.md` |
| `FlowStrip` | `paper-texture-warm-ivory-1024.png` | `contracts/component-contracts.md` |

## Key Component Examples

### AppShell

- Uses a `1536x1024` desktop source frame.
- Desktop grid:
  - top command bar across the upper surface
  - left memory rail
  - center writing editor
  - right rhythm panel
  - bottom flow strip
- Background uses the generated sunlit desk image as material atmosphere, with
  UI panels layered above it.

### MemoryTrail

- Left column width should feel around 300px on the source desktop viewport.
- Entries include date group, thumbnail, title, time, mood label, and colored
  status dot.
- Current entry is selected with a soft sage outline and warmer paper surface.
- Timeline markers use small colored rings/dots, not large icon buttons.

### WritingSanctuary

- Dominant central surface with tactile paper texture.
- Header includes `Morning Prompt`, `What would make today meaningful?`, focus
  mode, and expand/utility controls.
- Main editor area must remain spacious and calm.
- Toolbar sits along the bottom edge with familiar text/editor icons.
- It must be a real editable region, not image text.

### RhythmPanel

- Right column uses paper-note sections, not generic app cards.
- Sections:
  - Mood
  - Energy
  - Intention
  - Gratitude
  - Today's Focus
- Mood chips are compact, softly colored, and selectable.
- Energy uses a slider with a warm multi-color track.
- Gratitude and Focus use list rows inside taller paper slips.

### FlowStrip

- Bottom strip spans the app surface and includes:
  - Flow State summary
  - Focus Sound
  - `25:00` timer
  - Start/pause control
  - Morning Progress
  - short quote
- It should feel integrated into the desk/paper system, not like a media player
  glued on top.

## State And Variant Examples

- Memory entry selected/unselected.
- Mood chip selected/unselected.
- Energy slider value changes.
- Flow Mode toggle on/off.
- Editor focused with active cursor.
- Timer start/pause.
- Save status changes after editing.
- Narrow layout stacks or compresses right panel below/after editor.

## Design Decisions

- Richness comes from generated bitmap material assets plus restrained React UI,
  not from complex CSS art.
- The approved source image is for comparison only; final UI is composed from
  React components and generated atomic assets.
- Border radii stay small: 4-8px for card-like surfaces, pill radius only for
  toggles and timer controls.
- Letter spacing is 0 for display/body text; small labels may use slight
  positive tracking.
- Center editor remains visually quiet; detail density belongs mostly in the
  rails and rhythm panel.
