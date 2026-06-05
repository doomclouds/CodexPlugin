---
name: deep-research
description: Start, inspect, watch, cancel, or read Codex Deep Research runs from the codex-deep-research plugin.
---

# Codex Deep Research

Use this skill when the user asks for deep research, dynamic workflow research, multi-agent research, adversarial verification, or status/report management for a research run.

## Commands

Run these commands from the caller workspace root. Resolve `<plugin-root>` to the installed plugin directory that contains this `SKILL.md` under `skills\deep-research\SKILL.md`, then use its prebuilt Windows CLI at `bin\codex-deep-research.cmd`.

The CLI preserves the caller workspace through `INIT_CWD`. In a clean installed plugin copy, `start`, `status`, `watch`, `report`, `cancel`, and `list` run without `npm install`, `node_modules\`, or a post-install TypeScript build.

Start:

```powershell
& "<plugin-root>\bin\codex-deep-research.cmd" start "<question>"
```

Status:

```powershell
& "<plugin-root>\bin\codex-deep-research.cmd" status <run_id>
```

Watch:

```powershell
& "<plugin-root>\bin\codex-deep-research.cmd" watch <run_id>
```

Report:

```powershell
& "<plugin-root>\bin\codex-deep-research.cmd" report <run_id>
```

Cancel:

```powershell
& "<plugin-root>\bin\codex-deep-research.cmd" cancel <run_id>
```

## Behavior

- Start returns a `run_id`.
- The runner writes runs under the caller workspace, using `INIT_CWD` when launched through the CLI.
- `watch` follows `events.jsonl` and exits when status reaches `completed`, `partial`, `failed`, or `cancelled`.
- `cancel` writes a cooperative cancellation marker, emits a cancellation event, and marks active runs `cancelled`; v0 does not kill detached OS processes.
- Full reports are written to `.codex-deep-research/runs/<run_id>/report.md`.
- Chat responses should summarize status and provide the report path instead of pasting full reports by default.
- `--debug-prompts` is a reserved prompt-capture setting recorded in `manifest.json`; v0 does not save prompt envelopes.

## Repository Development

When working inside this repository checkout, the development runner is still available:

```powershell
npm --prefix src\codex-deep-research run dev -- list
```
