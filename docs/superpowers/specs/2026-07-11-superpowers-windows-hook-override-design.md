# Superpowers Windows Hook Override Design

- Date: `2026-07-11`
- Topic slug: `superpowers-windows-hook-override`
- Status: Approved by direct repair request
- Scope: `superpowers@superpowers-dev` v6.1.1 on native Windows Codex

## Problem and evidence

The active Superpowers plugin discovers `hooks/hooks.json`, but its sole
`SessionStart` command is Claude/Bash syntax:

```json
"command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start"
```

Under the Windows PowerShell command host, `${CLAUDE_PLUGIN_ROOT}` is a
PowerShell variable rather than an environment-variable reference. A controlled
reproduction therefore resolves it to `/hooks/run-hook.cmd` and fails before
the launcher starts. The same input succeeds when invoked through the
Windows-specific Codex shape:

```json
"commandWindows": "& \"$env:PLUGIN_ROOT\\hooks\\run-hook.cmd\" session-start"
```

Codex documents `hooks/hooks.json` as the default plugin hook location and
documents both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` for plugin commands. The
problem is Windows shell expansion, not plugin discovery, skill content, or the
stale `hooks-codex.json` trust record.

## Design

### Canonical override

Keep `SessionStart`, its matcher, and the upstream `run-hook.cmd` launcher.
Replace only the hook registration with a dual-platform command:

```json
{
  "type": "command",
  "command": "sh \"$PLUGIN_ROOT/hooks/run-hook.cmd\" session-start",
  "commandWindows": "& \"$env:PLUGIN_ROOT\\hooks\\run-hook.cmd\" session-start",
  "async": false,
  "statusMessage": "Loading Superpowers workflow"
}
```

The POSIX command expands `$PLUGIN_ROOT` in `sh`; Windows uses Codex's
`commandWindows` override. The existing launcher continues to select Git Bash
for the extensionless `session-start` script.

### Durable recovery kit

Track a small override kit in `tools/superpowers-hook-override/`:

- `hooks.json`: canonical replacement for the active plugin's hook file.
- `apply-superpowers-codex-hook-override.ps1`: validates the target manifest,
  snapshots the current file outside the update-prone cache, then atomically
  copies the canonical configuration.
- `test-superpowers-hook-override.ps1`: creates a disposable fake plugin root
  and verifies snapshot, replacement, and manifest guard behavior.
- `README.md`: copy/reapply procedure after a future Superpowers update.

Every application writes a timestamped snapshot below
`%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev\`. The
repository kit remains the source of truth; the snapshot is a local rollback
artifact, not a runtime plugin location.

## Boundaries

- Do not edit Superpowers skills or the upstream `session-start` payload.
- Do not edit `config.toml` trust hashes or bypass trust. After the hook file
  changes, Codex must be restarted and the new entry reviewed in `/hooks`.
- Do not treat the old missing `hooks-codex.json` trust record as an active
  hook. It is evidence of a prior layout, not the command currently running.
- Apply only to the active plugin path reported by `codex plugin list`.

## Acceptance

1. A PowerShell reproduction of the old registered command fails before the
   launcher, while the Windows override emits a valid `SessionStart`
   `hookSpecificOutput` payload.
2. The canonical JSON contains both POSIX `command` and Windows
   `commandWindows` fields.
3. Applying the override validates `name == "superpowers"`, keeps a timestamped
   original snapshot outside the plugin directory, and replaces only
   `hooks/hooks.json`.
4. The repeatable test passes against a temporary plugin root.
5. After restart and `/hooks` trust, a new session receives Superpowers context.
