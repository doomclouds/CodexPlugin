# Asset Compounding v0.3.0 Milestones and Technical Debt Design

- Date: `2026-06-13`
- Status: `Draft`
- Scope: `superpowers-asset-compounding`
- Tags: `asset-compounding`, `milestones`, `technical-debt`, `status-checks`, `script-refactor`

## Context

`superpowers-asset-compounding` currently preserves three main asset families:

- completed requirement history in `docs/superpowers/archives/`
- reusable failure modes in `docs/superpowers/problems/`
- uncertain but potentially reusable signals in `docs/superpowers/inbox/`

That model is useful for individual features, bug fixes, and debugging lessons, but it does not yet cover two project-level asset needs that have appeared in OpenHarnessTS practice:

- long-running milestone progress ledgers under `docs/milestones/`
- explicit engineering debt records under `docs/technical-debt/`

OpenHarnessTS has already used milestones to track phase progress across multiple specs, plans, and archives, and has used technical-debt records to preserve refactor obligations that should influence future slice selection. The v0.3.0 goal is to standardize those practices in the plugin without turning the closeout gate into a noisy route machine.

## Design Principle

The core boundary for v0.3.0 is:

```text
Skills own workflow and semantics.
Scripts own state, indexes, consistency checks, and mechanical updates.
```

Models should decide whether a topic is meaningful enough to become a milestone or technical-debt record, then draft the human explanation. Scripts should update statuses, recompute counts, synchronize indexes, validate document shape, check local links, and report closeout gaps.

The model should not manually count milestone progress, manually synchronize index rows, manually validate links, or rely on memory to decide whether a closed debt record has a matching archive.

## Goals

- Add a `manage-superpowers-milestone` skill for milestone creation, update, status checks, and index maintenance.
- Add a `manage-technical-debt` skill for technical-debt creation, update, closure, status checks, and index maintenance.
- Introduce reusable templates for milestone and technical-debt documents.
- Refactor script responsibilities so existing commands can grow without becoming large mixed-responsibility scripts.
- Extend `asset_status.py` and `asset_closeout.py` so topic status can include milestone and technical-debt signals.
- Preserve existing `asset_gate.route` values in v0.3.0.

## Non-Goals

- Do not replace Superpowers specs, plans, archives, problems, or inbox notes.
- Do not make every feature or refactor into a milestone.
- Do not split technical debt into large and small debt categories.
- Do not extend `asset_gate.route` with milestone or technical-debt route values in this release.
- Do not make hooks write milestone or technical-debt documents automatically.
- Do not remove existing CLI entry points such as `asset_status.py`, `asset_closeout.py`, `check_indexes.py`, or `check_completion_gate.py`.

## Milestone Skill

### Skill Name

`manage-superpowers-milestone`

### Role

This skill manages project milestone ledgers. It creates and updates milestone documents, explains when a milestone is appropriate, and delegates state changes and validation to scripts.

It does not implement milestone slices. Each slice should still have its own Superpowers spec, implementation plan, verification evidence, and archive when completed.

### Milestone Definition

A milestone is a strategically meaningful continuous development phase with trackable progress. It is defined by strategic significance, continuity, and progress visibility, not by a rigid slice count.

Milestones may be large or small:

- A large milestone usually spans three or more slices and often crosses multiple modules or capability areas.
- A small milestone may contain only two high-value stages when its strategic role is explicit and important to the project direction.

A milestone should usually exist when:

- the work advances the project into a named stage or capability level
- the work needs multiple trackable states or slices
- progress would be hard to understand from individual archives alone
- completion changes how future work should be selected
- the milestone has a clear final acceptance statement

A milestone should not be created for:

- a single ordinary feature
- a single bug fix
- a single refactor
- a loose backlog list
- exploration without a clear strategic acceptance target
- ordinary task decomposition that does not need a project-level ledger

When a milestone has only two slices, the README must explain why it has strategic significance. The validator should warn when a two-slice milestone lacks that explanation. It should not fail solely because the slice count is below three.

### Milestone Files

The skill owns this layout:

```text
docs/milestones/INDEX.md
docs/milestones/YYYY-MM/<milestone-slug>/README.md
docs/milestones/YYYY-MM/<milestone-slug>/CHECKLIST.md
```

`INDEX.md` is the cross-milestone table. It should stay scan-friendly and show:

- month
- milestone
- checklist
- status
- progress
- notes

`README.md` defines the milestone standard. It should explain what the phase means and how to judge completion.

`CHECKLIST.md` is the progress ledger. It should not become an implementation plan.

### Milestone Templates

The skill should include:

```text
skills/manage-superpowers-milestone/references/milestone-readme-template.md
skills/manage-superpowers-milestone/references/milestone-checklist-template.md
```

The README template should include:

- `Background`: why the milestone exists
- `Strategic Significance`: why this phase matters to the project
- `Milestone Goal`: the named target state
- `Acceptance Statement`: one short statement proving the milestone is done
- `Scope`: included capability areas
- `Non-Goals`: explicit boundaries
- `Reference Signals`: existing implementations, prior archives, architecture references, or user decisions
- `Slice Boundaries`: each slice goal and completion signal
- `Update Rules`: when to update the checklist, index, and related archives

The checklist template should include:

- progress summary
- slice checklist
- update rules

Each slice entry should use stable fields:

- `Status`
- `Related spec`
- `Related plan`
- `Related archive`
- `Completion signal`

### Milestone Statuses

Milestone status values:

- `Not Started`
- `In Progress`
- `Done`
- `Deferred`
- `Split`

Slice status values:

- `Not Started`
- `In Progress`
- `Done`
- `Deferred`
- `Split`

The script layer should recompute summary counts from slice status values. The model should not hand-count these values.

### Slice Rules

A milestone slice should be independently understandable and independently verifiable.

Each slice should:

- have one clear capability or phase outcome
- be small enough to receive its own spec and plan
- produce verification evidence
- produce an archive when completed
- keep implementation detail in the spec or plan, not the milestone checklist

Each slice should not:

- be named as miscellaneous cleanup
- mix unrelated work just to fill the milestone
- include step-by-step implementation instructions in `CHECKLIST.md`
- be marked `Done` without an archive unless the milestone explicitly explains why no archive is required

### Milestone Scripts

The milestone skill should use scripts for mechanical state operations. A single script facade is acceptable if subcommands keep responsibilities clear:

```text
milestone_assets.py create
milestone_assets.py update-slice
milestone_assets.py recompute
milestone_assets.py check
```

Expected behavior:

- `create` scaffolds README, CHECKLIST, and INDEX entries from templates.
- `update-slice` changes one slice status and related links.
- `recompute` recalculates progress summary and updates milestone index progress.
- `check` validates document shape, link health, status consistency, count consistency, and archive coverage for completed slices.

Write operations should require an explicit write path, such as a mutating subcommand or `--write`. Check operations should support `--json`.

## Technical Debt Skill

### Skill Name

`manage-technical-debt`

### Role

This skill manages engineering debt records. It creates, updates, closes, and checks technical-debt documents, while delegating state synchronization and validation to scripts.

Technical debt is not split into large and small categories in v0.3.0. It is one unified asset type managed by status, priority, revisit trigger, and resolution criteria.

### Technical Debt Definition

A technical-debt record captures a known engineering problem that should influence future work selection.

Technical debt is appropriate when:

- the current implementation is acceptable for now but will increase future complexity
- a better direction is known but out of scope for the current milestone or slice
- repeated patterns, broad responsibilities, or unclear boundaries will make future work harder
- the issue needs a future refactor slice or focused design to resolve
- the user or reviewer explicitly identifies something that should be repaid later

Technical debt is not appropriate when:

- the issue is a bug with stable root cause and recovery clues, which belongs in `docs/superpowers/problems/`
- the issue can be fixed immediately with a small local edit
- the note is low-value code preference without a revisit trigger
- the concern is too vague to define resolution criteria
- the item is a general backlog feature rather than debt

### Technical Debt Files

The skill owns this layout:

```text
docs/technical-debt/INDEX.md
docs/technical-debt/YYYY-MM/YYYY-MM-DD-<debt-slug>-debt.md
```

The index should show:

- month
- debt
- status
- priority
- milestone
- revisit trigger
- notes

### Technical Debt Template

The skill should include:

```text
skills/manage-technical-debt/references/technical-debt-template.md
```

Required metadata:

- `Date`
- `Topic slug`
- `Status`
- `Milestone`
- `Debt type`
- `Priority`
- `Revisit trigger`
- `Scope`
- `Related slice`

Required sections:

- `Summary`: what the debt is
- `Why This Is Debt`: why it is not just a normal task or bug
- `Current Impact`: what cost it creates now
- `Resolution Criteria`: what must be true before the debt can close
- `Initial Resolution Direction`: likely repair direction without becoming a full implementation plan
- `Non-Goals`: boundaries for the debt record
- `Related Assets`: milestone, spec, plan, archive, problem, inbox, or code references

When the debt is closed, the document must include:

- `Closure`: what changed, what remains out of scope, and which archive proves completion

### Technical Debt Statuses

Allowed statuses:

- `Open`
- `In Progress`
- `Closed`
- `Superseded`
- `Won't Fix`

Status meanings:

- `Open`: confirmed debt exists and is not currently being repaid
- `In Progress`: a repayment slice, spec, plan, or implementation is active
- `Closed`: repayment is complete and linked to an archive
- `Superseded`: replaced by a newer design, debt record, or architecture direction
- `Won't Fix`: intentionally accepted and no longer tracked as active debt

`Closed` records must link a related archive. `Superseded` records must link the replacement. `Won't Fix` records must explain why the debt is intentionally accepted.

### Technical Debt Scripts

The technical-debt skill should use scripts for mechanical state operations:

```text
technical_debt_assets.py create
technical_debt_assets.py set-status
technical_debt_assets.py close
technical_debt_assets.py check
```

Expected behavior:

- `create` scaffolds a debt document and index row.
- `set-status` updates status consistently in the detail file and index.
- `close` sets status to `Closed`, inserts or updates `Closure`, requires an archive link, and updates the index row.
- `check` validates metadata, required sections, allowed statuses, index consistency, local links, and closure requirements.

Write operations should be explicit. Check operations should support `--json`.

## Script Responsibility Split

Current scripts have useful behavior, but responsibilities have started to mix:

- `check_completion_gate.py` checks archive coverage, handoff text, and repository structure.
- `check_indexes.py` parses index files and validates index health directly.
- `asset_closeout.py` maps status to route decisions and required actions.

v0.3.0 should introduce shared internals while preserving existing CLI entry points.

### Shared Core

Add shared core modules under the compound-development scripts area:

```text
scripts/asset_core/areas.py
scripts/asset_core/topics.py
scripts/asset_core/discovery.py
scripts/asset_core/indexes.py
scripts/asset_core/issues.py
```

Responsibilities:

- `areas.py`: asset area registry and path conventions
- `topics.py`: slug canonicalization and filename date parsing
- `discovery.py`: asset discovery and topic matching
- `indexes.py`: index parsing, ordering checks, duplicate checks, dead-link checks, orphan checks
- `issues.py`: consistent issue and result dictionaries

The registry should include existing Superpowers areas plus project-level areas:

- `specs`
- `plans`
- `archives`
- `problems`
- `inbox`
- `milestones`
- `technical-debt`

### Domain Checks

Add domain-specific check modules:

```text
scripts/checks/archive_checks.py
scripts/checks/milestone_checks.py
scripts/checks/technical_debt_checks.py
scripts/checks/handoff_checks.py
scripts/checks/repo_structure_checks.py
```

Responsibilities:

- `archive_checks.py`: spec and plan coverage versus archive coverage
- `milestone_checks.py`: milestone README, checklist, progress, index, and completed-slice archive consistency
- `technical_debt_checks.py`: technical-debt metadata, status, closure, archive link, and index consistency
- `handoff_checks.py`: `asset_gate` handoff text completeness
- `repo_structure_checks.py`: repository layout checks that are not asset-specific

### CLI Facades

Keep these existing scripts as stable entry points:

```text
check_indexes.py
asset_status.py
asset_closeout.py
check_completion_gate.py
```

They should become orchestration facades over the shared core and domain checks. This keeps older README, AGENTS, specs, plans, and user habits valid.

## Status and Closeout Integration

### asset_status.py

`asset_status.py --topic <topic>` should report:

- requirement archive status
- related problem assets
- related inbox assets
- related milestone assets or checklist entries
- related technical-debt assets
- index health
- completion gate status

The output should stay compact. JSON output may contain full structured detail.

### asset_closeout.py

`asset_closeout.py --topic <topic>` should add milestone and technical-debt gaps to `required_actions`.

Examples:

- completed slice has archive but milestone checklist still says `In Progress`
- milestone index progress does not match checklist progress
- technical-debt record is still `Open` after the repayment archive exists
- technical-debt record is `Closed` but lacks a closure section or archive link
- technical-debt index row disagrees with the detail file

The route should continue to use the existing route vocabulary:

```text
none | inbox | update-existing | archive | new-problem | both
```

Milestone and technical-debt issues should usually produce `update-existing` or required actions, not new route values.

### asset_gate

v0.3.0 should not extend `asset_gate.route`.

Milestone and technical-debt signals should appear in:

- `related_assets`
- `asset_candidates`
- `deferred_signals`
- `required_actions` from closeout scripts

This preserves the existing protocol while making the closeout checks more useful.

## Skill Coordination

The high-level routing remains:

- `archive-superpowers-feature` writes completed requirement archives
- `write-superpowers-problem` writes problem and inbox assets
- `manage-superpowers-milestone` writes and updates milestone ledgers
- `manage-technical-debt` writes and updates technical-debt records
- `compound-development-asset` remains the router for requirement/problem/inbox preservation and can call status/closeout scripts for broader context

The new skills should not be hidden inside the existing archive or problem writers. Milestones and technical debt have different semantics and need their own templates, status rules, and validators.

## Validation

Add tests for:

- milestone creation templates
- milestone checklist recompute
- milestone index synchronization
- milestone check warnings for small milestones without strategic significance
- completed milestone slices requiring archive links
- technical-debt creation templates
- technical-debt status updates
- closed debt requiring closure and archive link
- technical-debt index consistency
- `asset_status.py` reporting milestone and debt matches
- `asset_closeout.py` producing required actions for milestone and debt gaps
- existing archive/problem/inbox checks staying compatible
- existing CLI names staying valid

Primary verification command:

```powershell
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Also run:

```powershell
git diff --check
```

## Implementation Strategy

Implement in stages:

1. Add script core modules and move shared parsing, discovery, issue, and index logic behind existing CLI facades.
2. Keep existing tests green after the refactor.
3. Add milestone templates, script support, validators, and tests.
4. Add technical-debt templates, script support, validators, and tests.
5. Extend `asset_status.py` and `asset_closeout.py` to include milestone and debt signals.
6. Add the two new skills and update plugin README and manifest metadata.
7. Bump plugin version to `0.3.0`.

This order reduces blast radius. The script refactor should prove compatibility before new asset types are layered on.

## Risks

### Milestone Overuse

If milestones are too easy to create, the repository can accumulate progress ledgers for ordinary tasks. The skill should be conservative and require strategic significance, especially for small milestones.

### Script Refactor Blast Radius

Refactoring shared script internals can break existing closeout flows. Keep CLI facades stable and preserve current behavior before adding new asset types.

### Technical Debt Versus Problem Confusion

Technical debt and problem assets can look similar. The skill must keep the split clear: problem assets preserve stable failure modes and recovery rules; technical-debt assets preserve known engineering obligations that should influence future work.

### Closeout Noise

Milestone and debt checks should improve closeout evidence without causing extra Stop hook interruptions. v0.3.0 should report gaps through status and closeout scripts, not by expanding hook route semantics.

## Open Decisions

- Exact command names for milestone and technical-debt script facades can still change during implementation planning.
- The validator can decide whether a two-slice milestone without strategic significance is a warning or a needs-review status, but it should not be a hard error.
- The milestone and technical-debt script modules may live under the compound-development skill scripts area first, then be shared by the new writer skills through relative paths.
