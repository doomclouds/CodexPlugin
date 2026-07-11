# Superpowers Windows Hook Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `superpowers@superpowers-dev` SessionStart work on native Windows Codex and preserve a reusable recovery kit for future plugin updates.

**Architecture:** Keep the upstream hook script untouched. A repository-tracked override JSON supplies platform-specific registration, while one PowerShell script validates the target, copies the override, and writes a local snapshot outside Codex's transient marketplace/cache paths.

**Tech Stack:** JSON, PowerShell 7-compatible script, Python-free filesystem checks, Codex plugin hooks.

## Global Constraints

- The target plugin is `superpowers@superpowers-dev`, not `superpowers-asset-compounding`.
- Preserve upstream `SessionStart` matcher and `run-hook.cmd` launcher.
- Never edit or synthesize `/hooks` trust hashes; restart and review are explicit user actions.
- The recovery source lives in the repository; mutable snapshots live under `%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev`.

---

### Task 1: Establish a failing Windows compatibility regression

**Files:**
- Create: `tools/superpowers-hook-override/test-superpowers-hook-override.ps1`
- Test: `tools/superpowers-hook-override/test-superpowers-hook-override.ps1`

**Interfaces:**
- Consumes: `apply-superpowers-codex-hook-override.ps1 -PluginRoot <path> -BackupRoot <path>`.
- Produces: a zero-exit disposable integration check.

- [x] **Step 1: Write the failing test harness**

Create a temporary `superpowers` plugin root with `.codex-plugin/plugin.json`
and a legacy `hooks/hooks.json`. Call the absent override script, then assert
that it produces a timestamped backup containing the legacy JSON and replaces
the target with the canonical JSON.

- [x] **Step 2: Verify RED**

Run:

~~~powershell
$env:PYTHONIOENCODING='utf-8'; powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\test-superpowers-hook-override.ps1
~~~

Expected: fail because `apply-superpowers-codex-hook-override.ps1` and canonical
`hooks.json` do not yet exist.

### Task 2: Add the canonical hook configuration and recovery script

**Files:**
- Create: `tools/superpowers-hook-override/hooks.json`
- Create: `tools/superpowers-hook-override/apply-superpowers-codex-hook-override.ps1`
- Create: `tools/superpowers-hook-override/README.md`

**Interfaces:**
- `apply-superpowers-codex-hook-override.ps1` accepts mandatory `PluginRoot`
  and optional `BackupRoot`.
- The target must contain `.codex-plugin/plugin.json` with `name` equal to
  `superpowers` and `hooks/hooks.json`.

- [x] **Step 1: Write minimal canonical JSON**

Use one `SessionStart` registration whose POSIX command is:

~~~json
"command": "sh \"$PLUGIN_ROOT/hooks/run-hook.cmd\" session-start"
~~~

and whose Windows override is:

~~~json
"commandWindows": "& \"$env:PLUGIN_ROOT\\hooks\\run-hook.cmd\" session-start"
~~~

- [x] **Step 2: Implement guarded application**

Read the manifest as JSON, reject any plugin whose name is not `superpowers`,
make `<BackupRoot>\<version>-<UTC timestamp>`, copy the original file as
`hooks.original.json`, copy the canonical JSON as `hooks.applied.json`, then
atomically replace `<PluginRoot>\hooks\hooks.json`.

- [x] **Step 3: Document reapplication**

Document how to obtain the active path from `codex plugin list`, run the
script, restart Codex, and review the changed SessionStart entry in `/hooks`.

### Task 3: Verify then apply the current override

**Files:**
- Modify: active external plugin `hooks/hooks.json` only through the recovery script.
- Create: local snapshot under `%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev`.

- [x] **Step 1: Verify GREEN**

Run the Task 1 harness. Expected: exit `0`, original hooks file preserved in a
snapshot, canonical replacement installed in the temporary target, and wrong
manifest rejected.

- [x] **Step 2: Apply to the active plugin root**

Run:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\apply-superpowers-codex-hook-override.ps1 `
  -PluginRoot C:\Users\10062\.codex\.tmp\marketplaces\superpowers-dev
~~~

Expected: a path outside `.codex\.tmp` reports the saved original and applied
configuration hashes.

- [x] **Step 3: Validate the launcher contract**

Pipe a `SessionStart` JSON object to
`& "$env:PLUGIN_ROOT\hooks\run-hook.cmd" session-start` with the active plugin
root. Expected: exit `0` and JSON containing
`hookSpecificOutput.hookEventName == "SessionStart"`.

- [ ] **Step 4: Restart and trust boundary**

Restart Codex, open `/hooks`, and trust the new `superpowers@superpowers-dev`
`hooks/hooks.json:session_start` definition. Start a fresh thread and confirm
the Superpowers SessionStart context appears.
