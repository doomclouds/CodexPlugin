# JSONL Hook Event Concurrent Append Corruption

- Date: `2026-06-06`
- Topic slug: `jsonl-hook-event-concurrent-append-corruption`
- Status: `Captured`
- Scope: `Repo`
- Tags: `asset-compounding`, `hook`, `jsonl`, `concurrency`

## Symptom

Hook audit reports show a small number of invalid JSON lines in per-session `events.jsonl` files. The observed bad line can look like a truncated tail, for example only the end of a JSON string remains, so the report can count the damage but cannot recover the lost event.

## Trigger / Context

- Multiple Codex lifecycle hook processes append to the same `PLUGIN_DATA/<session>/events.jsonl` or `_hook/events.jsonl`.
- The event payload itself is privacy-safe and valid before writing.
- The failure is rare, so normal sequential hook tests pass unless concurrency is exercised.

## Root Cause

`append_usage_event()` and `append_raw_usage_event()` both opened `events.jsonl` in append mode and wrote one JSON string without any cross-process coordination. Under concurrent hook process execution, separate append operations can interleave or leave a partial write visible, producing malformed JSONL even though each individual payload was valid.

## Fix

- Added `append_jsonl_event(path, payload)` as the single JSONL append path.
- Added a per-file lock file and platform-specific non-blocking lock acquisition before writing.
- Routed both normal session events and raw `_hook` events through the locked helper.
- Added a regression test that starts concurrent writer processes and asserts every emitted line parses as JSON and the expected event count is preserved.

## Why This Fix

A per-file lock keeps the existing append-only JSONL layout, avoids storing raw commands or prompts, and requires no migration of existing `PLUGIN_DATA`. A per-event file plus atomic rename would also avoid interleaving, but it would make existing report traversal, session locality, and retention behavior noisier for a small audit stream.

## Recognition Clues

- `asset_hook_report.py` shows `invalid_json_lines > 0` or `invalid_json_files > 0`.
- Bad lines are fragments, tails, or merged JSON objects rather than complete events with unexpected fields.
- Failures cluster in active sessions where `PostToolUse`, `Stop`, compact hooks, or raw hook errors can run close together.
- Sequential tests around `append_usage_event()` pass, but process-level concurrent append tests expose the risk.

## Applicability / Non-Applicability

### Applies When

- Multiple short-lived hook processes write to the same append-only log file.
- The log format is line-delimited JSON and every line must remain independently parseable.
- The recovery goal is preserving future audit health, not repairing already corrupted history.

### Does Not Apply When

- Each event already writes to a unique file and is moved into place with atomic rename.
- The corruption comes from invalid payload construction before writing.
- A report is intentionally tolerating historical malformed JSONL without changing the writer.

## Related Artifacts

- Spec: None yet.
- Plan: None yet.
- Archive: [Hook Audit Reliability v0.2.8](../../archives/2026-06/2026-06-06-hook-audit-reliability-v0.2.8-archives.md)
- Related Problems:
  - [PostCompact Hook Output Schema Problem](./2026-06-02-postcompact-hook-output-schema-problem.md)
- Code or Test:
  - [asset_hook.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook.py)
  - [test_asset_scripts.py](../../../../plugins/superpowers-asset-compounding/tests/test_asset_scripts.py)
