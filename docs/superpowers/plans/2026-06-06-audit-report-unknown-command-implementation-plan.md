# Audit Report Unknown Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make asset-compounding audit reports explain which unknown command families dominate without storing full command text, and add a concise repository guide outside the managed `AGENTS.md` asset block.

**Architecture:** Keep raw hook events privacy-preserving: hooks already store `commandHash`, `commandLength`, `toolName`, and `repoName`, so the report can cluster unknown commands from those fields. `AGENTS.md` remains split between a small hand-maintained repository guide and the plugin-managed asset retrieval block.

**Tech Stack:** Python standard library, `unittest`, Markdown.

**Spec:** `docs/superpowers/specs/2026-06-06-audit-report-unknown-command-design.md`

---

### Task 1: Unknown Command Report Diagnostics

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

- [ ] **Step 1: Write the failing test**

Add a test that writes JSONL events with repeated unknown commands and one invalid line, then asserts the report includes:

```python
self.assertEqual(report["invalid_json_lines"], 1)
self.assertEqual(report["invalid_json_files"], 1)
self.assertEqual(report["unknown_command_tools"]["Bash"], 2)
self.assertEqual(report["unknown_command_repos"]["CodexPlugin"], 2)
self.assertEqual(report["unknown_command_clusters"][0]["count"], 2)
self.assertEqual(report["unknown_command_clusters"][0]["commandHash"], "abc123")
self.assertNotIn("command", report["unknown_command_clusters"][0])
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.TestAssetScripts.test_hook_report_clusters_unknown_commands_without_raw_command_text
```

Expected: fail because the current report has no invalid JSON or unknown cluster fields.

- [ ] **Step 3: Implement minimal report support**

Update `asset_hook_report.py` to:

```python
def iter_event_records(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ...
```

Keep `iter_events(root)` as a compatibility wrapper. Add `invalid_json_lines`, `invalid_json_files`, `unknown_command_tools`, `unknown_command_repos`, and `unknown_command_clusters` to `summarize(...)`. Clusters use only `commandHash`, `commandLength`, `toolName`, and `repoName`.

- [ ] **Step 4: Run targeted test to verify it passes**

Run the same single-test command. Expected: pass.

### Task 2: Repository Guide

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook.py`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the failing classification test**

Add a test that feeds `PostToolUse` events for `git status`, `git diff`, generic `rg`, PowerShell read-only commands, `python -m unittest`, `codex plugin list`, and `apply_patch`.

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_classifies_common_diagnostic_commands
```

Expected: fail because the commands currently report `unknown`.

- [ ] **Step 2: Implement conservative command kinds**

Update `classify_command_kind` so common diagnostic commands are classified as `git-*`, `rg-search-readonly`, `powershell-readonly`, `python-unittest`, `codex-plugin-cli`, and `file-edit`.

- [ ] **Step 3: Run the classification test**

Run the same single-test command. Expected: pass.

- [ ] **Step 4: Add a concise repo guide outside the managed block**

Add:

```markdown
## Repository Guide

- Plugin packages live under `plugins/`; each plugin owns its `.codex-plugin/plugin.json`, skills, hooks, and README.
- Marketplace metadata lives under `.agents/plugins/`; keep plugin source paths relative to that marketplace root.
- Superpowers assets live under `docs/superpowers/`; use them for specs, plans, archives, problems, and inbox notes before guessing from memory.
- Validate asset-compounding changes with `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`.
- After changing plugin hooks or manifests, restart Codex and review `/hooks` before judging runtime behavior.
```

- [ ] **Step 5: Verify managed asset block remains current**

Run:

```powershell
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\ensure_agent_asset_guidance.py . --json
```

Expected: `needs_update=false`.

### Task 3: Full Verification

**Files:**
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
- Test: `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
- Test: `AGENTS.md`

- [ ] **Step 1: Run full Python test suite**

```powershell
$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: all tests pass.

- [ ] **Step 2: Run report against current plugin data**

```powershell
python plugins\superpowers-asset-compounding\hooks\asset_hook_report.py C:\Users\10062\.codex\plugins\data\superpowers-asset-compounding-codex-plugin --json
```

Expected: output includes unknown clusters and invalid JSON counters.

- [ ] **Step 3: Check working tree**

```powershell
git status --short --branch
```

Expected: only the planned files changed.
