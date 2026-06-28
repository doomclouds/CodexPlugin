# Layout And Regions

Package: `morning-journal-note-ui`

## Desktop Source Frame

- Source image frame: `1536x1024`.
- Desktop prototype target: match the source frame as closely as possible.
- Use a full app surface; do not place the whole UI inside a centered card.

## Desktop Region Grid

Recommended desktop structure:

```text
┌────────────────────────────────────────────────────────────────────┐
│ TopBar                                                             │
├──────────────┬──────────────────────────────────────┬──────────────┤
│ MemoryTrail  │ WritingSanctuary                     │ RhythmPanel  │
│              │                                      │              │
├──────────────┴──────────────────────────────────────┴──────────────┤
│ FlowStrip                                                          │
└────────────────────────────────────────────────────────────────────┘
```

Approximate region sizing at source width:

- outer margin: 24-32px
- app gap: 18-22px
- top bar height: 64-76px
- left rail width: 300-320px
- right rail width: 340-360px
- bottom strip height: 78-96px
- center editor consumes remaining width

## TopBar

Contains:

- product title and subtitle at far left
- date navigation and current date
- flow mode toggle and utility controls near center/right
- saved status and avatar at far right

It should sit on the background surface with light paper-like controls, not a
solid navbar slab.

## MemoryTrail

- Left vertical region with paper panel background.
- Timeline line and colored markers sit along the left edge of entries.
- Current day entry has a stronger paper surface and sage outline.
- Thumbnails must preserve a consistent aspect ratio and rounded 6-8px corners.

## WritingSanctuary

- Largest region.
- Paper editor panel with prompt header, divider, empty writing area, bottom
  toolbar, and word count.
- Keep the editor body spacious: no decorative image should cross into the main
  writing area.

## RhythmPanel

- Right vertical region.
- Use stacked paper slips with slight material offsets.
- Must include Mood, Energy, Intention, Gratitude, and Today's Focus.
- Avoid making every section look like identical bordered app cards.

## FlowStrip

- Bottom region spans almost full viewport width.
- It contains multiple functional groups separated by subtle dividers.
- Timer is the visual anchor.
- The strip should align with the left/right rails and center editor.

## Narrow Behavior

For narrow screens:

- Keep TopBar compact.
- MemoryTrail may become a horizontal scroll row or collapse above the editor.
- WritingSanctuary remains first priority.
- RhythmPanel can stack below the editor.
- FlowStrip can wrap into two rows.

## Acceptance Checklist

- Desktop composition matches source image proportions.
- Center editor is the dominant visual mass.
- Left and right rails support the flow, not overpower it.
- Narrow layout remains usable without text overlap.
