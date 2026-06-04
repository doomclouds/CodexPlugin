# Inbox Template

Use this file when `write-superpowers-problem` preserves an uncertain but potentially reusable signal without promoting it into the formal problem corpus.

## Inbox Document Template

```md
# <Inbox Signal Title>

- Date: `YYYY-MM-DD`
- Topic slug: `<topic-slug>`
- Status: `Inbox`
- Lifecycle: `Open` | `Partially promoted` | `Promoted` | `Closed`
- Revisit trigger: `<when this should be checked again>`
- Scope: `Repo` | `Project` | `Feature` | `Environment` | `UI` | `Test`
- Confidence: `Low` | `Medium`
- Route candidate: `update-existing` | `new-problem` | `archive` | `both` | `unknown`

## Signal

<What was observed?>

## Why It Might Matter

<Why this signal should not be discarded yet?>

## What Is Missing

- <Evidence, reproduction, repeated occurrence, or boundary still needed>

## Likely Next Route

<What should happen if this recurs or stabilizes?>

## Related Assets

- Spec: [<spec-label>](<relative-path>) / `None yet.`
- Plan: [<plan-label>](<relative-path>) / `None yet.`
- Archive: [<archive-label>](<relative-path>) / `None yet.`
- Problems:
  - [<problem-label>](<relative-path>)
```

## File Naming

Use:

`docs/superpowers/inbox/YYYY-MM/YYYY-MM-DD-<topic>-inbox.md`

## Inbox Index Format

Keep one root index:

`docs/superpowers/inbox/INDEX.md`

Group by month heading:

```md
# Superpowers Inbox Index

## YYYY-MM

- [YYYY-MM-DD-<topic>-inbox.md](./YYYY-MM/YYYY-MM-DD-<topic>-inbox.md): <one-line description of the uncertain signal and likely next route>
```

## Writing Rules

- Keep the note short.
- Do not state uncertain diagnosis as confirmed root cause.
- Make the missing evidence explicit.
- Prefer promotion into an existing problem when the same class stabilizes.
- Use `Partially promoted` when a formal asset covers only part of the signal.
- Use `Promoted` when a formal asset fully covers the signal and link that target.
- Use `Closed` when the signal is intentionally discarded or disproved, and state why.
