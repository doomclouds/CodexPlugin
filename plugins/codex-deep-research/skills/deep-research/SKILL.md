---
name: deep-research
description: Start, inspect, watch, cancel, or read Codex Deep Research runs from the codex-deep-research plugin.
---

# Codex Deep Research

Use this skill when the user asks for deep research, dynamic workflow research, multi-agent research, adversarial verification, or status/report management for a research run.

## Commands

Run these commands from the caller workspace root. `npm --prefix` invokes the plugin package while preserving the caller workspace through `INIT_CWD`.

Start:

```powershell
npm --prefix plugins\codex-deep-research run dev -- start "<question>"
```

Status:

```powershell
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
```

Watch:

```powershell
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
```

Report:

```powershell
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
```

Cancel:

```powershell
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
```

## Behavior

- Start returns a `run_id`.
- The runner writes runs under the caller workspace, using `INIT_CWD` when invoked with `npm --prefix`.
- Full reports are written to `.codex-deep-research/runs/<run_id>/report.md`.
- Chat responses should summarize status and provide the report path instead of pasting full reports by default.
- `--debug-prompts` is a reserved prompt-capture setting recorded in `manifest.json`; v0 does not save prompt envelopes.
