# UI Design Package Skill Design

- Date: `2026-06-26`
- Topic slug: `ui-design-package-skill`
- Status: `Draft`
- Scope: `Plugin skill`
- Tags: `asset-compounding`, `ui-design`, `imagegen`, `product-design`, `subagent`, `docs-designs`

## Summary

The `superpowers-asset-compounding` plugin should add a UI design package skill
that turns an approved visual prototype into a durable, implementation-ready
design package under `docs/designs/<slug>/`.

The skill is not a generic document writer. It is a visual-first orchestration
workflow:

```text
brief -> visual iteration loop -> approved source image -> image-to-code
-> rendered QA -> design contracts -> subagent task pack
```

The main problem it solves is subagent context loss. A subagent implementing UI
from a short prompt often matches the broad structure but invents colors,
spacing, typography, density, component states, or visual hierarchy. The design
package should prevent that by making the approved image, tokens, screenshots,
contracts, and completion checklist self-contained and mandatory.

## Goals

- Create a new skill, tentatively named `create-ui-design-package`.
- Use a visual-first workflow that iterates images with the user until one
  image is explicitly approved.
- Store all durable design output under `docs/designs/<design-slug>/`, not
  under `docs/superpowers/`.
- Ensure generated visual options and the approved source image are persisted
  inside the design package.
- Use the approved image as the source of truth for image-to-code and later
  design documentation.
- Generate a reference implementation and rendered screenshots before claiming
  the design package is implementation-ready.
- Produce a subagent-ready task pack that lets another agent implement the UI
  without relying on chat history.
- Add validation scripts that check package completeness, local links, required
  evidence, token shape, and subagent handoff rules.
- Extend repository retrieval guidance so future UI work checks
  `docs/designs/` before implementation.
- Make the package compatible with the normal Superpowers spec, plan,
  implementation, review, verification, and archive workflow.

## Non-Goals

- Do not put project UI design packages under `docs/superpowers/`.
- Do not treat the first generated image as final.
- Do not create implementation-ready documents before the user approves a
  source image.
- Do not claim visual fidelity without rendered screenshots.
- Do not make hooks automatically generate images, prototypes, or design
  packages.
- Do not replace Product Design skills. This skill coordinates with visual
  ideation, image-to-code, and design QA workflows instead of reimplementing
  them.
- Do not force every UI package to modify production application code. The
  default implementation target should be a reference prototype unless the user
  explicitly asks to change the product code.

## Skill Name And Trigger

### Skill Name

`create-ui-design-package`

### Description

Suggested frontmatter description:

```yaml
description: Create visual-first UI design packages under docs/designs by iterating ImageGen concepts with the user, approving a source image, converting it through image-to-code, capturing rendered QA screenshots, extracting design tokens and component contracts, and producing a subagent-ready implementation task pack. Use when a project needs UI design docs, visual source-of-truth assets, component guidance, design-system planning, or implementation-ready UI instructions before frontend, TUI, desktop, or app UI work.
```

## Design Principles

### Visual Consensus Before Documents

The skill must not start by writing the full design package. It starts by
creating and iterating visual options until the user explicitly approves one
source image.

Hard rule:

```text
No approved source image, no image-to-code.
No approved source image, no final design package.
```

### Self-Contained Context

The design package must contain enough context for a subagent to implement the
UI without reading the original chat. It should include the source image,
design tokens, component board, contracts, screenshots, known deviations, and a
strict completion protocol.

Hard rule:

```text
If the package requires chat history to understand the design, the package is
incomplete.
```

### Fidelity Over Directional Similarity

The target is not "roughly the same direction." The target is visual fidelity to
the approved source image within the limits of the target platform.

Allowed deviations must be explicit, such as responsive wrapping, terminal
font fallback, or platform accessibility constraints.

### Evidence Before Claims

Implementation-ready documentation requires rendered evidence. The package
must include implementation screenshots and a visual fidelity checklist before
subagent handoff.

Hard rule:

```text
No rendered screenshots, no fidelity claim.
No visual fidelity checklist, no DONE handoff.
```

## Workflow

### 1. Design Brief Gate

Gather or confirm only the context needed to begin visual exploration:

- product or feature name
- target surface: page, screen, flow, component, TUI surface, desktop surface,
  mobile screen, or design-system slice
- intended user and primary job
- visual references: existing design package, screenshot, Figma, URL, app
  surface, brand assets, or desired style
- target platform and constraints
- expected interaction level
- whether image-to-code should create a reference prototype or modify
  production code

If required context is already present, play back the brief and continue. If it
is missing, ask focused questions before generating images.

### 2. Visual Exploration

Generate initial visual options from the brief.

Default behavior:

- Generate three meaningfully different options when style direction is open.
- Generate one focused option when the user already supplied a clear visual
  direction.
- Store every durable generated image under:

```text
docs/designs/<slug>/assets/generated-options/
```

If the ImageGen runtime supports an explicit output directory, use the design
package directory directly. If it does not, materialize or copy the generated
result into the package before the package is considered valid.

Do not leave the design package depending on chat-only images.

### 3. Visual Iteration Loop

Repeat visual revisions until the user explicitly approves a final source
image.

Each iteration should:

1. generate or revise one or more image options
2. ask the user for feedback
3. record the feedback and resulting design decision
4. preserve generated images in `assets/generated-options/`
5. continue until approval

Suggested naming:

```text
round-01-option-a.png
round-01-option-b.png
round-01-option-c.png
round-02-refined-a.png
round-03-approved.png
```

The loop supports:

- changing layout
- changing palette
- changing density
- changing component shape
- adding or removing states
- combining useful traits from multiple options
- aligning more closely with an existing product or design package

### 4. Approved Source Image

When the user approves a visual version, persist it as:

```text
docs/designs/<slug>/assets/source/selected-ui-design.png
```

This image becomes the source of truth for:

- image-to-code
- design token extraction
- component board
- visual contracts
- subagent task pack
- visual fidelity review

Approval must be explicit. A promising image is not an approved source image
until the user confirms it.

### 5. Image To Code

Convert the approved source image into a reference implementation using the
Product Design image-to-code workflow or equivalent local frontend workflow.

Default implementation target:

```text
docs/designs/<slug>/prototype/
```

Alternative target:

- production application code, only when the user explicitly requests it

The prototype should be runnable and screenshot-able. It does not replace the
final product implementation unless the user explicitly asks for production
code changes.

### 6. Rendered QA

Run the prototype or production implementation and capture screenshots.

Minimum screenshot evidence:

```text
docs/designs/<slug>/assets/screenshots/implementation-desktop.png
docs/designs/<slug>/assets/screenshots/implementation-mobile.png
```

For TUI or terminal surfaces, replace mobile with the relevant narrow terminal
or no-color evidence:

```text
docs/designs/<slug>/assets/screenshots/implementation-narrow.png
docs/designs/<slug>/assets/screenshots/implementation-no-color.png
```

Compare the rendered result against `assets/source/selected-ui-design.png`.
Iterate the implementation if it visibly diverges.

### 7. Token And Component Extraction

Extract stable implementation guidance from the approved source image and the
rendered implementation:

- colors
- typography
- spacing
- shape
- elevation
- motion
- breakpoints
- component inventory
- state and variant inventory
- interaction flows
- accessibility and responsive constraints

The package should not require subagents to infer these details from pixels.

### 8. Design Package Generation

Generate the durable design package under:

```text
docs/designs/<slug>/
```

Docs should summarize confirmed visual and rendered evidence. They should not
invent unapproved design rules.

### 9. Subagent Task Pack

Generate `subagent-task-pack.md` as the direct implementation handoff. It must
tell a subagent:

- what to implement
- which files to read first
- which image is mandatory
- which tokens and contracts are mandatory
- what not to invent
- what evidence is required before DONE
- what to do when a design detail is missing

### 10. Package Validation

Run the design package validator before finishing. A valid package has:

- an approved source image
- visual iteration record
- runnable or documented prototype implementation
- rendered screenshots
- design tokens
- component contracts
- visual fidelity checklist
- subagent task pack
- valid local links
- no unresolved TODO/TBD placeholders

## Design Package Layout

The standard package layout is:

```text
docs/designs/<slug>/
  START_HERE.md
  design-brief.md
  visual-source.md
  visual-decision-log.md
  prototype-implementation.md
  subagent-task-pack.md
  visual-fidelity-checklist.md
  design-tokens.json
  traceability.md
  component-board.md
  contracts/
    visual-system.md
    layout-and-regions.md
    component-contracts.md
    states-and-variants.md
    interaction-flows.md
    accessibility-and-responsive.md
  guides/
    implementation-readiness.md
    subagent-implementation-guide.md
    design-readiness-review.md
  assets/
    generated-options/
    source/
      selected-ui-design.png
    screenshots/
    components/
  prototype/
```

For small or incremental design packages, the skill may omit unused contract
files only when `START_HERE.md` and `traceability.md` explain the reduced
scope. It must not omit `START_HERE.md`, `visual-source.md`,
`visual-decision-log.md`, `subagent-task-pack.md`,
`visual-fidelity-checklist.md`, `design-tokens.json`, or the approved source
image.

## File Contracts

### START_HERE.md

Purpose: shortest entry point for future agents.

Required content:

- design goal
- source image path
- required reading order
- implementation target
- hard rules
- validation commands
- DONE requirements

Key rule:

```text
Future UI implementation agents must read START_HERE.md first.
```

### design-brief.md

Purpose: preserve the confirmed brief.

Required content:

- product or feature name
- surface being designed
- target user
- primary job
- visual references
- platform constraints
- interaction level
- prototype mode: `reference` or `production`

### visual-source.md

Purpose: define the approved visual source of truth.

Required content:

- approved source image link
- approval status
- approval notes
- must-match visual traits
- allowed deviations
- forbidden deviations

### visual-decision-log.md

Purpose: preserve the visual iteration history.

Required content per round:

- generated image paths
- user feedback
- retained decisions
- rejected decisions
- next revision direction

This file prevents the final package from losing why the design converged.

### prototype-implementation.md

Purpose: connect the approved image to runnable code.

Required content:

- implementation mode: `reference` or `production`
- code path
- install/run command
- screenshot command or manual screenshot instructions
- rendered screenshot links
- known deviations from the source image
- whether deviations are approved

### subagent-task-pack.md

Purpose: direct handoff to implementation subagents.

Required content:

- task summary
- required reading order
- source image path
- token path
- component board path
- contract paths
- hard rules
- missing-detail protocol
- required DONE format

Required hard rules:

```text
Do not invent colors, spacing, typography, layout regions, component density,
or interaction states.

If a required visual detail is missing, stop and report the missing detail.

Do not mark DONE without screenshots and a completed visual fidelity checklist.
```

### visual-fidelity-checklist.md

Purpose: make completion auditable.

Required checklist items:

- source image opened and inspected
- layout matches source image
- color tokens match implementation
- typography scale matches spec
- spacing rhythm matches source
- component shapes match source
- required states are covered
- desktop screenshot captured
- mobile, narrow, or no-color screenshot captured
- known deviations documented
- deviations approved or explicitly blocked

### design-tokens.json

Purpose: prevent visual guessing.

Required top-level keys:

```json
{
  "colors": {},
  "typography": {},
  "spacing": {},
  "shape": {},
  "elevation": {},
  "breakpoints": {},
  "motion": {}
}
```

If a category does not apply, use an empty object or an explicit neutral value.
Do not leave it undefined.

### traceability.md

Purpose: map design evidence to implementation guidance.

Required content:

- source of truth order
- design graph
- requirement matrix
- asset-to-contract mapping
- implementation touchpoints
- AI reading recipes
- coverage audit
- open questions

### component-board.md

Purpose: capture selected component composition and examples in text-native
form.

Required content:

- rendered scene inventory
- component inventory
- key component examples
- state and variant examples
- design decisions

### contracts/

Purpose: define implementation constraints and acceptance rules.

Recommended contracts:

- `visual-system.md`
- `layout-and-regions.md`
- `component-contracts.md`
- `states-and-variants.md`
- `interaction-flows.md`
- `accessibility-and-responsive.md`

Contracts override images when they clarify text semantics or platform
constraints. Images remain the visual source of truth.

## Missing Detail Protocol

The design package must explicitly instruct subagents to stop instead of
guessing when required visual detail is missing.

Missing details include:

- unknown color token
- unknown spacing rhythm
- missing state for a required interaction
- unclear responsive behavior
- source image and contract contradiction
- implementation platform limitation that prevents matching the source image

Expected subagent response:

```text
BLOCKED: design detail missing
missing_detail: <specific missing or contradictory design detail>
affected_files: <files or components blocked by the gap>
needed_decision: <specific decision needed from the main agent or user>
```

## Prototype Strategy

The default image-to-code target is a reference prototype inside the design
package:

```text
docs/designs/<slug>/prototype/
```

Advantages:

- design package stays self-contained
- product code is not modified before visual validation
- screenshots are reproducible
- subagents can inspect a concrete implementation example

Production implementation mode is allowed only when the user explicitly asks
for it. In production mode, `prototype-implementation.md` must link the
modified product files and the run command used for screenshots.

## Asset Path Rules

All generated and approved images must be materialized inside the package.

Required paths:

```text
docs/designs/<slug>/assets/generated-options/
docs/designs/<slug>/assets/source/selected-ui-design.png
docs/designs/<slug>/assets/screenshots/
docs/designs/<slug>/assets/components/
```

If ImageGen supports direct output path selection, generate directly into
`assets/generated-options/`. If it does not, ingest the generated images into
the package before proceeding.

The package must never depend on chat-only image artifacts.

## Scripts

Add a script facade under the new skill:

```text
plugins/superpowers-asset-compounding/skills/create-ui-design-package/scripts/design_package.py
```

Expected subcommands:

```powershell
python <skill>\scripts\design_package.py create . <slug> --mode new
python <skill>\scripts\design_package.py create . <slug> --mode extend --source docs/designs/<source>
python <skill>\scripts\design_package.py check . docs/designs/<slug> --json
python <skill>\scripts\design_package.py summarize . docs/designs/<slug> --json
```

`create` scaffolds directories and starter documents. It should not invent a
final design or mark source images approved.

`check` validates:

- required files exist
- required directories exist
- `selected-ui-design.png` exists when package status is implementation-ready
- generated options are referenced by `visual-decision-log.md`
- `design-tokens.json` is valid JSON and contains required top-level keys
- `subagent-task-pack.md` contains DONE rules
- `visual-fidelity-checklist.md` contains screenshot evidence fields
- markdown links resolve
- image references resolve
- package does not contain unresolved `TODO` or `TBD`

`summarize` reports package status for closeout and future retrieval.

## Skill Resources

The skill should include:

```text
references/
  start-here-template.md
  design-brief-template.md
  visual-source-template.md
  visual-decision-log-template.md
  prototype-implementation-template.md
  subagent-task-pack-template.md
  visual-fidelity-checklist-template.md
  traceability-template.md
  component-board-template.md
  design-tokens-schema.md
```

Keep `SKILL.md` concise and route details to references. The skill body should
own workflow, gates, and resource navigation, not repeat every template.

## AGENTS Retrieval Guidance

Repository guidance should include `docs/designs/` alongside Superpowers asset
areas.

Suggested managed-block addition:

```text
Design packages: docs/designs/

For UI work, read docs/designs/<slug>/START_HERE.md before implementation.
The approved source image, design-tokens.json, component-board.md, contracts/,
and subagent-task-pack.md override general style guesses.
If a design detail is missing, stop and report the gap instead of inventing
visual decisions.
```

This belongs in repository retrieval guidance, not in every final handoff.

## Relationship To Existing Skills

### Product Design

Use Product Design concepts for:

- design brief gate
- visual ideation
- image-to-code
- screenshot QA

This skill should not duplicate those workflows. It coordinates them and
materializes durable project assets.

### ImageGen

Use ImageGen for visual options and refinements. Persist every durable output
inside `docs/designs/<slug>/assets/generated-options/`.

### Asset Compounding

The design package itself lives under `docs/designs/`. The skill development
spec, plan, archive, and future problem notes still live under
`docs/superpowers/`.

Completion of this skill implementation should be archived like other plugin
features.

## Superpowers Workflow Compatibility

The design package workflow should fit before and beside the existing
Superpowers workflow instead of replacing it.

The intended sequence for UI work is:

```text
create-ui-design-package
  -> Superpowers brainstorming/spec design
  -> Superpowers implementation plan
  -> implementation subagents
  -> verification and visual fidelity QA
  -> archive/problem/inbox closeout
```

The design package is the visual and interaction baseline. Superpowers specs
and plans are the implementation reasoning and delivery-control artifacts.

### Boundary With Superpowers Specs

Superpowers specs under `docs/superpowers/specs/` should reference the design
package when the work implements or changes UI.

A UI-focused spec should include:

- design package path
- approved source image path
- relevant `START_HERE.md`
- relevant `component-board.md`
- relevant contracts
- fidelity requirements
- known allowed deviations
- open design questions that block implementation

The spec should not duplicate the whole design package. It should summarize the
implementation requirement and link the package as the source of truth.

If a Superpowers spec contradicts the design package:

1. `docs/designs/<slug>/assets/source/selected-ui-design.png` owns visual
   intent.
2. `docs/designs/<slug>/contracts/` owns visual semantics, state rules, and
   platform constraints.
3. `docs/superpowers/specs/` owns the implementation scope for the current
   slice.

When the contradiction changes visual intent, update the design package first
or record a blocked design decision. Do not silently let the spec override the
approved visual baseline.

### Boundary With Superpowers Plans

Implementation plans should treat the design package as required context for
any UI slice.

A UI implementation plan should include a first-step context gate:

```text
Read docs/designs/<slug>/START_HERE.md, visual-source.md,
design-tokens.json, component-board.md, contracts/, and
subagent-task-pack.md before editing UI code.
```

Plan steps should include explicit visual verification work:

- implement against the approved source image
- render the UI
- capture required screenshots
- complete `visual-fidelity-checklist.md`
- document known deviations
- stop for user/design approval when fidelity cannot be achieved

Plans should not ask subagents to "make it look good" or "follow the general
style." They should point to concrete package files.

### Subagent Prompt Compatibility

When Superpowers dispatches implementation subagents for UI work, the main
agent should pass the design package path and require the subagent to start
from `subagent-task-pack.md`.

Recommended subagent prompt shape:

```text
Implement the UI slice using this design package:
docs/designs/<slug>/

Read START_HERE.md and subagent-task-pack.md first. Match
assets/source/selected-ui-design.png and design-tokens.json. Do not invent
colors, spacing, typography, layout regions, component density, or interaction
states. If a required design detail is missing, return BLOCKED with the exact
gap. Before DONE, capture screenshots and complete
visual-fidelity-checklist.md.
```

Subagent DONE output should include:

- implementation file paths
- desktop screenshot path
- mobile, narrow, or no-color screenshot path
- completed fidelity checklist path
- known deviations
- tests or preview command

Without those items, the main agent should treat the subagent result as
incomplete rather than accepted.

### Archive Compatibility

When a UI requirement is completed, the Superpowers archive should link both:

- the Superpowers spec and plan
- the related `docs/designs/<slug>/` package

Archive summaries should mention that the design package supplied the approved
visual baseline and subagent execution context. They should not copy the
design package contents.

The archive writer should treat `docs/designs/<slug>/` as a visual/source
document family for UI work, similar to how it already treats optional visual
artifacts beside specs and plans.

### Problem And Inbox Compatibility

If UI implementation drifts from the design package because of missing tokens,
ambiguous states, inaccessible source images, or incomplete subagent prompts,
the main agent should route that signal through the normal asset gate:

- stable repeatable failure mode -> `new-problem`
- weak but reusable signal -> `inbox`
- follow-up to an existing UI design package issue -> `update-existing`

Examples:

- subagent ignored `docs/designs/` because AGENTS retrieval omitted it
- source image existed only in chat and was not persisted
- design tokens were incomplete, causing palette guessing
- screenshots were missing but DONE was accepted

### Status And Closeout Compatibility

Future status helpers may include matching design packages in
`asset_status.py --topic <topic>` and `asset_closeout.py --topic <topic>`.
This is not required for the first implementation, but the package layout
should make it easy to discover design assets by slug and topic.

For first release compatibility, the minimum requirement is:

- Superpowers specs can link to design packages.
- plans require package reading before UI edits.
- archives can link design packages as source documents.
- AGENTS retrieval guidance names `docs/designs/`.
- subagent task packs define DONE evidence in a way the main agent can enforce.

## Acceptance Criteria

- The plugin exposes a `create-ui-design-package` skill.
- The skill requires a design brief before image generation.
- The skill supports multi-round visual iteration and records decisions in
  `visual-decision-log.md`.
- The skill requires explicit user approval before creating
  `assets/source/selected-ui-design.png`.
- The skill does not proceed to image-to-code without an approved source image.
- The skill defaults image-to-code output to
  `docs/designs/<slug>/prototype/`.
- The skill stores generated image options under
  `docs/designs/<slug>/assets/generated-options/`.
- The skill stores the approved source image under
  `docs/designs/<slug>/assets/source/selected-ui-design.png`.
- The skill produces `subagent-task-pack.md` with missing-detail protocol and
  DONE requirements.
- The skill produces `visual-fidelity-checklist.md` requiring screenshots and
  known-deviation reporting.
- The skill produces `design-tokens.json` with required top-level keys.
- The validator catches missing required files, invalid token JSON, dead links,
  unreferenced required images, missing screenshot fields, and unresolved
  TODO/TBD placeholders.
- Repository guidance can be updated so UI work discovers `docs/designs/`
  before implementation.
- Superpowers specs, plans, subagent prompts, archives, and problem/inbox
  routing have explicit compatibility rules for using design packages.
- UI implementation subagent handoff requires reading `subagent-task-pack.md`
  and returning screenshot plus fidelity checklist evidence before DONE.
- Existing asset-compounding tests continue to pass:

```powershell
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

## Implementation Strategy

1. Add the new skill scaffold and templates.
2. Add `design_package.py create/check/summarize` with tests.
3. Extend AGENTS managed guidance generation to mention `docs/designs/`.
4. Update plugin README and manifest metadata to include UI design packages.
5. Add tests covering package creation, package validation, token validation,
   markdown links, image paths, and subagent task pack checks.
6. Run full plugin tests and `git diff --check`.
7. Archive the completed requirement after implementation and verification.

## Risks

### Visual Iteration Artifacts Become Noisy

The package could accumulate too many failed image directions. Keep all
approval-relevant images, but let the decision log distinguish retained versus
rejected options.

### Documentation Gets Ahead Of Evidence

Agents may be tempted to write final docs before screenshots exist. The skill
must keep implementation-ready docs blocked until source image approval and
rendered QA are complete.

### Subagent Still Ignores The Package

The package needs a short `START_HERE.md`, a direct `subagent-task-pack.md`, and
repository retrieval guidance. Long docs alone are not enough.

### ImageGen Output Path May Not Be Controllable

The skill should not assume ImageGen can write directly to the package path.
It should allow direct output when available, but require an ingest step before
validation passes.

### TUI And Web Need Different Evidence

TUI packages may need narrow/no-color screenshots instead of mobile screenshots.
The validator should support platform-specific evidence profiles.

## Open Decisions

- Whether `prototype/` should live inside `docs/designs/<slug>/` for all
  repositories or be configurable to `artifacts/design-prototypes/<slug>/`.
- Whether the first validator release should check image dimensions and file
  hashes, or only path presence and references.
- Whether AGENTS guidance should be updated by the existing
  `ensure_agent_asset_guidance.py` script or by a new design-package helper.
- Whether a future route should let `asset_status.py --topic` include matching
  `docs/designs/` packages.
