# Codex Deep Research

`codex-deep-research` runs async, bounded-concurrency research workflows from Codex.

## Commands

Installed plugin usage from the caller workspace root:

```powershell
& "<installed-plugin-root>\bin\codex-deep-research.cmd" start "<question>"
& "<installed-plugin-root>\bin\codex-deep-research.cmd" status <run_id>
& "<installed-plugin-root>\bin\codex-deep-research.cmd" watch <run_id>
& "<installed-plugin-root>\bin\codex-deep-research.cmd" report <run_id>
& "<installed-plugin-root>\bin\codex-deep-research.cmd" cancel <run_id>
& "<installed-plugin-root>\bin\codex-deep-research.cmd" list
```

`<installed-plugin-root>` is the directory that contains this plugin's `.codex-plugin`, `skills`, and `bin` folders. The Windows CLI preserves the caller workspace through `INIT_CWD`, so run outputs stay under the workspace where the command was launched.

The installed plugin ships a prebuilt Windows CLI under `bin\`. A clean installed cache copy can run `start`, `status`, `watch`, `report`, `cancel`, and `list` without `npm install`, `node_modules\`, or a post-install TypeScript build.

Repository development usage from this repository root:

```powershell
npm --prefix src\codex-deep-research run dev -- start "<question>"
npm --prefix src\codex-deep-research run dev -- status <run_id>
npm --prefix src\codex-deep-research run dev -- watch <run_id>
npm --prefix src\codex-deep-research run dev -- report <run_id>
npm --prefix src\codex-deep-research run dev -- cancel <run_id>
npm --prefix src\codex-deep-research run dev -- list
```

The development command also uses the caller workspace via `INIT_CWD` when invoked with `npm --prefix`.

Build the installable CLI after source changes:

```powershell
npm --prefix src\codex-deep-research run build
```

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
& "<installed-plugin-root>\bin\codex-deep-research.cmd" list
& "<installed-plugin-root>\bin\codex-deep-research.cmd" status <run_id>
& "<installed-plugin-root>\bin\codex-deep-research.cmd" report <run_id>
```
