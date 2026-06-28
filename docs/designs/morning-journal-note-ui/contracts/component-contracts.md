# Component Contracts

Package: `morning-journal-note-ui`

## AppShell

Responsibilities:

- Load the sunlit desk background.
- Provide the responsive grid.
- Place botanical/decorative assets with low priority behind or beside UI
  regions.
- Expose stable layout slots for `TopBar`, `MemoryTrail`, `WritingSanctuary`,
  `RhythmPanel`, and `FlowStrip`.

Required assets:

- `sunlit-desk-bg-1536x1024.png`
- `botanical-corner-512.png`

## TopBar

Visible content:

- `Sunlit Memory Flow` or `Morning Journal`
- `Today`
- `May 15, 2025`
- `Flow Mode`
- `Saved`
- profile avatar

Interactions:

- date navigation affordances
- flow mode toggle
- saved state indicator

## MemoryTrail

Data rows:

1. `Morning clarity` / `7:32 AM` / `Calm`
2. `Grateful heart` / `7:28 AM` / `Grateful`
3. `Small wins` / `7:15 AM` / `Motivated`
4. `Reset & realign` / `7:07 AM` / `Peaceful`
5. `Slow is smooth` / `7:18 AM` / `Mindful`
6. `New perspective` / `7:22 AM` / `Inspired`

Required behavior:

- click entry to select it
- selected entry uses sage outline and warmer backing
- each entry uses the matching `memory-*.png` asset

## WritingSanctuary

Visible content:

- `Morning Prompt`
- `What would make today meaningful?`
- `Start writing...`
- bottom toolbar with text formatting and insert controls
- word count

Required behavior:

- editable text area
- focused state with visible cursor
- word count updates from editor content
- editing changes save status to unsaved, then saved after simulated delay or
  explicit save action

Required assets:

- `paper-texture-warm-ivory-1024.png`
- optional `pressed-flower-tape-512.png` if it does not invade the writing area

## RhythmPanel

Sections:

- Mood: selectable chips `Calm`, `Grateful`, `Motivated`, `Tired`, `Anxious`
- Energy: slider, visible value such as `7 / 10`
- Intention: short editable text
- Gratitude: three list rows
- Today's Focus: three checkbox-style priority rows

Required assets:

- `note-slip-small-360x180.png`
- `note-slip-360x220.png`
- `note-slip-tall-360x260.png`
- transparent decorations: `washi-tape-set-512.png`,
  `paperclip-set-512.png`, `pressed-flower-tape-512.png`

## FlowStrip

Visible groups:

- Flow State
- Focus Sound / `Morning Piano`
- `25:00`
- Start / pause button
- Morning Progress
- quote: `Clarity comes when we slow down.`

Required behavior:

- start/pause timer state
- progress value can move visually
- focus sound control has selected state

## Acceptance Checklist

- Every visible component maps to a named contract above.
- Every bitmap asset used by a component appears in `asset-manifest.json`.
- No component relies on the full source image as implementation material.
