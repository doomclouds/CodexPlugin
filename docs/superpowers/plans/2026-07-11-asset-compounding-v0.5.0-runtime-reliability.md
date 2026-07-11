# Superpowers Asset Compounding v0.5.0 Runtime Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver one v0.5.0 reliability release that makes hook state transactional, session archival correct, verification outcomes truthful, Stop policy deterministic, and audit records version-aware.

**Architecture:** Keep the six-skill plugin and JSONL audit stream. Refactor the hook around a short-lived locked state transaction, derive Stop decisions from one state snapshot, and add optional v0.5.0 report fields that older events may omit. Register POSIX and Windows commands separately, with a safe Windows direct-Python fast path and Git Bash fallback.

**Tech Stack:** Python 3 standard library, unittest, Windows batch, POSIX shell, JSON, Codex lifecycle hooks.

## Global Constraints

- Release version is exactly 0.5.0 in manifest, README, tests, archive, and indexes.
- Preserve six skills, existing asset routes, v1 events, and legacy state data.
- Never record raw tool responses, prompts, command output, full commands, or absolute repository paths.
- Windows rejects WindowsApps Python; POSIX retains run_asset_hook.sh.
- Every production behavior change begins with a focused failing unittest.

---

## File map

| File | Responsibility |
| --- | --- |
| plugins/superpowers-asset-compounding/hooks/asset_hook.py | State transactions, response normalization, Stop policy, audit identity. |
| plugins/superpowers-asset-compounding/hooks/asset_hook_report.py | Lifecycle-aware archival and v0.5.0 aggregates. |
| plugins/superpowers-asset-compounding/hooks/hooks.json | POSIX default and Windows override. |
| plugins/superpowers-asset-compounding/hooks/run_asset_hook.cmd | Direct Python fast path and Git Bash fallback. |
| plugins/superpowers-asset-compounding/hooks/run_asset_hook.sh | POSIX launcher identity and fallback path. |
| plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py | Strict and Stop-tolerant gate validation. |
| plugins/superpowers-asset-compounding/tests/test_asset_scripts.py | Regression and integration tests. |

## Task 1: Transactional state and lifecycle-aware archive selection

**Files:**

- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook.py
- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook_report.py
- Test: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py

**Interfaces:**

- state_transaction(event: dict[str, Any]) -> Iterator[dict[str, Any]]
- close_session_state(state: dict[str, Any]) -> None
- reopen_session_state(state: dict[str, Any]) -> None
- session_is_current(session_dir: Path) -> bool

- [x] **Step 1: Write failing tests**

Add test_concurrent_state_transactions_preserve_both_updates, test_stop_allow_marks_session_closed_and_post_tool_use_reopens_it, and test_hook_report_archives_closed_session_but_keeps_legacy_state_session.

The first process test writes two distinct verification evidence entries through the same state transaction and asserts both persist. The lifecycle test asserts a valid Stop allow stores lifecycle closed and the next PostToolUse stores active. The report test creates closed v2 and legacy state sessions and asserts only the closed one is selected.

- [x] **Step 2: Verify RED**

Run:

~~~powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_concurrent_state_transactions_preserve_both_updates plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allow_marks_session_closed_and_post_tool_use_reopens_it plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_archives_closed_session_but_keeps_legacy_state_session
~~~

Expected: state loses an update, lifecycle is absent, and report treats every state file as current.

- [x] **Step 3: Implement minimal transaction**

Extract a general file_lock(path) from event_file_lock and implement:

~~~python
@contextmanager
def state_transaction(event: dict[str, Any]) -> Iterator[dict[str, Any]]:
    path = state_path(event)
    with file_lock(path):
        state = load_state_path(path, event)
        yield state
        save_state_path_atomic(path, state, event)
~~~

Use a same-directory temporary file plus os.replace. Default v2 state includes lifecycle active and closedAtUtc None. Make each PostToolUse and Stop mutation use one transaction. close_session_state clears closeout fields and sets closed; reopen_session_state sets active and clears closedAtUtc. Replace report existence checks with session_is_current, which regards only lifecycle closed as non-current.

- [x] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: all three tests pass and legacy state is still protected.

## Task 2: Truthful verification outcomes

**Files:**

- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook.py
- Test: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py

**Interfaces:**

- extract_exit_code(tool_response: Any) -> tuple[int | None, str]
- verification_signal(status: str) -> str

- [x] **Step 1: Write failing tests**

Add test_post_tool_use_extracts_nested_exit_code, test_post_tool_use_extracts_line_level_text_exit_code, and test_post_tool_use_marks_unknown_outcome_as_observed. Use response fixtures:

~~~python
{"content": [{"type": "text", "text": "Exit code: 1"}]}
{"result": {"returnCode": 0}}
{"content": [{"type": "text", "text": "test output without status"}]}
~~~

Assert failed, passed, and observed respectively, with unknown output adding verification-observed only.

- [x] **Step 2: Verify RED**

Run:

~~~powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_extracts_nested_exit_code plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_extracts_line_level_text_exit_code plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_marks_unknown_outcome_as_observed
~~~

Expected: all fixtures remain observed or use the old verification-ran signal.

- [x] **Step 3: Implement bounded normalization**

Traverse mappings and lists to a fixed depth. Accept only keys exit_code, exitCode, returncode, and returnCode; for strings accept complete line matches of:

~~~python
re.compile(r"(?im)^\s*(?:exit|return)\s+code\s*:\s*(-?\d+)\s*$")
~~~

Return sources top-level, nested, text, or unknown. Map statuses with:

~~~python
{"passed": "verification-ran", "failed": "verification-failed", "observed": "verification-observed"}
~~~

Do not add the raw response to state or audit data.

- [x] **Step 4: Verify GREEN**

Run Step 2 plus test_post_tool_use_records_failed_verification_separately. Expected: all pass.

## Task 3: Semantic-first Stop policy

**Files:**

- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook.py
- Modify: plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py
- Test: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py

**Interfaces:**

- validate_asset_gate_text(text: str, *, allow_defaults: bool = False) -> dict[str, object]
- defaultedFields in tolerant Stop audit events

- [x] **Step 1: Write failing tests**

Add test_stop_allows_incomplete_gate_when_no_hard_work, test_stop_allows_missing_supplemental_fields_when_hard_work_exists, test_stop_blocks_missing_reason_or_evidence_when_hard_work_exists, test_stop_does_not_auto_allow_failed_cleanup_phrase, and test_stop_allows_structured_cleanup_only_none_gate.

The no-work fixture contains only asset_gate followed by route none. The failed-cleanup fixture is remove failed; issue unresolved after an edit and must block. The structured cleanup fixture uses event_type cleanup-only and route none.

- [x] **Step 2: Verify RED**

Run:

~~~powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_incomplete_gate_when_no_hard_work plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_missing_supplemental_fields_when_hard_work_exists plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_blocks_missing_reason_or_evidence_when_hard_work_exists plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_does_not_auto_allow_failed_cleanup_phrase plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_structured_cleanup_only_none_gate
~~~

Expected: ordering, keyword bypass, and tolerant defaults are absent.

- [x] **Step 3: Implement strict core and tolerant supplemental fields**

Split fields into core event_type, route, reason, evidence and supplemental related_assets, asset_candidates, deferred_signals, next_step. allow_defaults only inserts none for missing supplemental fields and returns their names. The completion gate remains strict.

In handle_stop, load one state snapshot first. Allow no hard work before parsing a gate. For meaningful work, use tolerant validation, record defaultedFields, and close state for every allow. Delete is_cleanup_only_closeout and its keyword branch.

- [x] **Step 4: Verify GREEN**

Run Step 2 plus existing strict completion, push-only, and merge-only tests. Expected: tolerant Stop behavior does not weaken the explicit completion gate.

## Task 4: Platform-specific registration and safe launcher path

**Files:**

- Modify: plugins/superpowers-asset-compounding/hooks/hooks.json
- Modify: plugins/superpowers-asset-compounding/hooks/run_asset_hook.cmd
- Modify: plugins/superpowers-asset-compounding/hooks/run_asset_hook.sh
- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook.py
- Test: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py

**Interfaces:**

- Every hook registration has command and commandWindows.
- ASSET_HOOK_LAUNCHER is windows-direct, windows-git-bash, or posix-shell.
- Audit event has launcherKind.

- [x] **Step 1: Write failing tests**

Add test_hook_config_uses_posix_command_and_windows_override, test_windows_launcher_prefers_real_python_before_git_bash, and test_usage_event_records_launcher_kind_without_plugin_root.

Assert command references run_asset_hook.sh, commandWindows references run_asset_hook.cmd, cmd source rejects WindowsApps and honors CODEX_ASSET_PYTHON, and event omits PLUGIN_ROOT.

- [x] **Step 2: Verify RED**

Run the three tests above. Expected: only the Windows command exists and no launcherKind is emitted.

- [x] **Step 3: Implement registration and fast path**

Use this registration shape:

~~~json
{
  "type": "command",
  "command": "\"$PLUGIN_ROOT/hooks/run_asset_hook.sh\"",
  "commandWindows": "& \"$env:PLUGIN_ROOT\\hooks\\run_asset_hook.cmd\""
}
~~~

The cmd launcher tries CODEX_ASSET_PYTHON then real non-WindowsApps candidates, sets ASSET_HOOK_LAUNCHER=windows-direct, and starts asset_hook.py with -X utf8. It sets windows-git-bash only for the existing fallback. The shell launcher defaults to posix-shell. append_usage_event writes launcherKind only.

- [x] **Step 4: Verify GREEN**

Run focused tests, then pipe a no-asset SessionStart document to run_asset_hook.cmd five times. Expected: each returns 0 and direct Python is used when available.

## Task 5: Build identity and report health aggregates

**Files:**

- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook.py
- Modify: plugins/superpowers-asset-compounding/hooks/asset_hook_report.py
- Test: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py

**Interfaces:**

- plugin_runtime_identity() -> dict[str, str]
- Report fields: plugin_versions, plugin_fingerprints, launcher_kinds, verification_statuses, active_sessions, closed_sessions, legacy_state_sessions.

- [x] **Step 1: Write failing tests**

Add test_usage_event_records_plugin_version_and_fingerprint and test_hook_report_summarizes_v050_runtime_identity_and_session_lifecycle.

The report fixture contains active v2, closed v2, and legacy states plus passed, failed, and observed events. Assert fields are counted and root paths are absent.

- [x] **Step 2: Verify RED**

Run both tests. Expected: identity and lifecycle aggregate fields are absent.

- [x] **Step 3: Implement privacy-safe identity**

Read the manifest under PLUGIN_ROOT for pluginVersion. Calculate a short SHA-256 fingerprint over normalized bytes of plugin.json, hooks.json, and asset_hook.py. Fall back to unknown. Merge it into events and new states. Report optional fields without rejecting v1 records.

- [x] **Step 4: Verify GREEN**

Run both tests plus the existing usage summary and archive-current-session test. Expected: legacy records remain readable.

## Task 6: Release assets and complete verification

**Files:**

- Modify: plugins/superpowers-asset-compounding/.codex-plugin/plugin.json
- Modify: plugins/superpowers-asset-compounding/README.md
- Modify: plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
- Create: docs/superpowers/archives/2026-07/2026-07-11-asset-compounding-v0.5.0-runtime-reliability-archives.md
- Create: docs/superpowers/problems/2026-07/2026-07-11-hook-state-transaction-and-lifecycle-problem.md
- Create: docs/superpowers/problems/2026-07/2026-07-11-hook-tool-response-outcome-normalization-problem.md
- Modify: docs/superpowers/archives/INDEX.md
- Modify: docs/superpowers/problems/INDEX.md

- [x] **Step 1: Write failing metadata test**

Change metadata assertions to manifest version 0.5.0, README text Version 0.5.0, and hook configuration containing commandWindows.

- [x] **Step 2: Verify RED**

Run the metadata test. Expected: current source still says 0.3.3.

- [x] **Step 3: Publish release docs and durable assets**

Update manifest and README. Create the release archive plus separate state-lifecycle and response-normalization problem assets because they have separate triggers and recovery paths. Update indexes.

- [x] **Step 4: Full verification**

Run:

~~~powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
$env:PYTHONIOENCODING='utf-8'; python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json
$env:PYTHONIOENCODING='utf-8'; python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_completion_gate.py . --completed-topic "asset compounding v0.5.0 runtime reliability" --json
$env:PYTHONIOENCODING='utf-8'; git diff --check
~~~

Expected: all pass, the requirement archive is found, and diff check reports no whitespace errors.

- [x] **Step 5: Commit**

~~~powershell
git add plugins/superpowers-asset-compounding docs/superpowers
git commit -m "feat(asset-compounding): release runtime reliability v0.5.0"
~~~

Expected: one coherent release commit on codex/asset-compounding-v050-runtime-reliability.

## Post-review regression hardening

- A real Windows bare-`sh.exe` launch failed because an otherwise POSIX-compliant launcher still called Git-provided `dirname` and `tr` through an incomplete `PATH`.
- A test-first regression case now starts the launcher through `Git/usr/bin/sh.exe` with that utility directory removed from `PATH` and verifies normal SessionStart output plus `launcherKind: posix-shell`.
- The minimal fix resolves the hook through injected `PLUGIN_ROOT` first, retains a `$0` fallback for standalone POSIX invocation, and replaces the WindowsApps check with shell pattern matching.

## Plan self-review

- Tasks 1 through 5 map directly to the five runtime reliability areas in the approved design.
- Task 6 closes manifest, documentation, archive, problem, index, and deterministic verification gaps.
- Function names are defined before later tasks consume them, and the plan has no incomplete requirements.
