---
name: manage-technical-debt
description: Create, update, close, and check technical-debt records under docs/technical-debt. Use when an engineering debt item needs a template, status transition, revisit trigger, resolution criteria, closure archive link, or INDEX.md synchronization.
---

# Manage Technical Debt

Use this skill for `docs/technical-debt` records that track intentional engineering debt, revisit triggers, resolution criteria, and closure evidence. Technical debt is not split into large and small categories; classify it by status, priority, type, and resolution path.

## SOP Requirements

Every technical-debt record must explain enough history for a later agent to understand what happened and what to do next:

- Why the debt exists: the tradeoff, shortcut, boundary leak, duplication, missing abstraction, or deferred cleanup that created it.
- How the debt was discovered: user feedback, reviewer note, implementation friction, repeated code pattern, failed validation, closeout finding, or milestone planning signal.
- Current impact: how it affects future slices, maintenance cost, correctness risk, user experience, or architecture clarity.
- Revisit trigger: the concrete future moment when the debt must be reconsidered.
- Resolution criteria: what must be true before the debt can close.
- Initial resolution direction: the likely repair path, without turning the debt record into a full implementation plan.
- Non-goals: what the repayment should not attempt.
- Related assets: milestone, slice, spec, plan, archive, problem, inbox, or code references that explain the context.

## Workflow

- Use `compound-development-asset/scripts/technical_debt_assets.py` for creation, status transitions, closure, checks, and `docs/technical-debt/INDEX.md` synchronization.
- Do not hand-edit script-owned status, closure, or index state when `technical_debt_assets.py` can perform the update.
- Require `Closed` debt records to include a `Closure` section and a link to the archive that proves the debt was resolved.
- After edits, run `technical_debt_assets.py check --json` and fix reported issues before closeout.

## Boundaries

- Use technical-debt records for known tradeoffs, deferred cleanup, migration gaps, and revisit-triggered engineering liabilities.
- Use problem assets for reusable failure modes with symptoms, root cause, recovery rules, and recognition clues.
- Link related problem assets when debt emerged from a failure, but do not duplicate the problem narrative inside the debt record.
- Do not record vague preferences as debt; require a concrete cause, discovery signal, impact, trigger, and resolution path.
