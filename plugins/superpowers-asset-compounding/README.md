# Superpowers Asset Compounding

Local Codex plugin for turning completed work and reusable debugging lessons into repository assets.

Version `0.3.2` combines seven skills with plugin-bundled Codex lifecycle hooks.
This release adds structured `asset_gate` validation, `merge_only_closeout`
auto-allow handling, report filters, session summaries, and audit log archiving
for `v0.3.2` on top of the v0.3.1 managed-guidance refreshes, the
v0.3.0 milestone/debt navigation improvements, and the earlier hook launcher,
audit reliability, report diagnostics, and closeout UX updates.

The plugin provides six skills:

- `using-asset-compounding`: entry gate for deciding when preservation is needed.
- `compound-development-asset`: router for `none`, `inbox`, `update-existing`, `new-problem`, `archive`, and `both`.
- `archive-superpowers-feature`: writer for completed requirement archives.
- `write-superpowers-problem`: writer for problem and inbox assets.
- `manage-superpowers-milestone`: writer and checker for project milestone ledgers.
- `manage-technical-debt`: writer and checker for technical-debt records.
- `create-ui-design-package`: visual-first UI design package creator for `docs/designs/<slug>/`.

The plugin also bundles hooks under `hooks/hooks.json`:

- `SessionStart`: injects a short asset-compounding protocol when a repository has `docs/superpowers/`.
- `PostToolUse`: records compact lifecycle signals from edits, verification commands, git closeout commands, and main-agent plan updates.
- `Stop`: asks the main agent for one continuation when meaningful work is ending without an `asset_gate` block.
- `PreCompact` / `PostCompact`: preserve and restore compact pending asset state across compaction.

The `Stop` hook validates structured `asset_gate` blocks before clearing
closeout state. It intentionally auto-allows three low-value closeout cases:
push-only synchronization after work has already been closed out,
`merge_only_closeout` sessions that only record a merge sync with no edits or
verification, and explicit cleanup-only abandonment messages such as deleting
or abandoning obsolete asset work. Each case is still recorded in the audit
stream with a dedicated reason code.

`UserPromptSubmit` is intentionally not part of the asset lifecycle. It is better suited for prompt risk checks than workflow routing.

After enabling or upgrading the plugin, review and trust the hook definitions with `/hooks`. Codex skips plugin-bundled command hooks until the current hook definition has been trusted.

The intended project-local asset layout is `docs/superpowers/`.

Initialize a repository with:

```powershell
python <plugin>\skills\compound-development-asset\scripts\bootstrap_asset_compounding.py . --write
```

The bootstrap step is idempotent. It creates the standard asset directories and
adds or refreshes the versioned managed `AGENTS.md` retrieval block before later
archive/problem work.

At meaningful development task boundaries, the hooks assist the main agent by
recording plan-update checkpoints and enforcing an explicit closeout decision.
The main agent owns route decisions and repository asset writes. Weak but
potentially reusable problem signals should go to `inbox` first instead of being
dropped or prematurely promoted.

When an `update_plan` call contains a completed step, the hook marks
`assetGateDue`. The next plan update returns a lightweight reminder to run the
main-agent asset gate before starting the next planned task. This reminder does
not block tool execution; the hard gate remains the final `Stop` check.

Before final handoff, merge, PR, or cleanup, run:

```powershell
python <plugin>\skills\compound-development-asset\scripts\check_completion_gate.py . --json
```

For completed requirement work, include the topic so spec+plan without archive
coverage becomes a blocking issue:

```powershell
python <plugin>\skills\compound-development-asset\scripts\check_completion_gate.py . --completed-topic "document lifecycle alignment" --json
```

For quick topic status questions, run:

```powershell
python <plugin>\skills\compound-development-asset\scripts\asset_status.py . --topic "document lifecycle alignment" --json
python <plugin>\skills\compound-development-asset\scripts\milestone_assets.py . check --json
python <plugin>\skills\compound-development-asset\scripts\technical_debt_assets.py . check --json
```

For merge/PR closeout, prefer the aggregate closeout check:

```powershell
python <plugin>\skills\compound-development-asset\scripts\asset_closeout.py . --topic "document lifecycle alignment" --json
```

`asset_status.py` and `asset_closeout.py` summarize requirement archive
coverage, related problem and inbox assets, milestone and technical-debt gaps,
index health, and the completion gate into a small handoff block.

Subagent lifecycle hooks are intentionally not registered. Subagents should
return the status format required by their own workflow, such as Superpowers
`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`. The main agent
collects reusable lessons from implementation notes, reviewer output,
verification results, user feedback, and plan-boundary checkpoints, then routes
or defers them at the final `asset_gate`.

Hook usage events are written under `PLUGIN_DATA` as per-session `events.jsonl`
files in `<project>--<session-id>` directories. Appends are serialized with a per-file lock so concurrent hook processes
do not interleave JSONL lines. Events record structured metadata such as hook event name, decision,
reason code, command kind, command hash/length, hook duration, exit code, signal
names, per-tool signal deltas, asset-write markers, and candidate counts. They do
not record prompts, diffs, command output, full commands, or full repository paths.

Summarize collected usage data with:

```powershell
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --since 2026-06-10 --until 2026-06-20 --repo OpenHarnessTS --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --reason missing_asset_gate --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --dry-run --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --json
```

The report includes unknown command tool/repo counts, top unknown command
clusters keyed by command hash and length, filtered stop-gate diagnostics,
session signal summaries, and invalid JSONL line/file counts. It intentionally
omits raw commands, prompts, diffs, command output, full repository paths, and
secrets even if an event accidentally contains one.
The reports do not include raw commands, prompts, diffs, command output, full repository paths, or secrets.

`asset_status.py --topic <topic>` distinguishes completed requirement status
from problem/inbox signals. When a topic only matches problem or inbox assets,
the requirement archive and completion gate are reported as `not_required`
instead of forcing a missing archive finding.

### UI Design Packages

Use `create-ui-design-package` when UI work needs a user-approved visual baseline before Superpowers spec and implementation planning.

The workflow is:

```text
brief -> visual iteration -> approved source image -> image-to-code
-> rendered QA -> design contracts -> subagent task pack
```

Generated project assets live under:

```text
docs/designs/<slug>/
```

Key files include `assets/source/selected-ui-design.png`, `design-tokens.json`,
`component-board.md`, `contracts/`, `subagent-task-pack.md`, and
`visual-fidelity-checklist.md`.

Superpowers specs and plans should link the design package instead of duplicating it. UI implementation subagents should read `START_HERE.md` and `subagent-task-pack.md` before editing UI code.

When this plugin is upgraded, bump `.codex-plugin/plugin.json`, commit and push
the source plugin repository, then refresh the remote marketplace snapshot:

```powershell
codex plugin marketplace upgrade codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin
```

The older `sync_local_plugin_cache.py` / `local-home` cache workflow is deprecated
for this repository. Keep it only for legacy local-plugin maintenance outside the
remote marketplace flow.

This plugin does not publish assets or upload repository content by itself.
