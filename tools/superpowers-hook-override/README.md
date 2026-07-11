# Superpowers Codex SessionStart Recovery Override

`superpowers@superpowers-dev` v6.1.1 intentionally disables Codex's
SessionStart hook: its manifest declares `"hooks": {}` to suppress Codex's
automatic discovery of `hooks/hooks.json`. This recovery kit deliberately
restores the hook for this machine and makes the Windows launch path explicit.

It does not add `resume` to the matcher. Upstream removed that behavior because
it re-injected the bootstrap on every resumed thread; the restored hook runs on
new startup, `/clear`, and compaction only.

## What is kept

- `hooks-codex.json` is the canonical Codex hook declaration.
- `session-start-codex` always emits Codex's `hookSpecificOutput` JSON shape.
- `run-codex-session-start.cmd` is a Windows-only strict launcher: it invokes
  Git for Windows Bash only and exits nonzero if it is unavailable, rather than
  silently claiming a successful hook with no context.
- `apply-superpowers-codex-hook-override.ps1` validates the target manifest,
  snapshots the existing manifest and Codex hook files outside Codex's
  transient plugin folders, installs every hook prerequisite first, and commits
  the explicit manifest pointer last.
- Each apply writes original and applied files plus metadata to
  `%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev\<version>-<UTC timestamp>\`.

## Apply after an upstream Superpowers update

Pass the Superpowers marketplace root reported by `codex plugin list`. At the
time this kit was created that source path was:

```text
C:\Users\10062\.codex\.tmp\marketplaces\superpowers-dev
```

Then run this from the CodexPlugin checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\apply-superpowers-codex-hook-override.ps1 `
  -PluginRoot 'C:\Users\10062\.codex\.tmp\marketplaces\superpowers-dev'
```

Do not copy a snapshot into an arbitrary plugin. The script requires a
`.codex-plugin/plugin.json` whose `name` is exactly `superpowers`. When the
matching version exists under Codex's plugin cache, the script automatically
patches that runtime cache instead of the marketplace clone; this is the path
Codex actually loads.

The Windows recovery path requires Git for Windows Bash in one of its standard
locations (`C:\Program Files\Git\bin\bash.exe` or the x86 equivalent). The
launcher deliberately returns an error otherwise, so a WSL/WindowsApps
`bash.exe` cannot masquerade as a successfully triggered hook.

After application, restart Codex and review/trust
`superpowers@superpowers-dev:hooks/hooks-codex.json:session_start` in `/hooks`.
The script intentionally never edits the trust hash in `config.toml`.

Important: reopening an existing task after a restart is a `resume`, and this
override intentionally does not match `resume`. Verify with a new task,
`/clear`, or compaction; otherwise a correct no-resume result can look like a
failed recovery.

## Verify the kit

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\test-superpowers-hook-override.ps1
```

The test uses a temporary fake plugin root and removes it after completion. It
does not change the active Superpowers installation.

## Manual rollback

Restore `manifest.original.json` plus any original `hooks-codex.json`,
`session-start-codex`, and `run-codex-session-start.cmd` files recorded in the
desired timestamped snapshot. If a metadata entry says its original file was
absent, remove the corresponding restored file instead. Then restart Codex and
review the restored definition in `/hooks`.
