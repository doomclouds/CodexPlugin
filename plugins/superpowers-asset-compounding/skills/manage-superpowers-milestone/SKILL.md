---
name: manage-superpowers-milestone
description: Create, update, check, and close project milestone ledgers under docs/milestones. Use when a strategically meaningful continuous development phase needs tracked slices, README/CHECKLIST templates, progress recomputation, status checks, or INDEX.md synchronization.
---

# Manage Superpowers Milestone

Use this skill for `docs/milestones` ledgers that track strategically meaningful development phases. Milestones may be large multi-slice efforts or small milestones around a few high-value stages; strategic significance defines a milestone more than slice count.

## SOP Requirements

Before creating or rewriting a milestone, make the README answer these questions plainly:

- What is the target stage this milestone moves the project into?
- Why does this stage matter strategically now?
- What concrete outcome proves the milestone is complete?
- What acceptance criteria must be true before the milestone can be marked `Done`?
- What is explicitly outside this milestone?
- Which specs, plans, archives, prior implementations, user decisions, or technical-debt records should later agents read before planning new slices?

Every slice must describe a slice boundary, not a loose task:

- State the slice goal and the phase outcome it unlocks.
- State what the slice does and does not include.
- Link or reserve space for the related spec, plan, archive, and completion signal.
- Keep implementation steps out of `CHECKLIST.md`; put design and sequencing detail in specs and plans.
- Mark `Done` only when the slice has delivery evidence or an explicit reason no archive applies.

## Workflow

- Use `compound-development-asset/scripts/milestone_assets.py` for creation, updates, status checks, closure, progress recomputation, and `docs/milestones/INDEX.md` synchronization.
- Do not hand-edit script-owned status, progress counts, closeout state, or index entries when `milestone_assets.py` can perform the state update.
- Before finishing milestone creation or major milestone updates, inspect root `AGENTS.md` or `AGENT.md`. Ensure it has an English `Milestone Navigation` section or the managed asset-compounding block from `compound-development-asset/references/agents-asset-guidance-template.md`.
- The milestone navigation must point to `docs/milestones/INDEX.md` and explain that milestone records track target stages, strategic significance, slice boundaries, acceptance signals, progress, and links to evidence.
- If milestone navigation is missing or stale, run `compound-development-asset/scripts/ensure_agent_asset_guidance.py . --write` from the repository root, or patch the same English guidance manually when the script is unavailable.
- Preserve existing repository rules and the managed `asset-compounding-guidance` markers when updating `AGENTS.md`; do not duplicate generic hook routing or closeout policy there.
- Keep `CHECKLIST.md` at progress-ledger level: slice names, status, progress summary, and links.
- Keep implementation details, task breakdowns, and acceptance reasoning in specs, plans, and archives instead of the milestone checklist.
- After edits, run `milestone_assets.py check --json` and fix reported issues before closeout.

## Boundaries

- Use a milestone when a continuous phase deserves durable progress tracking and coordination.
- Use specs or plans for implementation design and task sequencing.
- Use archives for completed delivery evidence linked from milestone slices.
- Use `Deferred` when a slice is intentionally paused but remains part of the milestone.
- Use `Split` when a slice must be decomposed into later milestone slices; record the new boundary before continuing.
