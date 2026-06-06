# Audit Report Unknown Command Design

- Date: `2026-06-06`
- Status: `Accepted`
- Scope: `superpowers-asset-compounding`
- Tags: `asset-compounding`, `audit`, `unknown-command`, `agents-md`

## Context

The asset-compounding hook audit stream is useful after v0.2.6 because it records compact lifecycle facts and avoids several noisy closeout prompts. Current real local data still shows a weak diagnostic surface: `unknown_command_kind_ratio` is high, but the report only exposes the total unknown count. That makes it hard to decide which commands should become first-class command kinds.

The repository also has a healthy managed `AGENTS.md` asset retrieval block, but it lacks a short non-managed repository map for plugin layout, marketplace metadata, and verification commands.

## Goals

- Explain unknown command sources without storing or printing raw commands.
- Surface invalid JSONL health in the normal hook report.
- Reduce future unknown command volume for common diagnostic and repository commands.
- Keep the hook event privacy boundary intact.
- Add a short repository guide outside the managed `asset-compounding-guidance` block.

## Non-Goals

- Do not record full command text in `events.jsonl`.
- Do not change hook matching or closeout gate behavior.
- Do not rewrite the managed `AGENTS.md` asset retrieval block.
- Do not classify every unknown command in this pass; first make the unknown population inspectable.

## Audit Report Behavior

`asset_hook_report.py` should continue to summarize hook events, decisions, reason codes, command kinds, verification evidence, duration, and slow events.

It should additionally report:

- `invalid_json_lines`: total malformed non-empty JSONL lines skipped while loading audit files.
- `invalid_json_files`: number of `events.jsonl` files containing at least one malformed line.
- `unknown_command_tools`: count of unknown `PostToolUse` events by `toolName`.
- `unknown_command_repos`: count of unknown `PostToolUse` events by `repoName`.
- `unknown_command_clusters`: top unknown command clusters grouped by `commandHash`, `commandLength`, `toolName`, and `repoName`.

Clusters must omit raw command text even if a historical or synthetic event contains a `command` field. A cluster with no command hash should still be represented with `commandHash: null` and `commandLength: null` so tool-only unknowns remain visible.

## Command Classification Behavior

Future hook events should classify common deterministic operations instead of leaving them as `unknown`:

- `apply_patch`, `Edit`, and `Write` become `file-edit`.
- `git status`, `git diff`, `git show`, `git log`, `git add`, `git branch`, and `git worktree` become `git-*` command kinds.
- generic `rg` searches become `rg-search-readonly`, while `docs/superpowers` searches keep the more specific `asset-search-readonly`.
- `Get-Content`, `Select-String`, `Get-ChildItem`, and `Test-Path` become `powershell-readonly`.
- `python -m unittest` becomes `python-unittest`.
- `codex plugin ...` becomes `codex-plugin-cli`.

These classifications are intentionally conservative. Commands that write files, run unclear scripts, or combine multiple operations should remain `unknown` until real audit data justifies a stable category.

## Repository Guide Behavior

`AGENTS.md` should keep the managed asset retrieval block unchanged. A short hand-maintained `Repository Guide` section may live outside that block and should cover:

- plugin package location under `plugins/`;
- marketplace metadata under `.agents/plugins/`;
- Superpowers asset location under `docs/superpowers/`;
- the primary asset plugin test command;
- restart and `/hooks` review after hook or manifest changes.

The guide should stay concise. Detailed routing, archive policy, problem-writing rules, and closeout gates belong to plugin skills and hooks, not repo-level guidance.

## Privacy and Safety

The report may use existing sanitized fields:

- `commandHash`
- `commandLength`
- `toolName`
- `repoName`
- `commandKind`
- `durationMs`

The report must not output:

- raw command text;
- command output;
- full cwd;
- raw prompt or assistant message text.

## Verification

- Add a RED test proving unknown clusters and invalid JSON counters are absent before implementation.
- Add a RED test proving common diagnostic commands currently classify as `unknown`.
- Make the test pass with minimal report changes.
- Run the full `plugins.superpowers-asset-compounding.tests.test_asset_scripts` suite.
- Run the report against current plugin data to verify it emits unknown clusters.
- Run `ensure_agent_asset_guidance.py . --json` to confirm the managed `AGENTS.md` block remains current.
