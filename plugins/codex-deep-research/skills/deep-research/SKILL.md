---
name: deep-research
description: Start, inspect, watch, cancel, or read Codex Deep Research runs from the codex-deep-research plugin.
---

# Codex Deep Research

Use this skill when the user asks for deep research, dynamic workflow research, multi-agent research, adversarial verification, or status/report management for a research run.

## Commands

Use the plugin runner from `plugins/codex-deep-research`.

Start:

```powershell
Set-Location plugins\codex-deep-research
npm run dev -- start "<question>"
```

Status:

```powershell
Set-Location plugins\codex-deep-research
npm run dev -- status <run_id>
```

Watch:

```powershell
Set-Location plugins\codex-deep-research
npm run dev -- watch <run_id>
```

Report:

```powershell
Set-Location plugins\codex-deep-research
npm run dev -- report <run_id>
```

Cancel:

```powershell
Set-Location plugins\codex-deep-research
npm run dev -- cancel <run_id>
```

## Behavior

- Start returns a `run_id`.
- Full reports are written to `.codex-deep-research/runs/<run_id>/report.md`.
- Chat responses should summarize status and provide the report path instead of pasting full reports by default.
- Prompt envelopes are redacted unless `--debug-prompts` is explicitly requested.
