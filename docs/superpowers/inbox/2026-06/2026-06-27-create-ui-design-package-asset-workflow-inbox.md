# Create UI Design Package Asset Workflow Gaps

- Date: `2026-06-27`
- Topic slug: `create-ui-design-package-asset-workflow`
- Status: `Inbox`
- Lifecycle: `Promoted`
- Revisit trigger: `Next time create-ui-design-package is optimized, or when a UI design package reaches image-to-code/prototype implementation with generated bitmap assets`
- Scope: `Feature`
- Confidence: `Medium`
- Route candidate: `update-existing`

## Signal

The `create-ui-design-package` skill successfully created a design package shell
and supported visual iteration, but the morning journal test exposed gaps around
turning an approved full-screen ImageGen mock into implementation-ready React UI
assets.

Observed issues:

- The skill says to convert the approved source image through image-to-code, but
  does not define a robust asset extraction/generation workflow before coding.
- It is too easy for the agent to crop assets directly from the full-screen mock.
  That produced low-quality or misaligned assets because shadows, borders, UI
  chrome, paper texture, and decoration were baked together.
- ImageGen output dimensions are not guaranteed to match intended engineering
  dimensions. A paper texture requested as a square sample came back as
  `1254x1254`, requiring local resizing before use.
- The skill does not require an asset manifest that records each asset's role,
  target size, prompt/source, transparency requirement, and placement region.
- Transparent decorative assets need an explicit chroma-key or transparency
  workflow. The trial found that the generated green-screen background was not
  perfectly uniform, so local post-processing and alpha validation are needed.
- The package validator checks for persisted generated options and screenshots,
  but does not validate generated component assets, target dimensions, alpha
  presence, or whether prototype assets live under the package.
- Product Design's image-to-code guidance requires cataloging every image asset,
  but `create-ui-design-package` does not bridge that requirement into its own
  templates, contracts, or validation.
- Temporary/manual image-processing commands were fragile on Windows PowerShell
  (`System.Drawing` constructor overloads and C# assembly references were easy
  to get wrong), suggesting the skill should ship deterministic helper scripts.
- The prototype package briefly contained `node_modules/` and `.npm-cache/`.
  `design_package.py check` then scanned third-party README files and reported
  dead local links unrelated to the design package. The package should keep
  dependency installs and npm caches out of the durable design artifact, or the
  validator should explicitly ignore dependency/cache directories.
- A prototype-local `.npmrc` that points `cache=` inside the design package can
  create durable validation noise and asset bloat. The package template should
  avoid that default unless a cleanup/ignore rule is also generated.

Concrete test artifacts from this run:

- `docs/designs/morning-journal-note-ui/assets/source/selected-ui-design.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/asset-samples-preview.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/paper-texture-warm-ivory-1024.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/memory-morning-320x220.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/note-slip-360x220.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/sunlit-desk-bg-1536x1024.png`
- `docs/designs/morning-journal-note-ui/assets/components/asset-samples/pressed-flower-tape-512.png`
- `docs/designs/morning-journal-note-ui/prototype/.npmrc`

## Why It Might Matter

Without a guided asset workflow, future agents may treat the approved source
image as a visual screenshot to crop instead of a source of design intent. That
can make the React prototype look dirty, blurry, misaligned, or impossible to
maintain.

For visually rich UI packages, the implementation-ready package needs more than
an approved source image and screenshots. It needs reusable atomic assets:

- background/material assets
- memory/photo thumbnails
- transparent decorative assets
- note/paper surfaces
- avatar or product imagery
- a manifest that ties those assets to components and dimensions

If the skill does not make this explicit, image-to-code work can drift into
manual guesswork, and validators may pass packages that still lack the assets
needed for faithful implementation.

## What Is Missing

- A required `assets/component-assets/` or similar package convention distinct
  from `assets/generated-options/`, `assets/source/`, and `assets/screenshots/`.
- An `asset-manifest.json` schema covering:
  - asset id
  - target component/region
  - intended display size
  - generated/raw source path
  - processed/final path
  - prompt or derivation note
  - transparency/alpha requirement
  - validation status
- A helper script for deterministic asset processing:
  - resize contain/cover
  - crop to engineering size
  - generate contact/preview sheet
  - validate image dimensions
  - validate PNG alpha for transparent assets
  - report oversized/missing/unreferenced package assets
- A package hygiene rule for generated frontend dependencies and caches:
  - do not persist `node_modules/`
  - do not persist package-local `.npm-cache/`
  - make validators ignore dependency/cache directories if they exist
  - keep `.npmrc` from routing caches into `docs/designs/<slug>/prototype/`
- Template updates so `component-board.md`, `visual-source.md`,
  `prototype-implementation.md`, `subagent-task-pack.md`, and contracts tell
  implementation agents which assets to use and which assets still need
  generation.
- Validator updates so `design_package.py check` fails or warns when:
  - approved image exists but component asset manifest is missing
  - manifest paths are missing
  - final asset dimensions do not match manifest targets
  - transparent assets do not contain an alpha channel
  - prototype references assets outside the design package or only under
    `$CODEX_HOME/generated_images`
- Guidance that full-screen mocks are visual references, not asset sprite
  sheets. Cropping from the mock should be allowed only for measured reference
  analysis or intentional temporary debugging, not for final package assets.
- Product Design integration guidance that explicitly sequences:
  `approved source image -> asset inventory -> generate/process atomic assets ->
  React implementation -> screenshot QA`.

## Likely Next Route

This signal has been promoted into the workflow-hardening spec, implementation
plan, and archive for `create-ui-design-package-workflow-hardening`.

Update the existing UI design package skill spec/plan/archive with an asset
workflow improvement slice.

Candidate implementation shape:

1. Add `references/asset-manifest-schema.md`.
2. Add an `asset-manifest.json` template to new package shells.
3. Add `scripts/design_assets.py` or extend `design_package.py` with:
   - `assets init`
   - `assets check`
   - `assets preview`
   - `assets resize`
   - `assets chroma-key`
4. Update `SKILL.md` workflow with a hard gate:
   `No asset inventory for image-to-code when the approved source depends on
   bitmap textures/photos/decorations.`
5. Update templates and tests to require asset manifest coverage for rich UI
   packages while allowing simple UI packages to declare `asset_strategy: none`.
6. Add Windows-friendly tests for deterministic image handling without relying
   on ad hoc PowerShell snippets.
7. Add validator ignore coverage for `prototype/node_modules/`,
   `prototype/.npm-cache/`, `dist/`, and other generated frontend outputs.

If the same issue recurs during another UI package implementation, promote this
from inbox into an update to the existing UI design package skill requirement
archive/spec, or create a formal problem note if the failure mode is still
broader than this one skill.

## Related Assets

- Spec: [UI Design Package Skill Design](../../specs/2026-06-26-ui-design-package-skill-design.md)
- Spec update: [Create UI Design Package Workflow Hardening Design](../../specs/2026-06-27-create-ui-design-package-workflow-hardening-design.md)
- Plan: [UI Design Package Skill Implementation Plan](../../plans/2026-06-26-ui-design-package-skill.md)
- Archive: [UI Design Package Skill](../../archives/2026-06/2026-06-26-ui-design-package-skill-archives.md)
- Problems:
  - None yet.
