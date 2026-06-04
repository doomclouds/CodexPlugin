# Hook Lifecycle Asset Compounding v0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add plugin-bundled Codex hooks that move asset-compounding enforcement from long `AGENTS.md` prose into lifecycle-aware context injection and closeout gates.

**Architecture:** Add a small hook runner under `hooks/` that dispatches by `hook_event_name`, stores compact session state in `PLUGIN_DATA`, and emits Codex hook JSON for `SessionStart`, `SubagentStart`, `SubagentStop`, `PostToolUse`, `Stop`, `PreCompact`, and `PostCompact`. Existing asset writer skills remain the only path that writes repository assets.

**Tech Stack:** Python 3 standard library, Codex hook JSON protocol, existing `unittest` test suite, local Codex plugin cache sync/validation.

---

## File Map

- Create `hooks/hooks.json`: plugin-bundled hook configuration.
- Create `hooks/asset_hook.py`: deterministic hook dispatcher and state manager.
- Modify `.codex-plugin/plugin.json`: bump version to `0.2.0` and expose hooks path if needed.
- Modify `README.md`: document hook lifecycle behavior and trust step.
- Modify `tests/test_asset_scripts.py`: add hook behavior tests.
- Keep `docs/superpowers/specs/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-design.md`: accepted design draft.

## Task 1: Hook Red Tests

**Files:**
- Modify: `tests/test_asset_scripts.py`

- [ ] **Step 1: Add failing tests for hook configuration and behavior**

Add tests that expect:

- `hooks/hooks.json` exists and registers the required lifecycle events.
- `SessionStart` injects concise asset context only when `docs/superpowers` exists.
- `SubagentStart` injects the `asset_candidates` reporting protocol.
- `SubagentStop` asks for one continuation when a subagent handoff lacks `asset_candidates`.
- `Stop` asks for one continuation when meaningful work exists but final text lacks `asset_gate`.
- `UserPromptSubmit` is absent from the plugin hook config.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest tests.test_asset_scripts.AssetScriptTests
```

Expected: fails because `hooks/hooks.json` and `hooks/asset_hook.py` do not exist yet.

## Task 2: Hook Runner Implementation

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/asset_hook.py`

- [ ] **Step 1: Add hook configuration**

Create `hooks/hooks.json` with command hooks for:

- `SessionStart`
- `SubagentStart`
- `SubagentStop`
- `PostToolUse`
- `Stop`
- `PreCompact`
- `PostCompact`

Do not include `UserPromptSubmit`.

- [ ] **Step 2: Implement minimal hook runner**

Create `hooks/asset_hook.py` with:

- stdin JSON parsing;
- `PLUGIN_DATA` state directory support;
- repo `docs/superpowers` detection;
- JSON outputs using Codex `hookSpecificOutput.additionalContext` where appropriate;
- one-shot continuation guards for `SubagentStop` and `Stop`;
- compact state writes for `PostToolUse`, `SubagentStop`, and `PreCompact`.

- [ ] **Step 3: Run tests and verify GREEN**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest tests.test_asset_scripts.AssetScriptTests
```

Expected: all tests pass.

## Task 3: Plugin Manifest and Documentation

**Files:**
- Modify: `.codex-plugin/plugin.json`
- Modify: `README.md`

- [ ] **Step 1: Bump plugin version**

Change `.codex-plugin/plugin.json` version from `0.1.4` to `0.2.0`.

- [ ] **Step 2: Document v0.2.0 hooks**

Update `README.md` to describe:

- plugin-bundled hooks;
- `/hooks` trust review requirement;
- subagent candidate reporting;
- `Stop` closeout gate;
- `UserPromptSubmit` not being used for lifecycle routing.

- [ ] **Step 3: Run tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest discover -s tests
```

Expected: all tests pass.

## Task 4: Cache Sync and Plugin Validation

**Files:**
- Cache output under the local Codex plugin cache, for example `<CODEX_HOME>\plugins\cache\local-home\superpowers-asset-compounding\0.2.0`

- [ ] **Step 1: Sync local plugin cache**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python <develop-local-codex-plugin>\scripts\sync_local_plugin_cache.py superpowers-asset-compounding
```

Expected: cache sync succeeds for version `0.2.0`.

- [ ] **Step 2: Validate local plugin**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python <develop-local-codex-plugin>\scripts\validate_local_plugin.py superpowers-asset-compounding
```

Expected: validation passes.

## Task 5: Final Review and Commit

**Files:**
- All changed source, docs, tests, and cache-relevant plugin files.

- [ ] **Step 1: Review diff**

Run:

```powershell
git diff --stat
git diff -- .codex-plugin/plugin.json README.md hooks tests docs
```

Expected: changes are limited to v0.2.0 hook lifecycle implementation and documentation.

- [ ] **Step 2: Commit**

Run:

```powershell
git add .codex-plugin/plugin.json README.md hooks tests docs
git commit -m "feat: add hook lifecycle asset compounding"
```

Expected: commit succeeds.

## Plan Self-Review

- Spec coverage: covers subagent reporting, main-agent closeout, PostToolUse facts, compaction preservation, disabled UserPromptSubmit, version bump, cache sync, and validation.
- Placeholder scan: no `TBD` or unresolved placeholders.
- Type consistency: hook names and state fields match the design draft and Codex hook event names.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-31-hook-lifecycle-asset-compounding-v0.2.0-implementation-plan.md`.
The user requested immediate execution, so use inline execution in this session.
