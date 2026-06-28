---
name: using-asset-compounding
description: Use when meaningful work may produce reusable feature history, root-cause lessons, or uncertain signals. Acts as the lightweight gate before finish/commit/merge and routes to archive, problem, inbox, update-existing, both, or none.
---

# Using Asset Compounding

<SUBAGENT-STOP>
If you were dispatched as a subagent for a narrow task, skip this skill unless
the parent explicitly asks you to assetize.
</SUBAGENT-STOP>

## Role

This is the entry gate for asset compounding. Its output is a route decision,
not an asset document.

Use it to decide whether a session should preserve durable knowledge into the
project's Superpowers assets, then dispatch to `compound-development-asset`
when writing, search, or index maintenance may be needed.

If a repository starts using `docs/superpowers/`, `docs/milestones/`, or
`docs/technical-debt/`, or creates its first spec, plan, archive, problem,
inbox, milestone, or technical-debt asset, dispatch to
`compound-development-asset` so it can run the asset bootstrap before routing.
Do not leave repository initialization to a later writer skill.

Routes:

- `none`
- `inbox`
- `update-existing`
- `archive`
- `new-problem`
- `both`

## Fast Gate

First classify the asset event. Use the closest one:

- `implementation-boundary`: implementation/review/verification reached a task boundary.
- `requirement-archive`: a coherent requirement, phase, or feature was accepted or archived.
- `bugfix-root-cause`: a bug fix produced stable root-cause and recovery evidence.
- `user-validation-feedback`: the user validated a build and reported a gap, correction, or missed behavior.
- `ci-release-feedback`: CI, installer, release, tag, artifact, or hosted automation produced a warning, failure, or follow-up signal.
- `post-release-warning`: a release completed but emitted warnings that may affect future releases.
- `artifact-generation`: a meaningful artifact was generated, transformed, or exported and may need reusable evidence.
- `cleanup-only`: purely mechanical cleanup with no reusable behavior or lesson.

Ask these in order:

1. Did this complete or accept a coherent requirement thread?
2. Did it uncover a stable failure mode with root cause and recovery clues?
3. Did it produce an uncertain but likely reusable signal?
4. Does an existing archive, problem, or inbox note already cover this topic?
5. Would future lookup realistically search for this?

If every answer is "no", choose `none` and keep moving.

## Lightweight Path

Choose `none` for clearly low-compounding work:

- pure formatting, generated screenshots, or verification repeats
- one-line copy, label, size, color, spacing, or position tweaks
- mechanical renames or moves with no new rule
- trivial fixes with immediately obvious cause and no repeatable diagnostic value

Choose `update-existing` instead of a new asset when a small accepted follow-up
belongs to an existing requirement archive or problem note.

Choose `inbox` for weak but possibly reusable signals: local preference drift,
tool quirks without confirmed cause, suspicious behavior, or a fix whose root
cause is not yet stable. When a signal feels "could archive or could skip" but
future agents might realistically search for it, choose `inbox` instead of
dropping it.

Choose `update-existing` or `inbox` for `user-validation-feedback`,
`ci-release-feedback`, and `post-release-warning` unless the signal is clearly
noise. If a related archive/problem/inbox exists, prefer `update-existing`;
otherwise park the signal in `inbox`.

## Formal Routes

- `archive`: completed or accepted requirement with implementation and
  verification evidence.
- `new-problem`: stable, distinct failure pattern with symptom, trigger/context,
  root cause, fix, and recognition clues.
- `both`: a completed requirement also produced a mature problem pattern.

Prefer `update-existing` over duplicate formal assets. Prefer `inbox` over
premature `new-problem`.

## When To Trigger

Mid-session: trigger once per emerging lesson when a root cause, reusable
debugging pattern, or durable requirement thread appears. Do not repeat the same
check unless new evidence changes the route.

End-session: for non-trivial work, trigger before final response, commit, merge,
PR, cleanup, or any claim that the work is complete.

Main-agent problem gate: after a development task has been implemented,
spec-reviewed, code-quality-reviewed, and verified, the main agent must run this
gate before starting the next task or before ending the overall task. This gate
collects problem candidates from implementation, debugging, review findings,
test failures, provider/tool quirks, subagent reports, and plan-boundary
checkpoints. Subagents should follow their own workflow handoff format; the main
agent owns extracting any reusable asset signal from that output.

When hook state says an asset gate is due because a completed plan step was
observed, run this gate before starting the next planned task. The update-plan
reminder is a checkpoint, not a route decision; use this skill to choose
`none`, `inbox`, `update-existing`, `archive`, `new-problem`, or `both`.

Hard completion gate: before merge/PR/cleanup/final handoff on meaningful work,
the main agent must produce an auditable `asset_gate:` block. Route or
explicitly defer reusable lessons from implementation notes, reviewer output,
subagent output, verification results, user feedback, and plan-boundary
checkpoints, milestone ledger gaps, and technical-debt record gaps. If there
are no candidates, write `asset_candidates: none`; do not leave the gate
implicit.

Completion archive invariant: `check_completion_gate.py` passing with no extra
arguments is only a preflight. It never proves that a completed requirement has
been archived. If the work completed or accepted a coherent requirement,
feature, phase, or spec-to-plan implementation thread, run the completion gate
with `--completed-topic <topic-slug-or-words>` and treat
`missing_requirement_archive` as blocking. Route to `archive` or
`update-existing` before close-out unless a matching archive already exists.

When `compound-development-asset/scripts/check_completion_gate.py` is available,
use it as deterministic evidence before close-out. Prefer the aggregate
`asset_closeout.py` when the completed topic is known, because it reports
archive coverage, related problem/inbox assets, milestone and technical-debt
signals, index health, and a compact handoff block in one place:

```bash
python <compound-development-asset>/scripts/asset_status.py . --topic "<topic>" --json
python <compound-development-asset>/scripts/asset_closeout.py . --topic "<topic>" --json
python <compound-development-asset>/scripts/check_completion_gate.py . --json
python <compound-development-asset>/scripts/check_completion_gate.py . --completed-topic "<topic>" --json
python <compound-development-asset>/scripts/check_completion_gate.py . --require-asset-gate --handoff-file <handoff.md> --json
```

After `archive-superpowers-feature` writes or updates an archive, return to this
gate once to collect same-thread problem or inbox candidates. Requirement
archives and problem gates are separate; finishing one does not imply the other
has been checked.

## Dispatch

Use `compound-development-asset` when the route is anything except obvious
`none`, or when related assets should be searched before deciding.

Also use `compound-development-asset` when the repository needs asset
bootstrap: standard `docs/superpowers/`, `docs/milestones/`, or
`docs/technical-debt/` directories, managed `AGENTS.md` retrieval guidance, or
stale asset guidance refresh.

Use writer skills only after the route is clear:

- `archive` -> `archive-superpowers-feature`
- `inbox` or `new-problem` -> `write-superpowers-problem`
- `update-existing` -> writer that owns the existing asset type
- `both` -> both writer skills

## Minimal Output

For the route decision, keep the output compact and auditable:

Prefer the deterministic emitter when the script is available:

```bash
python <compound-development-asset>/scripts/emit_asset_gate.py --event-type implementation-boundary --route none --reason "<one concrete sentence>" --evidence "<tests, command, user feedback, or manual validation>"
```

Otherwise use this canonical flat shape:

```text
asset_gate:
  event_type: implementation-boundary | requirement-archive | bugfix-root-cause | user-validation-feedback | ci-release-feedback | post-release-warning | artifact-generation | cleanup-only
  route: none | inbox | update-existing | archive | new-problem | both
reason: <one concrete sentence>
evidence: <tests, manual validation, CI/release result, or user feedback used>
related_assets: <none | matched archive/problem/inbox/spec/plan/milestone/technical-debt paths>
asset_candidates: <none | extracted reviewer/subagent/tool/check script candidates, including milestone/debt closeout gaps>
deferred_signals: <none | weak signals to revisit later>
next_step: <none | compound-development-asset | writer skill>
```

The validator tolerates common YAML-like nested fields and list values, plus
the legacy `artifact_generation` alias. Still prefer the emitter or canonical
flat shape above so hook retry prompts, audit logs, and completion-gate checks
all see the same field names.

Even when the route is `none`, include the event type and concrete reason when
the work was non-trivial. This makes skipped gates reviewable later.

If an asset is written or updated, apply the effect scorecard from
`references/effect-scorecard.md`.

## References

Load these only when needed:

- `references/routing-details.md`: fuller routing boundaries, non-Superpowers
  behavior, de-duplication, and anti-patterns.
- `references/effect-scorecard.md`: minimal check for whether asset compounding
  actually improved future retrieval instead of adding paperwork.
