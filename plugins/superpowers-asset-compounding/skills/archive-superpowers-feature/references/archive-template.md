# Archive Template

Use this file as the fixed shape for Superpowers archive output.

## Archive Document Template

```md
# <Feature Title>

- Date: `YYYY-MM-DD`
- Topic slug: `<topic-slug>`
- Status: `Archived`
- Scope: `Repo` | `Project` | `Feature` | `Environment` | `UI` | `Test`
- Tags: `<tag-1>`, `<tag-2>`, `<tag-3>`

## Summary

<1 short paragraph derived from the spec's 目标 / 范围 / 方案 sections, explaining what capability or problem this requirement addressed.>

## Delivered Scope

- <specific scope item from the design>
- <specific scope item from the design>
- <specific scope item or boundary from the design>

## Out of Scope

- <explicitly not delivered in this archive>
- <still intentionally outside this slice>

## Verification Snapshot

- <what test, build, runtime, or review evidence justified archiving this work>

## Source Documents

- Spec: [<spec-label>](<relative-path-to-spec>)
- Visual: [<visual-label>](<relative-path-to-visual>)
- Plan: [<plan-label>](<relative-path-to-plan>)

## Related Problems

- [<problem-label>](<relative-path-to-problem>)

## Notes

- <optional short note about completion, verification, or follow-up context>
```

## Rules

- Keep the whole archive concise.
- Prefer 1 short summary paragraph plus 2-4 scope bullets.
- Link source files using repository-relative paths.
- Write the archive document and index description in Simplified Chinese unless the user asked for another language.
- Use the primary design spec date as the archive date. Do not use the day you happen to generate the archive.
- Derive the summary and scope bullets from the actual spec. Do not use one canned summary across multiple archive files.
- Always include `Out of Scope` so the archive does not silently over-claim.
- Always include `Verification Snapshot` so later readers can see why the work was considered done.
- If same-thread problem assets exist, list them under `Related Problems`.
- If no visual artifact exists, write `- Visual: None found for this topic.`
- If multiple visual artifacts exist, list each on its own bullet under `Source Documents`.

## INDEX.md Line Format

Use month headings plus one bullet per archive:

```md
## YYYY-MM

- [YYYY-MM-DD-<topic>-archives.md](./YYYY-MM/YYYY-MM-DD-<topic>-archives.md): <one-line description derived from the design's concrete capability or behavior change>
```

Ordering rules:

1. Newest month first
2. Newest file first inside the month
3. Same-date files sorted by topic slug

## Description Style

- Describe the delivered result, not the implementation process.
- Keep the index description to one sentence.
- Avoid vague descriptions such as `some updates` or `documentation archive`.
- Mention at least one specific capability, behavior, integration, UI change, protocol, rule, or boundary from the design.
- Keep archive markdown files in `docs/superpowers/archives/YYYY-MM/`, not flat under `archives/`.
- In the root `INDEX.md`, group entries by `YYYY-MM` heading and keep the heading order plus file order consistent with the actual archive folders.
