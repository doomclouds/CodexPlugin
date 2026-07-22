# Problem Template

Use this file when `write-superpowers-problem` writes a formal reusable problem asset.

## Problem Document Template

```md
# <Problem Title>

- Date: `YYYY-MM-DD`
- Topic slug: `<topic-slug>`
- Status: `Captured`
- Scope: `Repo` | `Project` | `Feature` | `Environment` | `UI` | `Test`
- Tags: `<tag-1>`, `<tag-2>`, `<tag-3>`

## Symptom

<What failed or looked wrong from the outside?>

## Trigger / Context

- <When it happened>
- <What conditions made it appear>

## Root Cause

<The actual reason, not just the visible failure>

## Fix

- <What was changed>
- <What boundary or guardrail was added>

## Why This Fix

<Why this solution was chosen over nearby alternatives>

## Recognition Clues

- <How to identify this pattern faster next time>
- <What evidence or logs to check first>

## Applicability / Non-Applicability

### Applies When

- <When this lesson is a good fit>

### Does Not Apply When

- <When this lesson would be over-applied or misleading>

## Related Artifacts

- Spec: [<spec-label>](<relative-path>) / `None yet.`
- Plan: [<plan-label>](<relative-path>) / `None yet.`
- Archive: [<archive-label>](<relative-path>) / `None yet.`
- Related Problems:
  - [<problem-label>](<relative-path>)
- Code or Test:
  - [<path-label>](<relative-path>)
```

## File Naming

Use:

`docs/superpowers/problems/YYYY-MM/YYYY-MM-DD-<topic>-problem.md`

## Problem Index Format

Keep one root index:

`docs/superpowers/problems/INDEX.md`

Group by month heading:

```md
# Superpowers Problem Index

## YYYY-MM

- [YYYY-MM-DD-<topic>-problem.md](./YYYY-MM/YYYY-MM-DD-<topic>-problem.md): <one-line description of the failure mode or recovery lesson>
```

Ordering rules:

1. Newest month first
2. Newest file first inside the month
3. Same-date files sorted by topic slug

## Writing Rules

- Describe reusable debugging knowledge, not chat history.
- Mention the symptom and the root cause.
- Explain why the chosen fix beats nearby alternatives.
- State both where the lesson applies and where it does not.
- Keep the index description to one sentence.
- Prefer concrete cues such as status drift, race condition, stale cache, wrong state source, protocol mismatch, missing cleanup, or recovery rule.
- If `Archive: None yet.` was true when the problem was first written, replace it later when the matching archive exists.
