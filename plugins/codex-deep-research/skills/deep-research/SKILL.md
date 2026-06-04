---
name: deep-research
description: Start, inspect, watch, cancel, or read Codex Deep Research runs from the codex-deep-research plugin.
---

# Codex Deep Research

Use this skill when the user asks for deep research, dynamic workflow research, multi-agent research, adversarial verification, or status/report management for a research run.

## Commands

Run these commands from the caller workspace root. Resolve `<plugin-root>` to the installed plugin directory that contains this `SKILL.md` under `skills\deep-research\SKILL.md`, then use its dependency-free wrapper at `scripts\run.mjs`.

The wrapper preserves the caller workspace through `INIT_CWD`. In a clean installed plugin copy, `list`, `status`, `watch`, `report`, and `cancel` are dependency-free. `start` and `run` still require `dist\cli.js` or repository development dependencies; when those are missing, the wrapper exits with setup instructions.

Start:

```powershell
node "<plugin-root>\scripts\run.mjs" start "<question>"
```

Use `start` only when this plugin copy has a built runner or repository development dependencies available.

Status:

```powershell
node "<plugin-root>\scripts\run.mjs" status <run_id>
```

Watch:

```powershell
node "<plugin-root>\scripts\run.mjs" watch <run_id>
```

Report:

```powershell
node "<plugin-root>\scripts\run.mjs" report <run_id>
```

Cancel:

```powershell
node "<plugin-root>\scripts\run.mjs" cancel <run_id>
```

## Behavior

- Start returns a `run_id`.
- The runner writes runs under the caller workspace, using `INIT_CWD` when launched through the wrapper.
- `watch` follows `events.jsonl` and exits when status reaches `completed`, `partial`, `failed`, or `cancelled`.
- `cancel` writes a cooperative cancellation marker, emits a cancellation event, and marks active runs `cancelled`; v0 does not kill detached OS processes.
- Full reports are written to `.codex-deep-research/runs/<run_id>/report.md`.
- Chat responses should summarize status and provide the report path instead of pasting full reports by default.
- `--debug-prompts` is a reserved prompt-capture setting recorded in `manifest.json`; v0 does not save prompt envelopes.

## Repository Development

When working inside this repository checkout, the development runner is still available:

```powershell
npm --prefix plugins\codex-deep-research run dev -- list
```
