# Superpowers Codex Windows Hook Override

This recovery kit fixes the Windows command registration shipped by
`superpowers@superpowers-dev`. The upstream hook uses Bash syntax in its
generic `command`; native Windows Codex needs the `commandWindows` override in
`hooks.json` so PowerShell expands `$env:PLUGIN_ROOT` correctly.

## What is kept

- `hooks.json` is the canonical, reviewable replacement.
- `apply-superpowers-codex-hook-override.ps1` validates the target manifest,
  snapshots the existing hook file outside Codex's transient plugin folders,
  and replaces only `hooks/hooks.json`.
- Each apply writes original and applied files plus metadata to
  `%USERPROFILE%\.codex\plugin-overrides\superpowers@superpowers-dev\<version>-<UTC timestamp>\`.

## Apply after an upstream Superpowers update

First obtain the active root from `codex plugin list`. At the time this kit was
created the active path was:

```text
C:\Users\10062\.codex\.tmp\marketplaces\superpowers-dev
```

Then run this from the CodexPlugin checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\apply-superpowers-codex-hook-override.ps1 `
  -PluginRoot 'C:\Users\10062\.codex\.tmp\marketplaces\superpowers-dev'
```

Do not copy a snapshot into an arbitrary plugin. The script requires a
`.codex-plugin/plugin.json` whose `name` is exactly `superpowers`.

After application, restart Codex and open `/hooks`. Review and trust the new
`superpowers@superpowers-dev:hooks/hooks.json:session_start` definition. The
script intentionally never edits the trust hash in `config.toml`.

## Verify the kit

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\test-superpowers-hook-override.ps1
```

The test uses a temporary fake plugin root and removes it after completion. It
does not change the active Superpowers installation.

## Manual rollback

Use the `hooks.original.json` from the desired timestamped snapshot, copy it
back to the active plugin's `hooks\hooks.json`, then restart Codex and review
the restored definition in `/hooks`.
