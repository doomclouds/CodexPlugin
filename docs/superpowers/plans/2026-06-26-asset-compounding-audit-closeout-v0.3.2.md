# Asset Compounding Audit and Closeout v0.3.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve asset-compounding closeout precision, audit report diagnostics, command classification, and audit-log accounting archives for v0.3.2.

**Architecture:** Keep the existing plugin layout and CLI entry points. Add shared `asset_gate` validation in the existing handoff check module, use it from both Stop hook and completion-gate CLI, then enhance `asset_hook_report.py` with filtering, session summaries, and an archive subcommand without changing the hook hot path.

**Tech Stack:** Python 3 standard library, `unittest`, Codex plugin hooks, JSONL audit records, Markdown plugin docs.

## Global Constraints

- Do not create a database, background service, or external index.
- Do not record raw commands, prompts, diffs, command output, full repository paths, or secrets in audit summaries or manifests.
- Do not change the `asset_gate.route` enum.
- Do not automatically write repository assets from hook events.
- Do not migrate historical audit records unless the new archive command is explicitly invoked.
- Preserve UTF-8 JSONL exactly during archive moves.
- Validate with `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts`.

---

## File Structure

Modify these files:

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py`
  - Owns shared `asset_gate` structural validation.
  - Exposes result helpers usable by both CLI checks and hook code.

- `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py`
  - Continues to call `check_asset_gate_text()`, now backed by stricter shared validation.

- `plugins/superpowers-asset-compounding/hooks/asset_hook.py`
  - Uses shared `asset_gate` validation in Stop.
  - Adds merge-only closeout auto-allow.
  - Expands command classification.

- `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
  - Adds active/archive scanning modes.
  - Adds filters, stop diagnostics, session summaries, and archive subcommand.

- `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`
  - Adds focused regression tests for every behavior change.

- `plugins/superpowers-asset-compounding/README.md`
  - Documents report filters, session summaries, and audit archive examples.

- `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
  - Bumps plugin version to `0.3.2`.

No new runtime dependencies are required.

---

### Task 1: Shared `asset_gate` Structural Validation

**Files:**
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: handoff text strings from `check_completion_gate.py` and later from `asset_hook.py`.
- Produces:
  - `ASSET_GATE_EVENT_TYPES: tuple[str, ...]`
  - `ASSET_GATE_ROUTES: tuple[str, ...]`
  - `validate_asset_gate_text(text: str) -> dict[str, object]`
  - `check_asset_gate_text(text: str, issues: list[dict[str, str]]) -> None`

- [ ] **Step 1: Write failing tests for missing and invalid structured gates**

Add these tests near the existing completion-gate handoff tests in `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`:

```python
    def test_completion_gate_blocks_incomplete_asset_gate_as_error(self) -> None:
        repo = self.temp_root / "incomplete_gate_repo"
        repo.mkdir()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            "asset_gate:\n  route: none\nreason: too short",
            "--json",
        )

        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("invalid_asset_gate_output", codes)
        messages = "\n".join(issue["message"] for issue in result["issues"])
        self.assertIn("event_type", messages)
        self.assertIn("evidence", messages)
        self.assertIn("asset_candidates", messages)

    def test_completion_gate_blocks_unknown_asset_gate_route(self) -> None:
        repo = self.temp_root / "bad_route_gate_repo"
        repo.mkdir()

        result = self.run_json_fail(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: implementation-boundary\n"
                "  route: skip\n"
                "reason: tested\n"
                "evidence: unit tests\n"
                "related_assets: none\n"
                "asset_candidates: none\n"
                "deferred_signals: none\n"
                "next_step: none"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "needs_attention")
        self.assertEqual(result["issues"][0]["code"], "invalid_asset_gate_output")
        self.assertIn("route", result["issues"][0]["message"])
        self.assertIn("skip", result["issues"][0]["message"])

    def test_completion_gate_accepts_structured_asset_gate(self) -> None:
        repo = self.temp_root / "valid_gate_repo"
        repo.mkdir()

        result = self.run_json(
            COMPLETION_GATE,
            repo,
            "--skip-structure-checks",
            "--require-asset-gate",
            "--handoff-text",
            (
                "asset_gate:\n"
                "  event_type: implementation-boundary\n"
                "  route: none\n"
                "reason: no reusable signal\n"
                "evidence: focused unit tests passed\n"
                "related_assets: none\n"
                "asset_candidates: none\n"
                "deferred_signals: none\n"
                "next_step: none"
            ),
            "--json",
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["issues"], [])
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_blocks_incomplete_asset_gate_as_error plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_blocks_unknown_asset_gate_route plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_accepts_structured_asset_gate
```

Expected: at least the first two tests fail because incomplete gates currently produce warnings or pass the route unchecked.

- [ ] **Step 3: Implement shared validator**

In `checks/handoff_checks.py`, replace the string-only loop with a structured validator:

```python
ASSET_GATE_EVENT_TYPES = (
    "implementation-boundary",
    "requirement-archive",
    "bugfix-root-cause",
    "user-validation-feedback",
    "ci-release-feedback",
    "post-release-warning",
    "cleanup-only",
)

ASSET_GATE_ROUTES = ("none", "inbox", "update-existing", "archive", "new-problem", "both")

REQUIRED_ASSET_GATE_FIELDS = (
    "event_type",
    "route",
    "reason",
    "evidence",
    "related_assets",
    "asset_candidates",
    "deferred_signals",
    "next_step",
)


def parse_asset_gate_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    in_gate = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line == "asset_gate:":
            in_gate = True
            continue
        if not in_gate and line.startswith("asset_gate:"):
            in_gate = True
            continue
        if not in_gate:
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key in REQUIRED_ASSET_GATE_FIELDS:
            fields[key] = value.strip()
    return fields


def validate_asset_gate_text(text: str) -> dict[str, object]:
    if "asset_gate:" not in text:
        return {"valid": False, "code": "missing_asset_gate_output", "missing": list(REQUIRED_ASSET_GATE_FIELDS), "invalid": []}
    fields = parse_asset_gate_fields(text)
    missing = [field for field in REQUIRED_ASSET_GATE_FIELDS if not fields.get(field)]
    invalid: list[str] = []
    event_type = fields.get("event_type")
    route = fields.get("route")
    if event_type and event_type not in ASSET_GATE_EVENT_TYPES:
        invalid.append(f"event_type={event_type}")
    if route and route not in ASSET_GATE_ROUTES:
        invalid.append(f"route={route}")
    return {
        "valid": not missing and not invalid,
        "code": "invalid_asset_gate_output" if missing or invalid else "asset_gate_present",
        "fields": fields,
        "missing": missing,
        "invalid": invalid,
    }
```

Update `check_asset_gate_text()` to append:

- `missing_asset_gate_output` as an error when no `asset_gate:` exists.
- `invalid_asset_gate_output` as an error when fields are missing or enum values are invalid.

- [ ] **Step 4: Run focused GREEN verification**

Run the same focused command from Step 2.

Expected: all three tests pass.

- [ ] **Step 5: Run nearby existing handoff tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_requires_asset_gate_when_requested plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_completion_gate_accepts_asset_candidates_and_asset_gate
```

Expected: both tests pass. If `test_completion_gate_accepts_asset_candidates_and_asset_gate` fails because the existing fixture lacks required fields, update the fixture to the full structured gate used in Step 1.

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "fix(asset-compounding): validate asset gate structure"
```

---

### Task 2: Stop Gate Validation and Merge-Only Auto-Allow

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: `validate_asset_gate_text()` from `checks/handoff_checks.py`.
- Produces:
  - `is_merge_only_closeout(state: dict[str, Any]) -> bool`
  - Stop reason code `merge_only_closeout`
  - Stop reason code `invalid_asset_gate`

- [ ] **Step 1: Write failing tests for invalid Stop gates and merge-only closeout**

Add these tests near the existing Stop hook tests:

```python
    def test_stop_blocks_invalid_asset_gate_without_clearing_state(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "dotnet test .\\LightRAGNet.slnx"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "asset_gate:\n  route: none\nreason: missing fields",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("invalid asset_gate", payload["reason"])
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "invalid_asset_gate")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertIn("verification-ran", state["meaningfulWorkSignals"])

    def test_stop_allows_merge_only_closeout_without_asset_gate(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "tool_name": "Bash",
                "tool_input": {"command": "git merge --no-ff feature/demo"},
                "tool_response": {"exit_code": 0},
            },
            plugin_data=plugin_data,
        )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "已 merge 回 main，仅同步分支历史。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, "")
        events = [
            json.loads(line)
            for line in (self.audit_dir(plugin_data, repo) / "events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(events[-1]["reasonCode"], "merge_only_closeout")
        state = json.loads((self.audit_dir(plugin_data, repo) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["meaningfulWorkSignals"], [])

    def test_stop_requires_asset_gate_when_merge_follows_verification(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        for command in ("dotnet test .\\LightRAGNet.slnx", "git merge --no-ff feature/demo"):
            self.run_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": "session-1",
                    "turn_id": "turn-1",
                    "cwd": str(repo),
                    "tool_name": "Bash",
                    "tool_input": {"command": command},
                    "tool_response": {"exit_code": 0},
                },
                plugin_data=plugin_data,
            )

        code, stdout, stderr = self.run_hook(
            {
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "turn_id": "turn-1",
                "cwd": str(repo),
                "last_assistant_message": "验证后已 merge。",
            },
            plugin_data=plugin_data,
        )

        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout)["decision"], "block")
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_blocks_invalid_asset_gate_without_clearing_state plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_merge_only_closeout_without_asset_gate plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_requires_asset_gate_when_merge_follows_verification
```

Expected: invalid gate currently passes as present, and merge-only currently blocks.

- [ ] **Step 3: Import the shared validator in `asset_hook.py`**

Use the existing dynamic script path pattern near `bootstrap_module()` or add a focused helper:

```python
def handoff_module() -> Any:
    scripts_root = Path(__file__).resolve().parent.parent / "skills" / "compound-development-asset" / "scripts"
    if str(scripts_root) not in sys.path:
        sys.path.insert(0, str(scripts_root))
    return importlib.import_module("checks.handoff_checks")
```

- [ ] **Step 4: Validate `asset_gate` before allowing Stop**

Change the first `asset_gate:` branch in `handle_stop()` so it calls:

```python
validation = handoff_module().validate_asset_gate_text(message)
if validation.get("valid"):
    ...
else:
    append_usage_event(... reason_code="invalid_asset_gate", validation=validation_summary(validation), ...)
    return {"decision": "block", "reason": f"Invalid asset_gate block: {validation_reason(validation)}"}
```

Keep the existing state-clearing behavior only for valid gates.

- [ ] **Step 5: Add merge-only helper**

Add:

```python
def is_merge_only_closeout(state: dict[str, Any]) -> bool:
    signals = set(state.get("meaningfulWorkSignals") or [])
    return bool(
        signals == {"git-closeout"}
        and state.get("lastGitCloseoutKind") == "git-merge"
        and not state.get("subagentCandidates")
        and not state.get("assetFilesChanged")
        and not state.get("verificationEvidence")
    )
```

In `handle_stop()`, check it after push-only and before cleanup-only. Record `reason_code="merge_only_closeout"`, clear closeout state, and return `None`.

- [ ] **Step 6: Run focused GREEN verification**

Run the focused command from Step 2.

Expected: all tests pass.

- [ ] **Step 7: Run existing Stop hook regression tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_push_only_closeout_without_reprompting_asset_gate plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_cleanup_only_abandonment_without_reprompting_asset_gate plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_marks_meaningful_work_and_stop_requires_asset_gate
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 2**

Run:

```powershell
git add plugins/superpowers-asset-compounding/hooks/asset_hook.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "fix(asset-compounding): reduce closeout gate false positives"
```

---

### Task 3: Command Classification Improvements

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: command strings from PostToolUse.
- Produces command kinds:
  - `python-script`
  - `pytest`
  - `vitest`
  - `node-script`
  - `powershell-write`

- [ ] **Step 1: Write failing command classification tests**

Extend or add a command classification test:

```python
    def test_post_tool_use_classifies_common_script_and_runner_commands(self) -> None:
        repo = self.create_repo()
        plugin_data = self.temp_root / "plugin-data"
        cases = [
            ("python scripts\\audit.py --json", "python-script"),
            ("python -m pytest tests", "pytest"),
            ("pytest tests/test_demo.py", "pytest"),
            ("node scripts/report.mjs", "node-script"),
            ("node_modules\\.bin\\vitest run tests/demo.test.ts", "vitest"),
            ("Get-Content file.txt | Select-String demo", "powershell-readonly"),
            ("Set-Content file.txt 'demo'", "powershell-write"),
        ]

        for index, (command, expected_kind) in enumerate(cases, start=1):
            code, stdout, stderr = self.run_hook(
                {
                    "hook_event_name": "PostToolUse",
                    "session_id": f"session-{index}",
                    "turn_id": "turn-1",
                    "cwd": str(repo),
                    "tool_name": "Bash",
                    "tool_input": {"command": command},
                    "tool_response": {"exit_code": 0},
                },
                plugin_data=plugin_data,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(stdout, "")
            events_path = plugin_data / f"repo--session-{index}" / "events.jsonl"
            events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(events[-1]["commandKind"], expected_kind, command)
            self.assertNotIn("command", events[-1])
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_classifies_common_script_and_runner_commands
```

Expected: several cases fail as `unknown` or less specific PowerShell kinds.

- [ ] **Step 3: Update `classify_command_kind()`**

Add specific checks before the generic `unknown` fallback:

```python
if re.search(r"\b(?:python|python\.exe|py)\s+-m\s+pytest\b", command) or re.search(r"\bpytest\b", command):
    return "pytest"
if re.search(r"(?:^|[\\/])vitest(?:\.cmd|\.ps1|\.exe)?\b", command) or re.search(r"\bvitest\s+run\b", command):
    return "vitest"
if re.search(r"\b(?:python|python\.exe|py)\b", command):
    return "python-script"
if re.search(r"\bnode(?:\.exe)?\s+", command):
    return "node-script"
if re.search(r"\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item)\b", command, re.IGNORECASE):
    return "powershell-write"
if re.search(r"\b(?:get-content|select-string|get-childitem|test-path|where-object|foreach-object)\b", command, re.IGNORECASE):
    return "powershell-readonly"
```

Keep `python -m unittest` before `python-script` so existing `python-unittest` remains stable.

- [ ] **Step 4: Run focused GREEN verification**

Run the focused command from Step 2.

Expected: pass.

- [ ] **Step 5: Run existing command classification tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_records_failed_verification_separately plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_does_not_count_dotnet_build_version_as_verification plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_readonly_docs_search_does_not_mark_asset_files_changed
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add plugins/superpowers-asset-compounding/hooks/asset_hook.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): classify common audit commands"
```

---

### Task 4: Audit Report Filters and Session Summaries

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: active and archived `events.jsonl` files.
- Produces filtered summary fields:
  - `filters`
  - `stop_blocks_by_reason`
  - `stop_block_sessions`
  - `sessions_with_gate_due`
  - `top_signal_sets`
  - `signals_added`

- [ ] **Step 1: Write failing report filter and summary tests**

Add helper test data creation inside the test method so the behavior is self-contained:

```python
    def test_hook_report_filters_events_and_summarizes_sessions(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session_a = plugin_data / "RepoA--session-a"
        session_b = plugin_data / "RepoB--session-b"
        session_a.mkdir(parents=True)
        session_b.mkdir(parents=True)
        session_a.joinpath("events.jsonl").write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "timestampUtc": "2026-06-10T00:00:00Z",
                            "hookEventName": "PostToolUse",
                            "decision": "recorded",
                            "reasonCode": "tool_observed",
                            "repoName": "RepoA",
                            "signals": ["edited-files"],
                            "signalsAdded": ["edited-files"],
                            "assetGateDue": True,
                            "commandKind": "file-edit",
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "timestampUtc": "2026-06-10T00:01:00Z",
                            "hookEventName": "Stop",
                            "decision": "block",
                            "reasonCode": "missing_asset_gate",
                            "repoName": "RepoA",
                            "signals": ["edited-files"],
                        },
                        ensure_ascii=False,
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        session_b.joinpath("events.jsonl").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-11T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "no_meaningful_work",
                    "repoName": "RepoB",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "--since", "2026-06-10", "--until", "2026-06-10", "--repo", "RepoA", "--reason", "missing_asset_gate", "--json")

        self.assertEqual(result["filters"]["since"], "2026-06-10")
        self.assertEqual(result["filters"]["until"], "2026-06-10")
        self.assertEqual(result["filters"]["repo"], "RepoA")
        self.assertEqual(result["filters"]["reason"], "missing_asset_gate")
        self.assertEqual(result["total_events"], 1)
        self.assertEqual(result["stop_blocks_by_reason"], {"missing_asset_gate": 1})
        self.assertEqual(result["stop_block_sessions"][0]["session"], "RepoA--session-a")
        self.assertEqual(result["stop_block_sessions"][0]["finalSignals"], ["edited-files"])
        self.assertEqual(result["sessions_with_gate_due"], 1)
        self.assertEqual(result["signals_added"], {"edited-files": 1})
        self.assertEqual(result["top_signal_sets"][0]["signals"], ["edited-files"])
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_filters_events_and_summarizes_sessions
```

Expected: fail because filters and new summary fields do not exist.

- [ ] **Step 3: Extend report record model**

In `asset_hook_report.py`, make `iter_event_records()` include safe metadata on each event:

```python
payload["_eventFile"] = str(path)
payload["_session"] = path.parent.name
payload["_archived"] = "_archives" in path.parts
```

Do not print these internal keys directly in public summaries except for safe `session` names.

- [ ] **Step 4: Add date parsing and filters**

Add helpers:

```python
def parse_date_filter(value: str | None) -> str | None:
    return value or None


def event_date(event: dict[str, Any]) -> str | None:
    timestamp = event.get("timestampUtc")
    if not isinstance(timestamp, str) or len(timestamp) < 10:
        return None
    return timestamp[:10]


def event_matches_filters(event: dict[str, Any], filters: dict[str, str | None]) -> bool:
    date = event_date(event)
    if filters.get("since") and (date is None or date < str(filters["since"])):
        return False
    if filters.get("until") and (date is None or date > str(filters["until"])):
        return False
    if filters.get("repo") and event.get("repoName") != filters["repo"]:
        return False
    if filters.get("reason") and event.get("reasonCode") != filters["reason"]:
        return False
    return True
```

Apply filtering before `summarize()`.

- [ ] **Step 5: Add session summary builder**

Add:

```python
def session_summaries(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        grouped.setdefault(str(event.get("_session") or "unknown"), []).append(event)
    summaries = []
    for session, session_events in sorted(grouped.items()):
        timestamps = [str(event.get("timestampUtc")) for event in session_events if event.get("timestampUtc")]
        final_signals: list[str] = []
        for event in session_events:
            signals = event.get("signals")
            if isinstance(signals, list):
                final_signals = sorted(str(signal) for signal in signals)
        stop_blocks = [
            event for event in session_events
            if event.get("hookEventName") == "Stop" and event.get("decision") == "block"
        ]
        summaries.append(
            {
                "session": session,
                "repoName": next((event.get("repoName") for event in session_events if event.get("repoName")), None),
                "firstTimestampUtc": min(timestamps) if timestamps else None,
                "lastTimestampUtc": max(timestamps) if timestamps else None,
                "toolEventCount": sum(1 for event in session_events if event.get("hookEventName") == "PostToolUse"),
                "stopBlockCount": len(stop_blocks),
                "reasonCodes": sorted({str(event.get("reasonCode")) for event in stop_blocks}),
                "finalSignals": final_signals,
                "assetGateDueEver": any(event.get("assetGateDue") is True for event in session_events),
                "assetFilesChangedEver": any(event.get("assetFilesChanged") is True for event in session_events),
                "signalsAdded": sorted(
                    {
                        str(signal)
                        for event in session_events
                        for signal in (event.get("signalsAdded") or [])
                    }
                ),
            }
        )
    return summaries
```

Add aggregate fields in `summarize()`.

- [ ] **Step 6: Add CLI arguments**

Update `main()` parser:

```python
parser.add_argument("--since")
parser.add_argument("--until")
parser.add_argument("--repo")
parser.add_argument("--reason")
parser.add_argument("--active-only", action="store_true")
parser.add_argument("--archives-only", action="store_true")
```

Reject `--active-only` with `--archives-only` by printing a JSON/text error and returning `1`.

- [ ] **Step 7: Run focused GREEN verification**

Run the focused command from Step 2.

Expected: pass.

- [ ] **Step 8: Run existing report tests**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_audit_report_summarizes_events plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_audit_report_detects_invalid_json_lines
```

Expected: pass. If test names differ, run `rg -n "hook_audit_report|asset_hook_report" plugins\superpowers-asset-compounding\tests\test_asset_scripts.py` and use the existing report test names.

- [ ] **Step 9: Commit Task 4**

Run:

```powershell
git add plugins/superpowers-asset-compounding/hooks/asset_hook_report.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): filter audit hook reports"
```

---

### Task 5: Audit Log Accounting Archive

**Files:**
- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook_report.py`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`

**Interfaces:**
- Consumes: `PLUGIN_DATA` session directories containing `events.jsonl`.
- Produces:
  - CLI subcommand `archive`
  - archive directory `_archives/<fromDate>_to_<untilDate>/<archiveHash>/`
  - `manifest.json`

- [ ] **Step 1: Write failing dry-run and archive tests**

Add:

```python
    def test_hook_report_archive_dry_run_reports_eligible_sessions_without_moving(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        session.joinpath("events.jsonl").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-01T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "asset_gate_present",
                    "repoName": "RepoA",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--dry-run", "--json")

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["sessionCount"], 1)
        self.assertEqual(result["eventCount"], 1)
        self.assertTrue(session.exists())
        self.assertFalse((plugin_data / "_archives").exists())

    def test_hook_report_archive_moves_sessions_and_writes_manifest(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        session = plugin_data / "RepoA--old-session"
        session.mkdir(parents=True)
        original_text = (
            json.dumps(
                {
                    "schemaVersion": 1,
                    "timestampUtc": "2026-06-01T00:00:00Z",
                    "hookEventName": "Stop",
                    "decision": "allow",
                    "reasonCode": "asset_gate_present",
                    "repoName": "RepoA",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        session.joinpath("events.jsonl").write_text(original_text, encoding="utf-8")

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--json")

        self.assertEqual(result["status"], "archived")
        self.assertEqual(result["sessionCount"], 1)
        self.assertEqual(result["eventCount"], 1)
        self.assertFalse(session.exists())
        archive_root = Path(result["archivePath"])
        self.assertTrue(archive_root.is_dir())
        self.assertRegex(archive_root.as_posix(), r"_archives/2026-06-01_to_2026-06-01/[0-9a-f]{16}")
        archived_events = archive_root / "RepoA--old-session" / "events.jsonl"
        self.assertEqual(archived_events.read_text(encoding="utf-8"), original_text)
        manifest = json.loads((archive_root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["archiveHash"], result["archiveHash"])
        self.assertEqual(manifest["files"][0]["eventCount"], 1)
        self.assertEqual(manifest["files"][0]["repoName"], "RepoA")

        summary = self.run_json(HOOK_REPORT, plugin_data, "--archives-only", "--json")
        self.assertEqual(summary["total_events"], 1)
        self.assertEqual(summary["repos"], ["RepoA"])

    def test_hook_report_archive_excludes_current_sessions_by_default(self) -> None:
        plugin_data = self.temp_root / "plugin-data"
        current = plugin_data / "RepoA--current-session"
        old = plugin_data / "RepoA--old-session"
        current.mkdir(parents=True)
        old.mkdir(parents=True)
        current.joinpath("state.json").write_text("{}", encoding="utf-8")
        current.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )
        old.joinpath("events.jsonl").write_text(
            '{"timestampUtc":"2026-06-01T00:00:00Z","hookEventName":"Stop","reasonCode":"asset_gate_present","repoName":"RepoA"}\n',
            encoding="utf-8",
        )

        result = self.run_json(HOOK_REPORT, plugin_data, "archive", "--before", "2026-06-10", "--json")

        self.assertEqual(result["sessionCount"], 1)
        self.assertTrue(current.exists())
        self.assertFalse(old.exists())
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_archive_dry_run_reports_eligible_sessions_without_moving plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_archive_moves_sessions_and_writes_manifest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_archive_excludes_current_sessions_by_default
```

Expected: fail because the `archive` subcommand does not exist.

- [ ] **Step 3: Add archive candidate discovery**

In `asset_hook_report.py`, add functions:

```python
def session_event_files(root: Path, include_archives: bool = False) -> list[Path]:
    files = []
    for path in sorted(root.rglob("events.jsonl")):
        if "_archives" in path.parts and not include_archives:
            continue
        if "_archives" not in path.parts:
            files.append(path)
    return files


def session_bounds(path: Path) -> dict[str, Any]:
    events, invalid = read_event_file(path)
    timestamps = [str(event.get("timestampUtc")) for event in events if event.get("timestampUtc")]
    return {
        "path": path,
        "session": path.parent.name,
        "events": events,
        "invalid": invalid,
        "firstTimestampUtc": min(timestamps) if timestamps else None,
        "lastTimestampUtc": max(timestamps) if timestamps else None,
        "repoName": next((event.get("repoName") for event in events if event.get("repoName")), None),
    }
```

Use existing JSON parsing logic where possible instead of duplicating parsing behavior.

- [ ] **Step 4: Add hashing helpers**

Add:

```python
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_hash(file_rows: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted(file_rows, key=lambda item: str(item["originalPath"])):
        digest.update(str(row["originalPath"]).encode("utf-8"))
        digest.update(str(row["sha256"]).encode("utf-8"))
    return digest.hexdigest()[:16]
```

- [ ] **Step 5: Implement dry-run and move behavior**

Add `run_archive(args)` that:

1. Builds eligible session directories from filters.
2. Excludes sessions containing `state.json` unless `--include-current` is set.
3. Computes `fromDate` and `untilDate` from event timestamps.
4. Computes file hashes before moving.
5. For dry-run, prints JSON and returns without filesystem moves.
6. For archive mode, creates `_archives/<from>_to_<until>/<hash>/`.
7. Moves each eligible session directory under the archive path.
8. Recomputes hashes at destination before deleting source is considered complete. Because `shutil.move()` on one filesystem moves the directory, validate destination immediately and fail if mismatched.
9. Writes `manifest.json`.

Use JSON result shape:

```python
{
    "status": "dry_run" or "archived",
    "archivePath": str(archive_root) or None,
    "archiveHash": hash_value,
    "fromDate": from_date,
    "untilDate": until_date,
    "sessionCount": len(sessions),
    "eventCount": total_events,
    "filters": filters,
    "files": file_rows,
}
```

- [ ] **Step 6: Add archive subparser**

Change `main()` to use subparsers while preserving the current default summary command:

```python
subparsers = parser.add_subparsers(dest="command")
archive = subparsers.add_parser("archive")
archive.add_argument("--before")
archive.add_argument("--since")
archive.add_argument("--until")
archive.add_argument("--repo")
archive.add_argument("--dry-run", action="store_true")
archive.add_argument("--include-current", action="store_true")
archive.add_argument("--json", action="store_true")
```

If `args.command == "archive"`, call `run_archive(args)`. Otherwise keep the existing summary behavior.

- [ ] **Step 7: Run focused GREEN verification**

Run the focused command from Step 2.

Expected: pass.

- [ ] **Step 8: Run report filter tests again**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_report_filters_events_and_summarizes_sessions
```

Expected: pass, proving archive subparser did not break summary mode.

- [ ] **Step 9: Commit Task 5**

Run:

```powershell
git add plugins/superpowers-asset-compounding/hooks/asset_hook_report.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): archive audit hook logs"
```

---

### Task 6: Docs, Version Bump, Full Verification, and Closeout Assets

**Files:**
- Modify: `plugins/superpowers-asset-compounding/README.md`
- Modify: `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py` if version tests require updates
- Create: `docs/superpowers/archives/2026-06/2026-06-26-asset-compounding-audit-closeout-v0.3.2-archives.md`
- Modify: `docs/superpowers/archives/INDEX.md`

**Interfaces:**
- Consumes: completed implementation and test evidence from Tasks 1-5.
- Produces: plugin documentation, version metadata, release archive, index update.

- [ ] **Step 1: Write failing docs/version test**

Add or extend an existing metadata test:

```python
    def test_asset_compounding_plugin_metadata_mentions_v032_audit_archive(self) -> None:
        manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertEqual(manifest["version"], "0.3.2")
        self.assertIn("v0.3.2", readme)
        self.assertIn("archive --before", readme)
        self.assertIn("--since", readme)
        self.assertIn("merge_only_closeout", readme)
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_compounding_plugin_metadata_mentions_v032_audit_archive
```

Expected: fail because metadata and README still describe `0.3.1`.

- [ ] **Step 3: Update plugin manifest**

Set `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json`:

```json
"version": "0.3.2"
```

Do not change unrelated manifest fields.

- [ ] **Step 4: Update README**

In `plugins/superpowers-asset-compounding/README.md`:

- Change the version paragraph to say `Version 0.3.2`.
- Mention structured `asset_gate` validation.
- Mention `merge_only_closeout`.
- Add report examples:

```powershell
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --since 2026-06-10 --until 2026-06-20 --repo OpenHarnessTS --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> --reason missing_asset_gate --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --dry-run --json
python <plugin>\hooks\asset_hook_report.py <PLUGIN_DATA> archive --before 2026-06-20 --json
```

State that reports do not include raw commands, prompts, diffs, command output, full repository paths, or secrets.

- [ ] **Step 5: Run focused GREEN verification**

Run the focused command from Step 2.

Expected: pass.

- [ ] **Step 6: Run full unit suite**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
```

Expected: all tests pass.

- [ ] **Step 7: Validate manifest JSON**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json
```

Expected: valid JSON printed to stdout.

- [ ] **Step 8: Run diff hygiene**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 9: Create release archive**

Create `docs/superpowers/archives/2026-06/2026-06-26-asset-compounding-audit-closeout-v0.3.2-archives.md` with:

```markdown
# Asset Compounding Audit and Closeout v0.3.2

- Date: `2026-06-26`
- Topic slug: `asset-compounding-audit-closeout-v0.3.2`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `hooks`, `audit`, `closeout`, `archive`

## Summary

Implemented v0.3.2 audit and closeout improvements: structured asset_gate validation, merge-only closeout auto-allow, richer command classification, filtered audit reports, session signal summaries, and audit log accounting archives.

## Delivered Scope

- Stop hook validates structured asset_gate output before clearing closeout state.
- Merge-only sessions with no edits, verification, asset changes, candidates, or verification evidence auto-allow with reasonCode `merge_only_closeout`.
- Command classification covers common Python, pytest, Vitest, Node, and PowerShell read/write commands without storing raw command text.
- `asset_hook_report.py` supports date, repo, reason, active, and archive filters plus session-level signal summaries.
- `asset_hook_report.py archive` moves eligible reviewed audit sessions into `_archives/<date-range>/<hash>/` with `manifest.json`.
- README and manifest updated for v0.3.2.

## Out of Scope

- No database, daemon, or external index.
- No raw prompt, command output, diff, or secret capture.
- No automatic repository asset writes from hook events.

## Verification Snapshot

- `$env:PYTHONIOENCODING='utf-8'; python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` -> `Ran <N> tests ... OK`.
- `python -m json.tool plugins\superpowers-asset-compounding\.codex-plugin\plugin.json` -> valid JSON with `"version": "0.3.2"`.
- `git diff --check` -> passed.

## Source Documents

- Spec: [Asset Compounding Audit and Closeout v0.3.2 Design](../../specs/2026-06-26-asset-compounding-audit-closeout-v0.3.2-design.md)
- Plan: [Asset Compounding Audit and Closeout v0.3.2 Implementation Plan](../../plans/2026-06-26-asset-compounding-audit-closeout-v0.3.2.md)

## Related Problems

- [Stop Plan Boundary Closeout Noise Problem](../../problems/2026-06/2026-06-03-stop-plan-boundary-closeout-noise-problem.md)
- [WindowsApps Python Alias Hook Hang](../../problems/2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md)

## Notes

- Audit archive identity is based on the ordered table of archived file hashes, so archived ranges are dated and content-addressed.
```

Replace `<N>` with the real test count from Step 6.

- [ ] **Step 10: Update archive index**

Add a line to `docs/superpowers/archives/INDEX.md` under `2026-06`:

```markdown
- [Asset Compounding Audit and Closeout v0.3.2](./2026-06/2026-06-26-asset-compounding-audit-closeout-v0.3.2-archives.md)
```

Match the existing index style exactly.

- [ ] **Step 11: Run archive/index checks**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\check_indexes.py docs\superpowers
```

Expected: `OK`.

- [ ] **Step 12: Run final full verification**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
git diff --check
```

Expected: tests pass and diff check reports no whitespace errors.

- [ ] **Step 13: Commit Task 6**

Run:

```powershell
git add plugins/superpowers-asset-compounding/README.md plugins/superpowers-asset-compounding/.codex-plugin/plugin.json plugins/superpowers-asset-compounding/tests/test_asset_scripts.py docs/superpowers/archives/2026-06/2026-06-26-asset-compounding-audit-closeout-v0.3.2-archives.md docs/superpowers/archives/INDEX.md
git commit -m "docs(asset-compounding): release audit closeout v0.3.2"
```

---

## Plan Self-Review

- Spec coverage: all six spec goals are covered by Tasks 1-6.
- Shared validation: Task 1 makes `check_completion_gate.py` and Stop hook agree on `asset_gate` semantics.
- Closeout precision: Task 2 adds `merge_only_closeout` and keeps hard gates for edits and verification.
- Audit report usability: Task 4 adds filters and signal summaries.
- Audit archive accounting: Task 5 adds dry-run, move, manifest, hashes, and archive scanning.
- Release closeout: Task 6 updates metadata, docs, archive, index, and runs full verification.
- Placeholder scan: no task relies on deferred design choices or unspecified APIs.
- Type consistency: all introduced helper names are defined in the task that first uses them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-asset-compounding-audit-closeout-v0.3.2.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.
