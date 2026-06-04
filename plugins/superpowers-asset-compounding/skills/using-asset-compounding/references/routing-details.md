# Asset Compounding Routing Details

Use this reference only when the fast gate in `SKILL.md` is not enough.

## Asset Types

- Archive: completed requirement, feature, or design-to-implementation history.
- Problem: reusable failure mode, root cause, recovery rule, or debugging
  pattern.
- Inbox: uncertain but potentially reusable signal that is not mature enough
  for a formal problem or archive.
- Compound thread: completed requirement plus stable problem knowledge.

If the result does not improve future retrieval or execution, it is not a
compounding asset.

## Route Boundaries

- `none`: one-off, mechanical, obvious, or already covered by tests/docs.
- `inbox`: useful but weak, local, uncertain, review-discovered, "could archive
  or could skip", or missing root-cause evidence.
- `update-existing`: same feature, same failure class, or same uncertain signal
  already has an asset.
- `archive`: completed requirement that future agents should discover by topic.
- `new-problem`: stable failure pattern with enough evidence to recognize and
  fix it again.
- `both`: only when both the completed requirement and the failure pattern are
  independently worth preserving.

When in doubt between `none` and `inbox`, choose `inbox` if you can name a
future lookup query or if the signal came from a completed development task's
spec review, code quality review, verification, debugging, or subagent report.
When in doubt between `update-existing` and `new-problem`, search first and
prefer `update-existing`.

## Superpowers Projects

For repositories with `docs/superpowers/`, use the full workflow:

1. Search specs/plans, archives, problems, and inbox before creating new assets.
2. Ensure `AGENTS.md` or `AGENT.md` has project retrieval guidance.
3. Maintain relevant `INDEX.md` files.
4. Run writer-owned validators for new or modified assets.
5. At meaningful task boundaries, run the main-agent problem gate after
   implementation, spec review, code quality review, and verification, before
   starting the next task or ending the overall task.

Default locations:

- `docs/superpowers/specs/`
- `docs/superpowers/plans/`
- `docs/superpowers/archives/`
- `docs/superpowers/problems/`
- `docs/superpowers/inbox/`

## Non-Superpowers Projects

Still make the route decision, but do not automatically write assets when no
stable local docs home exists.

Use this compact stop shape:

```text
assetization_decision: inbox | update-existing | archive | new-problem | both | none
write_target: none
reason: no stable project-local docs location
next_step: suggest a repository-local preservation area or stop at classification
```

## De-Duplication

One mid-session check per topic is usually enough. Re-trigger only when:

- a new failure mode appears
- weak learning matures into stable evidence
- the route changes, such as `none` -> `inbox` or `inbox` -> `new-problem`
- final close-out is happening

## Anti-Patterns

Stop and route deliberately if you catch these thoughts:

- "The commit history is enough."
- "The user did not ask for archive docs."
- "This was expensive to learn, but I will remember it."
- "It says fix/issue, so it must be a formal problem asset."

The last one is the common trap: weak fixes often belong in `none`, `inbox`, or
`update-existing`, not `new-problem`.
