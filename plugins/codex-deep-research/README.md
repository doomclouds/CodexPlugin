# Codex Deep Research

`codex-deep-research` runs async, bounded-concurrency research workflows from Codex.

## Commands

From the caller workspace root:

```powershell
npm --prefix plugins\codex-deep-research run dev -- start "<question>"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
npm --prefix plugins\codex-deep-research run dev -- list
```

The runner uses the caller workspace via `INIT_CWD` when invoked with `npm --prefix`.

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

Prompt envelopes are redacted by default. Use `--debug-prompts` only when you explicitly want full prompt capture for local debugging.

## Codex Skill

The plugin includes a `deep-research` skill. In Codex, use it to start and inspect runs:

```text
npm --prefix plugins\codex-deep-research run dev -- start "your research question"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
```
