# Codex Deep Research

`codex-deep-research` runs async, bounded-concurrency research workflows from Codex.

## Commands

```text
codex-deep-research start "<question>"
codex-deep-research status <run_id>
codex-deep-research watch <run_id>
codex-deep-research report <run_id>
codex-deep-research cancel <run_id>
codex-deep-research list
```

## Output

Runs are written to:

```text
.codex-deep-research/runs/<run_id>/
```

The main files are:

- `status.json`
- `events.jsonl`
- `tasks.jsonl`
- `report.md`
- `report.summary.md`
- `report.sources.md`
- `report.audit.json`

## Privacy

Prompt envelopes are redacted by default. Use `--debug-prompts` only when you explicitly want full prompt capture for local debugging.
