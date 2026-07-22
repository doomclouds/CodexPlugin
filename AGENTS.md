# AGENTS

## Repository Guide

- Plugin packages live under `plugins/`; each plugin owns its `.codex-plugin/plugin.json`, skills, hooks, and README.
- Marketplace metadata lives under `.agents/plugins/`; keep plugin source paths relative to that marketplace root.
- Superpowers assets live under `docs/superpowers/`; search specs, plans, archives, problems, and inbox notes before guessing from memory.
- Bootstrap Python tooling with `uv venv --python 3.12 .venv && uv pip sync --python .venv/bin/python requirements-dev.txt`.
- Validate archived asset-compounding changes on macOS with `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" .venv/bin/python deprecated-plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`.
- Validate engineering-workflow changes with `.venv/bin/python -m unittest discover -s plugins/engineering-workflow/tests -p 'test_*.py'`.
- After changing plugin hooks or manifests, restart Codex and review `/hooks` before judging runtime behavior.

<!-- asset-compounding-guidance:start -->
<!-- asset-compounding-guidance:version=0.3.1 -->
## Asset Compounding Retrieval Guide

This repository retains historical assets created by the now-archived `superpowers-asset-compounding` plugin. Keep this block as repository-specific retrieval guidance, but do not assume its former hooks or lifecycle automation are active.

### Repository Context Guidance

Keep repository-owned context outside this managed block. Project goals, tech stack, repository boundaries, language rules, runtime commands, validation commands, and the current active milestone belong in the hand-maintained project guidance above or below this block.

This managed block only provides asset retrieval anchors. Guidance scripts may replace the content between the managed markers when the block version is stale, but they must not overwrite project-owned context outside the markers.

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

Read the current active milestone before choosing the next slice in a tracked phase. Read completed milestones when reconstructing historical phase evidence. If a task does not belong to the current milestone, decide whether it should become a future milestone slice, a technical-debt record, or ordinary Superpowers spec/plan/archive work before editing the checklist.

After completing, deferring, or splitting a milestone slice, update the milestone `CHECKLIST.md` status/progress and `docs/milestones/INDEX.md` before closeout. Prefer `compound-development-asset/scripts/milestone_assets.py` for script-owned status and progress updates.

`docs/milestones/` does not replace Superpowers specs, plans, archives, problems, or inbox notes. Use milestones to understand roadmap and progress; use `docs/superpowers/` assets for slice design, implementation plans, delivery evidence, and reusable lessons.

### Technical Debt Navigation

Use `docs/technical-debt/INDEX.md` as the project-level technical-debt ledger. Technical-debt records explain why debt exists, how it was discovered, current impact, revisit triggers, resolution criteria, and closure evidence.

Technical debt should inform milestone and slice planning when it affects acceptance, maintainability, or architecture clarity. If debt affects the active milestone's acceptance boundary, use it as slice-selection or spec input instead of mixing the debt record into the milestone checklist.

After resolving, closing, superseding, or intentionally keeping a debt item, update the debt record status, closure/replacement rationale, and `docs/technical-debt/INDEX.md` before closeout. Prefer `compound-development-asset/scripts/technical_debt_assets.py` for script-owned status and index updates.

Do not duplicate reusable failure-mode narratives that belong in `docs/superpowers/problems/`. Link problem assets when debt emerged from a failure, but keep technical-debt records focused on the engineering liability, revisit trigger, and repayment criteria.

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

### Archived Workflow Automation

The former lifecycle hooks are no longer active. The main agent owns retrieval decisions and any repository asset writes. Use scripts under `deprecated-plugins/superpowers-asset-compounding/` only when explicitly maintaining those historical assets.
<!-- asset-compounding-guidance:end -->
