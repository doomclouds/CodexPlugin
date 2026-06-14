<!-- asset-compounding-guidance:start -->
## Asset Compounding Retrieval Guide

This repository uses hook-assisted asset compounding from the `superpowers-asset-compounding` plugin. Keep this `AGENTS.md` block as repository-specific retrieval anchors only; generic routing, plan-boundary checkpoints, closeout reminders, and `asset_gate` nudges belong to the plugin hooks and skills.

If the plugin was just installed or upgraded, review and trust the bundled hooks with `/hooks` before relying on lifecycle automation.

### Asset Directories

- Specs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`
- Archives: `docs/superpowers/archives/`
- Problems: `docs/superpowers/problems/`
- Inbox: `docs/superpowers/inbox/`
- Milestones: `docs/milestones/`
- Technical debt: `docs/technical-debt/`

If one of these directories does not exist, do not assume there is no asset. Search the existing directories first, then inspect current code and tests before guessing.

### Milestone Navigation

Use `docs/milestones/INDEX.md` as the project-level milestone ledger. Milestone documents track target stages, strategic significance, slice boundaries, acceptance signals, progress, and links to completed evidence.

`docs/milestones/` does not replace Superpowers specs, plans, archives, problems, or inbox notes. Use milestones to understand roadmap and progress; use `docs/superpowers/` assets for slice design, implementation plans, delivery evidence, and reusable lessons.

### Technical Debt Navigation

Use `docs/technical-debt/INDEX.md` as the project-level technical-debt ledger. Technical-debt records explain why debt exists, how it was discovered, current impact, revisit triggers, resolution criteria, and closure evidence.

Technical debt should inform milestone and slice planning when it affects acceptance, maintainability, or architecture clarity. Do not mix technical-debt records into milestone checklists, and do not duplicate reusable failure-mode narratives that belong in `docs/superpowers/problems/`.

### Retrieval Order

When continuing feature work, explaining prior decisions, or checking whether a requirement is already delivered:

1. Search `docs/superpowers/specs/` and `docs/superpowers/plans/` for the intended behavior and implementation plan.
2. Search `docs/superpowers/archives/` for completed delivery history.
3. Search `docs/superpowers/problems/` for stable reusable failure modes, root causes, and recovery rules.
4. Search `docs/superpowers/inbox/` for uncertain but possibly reusable signals.
5. Search `docs/milestones/` for current target stages, slice boundaries, acceptance signals, and progress evidence.
6. Search `docs/technical-debt/` for unresolved engineering liabilities that may affect the next slice or refactor.
7. If no asset answers the question, inspect current code and tests before guessing.

Preferred keyword search:

```powershell
rg -n "<topic-keyword>" docs/superpowers/specs docs/superpowers/plans docs/superpowers/archives docs/superpowers/problems docs/superpowers/inbox docs/milestones docs/technical-debt
```

### Hook-Owned Workflow

- `SessionStart` injects a short asset protocol when `docs/superpowers/` exists.
- `PostToolUse` records compact signals from edits, verification, git closeout commands, and main-agent plan updates.
- `Stop` may request one more pass when meaningful work lacks an `asset_gate`.
- `PreCompact` / `PostCompact` preserve pending asset signals across compaction.

Subagent lifecycle hooks are intentionally not used for asset compounding. The main agent owns final route decisions and repository asset writes. Use the plugin skills and scripts when the hook-provided context indicates an archive, problem, inbox, or update is needed.
<!-- asset-compounding-guidance:end -->
