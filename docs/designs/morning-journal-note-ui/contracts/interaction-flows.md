# Interaction Flows

Package: `morning-journal-note-ui`

## Scope

The reference prototype demonstrates local interaction only. It does not need a
backend, authentication, real diary persistence, or real audio playback.

## Entry Flow

1. User opens the prototype.
2. `Morning clarity` is selected in the memory rail.
3. The editor shows the morning prompt and empty writing surface.
4. Rhythm panel shows default mood `Calm`, energy `7 / 10`, and editable
   intention/gratitude/focus sections.

The first viewport should immediately communicate the final visual direction:
sunlit paper, memory rail, center writing sanctuary, right rhythm panel, and
bottom flow strip.

## Memory Selection Flow

1. User clicks a memory entry.
2. Selected state moves to that row.
3. Editor context title can update to match the memory title.
4. Mood label and thumbnail remain stable and visible.

No animated page transition is required; use a subtle highlight shift.

## Writing Flow

1. User focuses the editor.
2. Placeholder disappears when text is entered.
3. Word count updates.
4. Save status changes from `Saved` to `Saving...` or `Unsaved`.
5. After a short simulated delay or explicit save action, status returns to
   `Saved`.

The writing area is the product's emotional center. Keep interactions quiet and
low-friction.

## Mood And Energy Flow

1. User selects one mood chip.
2. Selected visual state moves to the chosen chip.
3. Energy slider changes value and label.
4. The panel remains compact; changing values must not push other content out
   of view.

## Focus Flow

1. User toggles `Flow Mode`.
2. Bottom strip and top bar reflect active state.
3. User starts or pauses timer.
4. Timer button switches between start and pause affordances.

Audio controls are visual only for this reference prototype.

## Narrow Layout Flow

1. TopBar compresses but keeps title, date, flow toggle, and avatar/save status.
2. MemoryTrail becomes a horizontal selectable row above the editor.
3. WritingSanctuary remains the first large content block.
4. RhythmPanel stacks below editor.
5. FlowStrip wraps groups without text overlap.

## Acceptance Checklist

- Main flow can be completed with mouse and keyboard.
- No interaction depends on hidden instructions.
- State changes are visually confirmed.
- Layout remains stable during interaction.
