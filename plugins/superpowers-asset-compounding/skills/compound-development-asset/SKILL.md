---
name: compound-development-asset
description: Use when `using-asset-compounding` decides preservation may be needed. Finds related assets, selects `none`, `inbox`, `update-existing`, `archive`, `new-problem`, or `both`, and dispatches writer skills.
---

# Compound Development Asset

## Overview

Use this skill after work has already converged and the goal is to route reusable value into the right asset workflow instead of leaving the learning trapped in chat history or code diffs.

This skill is a router and coordinator. It decides whether the current work should produce:

- no asset
- an inbox note
- an update to an existing asset
- an archive asset
- a new problem asset
- both archive and problem assets

It does not write archive or problem documents itself.

Within the asset compounding system:

- `using-asset-compounding` is the entry skill and end-of-session gate
- `compound-development-asset` is the classifier/router
- `archive-superpowers-feature` writes completed requirement archives
- `write-superpowers-problem` writes problem assets, inbox notes, and problem/inbox updates
- `manage-superpowers-milestone` writes and updates project milestone ledgers
- `manage-technical-debt` writes and updates technical-debt records

## Routing Choices

Prefer the lightest useful route, but do not drop reusable uncertainty. Small
copy, style, spacing, position, or verification-only follow-ups are usually
`none` unless they update an existing archive/problem/inbox note. Weak,
uncertain, "could archive or could skip", or review-discovered problem signals
go to `inbox`; stable evidence gets formal promotion.

### `none`

Choose `none` only when the work is clearly one-off, mechanical, or not useful for future retrieval.

### `inbox`

Choose `inbox` when the signal might matter later but is not stable enough for a formal problem/archive asset.

This is the default route for weak but potentially reusable signals, such as local UI preference drift, possible tool quirks, one-off observations, fixes without confirmed root cause, review findings that suggest a mistake class, or task-boundary lessons that future agents might search for.

Also choose `inbox` for user validation feedback, CI/release warnings, installer
or artifact warnings, and hosted automation deprecations when no related asset
exists yet. These signals are often not product bugs, but they are useful future
release knowledge.

Route to `write-superpowers-problem`.

### `update-existing`

Choose `update-existing` when related archive, problem, or inbox assets already cover the same completed requirement, failure class, or uncertain signal.

Prefer `update-existing` for CI/release/user-validation feedback when a related
archive, problem, or inbox already exists. Do not create a duplicate inbox note
just because the new signal is weaker than a formal problem.

Route to:

- `archive-superpowers-feature` if the update is archive-only
- `write-superpowers-problem` if the update is problem/inbox-related
- both writer skills if both asset types need updates

### `archive`

Choose `archive` when the main value is a completed requirement, completed feature, design-to-implementation thread, or finished change that future lookup will start from as "what did we build?"

Route to `archive-superpowers-feature`.

### `new-problem`

Choose `new-problem` when the main value is a stable, distinct failure mode, root cause, debugging pattern, recovery rule, or "do not do this again" lesson.

Require enough evidence to describe symptom, trigger/context, root cause, fix, and recognition clues. If those pieces are not available yet, choose `inbox` or `update-existing`.

Route to `write-superpowers-problem`.

### `both`

Choose `both` when the work delivered a completed requirement and also uncovered reusable debugging knowledge.

Use this route only when the debugging knowledge is stable enough for a formal problem asset. A completed feature plus a small preference tweak or ordinary fix is usually `archive` plus `inbox` or `update-existing`, not `both`.

Route to both:

- `archive-superpowers-feature` for the completed requirement
- `write-superpowers-problem` for the failure pattern or inbox/problem update

## Default Project Layout

For Superpowers-style projects, use these locations:

- specs root: `docs/superpowers/specs/`
- plans root: `docs/superpowers/plans/`
- archive root: `docs/superpowers/archives/`
- archive index: `docs/superpowers/archives/INDEX.md`
- archive month folder: `docs/superpowers/archives/YYYY-MM/`
- problem root: `docs/superpowers/problems/`
- problem index: `docs/superpowers/problems/INDEX.md`
- problem month folder: `docs/superpowers/problems/YYYY-MM/`
- inbox root: `docs/superpowers/inbox/`
- inbox index: `docs/superpowers/inbox/INDEX.md`
- inbox month folder: `docs/superpowers/inbox/YYYY-MM/`
- milestone root: `docs/milestones/`
- milestone index: `docs/milestones/INDEX.md`
- milestone folder: `docs/milestones/YYYY-MM/<milestone-slug>/`
- technical-debt root: `docs/technical-debt/`
- technical-debt index: `docs/technical-debt/INDEX.md`
- technical-debt month folder: `docs/technical-debt/YYYY-MM/`
- repository entry guide: `AGENTS.md` or `AGENT.md`

If a selected output area does not exist yet, let the writer skill create it when the route actually requires writing.

## Script-Assisted Routing

Use bundled scripts for deterministic checks. Do not make Codex manually redo work that a script can check more reliably.

Scripts live in `scripts/`:

- `suggest_asset_route.py`: suggest `none`, `inbox`, `update-existing`, `new-problem`, `archive`, or `both` from changed files and keywords.
- `find_related_assets.py`: find related `specs`, `plans`, `archives`, `problems`, `inbox`, `milestones`, and `technical-debt` notes by slug or keywords before deciding whether to update or create.
- `check_indexes.py`: check `archives`, `problems`, `inbox`, `milestones`, and `technical-debt` index ordering, duplicate entries, dead links, and orphan asset files.
- `bootstrap_asset_compounding.py`: initialize `docs/superpowers/` directories and the managed `AGENTS.md` retrieval block.
- `ensure_agent_asset_guidance.py`: create or update a managed AGENTS.md section for specs/plans/archives/problems/inbox/milestones/technical-debt retrieval.
- `check_completion_gate.py`: check close-out evidence, completed-topic archive coverage, reviewer/subagent asset candidates, src/tests relayout leftovers, and solution-folder drift before final handoff.
- `asset_status.py`: answer topic-level status questions by summarizing requirement archive, related problem/inbox assets, milestone and technical-debt signals, index health, and completed-topic gate status.
- `asset_closeout.py`: aggregate topic status into a closeout route, required actions, related milestone/debt gaps, related assets, and a compact handoff block before merge, PR, cleanup, or final response.
- `milestone_assets.py`: create, update, recompute, and check project milestone ledgers under `docs/milestones/`.
- `technical_debt_assets.py`: create, update, close, and check technical-debt records under `docs/technical-debt/`.

Use scripts as evidence, not as final authority:

- scripts can identify facts, candidates, broken links, and likely routes
- Codex still makes the final routing decision
- if script output and reasoning disagree, inspect the evidence and explain the override

Recommended commands from a repository root:

```bash
python <skill>/scripts/suggest_asset_route.py . --keywords "<topic or symptom>"
python <skill>/scripts/find_related_assets.py . <slug-or-keywords>
python <skill>/scripts/check_indexes.py .
python <skill>/scripts/bootstrap_asset_compounding.py . --write
python <skill>/scripts/ensure_agent_asset_guidance.py . --diff
python <skill>/scripts/milestone_assets.py . check --json
python <skill>/scripts/technical_debt_assets.py . check --json
python <skill>/scripts/asset_status.py . --topic "<topic>" --json
python <skill>/scripts/asset_closeout.py . --topic "<topic>" --json
python <skill>/scripts/check_completion_gate.py . --json
python <skill>/scripts/check_completion_gate.py . --completed-topic "<topic>" --json
```

Document-shape validators belong to the writer skills:

- archive validation: `archive-superpowers-feature/scripts/validate_archive_asset.py`
- problem/inbox validation: `write-superpowers-problem/scripts/validate_problem_asset.py`
- inbox lifecycle review: `write-superpowers-problem/scripts/inspect_inbox_lifecycle.py`

Run the matching validator before treating an asset write as complete. `check_indexes.py` only validates index health; it is not a substitute for validating the asset document itself.

## Repository Entry Guidance

`AGENTS.md` is the project-level retrieval surface. It should not duplicate generic workflow rules from this skill or the plugin hooks; it should tell future agents where to look before guessing.

When a repository has `docs/superpowers/` or starts creating Superpowers assets, ensure `AGENTS.md` or `AGENT.md` has a managed asset-compounding retrieval block.

Use:

```bash
python <skill>/scripts/ensure_agent_asset_guidance.py . --diff
python <skill>/scripts/ensure_agent_asset_guidance.py . --write
```

In v0.2.0 and later, the managed block is intentionally small. It should cover:

- `docs/superpowers/specs/` and `plans/` for requirement history
- `docs/superpowers/archives/` for completed delivery history
- `docs/superpowers/problems/` for stable reusable failure modes
- `docs/superpowers/inbox/` for uncertain but potentially reusable signals
- `docs/milestones/` for project milestone ledgers
- `docs/technical-debt/` for technical-debt records
- the preferred `rg` keyword search command
- a short note that lifecycle enforcement, plan-boundary checkpoints, and closeout nudges are hook-owned

Do not put full routing boundaries, completion gates, or problem/inbox policy into the managed `AGENTS.md` block. Those rules belong in the plugin skills and hooks. Do not overwrite repository-specific hotspots, architecture notes, language rules, or code-first fallback paths. Add the managed retrieval block alongside them.

## Workflow

### 0. Run the main-agent problem gate at task boundaries

For meaningful development work, run this router after implementation,
spec-review, code-quality review, and verification are complete enough to review
as one unit. The gate belongs before starting the next planned task, before
merge/PR/cleanup when applicable, or before the final response when no next task
remains.

Only the main agent should execute this gate. Subagents should keep their native
workflow handoff format and should not write or promote problem/inbox/archive
assets unless the main agent explicitly delegates that asset-writing task.

At this gate, collect candidates from implementation issues, debugging paths,
failed or flaky tests, spec mismatches, code quality review findings, provider
or tool quirks, platform-specific runtime behavior, subagent reports, and
plan-boundary checkpoints. If a candidate is useful but immature, choose
`inbox` rather than `none`.

When the check script is available, run it before final handoff or cleanup:

```bash
python <skill>/scripts/asset_closeout.py . --topic "<topic>" --json
python <skill>/scripts/check_completion_gate.py . --json
```

If the work completed or accepted a coherent requirement, phase, feature, or
spec-to-plan implementation thread, run the same check with a completed topic:

```bash
python <skill>/scripts/check_completion_gate.py . --completed-topic "<topic>" --json
```

`missing_requirement_archive` is a blocking close-out issue. It means matching
spec+plan coverage exists without archive coverage, even if the generic
completion gate would otherwise pass. Do not interpret a plain `status: pass`
as `route: none` for completed requirement work.

Project-level milestone and technical-debt gaps usually produce
`update-existing` or closeout required actions, not new route values. Preserve
the existing route vocabulary and dispatch to the milestone/debt writer skills
only when the evidence says those project-level assets need creation or update.

If preparing a written final handoff, also validate that it includes the
auditable gate output:

```bash
python <skill>/scripts/check_completion_gate.py . --require-asset-gate --handoff-file <handoff.md> --json
```

### 1. Classify the current learning

Ask:

1. Is there a completed requirement that should be discoverable by topic later?
2. Is there a reusable failure mode, debugging pattern, or recovery rule with stable root-cause evidence?
3. Is the learning stable enough for formal promotion, or should it first be parked in inbox?
4. Does an existing asset already cover this same feature or failure class?
5. Will future lookup start from feature history, problem pattern, inbox signal, or an existing asset?

When the repository has `docs/superpowers/`, run `scripts/suggest_asset_route.py` with the best available keywords or changed files. Treat its output as a first-pass route suggestion, not as a hard gate.

When running the main-agent problem gate, pass `--problem-gate` so weak problem
signals are biased toward `inbox` instead of being dropped as ordinary polish.

For release, installer, GitHub Actions, artifact, tag, hosted CI, or deployment
feedback, include those words in `--keywords` and pass `--problem-gate`. Hosted
automation warnings should not be silently discarded just because the release
event succeeded.

### 2. Find related assets before writing

Before creating any formal asset, run or emulate:

```bash
python <skill>/scripts/find_related_assets.py . <slug-or-keywords>
```

Prefer updating an existing asset over creating a duplicate.

When updating a problem or archive, also search related inbox notes. If an inbox
signal has now been promoted, fixed, disproved, or superseded, update its
lifecycle instead of leaving it open-ended.

If the write-side lifecycle inspector is available, prefer it over ad hoc inbox
search:

```bash
python <write-superpowers-problem>/scripts/inspect_inbox_lifecycle.py . <topic-keywords> --needs-revisit-only
```

### 3. Ensure repository retrieval guidance exists

If the repository starts using Superpowers assets, or if any `docs/superpowers/`
directory already exists, run the bootstrap script first:

```bash
python <skill>/scripts/bootstrap_asset_compounding.py . --write
```

This is the preferred initialization path. It is idempotent and should create
the standard asset directories plus the managed `AGENTS.md` retrieval block.

If only the managed `AGENTS.md` block needs to be checked or refreshed, run:

```bash
python <skill>/scripts/ensure_agent_asset_guidance.py . --diff
```

If the script reports a missing or stale managed block, update `AGENTS.md` with `--write` unless the user explicitly asked not to touch repository guidance.

This is especially important when `inbox` is introduced into a project that already had older archive/problem-only guidance.

### 4. Dispatch to writer skills

Use the route to choose writer skills:

- `archive` -> use `archive-superpowers-feature`
- `inbox` -> use `write-superpowers-problem`
- `new-problem` -> use `write-superpowers-problem`
- `update-existing` -> use the writer skill that owns the existing asset type
- `both` -> use both writer skills
- `none` -> write no asset and state the concrete reason

Do not write archive/problem/inbox documents directly from this router.

### 5. Run deterministic checks

After writer skills update archive/problem/inbox indexes, run:

```bash
python <skill>/scripts/check_indexes.py .
```

Also run the writer-owned document validators for any new or modified archive/problem/inbox files. Fix missing metadata, missing sections, dead links, ordering, duplicate entries, and orphan files before close-out.

## Common Mistakes

- Writing problem or inbox documents directly in this router instead of using `write-superpowers-problem`
- Reimplementing archive logic here instead of using `archive-superpowers-feature`
- Creating a new problem asset when an existing one should be updated
- Promoting a weak `fix`/`issue`/`problem` signal directly into a formal problem instead of inbox
- Using `both` for ordinary implementation fixes that do not contain stable failure knowledge
- Dropping an uncertain but potentially reusable signal instead of routing it to inbox
- Adding assets but leaving `AGENTS.md` without retrieval guidance for archives/problems/inbox
- Treating milestone or technical-debt gaps as new asset route values instead of required actions or `update-existing`
- Duplicating the full generic skill workflow in `AGENTS.md` instead of adding only project-level retrieval guidance
- Promoting unstable one-off noise into AGENTS or memory too early

## Deliverables

When using this skill, produce one or more of:

- a route decision: `none`, `inbox`, `update-existing`, `archive`, `new-problem`, or `both`
- related asset candidates from `find_related_assets.py`
- initialized `docs/superpowers/` directories and managed `AGENTS.md` guidance when the project first enters the asset system
- a managed `AGENTS.md` asset retrieval block when the project lacks one
- archive output via `archive-superpowers-feature`
- problem/inbox output via `write-superpowers-problem`
- index validation output from `check_indexes.py`
- a short note explaining whether the learning stayed in docs or should be promoted to repo or global rules
