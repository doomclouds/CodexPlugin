---
name: manage-technical-debt
description: Create, update, close, and check technical-debt records under docs/technical-debt. Use when an engineering debt item needs a template, status transition, revisit trigger, resolution criteria, closure archive link, or INDEX.md synchronization.
---

# Manage Technical Debt

Use this skill for `docs/technical-debt` records that track intentional engineering debt, revisit triggers, resolution criteria, and closure evidence. Technical debt is not split into large and small categories; classify it by status, priority, type, and resolution path.

## Workflow

- Use `compound-development-asset/scripts/technical_debt_assets.py` for creation, status transitions, closure, checks, and `docs/technical-debt/INDEX.md` synchronization.
- Do not hand-edit script-owned status, closure, or index state when `technical_debt_assets.py` can perform the update.
- Require `Closed` debt records to include a `Closure` section and a link to the archive that proves the debt was resolved.
- After edits, run `technical_debt_assets.py check --json` and fix reported issues before closeout.

## Boundaries

- Use technical-debt records for known tradeoffs, deferred cleanup, migration gaps, and revisit-triggered engineering liabilities.
- Use problem assets for reusable failure modes with symptoms, root cause, recovery rules, and recognition clues.
- Link related problem assets when debt emerged from a failure, but do not duplicate the problem narrative inside the debt record.
