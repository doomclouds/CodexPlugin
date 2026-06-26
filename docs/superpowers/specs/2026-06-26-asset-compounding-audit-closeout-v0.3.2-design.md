# Asset Compounding Audit and Closeout v0.3.2 Design

- Date: `2026-06-26`
- Topic slug: `asset-compounding-audit-closeout-v0.3.2`
- Status: `Draft`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `hooks`, `audit`, `closeout`, `archive`

## Summary

This release improves the `superpowers-asset-compounding` plugin after recent
audit review. The hook runtime is already healthy: JSONL writes are stable,
launcher startup is fixed, and hook latency is low. The next optimization layer
is closeout precision, audit report usability, command classification, and
long-term audit log accounting.

The release keeps the current plugin architecture. It enhances existing hook
and report scripts instead of adding a new service or database.

## Goals

- Reduce false-positive Stop gate prompts for sync-only closeout work.
- Validate `asset_gate` blocks structurally instead of accepting any text that
  contains `asset_gate:`.
- Make `asset_hook_report.py` useful for recent-window and targeted audit
  review without ad hoc scripts.
- Reduce `unknown` command-kind noise in PostToolUse audit events.
- Add session-level signal summaries so repeated long-session state does not
  hide the important deltas.
- Add an audit log accounting command that archives reviewed or expired audit
  records into dated, hash-addressed archive folders.

## Non-Goals

- Do not create a database, background service, or external index.
- Do not record raw commands, prompts, diffs, command output, full repository
  paths, or secrets in audit summaries or manifests.
- Do not change the `asset_gate.route` enum.
- Do not automatically write repository assets from hook events.
- Do not migrate historical audit records unless the new archive command is
  explicitly invoked.

## Current Evidence

Recent local audit data showed the runtime is stable:

- `invalid_json_lines=0`.
- Hook duration around `p50=3ms`, `p95=16ms`.
- Stop gate blocks now mostly represent missing closeout decisions or
  sync/cleanup ambiguity, not hook runtime failure.
- `unknown` command kinds remain high enough to reduce audit explainability.

The existing implementation already has:

- `push_only_closeout` auto-allow behavior.
- `cleanup_only_auto_none` auto-allow behavior based on final message text.
- Per-session `events.jsonl` under `<project>--<session-id>`.
- `asset_hook_report.py` for global summaries and unknown command clusters.

## Design

### 1. Sync-Only Stop Gate Auto-Allow

Add a sync-only closeout classifier for Stop events. It should allow final
handoff without an `asset_gate` only when the session signal set proves there
was no new meaningful work in that session.

Allowed sync-only cases:

- `push_only_closeout`: existing behavior, unchanged.
- `merge_only_closeout`: new behavior for a session whose only hard signal is
  `git-closeout` and whose `lastGitCloseoutKind` is `git-merge`.

The new merge-only exception must not apply when any of these are present:

- `edited-files`
- `verification-ran`
- `verification-failed`
- `assetFilesChanged`
- `subagentCandidates`
- non-empty `verificationEvidence`

Reason code:

- `merge_only_closeout`

This keeps the hard gate for real implementation and verification work while
avoiding prompts for mainline synchronization or merge-only follow-up sessions.

### 2. Structured Asset Gate Validation

Replace the Stop hook's string-only check with a lightweight validation step.
The hook should still accept plain-text final answers, but the `asset_gate`
block must contain the required fields when meaningful work is being closed.

Required fields:

- `event_type`
- `route`
- `reason`
- `evidence`
- `related_assets`
- `asset_candidates`
- `deferred_signals`
- `next_step`

Allowed event types:

- `implementation-boundary`
- `requirement-archive`
- `bugfix-root-cause`
- `user-validation-feedback`
- `ci-release-feedback`
- `post-release-warning`
- `cleanup-only`

Allowed routes:

- `none`
- `inbox`
- `update-existing`
- `archive`
- `new-problem`
- `both`

Validation rules:

- Missing `asset_gate:` still returns the existing missing-gate block.
- Present but invalid `asset_gate` returns a block with reason code
  `invalid_asset_gate`.
- The block reason should list missing or invalid fields.
- A structurally valid gate clears closeout state just like the current
  `asset_gate_present` path.

The validation helper should be shared with `check_completion_gate.py` where
reasonable, so CLI handoff checks and hook Stop checks do not drift.

### 3. Audit Report Filters and Stop Diagnostics

Extend `asset_hook_report.py` with filters:

- `--since YYYY-MM-DD`
- `--until YYYY-MM-DD`
- `--repo <repoName>`
- `--reason <reasonCode>`
- `--active-only`
- `--archives-only`

The default report should scan both active audit sessions and archived audit
records. `--active-only` limits scans to current session directories.
`--archives-only` limits scans to `_archives`.

Add summary fields:

- `filters`
- `stop_blocks_by_reason`
- `stop_block_sessions`
- `sessions_with_gate_due`
- `top_signal_sets`
- `signals_added`

`stop_block_sessions` should contain only safe metadata:

- session directory name
- repo name
- first timestamp
- last timestamp
- stop block count
- reason codes
- final signal set

It must not include raw commands or assistant messages.

### 4. Command Classification Improvements

Expand `classify_command_kind()` to reduce `unknown` noise while preserving
privacy. The hook continues storing only command kind, hash, and length.

New or improved categories:

- `python-script`: Python script, module, or inline execution that is not
  specifically `python -m unittest`.
- `pytest`: `pytest` or `python -m pytest`.
- `vitest`: `vitest` or local Vitest binary execution.
- `node-script`: direct `node` script execution.
- `powershell-readonly`: common read-only PowerShell commands even when they
  appear in pipelines or multi-line snippets.
- `powershell-write`: clear PowerShell file-writing or mutation commands.

Existing classifications such as `python-unittest`, `npm-run-build`,
`npm-run-typecheck`, `git-*`, `asset-search-readonly`, and
`powershell-multi-command` remain stable unless a more specific category is
clearly safer.

### 5. Session Signal Delta Summaries

Keep raw events unchanged, but make reports more readable by summarizing deltas
and final session state.

For each session, derive:

- final signal set
- union of `signalsAdded`
- count of tool events
- count of Stop blocks
- whether `assetGateDue` was ever true
- whether asset files changed
- first and last timestamp

The global report should aggregate these into `top_signal_sets` and
`signals_added`. This avoids changing hook hot-path behavior while making long
sessions easier to inspect.

### 6. Audit Log Accounting Archive

Add an archive subcommand to `asset_hook_report.py`:

```powershell
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --dry-run --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --since 2026-06-01 --until 2026-06-15 --repo OpenHarnessTS --json
```

Archive behavior:

- Default mode moves eligible session directories into
  `<PLUGIN_DATA>/_archives/<from>_to_<until>/<archive_hash>/`.
- `--dry-run` reports what would be archived without moving files.
- `--repo` limits eligible sessions by `repoName` from events.
- `--since` and `--until` select sessions by event timestamps.
- `--before` is shorthand for archiving sessions whose last event is before the
  given date.
- Current or still-active sessions are excluded by default.
- `--include-current` allows archiving sessions even if they look current.

Archive identity:

- Each archived session file gets a SHA-256 hash.
- `archive_hash` is the first 16 characters of the SHA-256 digest computed from
  the ordered table of archived file hashes.
- Folder naming uses the event date span:
  `<fromDate>_to_<untilDate>/<archiveHash>/`.

Archive contents:

- Original session directories, preserving their relative names.
- `manifest.json` with:
  - `schemaVersion`
  - `createdAtUtc`
  - `fromDate`
  - `untilDate`
  - `archiveHash`
  - `sessionCount`
  - `eventCount`
  - `filters`
  - `files`

Each file entry contains:

- `originalPath`
- `archivedPath`
- `sha256`
- `eventCount`
- `firstTimestampUtc`
- `lastTimestampUtc`
- `repoName`

Safety rules:

- Never archive `_archives` into itself.
- Never delete active session data until the target file has been written and
  its hash matches the manifest entry.
- On collision with an existing archive hash directory, create a deterministic
  suffix such as `-2`.
- Preserve UTF-8 JSONL exactly; do not rewrite event files during archive.

Report behavior after archiving:

- Default summaries include active and archived records.
- Archive manifests are optional future accelerators; v0.3.2 can simply recurse
  into archived `events.jsonl` files for correctness.

## Files and Responsibilities

- `plugins/superpowers-asset-compounding/hooks/asset_hook.py`
  - Stop gate sync-only exceptions.
  - `asset_gate` validation entry point.
  - Command kind classification improvements.

- `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
  - Filtered report inputs.
  - Session summaries.
  - Archive subcommand and manifest writing.

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py`
  - Shared `asset_gate` structural validation where feasible.

- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
  - TDD coverage for every behavior change.

- `plugins/superpowers-asset-compounding/README.md`
  - New report filters and archive accounting examples.

- `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
  - Version bump after implementation, expected target `0.3.2`.

## Acceptance Criteria

- A merge-only session with no edits, verification, asset changes, or candidates
  exits without Stop reprompt and records `reasonCode=merge_only_closeout`.
- A merge session after real edits or verification still requires a valid
  `asset_gate`.
- Stop blocks invalid `asset_gate` output and reports missing or invalid fields.
- `check_completion_gate.py --require-asset-gate` and Stop gate validation agree
  on required field and allowed route semantics.
- `asset_hook_report.py --since/--until/--repo/--reason --json` returns only
  matching events and includes filter metadata.
- Report output includes session-level signal summaries.
- New command classifications reduce common `unknown` cases without storing raw
  command text.
- `asset_hook_report.py <PLUGIN_DATA> archive --dry-run --json` reports eligible
  sessions without moving files.
- `asset_hook_report.py <PLUGIN_DATA> archive ... --json` moves eligible session
  directories into `_archives/<date-range>/<hash>/`, writes `manifest.json`,
  verifies file hashes, and excludes active sessions by default.
- Default reports continue to find archived and active `events.jsonl` records.
- Full validation passes:
  `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`.

## Rollout Notes

This release changes Stop gate behavior. It should be shipped with focused
tests before any local plugin upgrade. After source verification and commit,
the plugin update path remains:

```powershell
codex plugin marketplace upgrade codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin
```

The local installed plugin should be refreshed only after the source repository
is committed and pushed.
