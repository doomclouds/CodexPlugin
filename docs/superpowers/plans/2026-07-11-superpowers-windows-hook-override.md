# Superpowers Windows Hook Override Implementation Plan

**Goal:** Restore a user-requested Superpowers SessionStart hook for native
Windows Codex without reintroducing resume-time duplicate bootstrap injection.

**Architecture:** Apply a repository-tracked Codex-specific hook declaration,
payload script, and strict Windows launcher to the versioned runtime cache, not
merely to the marketplace clone. Preserve rollback snapshots outside transient
plugin folders, stage hook prerequisites before the manifest pointer, and trust
only the exact runtime hash reported by Codex.

## Constraints

- Target superpowers@superpowers-dev, not superpowers-asset-compounding.
- Preserve matcher startup|clear|compact; do not add resume.
- Keep the override local and reversible.
- Use the runtime cache even when codex plugin list shows a marketplace clone.

## Delivery Steps

- [x] **Establish the real failure boundary.**
  - Confirmed v6.1.1 declares "hooks": {} and suppresses Codex auto-discovery.
  - Confirmed hooks/list initially contained no Superpowers hook and that the
    active runtime path is the versioned cache.

- [x] **Create the failing recovery contract.**
  - The test first failed for missing Codex-specific assets, then failed again
    when the apply script changed marketplace source instead of runtime cache.

- [x] **Implement cache-aware recovery.**
  - Added hooks-codex.json, deterministic session-start-codex output, strict
    Git-Bash launcher, snapshots, and version-based runtime-cache selection.
  - Hardened the reapply path for partial-write safety and upstream manifests
    that omit a hooks property.

- [x] **Apply, trust, and verify runtime.**
  - Reapplied the strict launcher to the cache, trusted the current hooks/list
    hash after a before/after config snapshot, and observed a completed
    thread-scoped SessionStart hook during an ephemeral turn/start.

- [ ] **Desktop reload handoff.**
  - Restart the already-running Codex desktop process and create a new thread.

## Regression Commands

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\superpowers-hook-override\test-superpowers-hook-override.ps1
    python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts
