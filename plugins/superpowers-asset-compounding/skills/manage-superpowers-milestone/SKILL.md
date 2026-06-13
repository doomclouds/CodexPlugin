---
name: manage-superpowers-milestone
description: Create, update, check, and close project milestone ledgers under docs/milestones. Use when a strategically meaningful continuous development phase needs tracked slices, README/CHECKLIST templates, progress recomputation, status checks, or INDEX.md synchronization.
---

# Manage Superpowers Milestone

Use this skill for `docs/milestones` ledgers that track strategically meaningful development phases. Milestones may be large multi-slice efforts or small milestones around a few high-value stages; strategic significance defines a milestone more than slice count.

## Workflow

- Use `compound-development-asset/scripts/milestone_assets.py` for creation, updates, status checks, closure, progress recomputation, and `docs/milestones/INDEX.md` synchronization.
- Do not hand-edit script-owned status, progress counts, closeout state, or index entries when `milestone_assets.py` can perform the state update.
- Keep `CHECKLIST.md` at progress-ledger level: slice names, status, progress summary, and links.
- Keep implementation details, task breakdowns, and acceptance reasoning in specs, plans, and archives instead of the milestone checklist.
- After edits, run `milestone_assets.py check --json` and fix reported issues before closeout.

## Boundaries

- Use a milestone when a continuous phase deserves durable progress tracking and coordination.
- Use specs or plans for implementation design and task sequencing.
- Use archives for completed delivery evidence linked from milestone slices.
