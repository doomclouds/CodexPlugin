---
name: archive-superpowers-feature
description: Use when a completed Superpowers feature or requirement must be preserved in `docs/superpowers/archives` with a dated archive and `INDEX.md` update.
---

# Archive Superpowers Feature

## Overview

Use this skill to close out one completed Superpowers requirement by turning scattered design and plan files into a single archive record under `docs/superpowers/archives`.

Keep the archive lightweight: summarize the finished feature, link the source documents, and keep `INDEX.md` scan-friendly.

Write the archive summary and `INDEX.md` description in Simplified Chinese unless the user explicitly asks for another language.

Store archive documents in month folders under `docs/superpowers/archives/YYYY-MM/`, while keeping one root `docs/superpowers/archives/INDEX.md` as the cross-month index.

The root `INDEX.md` must group entries by month heading such as `## 2026-03`, `## 2026-04`.

Within the asset compounding system:

- `using-asset-compounding` decides whether assetization should begin
- `compound-development-asset` decides whether archive output is actually needed
- `archive-superpowers-feature` writes the archive once that decision is already made

## Archive Asset Contract

Every archive written by this skill must follow one stable shape.

Required metadata order:

- `Date`
- `Topic slug`
- `Status`
- `Scope`
- `Tags`

Required section intent:

- `Summary`: what capability or delivery this requirement actually closed
- `Delivered Scope`: what definitely landed
- `Out of Scope`: what this delivery explicitly did not include
- `Verification Snapshot`: what evidence says the delivery is finished enough to archive
- `Source Documents`: the spec, optional visual artifacts, and the plan
- `Related Problems`: problem assets discovered during the same thread
- `Notes`: short close-out context only when it improves later retrieval

Content boundaries:

- do not turn the archive into a second implementation plan
- do not copy large chunks of the spec
- do not write vague close-out text such as "做了一系列优化"
- if related problem assets exist, list them explicitly
- if no visual artifact exists, state that plainly and keep moving

## Workflow

### 1. Confirm the archive should happen now

Use this skill only after the requirement is complete enough to archive:

- implementation is finished
- verification is finished or already explicitly accepted
- the spec and plan for the topic already exist

If the work is still actively changing, stop and finish the requirement first instead of creating premature archive noise.

### 2. Identify the topic slug and archive date

Infer the topic slug from the existing Superpowers document set.

Prefer the shared middle topic segment used by these files:

- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design-visual.html`
- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.drawio`
- `docs/superpowers/plans/YYYY-MM-DD-<topic>-implementation-plan.md`
- `docs/superpowers/plans/YYYY-MM-DD-<topic>-implementation.md`

Create the archive file as:

- `docs/superpowers/archives/YYYY-MM/YYYY-MM-DD-<topic>-archives.md`

Use the primary design spec date for `YYYY-MM-DD`, not the day the archive is generated. The archive file date should stay aligned with the original requirement document family so the archive sorts beside the matching spec and plan set.

Use the same date to derive the month folder:

- spec date `2026-04-15` -> month folder `docs/superpowers/archives/2026-04/`

If the plan date differs from the spec date, keep using the spec date for the archive filename and the archive metadata line.

Keep the topic slug lowercase and hyphenated to match the existing spec and plan naming style.

### 3. Ensure the archive base exists

If these files or folders do not exist, create them before writing content:

- `docs/superpowers/archives/`
- `docs/superpowers/archives/YYYY-MM/`
- `docs/superpowers/archives/INDEX.md`

Do not fail just because the archive area has not been bootstrapped yet.

### 4. Gather the source documents

Collect the best-matching files for the topic from:

- `docs/superpowers/specs/` for the main design spec
- `docs/superpowers/specs/` for optional visual artifacts such as `*-visual.html` or `.drawio`
- `docs/superpowers/plans/` for the implementation plan

Prefer exact topic matches over fuzzy partial matches.

If multiple files match:

- choose the main design markdown as the primary requirement source
- include every clearly-related visual artifact for the same topic
- choose the latest or most final implementation plan file for the same topic

If a visual artifact does not exist, keep the archive moving and state that no visual artifact was found.

If the spec or plan cannot be found, stop and tell the user which required source is missing.

### 5. Write the archive document

Read [references/archive-template.md](references/archive-template.md) before drafting.

The archive document should do four things well:

1. Name the completed requirement clearly.
2. Summarize the delivered feature in a few short paragraphs or bullets.
3. Link the source design, visual, and plan files.
4. Record any brief completion notes that will help later retrieval.

Keep it concise. This is an archive entry, not a second implementation plan.

The archive must also include:

- `Out of Scope` so the archive does not over-claim
- `Verification Snapshot` so later readers can see why this was considered done
- `Related Problems` whenever the same thread produced reusable failure knowledge

The summary and scope bullets must be derived from the actual design document, not from a canned archive phrase. Prefer extracting from these sections when present:

- `目标` / `目标与范围`
- `范围` / `本次范围包括`
- `方案` / `总体方案` / `设计结论` / `推荐方案`
- `当前问题` / `现状` when it clarifies why the feature exists

Use the design to answer these questions in the archive:

1. What problem or capability does this requirement address?
2. What concrete scope did this design introduce?
3. What approach or boundary made this design distinct?

Do not repeat the same archive summary structure across every topic. Two archive files for different requirements should read differently because their designs are different.

### 6. Update `INDEX.md`

Append one single-line entry for the new archive using the format in [references/archive-template.md](references/archive-template.md).

Each line should contain:

- the archive document link
- the topic label
- a brief one-line description of what the archived requirement delivered

Keep one archive per line. Do not turn `INDEX.md` into a narrative page.

The one-line description must mention a concrete capability, behavior, or design outcome from the spec. Avoid generic text such as "归档某需求的设计、计划与相关资料".

If an entry for the exact same archive file already exists, update that line instead of adding a duplicate.

Order the root `INDEX.md` like this:

1. sort month headings by date descending so the newest month appears first
2. under each month heading, list archive files by date descending
3. if multiple files share the same date, sort them by topic slug

The `INDEX.md` order and the actual folder order must stay consistent.

### 7. Sanity-check the archive

Before finishing, verify:

- the archive markdown file exists under `docs/superpowers/archives/YYYY-MM/`
- the filename follows `YYYY-MM-DD-<topic>-archives.md`
- the month folder name matches the spec date month
- the `YYYY-MM-DD` part matches the primary design spec date for that topic
- the root `INDEX.md` contains month headings in `YYYY-MM` order
- entries under each month heading follow the same file order as the matching month folder
- every referenced file path actually exists
- `INDEX.md` contains exactly one new line for the requirement
- `INDEX.md` does not contain duplicate lines for the same archive file
- the summary is brief and clearly about a completed feature, not an open plan
- `Out of Scope` and `Verification Snapshot` are present
- any known same-thread problem assets are listed under `Related Problems`

Then run the bundled validator:

```bash
python <skill>/scripts/validate_archive_asset.py docs/superpowers/archives/YYYY-MM/YYYY-MM-DD-<topic>-archives.md
```

This validator checks required metadata, required sections, filename date/slug consistency, status value, and local markdown links. It complements `compound-development-asset/scripts/check_indexes.py`, which checks index health but not archive document shape.

After the archive validates, return once to `using-asset-compounding` for a
problem gate. The archive records what was delivered; the follow-up gate records
whether the same thread produced a reusable failure mode, inbox signal, user
validation gap, or CI/release warning.

## Matching Rules

Use these practical matching rules when the document set is messy:

- Prefer exact topic slug matches first.
- Use the main design markdown as the date source of truth for the archive filename.
- Use the main design markdown date to derive both the archive filename and the month folder.
- Build the root `INDEX.md` from the month folders, not from a flat archive list.
- If date prefixes differ across spec and plan, allow that as long as the topic slug matches.
- Treat `*-implementation-plan.md` and `*-implementation.md` as eligible plan files.
- Treat `*-design-visual.html`, `*.drawio`, and same-topic design diagrams as visual references.
- Ignore unrelated specs that only share a broad subsystem name.

## Common Mistakes

- Archiving before the requirement is actually done
- Using the archive generation day instead of the original document family date
- Putting the archive file directly under `archives/` instead of the correct `archives/YYYY-MM/` month folder
- Leaving `INDEX.md` as a flat list instead of grouping by month headings
- Letting `INDEX.md` month or file order drift away from the real folder order
- Copying large chunks of the spec instead of summarizing
- Reusing one generic archive summary sentence for every topic
- Reusing one generic `INDEX.md` description for every topic
- Omitting `Out of Scope` so the archive silently claims more than was delivered
- Omitting `Verification Snapshot` so later readers cannot tell why the requirement was considered done
- Forgetting to create or update `INDEX.md`
- Using a topic slug that does not match the original spec/plan family
- Failing the task just because the visual artifact is absent

## Deliverables

When using this skill, produce:

- `docs/superpowers/archives/YYYY-MM/YYYY-MM-DD-<topic>-archives.md`
- an updated `docs/superpowers/archives/INDEX.md`
- validation output from `scripts/validate_archive_asset.py`
- a short note to the user listing which spec, visual artifact, and plan were archived
