# Superpowers Asset Compounding

Local Codex plugin for turning completed work and reusable debugging lessons into repository assets.

Version `0.5.0` combines six skills with plugin-bundled Codex lifecycle hooks.
This v0.5.0 release makes hook runtime behavior dependable: per-session
transactional state uses locking plus atomic replacement, states explicitly
move between `active` and `closed` so reports archive only closed sessions, and
verification normalizes nested or line-level exit codes into `passed`,
`failed`, or `observed`. It also keeps Stop decisions semantic-first, adds
platform-specific launch commands, and makes audit records build-identifiable.
It builds on the v0.3.3 structured `asset_gate` validation, v0.3.2 report and
archive tools, v0.3.1 managed-guidance refreshes, and v0.3.0 milestone/debt
navigation improvements.

The plugin provides six skills:

- `using-asset-compounding`: entry gate for deciding when preservation is needed.
- `compound-development-asset`: router for `none`, `inbox`, `update-existing`, `new-problem`, `archive`, and `both`.
- `archive-superpowers-feature`: writer for completed requirement archives.
- `write-superpowers-problem`: writer for problem and inbox assets.
- `manage-superpowers-milestone`: writer and checker for project milestone ledgers.
- `manage-technical-debt`: writer and checker for technical-debt records.

The plugin also bundles hooks under `hooks/hooks.json`:

- `SessionStart`: injects a short asset-compounding protocol when a repository has `docs/superpowers/`.
- `PostToolUse`: records compact lifecycle signals from edits, verification commands, git closeout commands, and main-agent plan updates.
- `Stop`: asks the main agent for one continuation when meaningful work is ending without an `asset_gate` block.
- `PreCompact` / `PostCompact`: preserve and restore compact pending asset state across compaction.

The `Stop` hook first asks whether the session has meaningful closeout work,
then validates a structured `asset_gate` before clearing state. It accepts the
canonical flat shape, common YAML-like nested fields and list values, and the
legacy `artifact_generation` alias while keeping the route enum strict. Core
fields (`event_type`, `route`, `reason`, `evidence`) always remain required;
Stop may default only omitted supplemental fields to `none` and records that
choice. It allows no-work, push-only, and `merge_only_closeout` cases, but a
cleanup must use an explicit valid `cleanup-only` / `none` gate rather than a
keyword in free text.

`UserPromptSubmit` is intentionally not part of the asset lifecycle. It is better suited for prompt risk checks than workflow routing.

Each registration uses a POSIX `command` and Windows `commandWindows` override.
Windows prefers a real non-WindowsApps Python interpreter through
`run_asset_hook.cmd`, then falls back to Git Bash when no direct interpreter is
available; the POSIX launcher remains `run_asset_hook.sh`. After enabling or
upgrading the plugin, review and trust the hook definitions with `/hooks`.
Codex skips plugin-bundled command hooks until the current hook definition has
been trusted.

The POSIX launcher resolves the hook from the host-provided `PLUGIN_ROOT` first
and does not require Git's `dirname` or `tr` utilities to be present on `PATH`.
It keeps a standard `$0`-based fallback only for standalone invocation.

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

To generate a validated closeout block instead of hand-writing field names, run:

```powershell
python <plugin>\skills\compound-development-asset\scripts\emit_asset_gate.py --event-type implementation-boundary --route none --reason "No reusable asset is needed for this boundary." --evidence "Focused tests passed."
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
files in `<project>--<session-id>` directories. State changes use a per-session
lock transaction plus atomic replacement; JSONL appends use the same lock
discipline so concurrent hook processes do not lose state or interleave lines.
Persisted state keeps only repository name/hash, command kind/hash/length, and
safe bootstrap actions or known relative directories; it does not retain a raw
working directory, full verification command, bootstrap path, exception text,
or tool response.
Events record structured metadata such as hook event name, decision, reason
code, command kind, command hash/length, hook duration, exit code, signal
names, per-tool signal deltas, asset-write markers, candidate counts,
`launcherKind`, `pluginVersion`, and `pluginFingerprint`. They do not record
prompts, diffs, command output, full commands, raw tool responses, or full
repository paths.

Summarize collected usage data with:

```powershell
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --since 2026-06-10 --until 2026-06-20 --repo OpenHarnessTS --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --reason missing_asset_gate --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --dry-run --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --json
```

Archive copies are staged without holding a long lifecycle lock. Before publish
and source deletion, the report takes the same per-session lock as hooks,
rechecks closed lifecycle and event hash, then atomically publishes the stage.
Reactivated or changed sessions stay in source and are listed as retained.

The report includes report filters, unknown command tool/repo counts, top
unknown command clusters keyed by command hash and length, filtered stop-gate
diagnostics, session summaries, version/build/launcher aggregates, verification
status counts, active/closed/legacy state counts, and invalid JSONL line/file
counts. It intentionally omits raw commands, prompts, diffs, command output,
full repository paths, and secrets even if an event accidentally contains one.
The reports do not include raw commands, prompts, diffs, command output, full repository paths, or secrets.

`asset_status.py --topic <topic>` distinguishes completed requirement status
from problem/inbox signals. When a topic only matches problem or inbox assets,
the requirement archive and completion gate are reported as `not_required`
instead of forcing a missing archive finding.

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
