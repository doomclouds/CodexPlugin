# Superpowers Asset Compounding v0.5.1 Quiet Gate UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide routine `asset_gate` protocol from users while preserving Stop auditability, showing one receipt for successful asset writes, and exposing unrecovered failures.

**Architecture:** Keep `last_assistant_message` as the only gate transport. Reuse the canonical gate generator, wrap validated output in one Markdown HTML comment, and prepend a single Chinese receipt only for successful asset-writing routes. Keep legacy plain gates valid and leave session state, routes, hook registration, and audit storage unchanged.

**Tech Stack:** Python 3.12 standard library, unittest, Markdown HTML comments, Codex lifecycle hooks, JSON.

## Global Constraints

- The UX principle is exactly: mechanism hidden by default, side effects proactively reported, failures never hidden.
- `route: none` produces no user-visible asset text.
- A successful asset-writing route produces exactly one `资产复利：已更新 ...` receipt containing the real asset path.
- Each individual final handoff contains at most one visible asset-compounding result or failure.
- A retry after a visible failure may later show one successful write receipt, because suppressing the side effect is forbidden.
- Ordinary success does not duplicate receipts within the same handoff.
- Stop block and unrecovered Hook failures remain visible and actionable.
- Legacy plain `asset_gate` blocks continue to validate.
- Do not add settings, commands, skills, routes, dependencies, or a second session-state protocol.
- Do not restructure `asset_hook.py`; change only the closeout guidance and failure copy required by this UX slice.
- Release version is exactly `0.5.1` in the manifest, README, and metadata tests.
- On this macOS checkout, run Python through `.venv/bin/python` with `TMPDIR=/private/tmp`.
- Every behavior change starts with a focused failing unittest.

---

## File map

| File | Responsibility |
| --- | --- |
| `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py` | Compose the visible receipt and hidden canonical gate without changing parsing rules. |
| `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/emit_asset_gate.py` | Emit the final quiet handoff and reject asset-writing routes that lack an asset path. |
| `plugins/superpowers-asset-compounding/hooks/asset_hook.py` | Tell the main agent to use the quiet handoff and make unrecovered Stop failures concise and actionable. |
| `plugins/superpowers-asset-compounding/skills/using-asset-compounding/SKILL.md` | Define the user-visible receipt and hidden-gate contract. |
| `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py` | Prove hidden output, legacy compatibility, Stop behavior, guidance, release metadata, and regressions. |
| `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json` | Publish version `0.5.1`. |
| `plugins/superpowers-asset-compounding/README.md` | Explain the quiet closeout behavior and host verification requirement. |
| `docs/superpowers/archives/2026-07/2026-07-22-asset-compounding-v0.5.1-quiet-gate-ux-archives.md` | Preserve accepted delivery and real-host evidence. |
| `docs/superpowers/archives/INDEX.md` | Index the accepted v0.5.1 delivery. |

## Task 1: Generate a quiet, validated final handoff

**Files:**

- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py:144-190`
- Modify: `plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/emit_asset_gate.py:7-48`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py:2076-2120`

**Interfaces:**

- Consumes: `canonical_asset_gate_text(...) -> str` and `validate_asset_gate_text(text: str) -> dict[str, object]`.
- Produces: `asset_gate_handoff_text(block: str, *, route: str, related_assets: str) -> str`.
- Contract: `none` returns only a hidden comment; every other valid route requires a non-`none` `related_assets` value and returns one receipt followed by the hidden comment.

- [ ] **Step 1: Replace the emitter regression with three failing UX tests**

Add these tests to `AssetScriptTests`:

```python
def test_emit_asset_gate_hides_none_route_and_remains_valid(self) -> None:
    repo = self.temp_root / "quiet_none_gate_repo"
    repo.mkdir()
    emitted = subprocess.run(
        [
            sys.executable,
            str(EMIT_ASSET_GATE),
            "--event-type",
            "implementation-boundary",
            "--route",
            "none",
            "--reason",
            "No reusable asset is needed.",
            "--evidence",
            "Focused tests passed.",
        ],
        text=True,
        capture_output=True,
        check=True,
    )

    self.assertTrue(emitted.stdout.startswith("<!-- asset-compounding\nasset_gate:\n"))
    self.assertTrue(emitted.stdout.rstrip().endswith("-->"))
    self.assertNotIn("资产复利：", emitted.stdout)
    result = self.run_json(
        COMPLETION_GATE,
        repo,
        "--skip-structure-checks",
        "--require-asset-gate",
        "--handoff-text",
        emitted.stdout,
        "--json",
    )
    self.assertEqual(result["status"], "pass")

def test_emit_asset_gate_reports_one_successful_asset_write(self) -> None:
    emitted = subprocess.run(
        [
            sys.executable,
            str(EMIT_ASSET_GATE),
            "--event-type",
            "implementation-boundary",
            "--route",
            "update-existing",
            "--reason",
            "Updated the reusable closeout guidance.",
            "--evidence",
            "Focused tests passed.",
            "--related-assets",
            "docs/superpowers/problems/example.md",
        ],
        text=True,
        capture_output=True,
        check=True,
    )

    self.assertEqual(
        emitted.stdout.splitlines()[0],
        "资产复利：已更新 docs/superpowers/problems/example.md",
    )
    self.assertEqual(emitted.stdout.count("资产复利："), 1)
    self.assertIn("<!-- asset-compounding\nasset_gate:\n", emitted.stdout)

def test_emit_asset_gate_rejects_asset_write_without_related_path(self) -> None:
    emitted = subprocess.run(
        [
            sys.executable,
            str(EMIT_ASSET_GATE),
            "--event-type",
            "implementation-boundary",
            "--route",
            "archive",
            "--reason",
            "Archived the accepted requirement.",
            "--evidence",
            "Focused tests passed.",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    self.assertEqual(emitted.returncode, 2)
    self.assertIn("related_assets is required for asset-writing routes", emitted.stderr)
    self.assertEqual(emitted.stdout, "")
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_emit_asset_gate_hides_none_route_and_remains_valid \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_emit_asset_gate_reports_one_successful_asset_write \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_emit_asset_gate_rejects_asset_write_without_related_path
```

Expected: the first test sees a plain block, the second lacks the receipt/comment wrapper, and the third exits `0` instead of rejecting the missing path.

- [ ] **Step 3: Add the minimum handoff composer**

Append this function after `canonical_asset_gate_text` in `handoff_checks.py`:

```python
def asset_gate_handoff_text(block: str, *, route: str, related_assets: str) -> str:
    hidden_gate = f"<!-- asset-compounding\n{block}\n-->"
    if route == "none":
        return hidden_gate

    normalized_assets = _normalize_empty_value(related_assets)
    if not normalized_assets or normalized_assets == "none":
        raise ValueError("related_assets is required for asset-writing routes")
    return f"资产复利：已更新 {normalized_assets}\n\n{hidden_gate}"
```

Do not change `parse_asset_gate_fields`: it already ignores comment marker lines and reads the canonical fields inside them.

Update the emitter import and output path:

```python
from checks.handoff_checks import (
    asset_gate_handoff_text,
    canonical_asset_gate_text,
    validate_asset_gate_text,
)
```

Replace `print(block)` with:

```python
try:
    handoff = asset_gate_handoff_text(
        block,
        route=args.route,
        related_assets=args.related_assets,
    )
except ValueError as exc:
    print(f"invalid asset_gate arguments: {exc}", file=sys.stderr)
    return 2
print(handoff)
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command.

Expected: three tests pass; the `none` output contains no visible receipt, and the asset-writing output contains exactly one receipt.

- [ ] **Step 5: Commit Task 1**

```bash
git add plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/checks/handoff_checks.py plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/emit_asset_gate.py plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): hide closeout gate output"
```

## Task 2: Align Hook guidance and visible failure copy

**Files:**

- Modify: `plugins/superpowers-asset-compounding/hooks/asset_hook.py:23-103,115-130,218-227,247-345`
- Modify: `plugins/superpowers-asset-compounding/skills/using-asset-compounding/SKILL.md:94-122,168-198`
- Test: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py:2330-2347,2520-2535,2580-2622,2686-2727,2954-3003`

**Interfaces:**

- Consumes: the Task 1 final handoff format.
- Produces: SessionStart and plan-boundary guidance that names the quiet contract; concise visible Stop failures with cause, impact, and next step.
- Preserves: one Stop continuation, audit reason codes, state cleanup, and legacy plain gate acceptance.

- [ ] **Step 1: Write failing Hook UX tests**

Extend `test_session_start_injects_context_only_for_asset_repo` with:

```python
self.assertIn("HTML comment", context)
self.assertIn("route none silent", context)
self.assertIn("report successful asset writes once", context)
self.assertIn("expose unrecovered failures", context)
```

Extend `test_post_tool_use_update_plan_reminds_before_next_task_when_gate_due` with:

```python
message = payload["systemMessage"]
self.assertIn("HTML comment", message)
self.assertIn("route none silent", message)
self.assertIn("report successful asset writes once", message)
self.assertIn("expose unrecovered failures", message)
```

Add this complete regression:

```python
def test_stop_accepts_hidden_asset_gate(self) -> None:
    repo = self.create_repo()
    plugin_data = self.temp_root / "plugin-data"
    self.run_hook(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "quiet-gate-session",
            "turn_id": "quiet-gate-turn",
            "cwd": str(repo),
            "tool_name": "apply_patch",
            "tool_input": {"patch": "*** Begin Patch\n*** End Patch"},
            "tool_response": {"ok": True},
        },
        plugin_data=plugin_data,
    )
    hidden_message = (
        "完成验证。\n\n"
        "<!-- asset-compounding\n"
        "asset_gate:\n"
        "  event_type: implementation-boundary\n"
        "  route: none\n"
        "reason: no reusable signal\n"
        "evidence: focused tests passed\n"
        "related_assets: none\n"
        "asset_candidates: none\n"
        "deferred_signals: none\n"
        "next_step: none\n"
        "-->"
    )

    code, stdout, stderr = self.run_hook(
        {
            "hook_event_name": "Stop",
            "session_id": "quiet-gate-session",
            "turn_id": "quiet-gate-turn",
            "cwd": str(repo),
            "last_assistant_message": hidden_message,
        },
        plugin_data=plugin_data,
    )

    self.assertEqual(code, 0, stderr)
    self.assertEqual(stdout, "")
    audit_dir = self.audit_dir(plugin_data, repo, "quiet-gate-session")
    state = json.loads((audit_dir / "state.json").read_text(encoding="utf-8"))
    events = [json.loads(line) for line in (audit_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    self.assertEqual(state["lifecycle"], "closed")
    self.assertEqual(events[-1]["reasonCode"], "asset_gate_present")
```

Update the invalid and missing-gate tests to assert:

```python
self.assertIn("资产复利未完成：", payload["reason"])
self.assertIn("主要任务结果不受影响", payload["reason"])
self.assertIn("下一步：", payload["reason"])
self.assertNotIn("Use this flat template", payload["reason"])
```

Add this malformed-input regression:

```python
def test_hook_invalid_json_failure_is_visible_and_actionable(self) -> None:
    code, stdout, stderr = self.run_hook_raw(b"{")

    self.assertEqual(code, 1)
    self.assertEqual(stdout, "")
    self.assertIn("资产复利未完成：Hook 输入格式无效", stderr)
    self.assertIn("主要任务可能已完成", stderr)
    self.assertIn("下一步：重试当前操作", stderr)
```

Extend `test_hook_times_out_when_stdin_never_closes` with the same impact and next-step assertions, while retaining the timeout audit assertions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_session_start_injects_context_only_for_asset_repo \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_update_plan_reminds_before_next_task_when_gate_due \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_accepts_hidden_asset_gate \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_blocks_invalid_asset_gate_without_clearing_state \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_post_tool_use_marks_meaningful_work_and_stop_requires_asset_gate \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_invalid_json_failure_is_visible_and_actionable \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_hook_times_out_when_stdin_never_closes
```

Expected: guidance lacks the quiet contract, the new hidden-gate test is absent or failing, and Stop failure text still dumps the flat machine template.

- [ ] **Step 3: Replace only the relevant guidance and failure strings**

Use this sentence in both SessionStart context and the plan-boundary reminder:

```python
"Put the auditable asset_gate in an HTML comment before final handoff; keep route none silent, report successful asset writes once with the written path, and expose unrecovered failures."
```

For an invalid gate, return:

```python
return {
    "decision": "block",
    "reason": (
        "资产复利未完成：隐藏门限无效（"
        f"{validation_reason(validation)}"
        "）；主要任务结果不受影响，但本轮知识尚未完成沉淀。"
        "下一步：重新生成有效的隐藏门限后重试。"
    ),
}
```

For a missing gate, return:

```python
return {
    "decision": "block",
    "reason": (
        "资产复利未完成：缺少隐藏门限；主要任务结果不受影响，"
        "但本轮知识尚未完成沉淀。下一步：生成有效的隐藏门限后重试。"
    ),
}
```

Keep the repeated-Stop branch internal and concise:

```python
return {
    "systemMessage": (
        "Asset compounding still lacks a valid hidden asset gate after one Stop retry."
    )
}
```

Do not change the decision ordering or audit fields.

Replace only the four Hook-input stderr messages; do not print raw exception text. Use the first message for both JSON parse and UTF-8 decode failures:

```python
print(
    "资产复利未完成：Hook 输入格式无效；主要任务可能已完成，但本轮知识尚未沉淀。"
    "下一步：重试当前操作。",
    file=sys.stderr,
)

print(
    "资产复利未完成：Hook 输入读取失败；主要任务可能已完成，但本轮知识尚未沉淀。"
    "下一步：重试当前操作。",
    file=sys.stderr,
)

print(
    "资产复利未完成：Hook 输入超时；主要任务可能已完成，但本轮知识尚未沉淀。"
    "下一步：重试当前操作。",
    file=sys.stderr,
)
```

Keep exit code `1`, timeout handling, and privacy-safe audit reason codes unchanged.

- [ ] **Step 4: Update the skill output contract**

Replace the visible canonical-block instruction in `using-asset-compounding/SKILL.md` with this contract:

```markdown
Before final handoff, prefer `emit_asset_gate.py`. Its output is already ready to
append to the response:

- `route: none` emits only a Markdown HTML comment and stays invisible.
- Asset-writing routes require `related_assets` and emit one
  `资产复利：已更新 ...` receipt followed by the hidden comment.
- A recovered pre-handoff formatting error stays internal.
- A Stop block or unrecovered Hook failure remains visible with cause, impact,
  and next step.

When the emitter is unavailable, wrap the canonical flat gate in
`<!-- asset-compounding` and `-->`. Do not expose the flat gate as ordinary
response text.
```

Keep the canonical field reference in the skill because it remains the fallback schema.

- [ ] **Step 5: Run focused and neighboring Stop tests**

Run the Step 2 command plus:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_plan_boundary_only_without_asset_gate \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_incomplete_gate_when_no_hard_work \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_stop_allows_missing_supplemental_fields_when_hard_work_exists
```

Expected: all focused and neighboring tests pass; legacy Stop semantics remain unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add plugins/superpowers-asset-compounding/hooks/asset_hook.py plugins/superpowers-asset-compounding/skills/using-asset-compounding/SKILL.md plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "fix(asset-compounding): make closeout feedback quiet"
```

## Task 3: Publish v0.5.1 metadata and automated regression evidence

**Files:**

- Modify: `plugins/superpowers-asset-compounding/.codex-plugin/plugin.json:3`
- Modify: `plugins/superpowers-asset-compounding/README.md:5-14,27-40,68-89,166-172`
- Modify: `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py:96-113`

**Interfaces:**

- Consumes: Task 1 handoff composer and Task 2 Hook contract.
- Produces: installable plugin version `0.5.1` and user-facing documentation.

- [ ] **Step 1: Make the metadata test fail on the old release**

Rename `test_asset_compounding_plugin_metadata_mentions_v050_runtime_reliability` to `test_asset_compounding_plugin_metadata_mentions_v051_quiet_gate_ux`, then change its metadata assertions to:

```python
self.assertEqual(manifest["version"], "0.5.1")
self.assertIn("Version `0.5.1`", readme)
self.assertIn("hidden HTML comment", readme)
self.assertIn("资产复利：已更新", readme)
```

- [ ] **Step 2: Run the metadata test and verify RED**

Run:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_asset_compounding_plugin_metadata_mentions_v051_quiet_gate_ux
```

Expected: manifest and README still report `0.5.0`, and the quiet UX text is absent.

- [ ] **Step 3: Update manifest and README**

Set `plugin.json` version to `0.5.1`.

Replace the README release introduction with:

```markdown
Version `0.5.1` combines six skills with plugin-bundled Codex lifecycle hooks.
This v0.5.1 release adds quiet closeout UX: routine gates travel in a hidden
HTML comment, `route: none` stays invisible, successful asset writes show one
`资产复利：已更新 ...` receipt with the written path, and unrecovered Stop or
Hook failures remain visible and actionable. It preserves the v0.5.0 runtime
reliability, structured gate schema, routes, audit privacy, and session state.
```

Replace the opening of the Stop section with:

```markdown
The `Stop` hook reads the raw final assistant message, where the canonical gate
is carried inside a hidden HTML comment. `route: none` therefore stays invisible
in the rendered response while audit validation remains unchanged. Successful
asset-writing routes show one `资产复利：已更新 ...` receipt before the hidden
comment. Legacy plain gates remain accepted for compatibility.
```

Replace the emitter introduction with:

````markdown
To generate a validated, response-ready closeout, run:

```powershell
python plugins\superpowers-asset-compounding\skills\compound-development-asset\scripts\emit_asset_gate.py --event-type implementation-boundary --route none --reason "No reusable asset is needed for this boundary." --evidence "Focused tests passed."
```

The `none` route emits only the hidden gate. Asset-writing routes also require
`--related-assets` and emit one visible receipt containing the written path.
````

Add this host note after the existing `/hooks` trust paragraph:

```markdown
After any quiet-closeout Hook or guidance change, restart Codex and review
`/hooks` before host acceptance. Unit tests cannot prove that the desktop
renderer hides the comment while Stop still receives the raw message.
```

- [ ] **Step 4: Run the full automated verification**

Run:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
.venv/bin/python -m json.tool plugins/superpowers-asset-compounding/.codex-plugin/plugin.json
.venv/bin/python plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py . --json
git diff --check
```

Expected: unittest exits `0` with only the existing Windows-only skip, JSON validation exits `0`, the preflight reports pass, and `git diff --check` prints nothing.

- [ ] **Step 5: Commit Task 3**

```bash
git add plugins/superpowers-asset-compounding/.codex-plugin/plugin.json plugins/superpowers-asset-compounding/README.md plugins/superpowers-asset-compounding/tests/test_asset_scripts.py
git commit -m "feat(asset-compounding): release quiet gate ux v0.5.1"
```

## Task 4: Verify the real Codex host and archive the accepted release

**Files:**

- Create: `docs/superpowers/archives/2026-07/2026-07-22-asset-compounding-v0.5.1-quiet-gate-ux-archives.md`
- Modify: `docs/superpowers/archives/INDEX.md:3-7`

**Interfaces:**

- Consumes: committed v0.5.1 source, installed marketplace plugin, Codex Hook lifecycle, and Task 3 automated evidence.
- Produces: user-observed host acceptance, `asset_gate_present` audit evidence, and the requirement archive.
- External-action gate: obtain explicit user approval covering both pushes, marketplace refresh, plugin reinstall, Codex restart, and creation/deletion of the temporary host-probe file before Step 2.

- [ ] **Step 1: Request the external-action approval**

Ask exactly:

```text
自动测试已通过。现在需要把 main 推送两次（宿主验证前和归档后）、刷新 codex-plugin 商城、重新安装插件并重启 Codex；宿主探针会临时创建并在验收后删除 `docs/superpowers/inbox/2026-07-22-quiet-gate-host-probe.md`（不入索引、不暂存、不归档）。是否继续？
```

Do not run Steps 2 through 6 until the user approves.

- [ ] **Step 2: Push the tested source and refresh the installed plugin**

Run:

```bash
git push origin main
codex plugin marketplace upgrade codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin --json
```

Expected: push succeeds, the marketplace snapshot points at the pushed commit, and install output reports version `0.5.1`.

- [ ] **Step 3: Restart and trust the changed Hook definition**

Restart Codex, open `/hooks`, and approve the v0.5.1 Hook definition. Open a new task in `/Users/palink/CodexProjects/CodexPlugin` so SessionStart uses the new plugin cache.

- [ ] **Step 4: Run the missing/invalid Stop -> corrected asset-writing host probe**

In the new task, run this focused verification, then make the first final handoff with a missing or invalid hidden gate:

```bash
TMPDIR=/private/tmp .venv/bin/python -m unittest \
  plugins.superpowers-asset-compounding.tests.test_asset_scripts.AssetScriptTests.test_emit_asset_gate_hides_none_route_and_remains_valid
```

Expected first result: Stop blocks once and shows exactly one visible `资产复利未完成：...` failure with cause, impact, and next step.

On the continuation, create exactly `docs/superpowers/inbox/2026-07-22-quiet-gate-host-probe.md` with this probe-only content:

```markdown
# Quiet Gate Host Probe

Temporary probe only; do not index or archive.
```

Do not add the probe to `docs/superpowers/inbox/INDEX.md`; the probe must never be staged or archived. Close the corrected handoff with `emit_asset_gate.py` using route `inbox` and `related_assets` set to that exact path.

Expected corrected result: the later final handoff shows exactly one `资产复利：已更新 ...` receipt for that path, while the hidden gate and HTML comment markers remain invisible. The prior failure and later success receipt are allowed because they belong to separate final handoffs; the corrected handoff must not duplicate its receipt.

Then run:

```bash
.venv/bin/python plugins/superpowers-asset-compounding/hooks/asset_hook_report.py /Users/palink/.codex/plugins/data/superpowers-asset-compounding-codex-plugin --since 2026-07-22 --json
```

Expected audit result: the new session contains one blocked Stop with `reasonCode: missing_asset_gate` or `invalid_asset_gate`, followed by an allowed Stop with `reasonCode: asset_gate_present`.

Delete that exact probe file after the receipt and audit checks, then run:

```bash
git status --short
```

Expected cleanup result: output must not list the probe path or `docs/superpowers/inbox/INDEX.md`. If the probe file or an index change remains, stop before creating the archive and clean up only those probe changes.

If the corrected comment is visible, stripped before Stop, blocks again, suppresses the successful write receipt, or duplicates that receipt, stop the release. Do not write the archive; preserve the failing evidence and return to the design.

- [ ] **Step 5: Create the accepted requirement archive**

After the corrected asset-writing host probe passes, create the archive with this content:

```markdown
# Asset Compounding v0.5.1 Quiet Gate UX Archive

- Date: 2026-07-22
- Status: Accepted
- Spec: ../../specs/2026-07-22-asset-compounding-quiet-gate-ux-design.md
- Plan: ../../plans/2026-07-22-asset-compounding-quiet-gate-ux.md

## Delivered

- Routine `asset_gate` output is carried in a hidden Markdown HTML comment.
- `route: none` produces no user-visible asset message.
- Successful asset writes produce one `资产复利：已更新 ...` receipt with the real asset path.
- Unrecovered Stop failures remain visible with cause, impact, and next step.
- Legacy plain gates, existing routes, state, and audit privacy remain compatible.

## Evidence

- The full asset-script unittest suite passed with only the existing Windows-only skip.
- The installed v0.5.1 retry probe showed one visible failure followed by one successful write receipt, with no visible gate or duplicate receipt.
- The corresponding audit events recorded the initial missing/invalid reason and the corrected `asset_gate_present` result.
- Manifest JSON, completion preflight, and `git diff --check` passed.
```

Add this first bullet under `## 2026-07` in `docs/superpowers/archives/INDEX.md`:

```markdown
- [2026-07-22-asset-compounding-v0.5.1-quiet-gate-ux-archives.md](./2026-07/2026-07-22-asset-compounding-v0.5.1-quiet-gate-ux-archives.md): v0.5.1 隐藏常规 asset_gate，只在资产写入或不可恢复异常时向用户反馈。
```

- [ ] **Step 6: Run the completion gate and commit the archive**

Run:

```bash
.venv/bin/python plugins/superpowers-asset-compounding/skills/compound-development-asset/scripts/check_completion_gate.py . --completed-topic "asset compounding quiet gate ux" --json
git diff --check
git add docs/superpowers/archives/2026-07/2026-07-22-asset-compounding-v0.5.1-quiet-gate-ux-archives.md docs/superpowers/archives/INDEX.md
git commit -m "docs(asset-compounding): archive quiet gate ux v0.5.1"
git push origin main
```

Expected: the completion gate finds the new archive, the diff check is silent, the archive commit succeeds, and the final push updates remote `main`.

## Plan self-review

- Tasks 1 and 2 cover hidden transport, conditional receipt, pre-handoff guidance, legacy compatibility, Stop auditability, and unrecovered failure copy.
- Task 3 covers versioned documentation, metadata, full automated regression, manifest validation, and completion preflight.
- Task 4 covers the design's mandatory real-host check, the explicit external-action approval boundary, failure fallback, acceptance archive, and remote closeout.
- The plan adds one production helper, no dependency, no state protocol, no route, no setting, and no new Skill.
- Function names, route behavior, paths, commands, messages, and test expectations are consistent across all tasks.
