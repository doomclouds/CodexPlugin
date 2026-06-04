# Codex Deep Research

`codex-deep-research` runs async, bounded-concurrency research workflows from Codex.

## Commands

Installed plugin usage from the caller workspace root:

```powershell
node "<installed-plugin-root>\scripts\run.mjs" start "<question>"
node "<installed-plugin-root>\scripts\run.mjs" status <run_id>
node "<installed-plugin-root>\scripts\run.mjs" watch <run_id>
node "<installed-plugin-root>\scripts\run.mjs" report <run_id>
node "<installed-plugin-root>\scripts\run.mjs" cancel <run_id>
node "<installed-plugin-root>\scripts\run.mjs" list
```

`<installed-plugin-root>` is the directory that contains this plugin's `.codex-plugin`, `skills`, and `scripts` folders. The wrapper preserves the caller workspace through `INIT_CWD`, so run outputs stay under the workspace where the command was launched.

The v0 wrapper is dependency-free, but the runner itself must exist in the plugin copy. It uses `dist/cli.js` when built, or the repository checkout's local `tsx` dev dependency when available. If neither exists, the wrapper exits with setup instructions instead of pretending the installed cache is runnable.

Repository development usage from this repository root:

```powershell
npm --prefix plugins\codex-deep-research run dev -- start "<question>"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
npm --prefix plugins\codex-deep-research run dev -- list
```

The development command also uses the caller workspace via `INIT_CWD` when invoked with `npm --prefix`.

## Output

Runs are written to:

```text
.codex-deep-research/runs/<run_id>/
```

The main files are:

- `manifest.json`
- `status.json`
- `events.jsonl`
- `report.md`
- `report.summary.md`
- `report.sources.md`

## Privacy

`--debug-prompts` is reserved for later prompt capture work. In v0 it is recorded in `manifest.json` only; v0 does not save prompt envelopes.

## v0 Runtime Semantics

- `watch <run_id>` follows `events.jsonl` and exits when `status.json` reaches `completed`, `partial`, `failed`, or `cancelled`.
- `cancel <run_id>` writes `cancel.requested`, emits `run.cancel_requested`, and updates `status.json` to `cancelled` for active runs.
- Cancellation is cooperative in v0. It is observed at workflow phase boundaries; it does not kill an already detached OS process.

## Codex Skill

The plugin includes a `deep-research` skill. In Codex, use it to start and inspect runs:

```text
node "<installed-plugin-root>\scripts\run.mjs" start "your research question"
node "<installed-plugin-root>\scripts\run.mjs" status <run_id>
node "<installed-plugin-root>\scripts\run.mjs" report <run_id>
```
