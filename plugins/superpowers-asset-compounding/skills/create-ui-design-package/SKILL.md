---
name: create-ui-design-package
description: Create visual-first UI design packages under docs/designs by iterating ImageGen concepts with the user, approving a source image, converting it through image-to-code, capturing rendered QA screenshots, extracting design tokens and component contracts, and producing a subagent-ready implementation task pack. Use when a project needs UI design docs, visual source-of-truth assets, component guidance, design-system planning, or implementation-ready UI instructions before frontend, TUI, desktop, or app UI work.
---

# Create UI Design Package

## Role

Use this skill to create a durable UI design package under `docs/designs/<slug>/`.

This skill is not a generic document writer. It coordinates a visual-first workflow:

```text
brief -> visual iteration loop -> approved source image -> image-to-code
-> rendered QA -> design contracts -> subagent task pack
```

The package must let a future Superpowers implementation subagent match the approved UI without relying on chat history or guessing colors, spacing, typography, component density, layout regions, or states.

## Hard Gates

- No approved source image, no image-to-code.
- No approved source image, no final design package.
- No rendered screenshots, no fidelity claim.
- No `subagent-task-pack.md`, no subagent handoff.
- No `design-tokens.json`, no implementation-ready package.
- No `visual-fidelity-checklist.md`, no completed design package.
- No persisted images under `docs/designs/<slug>/assets/`, no package validation.

## Workflow

### 1. Confirm the brief

Confirm:

- product or feature name
- target UI surface
- intended user and primary job
- visual references or desired style
- platform constraints
- interaction level
- prototype mode: `reference` or `production`

If these are already clear, play back the brief instead of asking again.

### 2. Create or open the package shell

Use:

```powershell
python <skill>\scripts\design_package.py create . <slug> --mode new --write
```

For an extension of an existing design package:

```powershell
python <skill>\scripts\design_package.py create . <slug> --mode extend --source docs/designs/<source> --write
```

### 3. Run visual exploration

Use ImageGen or Product Design visual ideation to generate initial options.

Persist every durable generated image under:

```text
docs/designs/<slug>/assets/generated-options/
```

If ImageGen cannot write directly to that directory, ingest the generated image into the package before validation.

### 4. Run the Visual Iteration Loop

Repeat until the user explicitly approves one final image:

1. generate or revise image options
2. ask the user for feedback
3. record feedback in `visual-decision-log.md`
4. preserve generated images in `assets/generated-options/`
5. continue until approval

Do not treat the first generated image as final.

### 5. Persist the approved source image

When the user approves a visual version, store it as:

```text
docs/designs/<slug>/assets/source/selected-ui-design.png
```

This image is the visual source of truth for image-to-code, contracts, tokens, and subagent implementation.

### 6. Convert image to code

Use Product Design image-to-code or an equivalent local frontend workflow.

Default target:

```text
docs/designs/<slug>/prototype/
```

Only modify production application code when the user explicitly asks for production mode.

### 7. Capture rendered QA evidence

Run the prototype or product UI and capture screenshots:

- desktop screenshot for web/desktop UI
- at least one mobile screenshot for responsive UI, or a narrow/no-color screenshot for TUI or terminal UI

Store screenshots under:

```text
docs/designs/<slug>/assets/screenshots/
```

### 8. Complete contracts and subagent pack

Use the templates in `references/` to complete:

- `START_HERE.md`
- `design-brief.md`
- `visual-source.md`
- `visual-decision-log.md`
- `prototype-implementation.md`
- `subagent-task-pack.md`
- `visual-fidelity-checklist.md`
- `design-tokens.json`
- `traceability.md`
- `component-board.md`
- `contracts/`
- `guides/`

Docs must summarize confirmed visual and rendered evidence. Do not invent unapproved design rules.

### 9. Validate the package

Run:

```powershell
python <skill>\scripts\design_package.py check . docs/designs/<slug> --json
```

Fix every error before handoff.

`check` and `summarize` only accept packages that resolve inside `<repo>/docs/designs/`.

## Missing Detail Protocol

If a required visual detail is missing, stop and report:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

Do not invent palette, spacing, typography, layout regions, component density, or interaction states.

## Superpowers Workflow Compatibility

The design package comes before and beside the normal Superpowers workflow:

```text
create-ui-design-package
  -> Superpowers brainstorming/spec design
  -> Superpowers implementation plan
  -> implementation subagents
  -> verification and visual fidelity QA
  -> archive/problem/inbox closeout
```

Superpowers specs and plans should link the design package instead of duplicating it. UI implementation subagents must start from `START_HERE.md` and `subagent-task-pack.md`, then return screenshots and a completed `visual-fidelity-checklist.md` before DONE.

Archives for completed UI work should link the related `docs/designs/<slug>/` package as a source document.

## References

Load these only when needed:

- `references/start-here-template.md`
- `references/design-brief-template.md`
- `references/visual-source-template.md`
- `references/visual-decision-log-template.md`
- `references/prototype-implementation-template.md`
- `references/subagent-task-pack-template.md`
- `references/visual-fidelity-checklist-template.md`
- `references/traceability-template.md`
- `references/component-board-template.md`
- `references/design-tokens-schema.md`
