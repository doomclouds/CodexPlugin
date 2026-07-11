# Superpowers Windows Hook Override Design

- Date: 2026-07-11
- Topic slug: superpowers-windows-hook-override
- Status: Approved by direct repair request
- Scope: superpowers@superpowers-dev v6.1.1 on native Windows Codex

## Problem and evidence

v6.1.1 intentionally declares "hooks": {} in .codex-plugin/plugin.json, so
Codex suppresses automatic discovery of the Claude-oriented hooks/hooks.json.
The upstream history confirms this is a deliberate no-SessionStart-hook choice.

The earlier local override changed only the marketplace clone. Codex actually
loads C:\Users\10062\.codex\plugins\cache\superpowers-dev\superpowers\6.1.1;
hooks/list therefore showed no Superpowers hook. The generic session-start
script also has an unsafe fallback output shape for Codex when the compatibility
environment variable is absent.

## Design

- Point the runtime manifest explicitly to ./hooks/hooks-codex.json.
- Keep matcher startup|clear|compact; do not add resume because upstream removed
  it to prevent duplicate bootstrap injection on resumed threads.
- Use a dedicated session-start-codex script that always emits
  hookSpecificOutput.additionalContext.
- Use commandWindows with a dedicated strict launcher,
  & "$env:PLUGIN_ROOT\hooks\run-codex-session-start.cmd", so missing Git Bash
  returns a visible failure rather than a zero-exit empty payload; do not fall
  through to WSL or WindowsApps bash aliases.
- Resolve the versioned runtime cache from the marketplace root, snapshot the
  runtime manifest/hook state under %USERPROFILE%\.codex\plugin-overrides, and
  stage hook files before atomically committing the manifest pointer.
- Trust only the exact currentHash reported by hooks/list; never reuse the
  stale hash for a deleted hook file.

## Boundaries

- This is a user-requested local override of upstream's no-Codex-hook choice.
- Do not modify upstream Superpowers history or re-enable resume.
- Do not treat the marketplace clone as the runtime source of truth.
- A fresh runtime probe proves the engine path; the already-running desktop
  process still needs a restart to load changed files.

## Acceptance

1. hooks/list shows one enabled Superpowers hook from the runtime cache.
2. It is trusted, uses commandWindows, and matches startup|clear|compact.
3. An ephemeral turn/start produces a completed thread-scoped SessionStart run
   with a context entry.
4. The recovery-kit test proves cache routing, snapshots, manifest pointer,
   deterministic payload through the real Windows launcher, missing-hooks
   manifest compatibility, and wrong-plugin rejection.
