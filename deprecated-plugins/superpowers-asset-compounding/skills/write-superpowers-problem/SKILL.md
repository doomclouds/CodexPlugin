---
name: write-superpowers-problem
description: Use when the router chooses `inbox`, problem-related `update-existing`, or `new-problem`. Writes or updates problem/inbox assets, indexes, and validation.
---

# Write Superpowers Problem

## Overview

Use this skill to write the problem side of asset compounding. It owns formal problem assets, inbox notes, updates to existing problem/inbox assets, and validation of those documents.

It is not the global trigger and not the high-level router:

- `using-asset-compounding` decides when assetization should be checked
- `compound-development-asset` decides the route
- `archive-superpowers-feature` writes archive assets
- `write-superpowers-problem` writes problem and inbox assets

## When To Write Which Problem Asset

### Write an inbox note

Write an inbox note when the signal might matter later but is not stable enough for a formal problem asset.

Typical signals:

- the lesson is plausible but not fully reproduced
- the diagnosis is still partly uncertain
- the issue may recur, but there is not enough evidence to name a stable failure mode
- the work produced a useful observation that should not be lost, but formalizing it now would create noise
- the main-agent problem gate found a "could archive or could skip" issue that future agents might search for
- a spec review or code quality review found a possible class of mistakes but not a confirmed root cause
- a subagent reported suspicious behavior, a failed approach, or a tool/provider quirk that the main agent has not fully diagnosed

Use:

- `docs/superpowers/inbox/YYYY-MM/YYYY-MM-DD-<topic>-inbox.md`

### Update an existing problem or inbox asset

Update an existing asset when the new learning belongs to the same failure class or uncertain signal.

Typical signals:

- an existing problem note already covers the same root cause family
- the user corrected an earlier diagnosis
- new recognition clues, applicability limits, or fix details refine an existing asset
- a related archive, spec, plan, code path, or test should be linked from an existing problem
- an inbox note has matured and should either be refined or promoted into a formal problem
- a CI/release/user-validation signal belongs to an existing archive/problem/inbox and should update lifecycle, notes, or related links

Prefer updating existing assets over creating duplicates.

### Write a new problem asset

Write a new problem asset when the main value is a stable, distinct failure mode:

- a bug root cause
- a debugging pattern
- a failure mode
- a recovery rule
- a "do not do this again" lesson

Typical signals:

- the issue required non-obvious diagnosis
- the same class of failure could recur
- future lookup will likely start from "why did this break?" or "how do we recognize this faster?"
- no existing problem asset already captures the same failure class

Use:

- `docs/superpowers/problems/YYYY-MM/YYYY-MM-DD-<topic>-problem.md`

Do not create a formal problem asset for a weak signal that only says "there was a bug", "we fixed something", or "this might matter later". Without a confirmed root cause and recognition clues, write an inbox note or update an existing asset instead.

## Problem Asset Contract

Every problem asset must use one stable shape so the result stays searchable and comparable across repositories.

Required metadata order:

- `Date`
- `Topic slug`
- `Status`
- `Scope`
- `Tags`

Required sections:

- `Symptom`: what looked wrong from the outside
- `Trigger / Context`: when it appears
- `Root Cause`: why it actually failed
- `Fix`: what changed and what guardrail was added
- `Why This Fix`: why this repair beat nearby alternatives
- `Recognition Clues`: how to identify the pattern faster next time
- `Applicability / Non-Applicability`: when the lesson does and does not apply
- `Related Artifacts`: links to spec, plan, archive, related problems, code, or tests

Content boundaries:

- do not write the problem note as a chronological debugging diary
- do not stop at "what was fixed"; keep the root cause and repair choice explicit
- do not omit applicability boundaries just because the fix feels obvious
- if a related archive does not exist yet, write `None yet.`
- if that archive is created later, come back and replace `None yet.` with the real link

## Inbox Note Contract

Inbox notes are temporary, lower-confidence assets. They preserve signals without promoting them into the formal problem corpus.

Required metadata order:

- `Date`
- `Topic slug`
- `Status: Inbox`
- `Lifecycle: Open | Partially promoted | Promoted | Closed`
- `Revisit trigger: <when to re-check this signal>`
- `Scope`
- `Confidence: Low | Medium`
- `Route candidate: update-existing | new-problem | archive | both | unknown`

Required sections:

- `Signal`: what was observed
- `Why It Might Matter`: why it is not being discarded
- `What Is Missing`: what evidence or reproduction is still needed
- `Likely Next Route`: what should happen if it recurs or stabilizes
- `Related Assets`: possible matching archive/problem/spec/plan links

Inbox boundaries:

- keep notes short
- do not present uncertain diagnosis as confirmed root cause
- revisit inbox notes when the same signal recurs or when touching nearby formal assets
- promote by updating an existing asset whenever possible; create a new problem only when the failure mode is stable and distinct
- when a formal problem/archive now covers part of an inbox note, set `Lifecycle` to `Partially promoted`; use `Promoted` only when no signal remains open
- use `Closed` when the signal is disproved or intentionally dropped, and state why in `Likely Next Route`

## Workflow

### 0. Respect main-agent ownership

Problem and inbox writing should usually be initiated by the main agent after
the task-boundary problem gate. Subagents may provide candidate notes, evidence,
or suggested routes, but should not write or promote assets unless the main
agent explicitly delegates that asset-writing work.

### 1. Confirm route and existing assets

This skill should usually be entered from `compound-development-asset` after route selection.

Before writing:

- search `docs/superpowers/problems/INDEX.md` if it exists
- search `docs/superpowers/inbox/INDEX.md` if it exists
- search the relevant month folders
- prefer updating an existing problem/inbox asset when the failure class already exists

If `compound-development-asset/scripts/find_related_assets.py` is available, use it before creating a new problem.

When updating or promoting inbox notes, use `scripts/inspect_inbox_lifecycle.py`
to find related inbox notes, lifecycle status, and legacy notes missing
`Lifecycle` / `Revisit trigger` metadata.

### 2. Write or update the document

For new problem assets, read [references/problem-template.md](references/problem-template.md).

For new inbox notes, read [references/inbox-template.md](references/inbox-template.md).

Use the date of the triggering issue or debugging session, not the day the note happens to be written.

Write output in Simplified Chinese unless the user asked for another language.

### 3. Maintain indexes

Keep these indexes when the matching area exists or is created:

- `docs/superpowers/problems/INDEX.md`
- `docs/superpowers/inbox/INDEX.md`

Ordering rules:

1. sort month headings by date descending so the newest month appears first
2. within each month, list files by date descending
3. if multiple files share the same date, sort them by topic slug

Each line should contain:

- the asset file link
- a one-line description of the failure mode, uncertain signal, or recovery lesson

### 4. Validate

Run the bundled validator:

```bash
python <skill>/scripts/validate_problem_asset.py docs/superpowers/problems/YYYY-MM/<file>.md
python <skill>/scripts/validate_problem_asset.py docs/superpowers/inbox/YYYY-MM/<file>.md --kind inbox
```

If `compound-development-asset/scripts/check_indexes.py` is available, run it after index edits to catch ordering, dead links, duplicate entries, and orphan files.

For inbox lifecycle review:

```bash
python <skill>/scripts/inspect_inbox_lifecycle.py . <topic-keywords> --needs-revisit-only
```

## Common Mistakes

- Creating a new problem asset when an existing one should be updated
- Dropping an uncertain but potentially reusable signal instead of parking it in inbox
- Promoting an inbox-level signal into a formal problem before the diagnosis is stable
- Writing a problem note that only says what was fixed, not why it failed
- Turning the problem asset into a chronological story instead of a reusable pattern note
- Leaving `Archive: None yet.` in place after the matching archive was later created
- Letting `problems/INDEX.md` or `inbox/INDEX.md` order drift away from the month folders

## Deliverables

When using this skill, produce one or more of:

- `docs/superpowers/inbox/YYYY-MM/YYYY-MM-DD-<topic>-inbox.md`
- an updated `docs/superpowers/inbox/INDEX.md`
- an updated existing problem or inbox asset
- `docs/superpowers/problems/YYYY-MM/YYYY-MM-DD-<topic>-problem.md`
- an updated `docs/superpowers/problems/INDEX.md`
- validation output from `validate_problem_asset.py`
- optional lifecycle review output from `inspect_inbox_lifecycle.py`
