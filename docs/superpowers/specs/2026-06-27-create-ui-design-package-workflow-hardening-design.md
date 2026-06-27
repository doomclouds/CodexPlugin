# Create UI Design Package Workflow Hardening Design

- Date: `2026-06-27`
- Topic slug: `create-ui-design-package-workflow-hardening`
- Status: `Draft`
- Scope: `Plugin skill`
- Tags: `asset-compounding`, `ui-design`, `image-to-code`, `asset-manifest`, `visual-qa`, `skill-hardening`

## Summary

`create-ui-design-package` 已经能创建 `docs/designs/<slug>/` 设计包，但
morning journal 测试证明：当前 skill 更像一份建议清单，不像一个有强制推进力
的工作流。

这次优化要把它升级成“分阶段门禁型 skill”。目标不是多写说明，而是让 future
agent 在压力下也很难跳过关键步骤：

```text
brief -> visual loop -> approved source -> asset inventory
-> atomic assets -> prototype -> rendered QA -> contracts -> closeout
```

富视觉 UI 的核心变化是：批准源图只做视觉真相，不是运行时资产来源。运行时
资产必须独立生成、记录到 manifest、处理成工程尺寸，并被 validator 检查。

## Problem Evidence

### RED Evidence From Morning Journal Test

这次测试没有失败在 React 能不能写，而是失败在流程纪律不够硬。

Observed baseline failures:

- Agent 曾尝试从全屏 mock 切图作为最终运行时资产，结果阴影、边框、UI chrome、
  纸张纹理和装饰混在一起，无法得到干净的组件资产。
- ImageGen 输出尺寸不稳定，例如方形纸张纹理并不天然等于工程目标尺寸，需要
  本地 resize/cover/contain。
- 透明装饰资产需要后处理；绿色背景不完全均匀时，需要 deterministic alpha
  处理和 alpha 校验。
- 当前 skill 没有要求 `asset-manifest.json`，导致资产角色、目标尺寸、透明度、
  组件归属和 prototype 路径都只能靠聊天记忆。
- Product Design image-to-code 要求 catalog every image asset，但
  `create-ui-design-package` 没把这个要求内化为自身模板和 validator 门禁。
- `prototype/node_modules/` 和 `.npm-cache/` 一度落在设计包目录里，
  `design_package.py check` 扫到三方 README 后产生无关死链错误。
- `visual-source.md` 的 approval status 用了自由文本，validator 期待精确
  `Approved`，说明模板和 validator 之间存在契约不清。
- 最终 QA 能通过，是因为 main agent 手动补了截图、comparison、QA report 和
  checklist，而不是 skill 自动要求这些证据。

Related inbox:

- [Create UI Design Package Asset Workflow Gaps](../inbox/2026-06/2026-06-27-create-ui-design-package-asset-workflow-inbox.md)

## Goals

- 强化 `create-ui-design-package` 的阶段门禁，让 agent 不容易跳过批准源图、资产盘点、
  atomic asset、QA 和 closeout。
- 为富视觉 UI 增加 `asset-manifest.json` 模板、schema 和 validator 校验。
- 增加 deterministic asset helper，至少覆盖尺寸检查、alpha 检查、preview sheet
  和 package hygiene。
- 明确“full-screen mock is visual truth, not a sprite sheet”。
- 让 Product Design image-to-code 的资产盘点要求成为本 skill 的硬门禁。
- 让 design package validator 忽略可重建前端依赖和缓存目录。
- 要求 rendered QA evidence：desktop/mobile screenshots、source-vs-implementation
  comparison、`design-qa.md`、completed `visual-fidelity-checklist.md`。
- 保持 `docs/designs/` 和 `docs/superpowers/` 的职责边界：设计包放视觉源，
  spec/plan/archive/problem/inbox 放工程复利资产。

## Non-Goals

- 不重写 Product Design 插件，不复制它的视觉 ideation/image-to-code/QA 细节。
- 不强制所有 UI 包都生成 bitmap assets。简单纯组件 UI 可以声明
  `asset_strategy: none`。
- 不要求 hook 自动生成设计包或自动调用 ImageGen。
- 不把 `docs/designs/` 变成 Superpowers archive 目录。
- 不把 `node_modules/`、`.npm-cache/`、`dist/` 作为 durable design package 资产。

## Proposed Workflow

### 1. Brief Gate

Skill 必须先播放简短 brief：

- product or feature name
- target surface
- intended user and primary job
- visual references / desired style
- platform constraints
- interaction level
- prototype mode: `reference` or `production`

如果上下文已经足够，播放 brief 而不是继续追问。

Required output:

- `design-brief.md` 初稿或明确 brief notes
- package slug
- prototype mode

### 2. Visual Iteration Gate

每一轮视觉生成必须保存到：

```text
docs/designs/<slug>/assets/generated-options/
```

每轮必须更新：

```text
visual-decision-log.md
```

Hard rule:

```text
No explicit user approval, no source image.
No source image, no image-to-code.
```

### 3. Approved Source Gate

批准图固定为：

```text
assets/source/selected-ui-design.png
```

`visual-source.md` 必须使用精确字段：

```text
Approval status: `Approved`
Approval scope: <reference implementation | production implementation | design reference only>
```

Validator 必须检查 exact approval status，模板也必须使用同一格式。

### 4. Asset Inventory Gate

在 image-to-code 之前，agent 必须盘点源图中的视觉资产。

Possible asset categories:

- background / scene / hero media
- material texture
- product/place/person imagery
- thumbnails
- avatars
- illustrations
- transparent decorations
- non-standard icons or logos
- note/card/paper surfaces

Rich UI package 必须生成：

```text
asset-manifest.json
```

Minimum schema:

```json
{
  "design_slug": "example",
  "source_image": "assets/source/selected-ui-design.png",
  "asset_strategy": "atomic-generated-assets",
  "assets": [
    {
      "id": "asset-id",
      "role": "what this asset is for",
      "target_region": "component or layout region",
      "display_intent": "how it should render",
      "target_size": "WIDTHxHEIGHT",
      "final_path": "assets/component-assets/asset.png",
      "prototype_path": "prototype/src/assets/generated/asset.png",
      "transparent": false,
      "validation": "pending|pass|blocked"
    }
  ]
}
```

Simple UI package may declare:

```json
{
  "asset_strategy": "none",
  "reason": "UI uses standard controls and icon library only."
}
```

Hard rule:

```text
If the approved source depends on bitmap textures/photos/decorations,
no asset-manifest.json means no image-to-code.
```

### 5. Atomic Asset Gate

The approved source image is not a sprite sheet.

Allowed:

- use source image for visual comparison
- measure layout, colors, density, and asset inventory
- generate independent assets matching the same art direction
- process assets locally into engineering dimensions

Forbidden:

- crop final runtime assets directly from the full-screen mock
- use the full source image as a live app background
- leave assets only under `$CODEX_HOME/generated_images`
- replace required bitmap assets with CSS art, div art, handcrafted SVG, emoji,
  or placeholder boxes

Recommended package convention:

```text
assets/component-assets/
assets/component-assets/raw/
assets/component-assets/preview/
prototype/src/assets/generated/
```

`assets/components/asset-samples/` from the morning journal test can remain
accepted as a legacy/experimental name, but the optimized skill should standardize
on `assets/component-assets/`.

### 6. Asset Helper Script

Add either `scripts/design_assets.py` or `design_package.py assets <command>`.

Required commands:

```text
assets check
assets preview
```

Useful commands:

```text
assets init
assets resize-cover
assets resize-contain
assets chroma-key
assets copy-to-prototype
```

`assets check` must verify:

- every manifest `final_path` exists
- every manifest `prototype_path` exists or is marked not required
- final dimensions match `target_size`
- transparent assets contain alpha
- paths stay inside the design package
- no durable asset path points to `$CODEX_HOME/generated_images`
- no required asset is only present in chat history

`assets preview` should generate a contact sheet for human inspection.

### 7. Prototype Gate

Prototype default target remains:

```text
docs/designs/<slug>/prototype/
```

Prototype rules:

- use React/CSS/components for real UI text, controls, states, and layout
- use `asset-manifest.json` for bitmap assets
- use `design-tokens.json` or generated CSS variables for tokens
- do not use `assets/source/selected-ui-design.png` as runtime material
- implement expected states before handoff
- run build before screenshot QA

Package hygiene:

- `node_modules/` must not be required for package validation
- `.npm-cache/` must not live inside durable package assets
- `dist/` is build output and should be ignored by link validator unless
  explicitly included as deployment evidence

### 8. Rendered QA Gate

Before handoff, package must include:

```text
assets/screenshots/implementation-desktop.png
assets/screenshots/implementation-mobile.png
assets/screenshots/qa-comparison-desktop.png
design-qa.md
visual-fidelity-checklist.md
```

`design-qa.md` must include:

- source visual truth path
- implementation screenshot path
- viewport and state
- full-view comparison evidence
- focused comparison evidence or reason not needed
- required fidelity surfaces
- patches made during QA
- `final result: passed|blocked`

Hard rule:

```text
No source-vs-implementation comparison evidence, no QA pass.
No design-qa.md with final result passed, no handoff.
```

### 9. Contracts And Handoff Gate

Only after rendered QA should docs be finalized:

- `START_HERE.md`
- `visual-source.md`
- `design-tokens.json`
- `component-board.md`
- `contracts/`
- `guides/`
- `subagent-task-pack.md`
- `traceability.md`
- `prototype-implementation.md`
- `visual-fidelity-checklist.md`

`subagent-task-pack.md` must state:

- source image is visual reference only
- asset manifest is required context
- runtime assets come from package-local asset paths
- screenshots and checklist are required before DONE
- missing visual detail protocol

### 10. Closeout Gate

Final response must include an `asset_gate`.

Routes:

- completed UI implementation with matching Superpowers spec/plan -> archive
- design package only, no implementation requirement archive yet -> none or inbox/update-existing
- workflow gap or skill failure -> inbox/update-existing/problem
- stable root cause and recovery pattern -> problem

The skill should explicitly remind the main agent:

```text
docs/designs/ is the design package.
docs/superpowers/ is the reusable development-history asset system.
Do not confuse the two.
```

## Validator Changes

Extend `design_package.py check` with:

- `asset-manifest.json` presence check for rich asset strategy
- manifest JSON schema check
- manifest path existence check
- target dimension check for final assets
- alpha check for transparent PNG assets
- prototype path locality check
- durable generated image locality check
- `design-qa.md` presence and `final result: passed` check when screenshots exist
- ignore directories:
  - `prototype/node_modules/`
  - `prototype/.npm-cache/`
  - `prototype/dist/`
  - `.vite/`
  - coverage/cache directories

Keep current required checks:

- package path under `docs/designs/`
- required package files
- approved source image
- generated options
- desktop and mobile/narrow/no-color screenshots
- design tokens shape
- markdown local links

## Template Changes

Update templates to include:

- `asset-manifest.json` reference in `START_HERE.md`
- source image not sprite sheet rule in `visual-source.md`
- asset section in `component-board.md`
- asset and QA requirements in `subagent-task-pack.md`
- rendered QA statuses in `visual-fidelity-checklist.md`
- dependency hygiene notes in `prototype-implementation.md`
- traceability rows for assets, screenshots, comparison image, and QA report
- implementation readiness guide with explicit pre/post implementation states

Add new reference:

```text
references/asset-manifest-schema.md
```

## Test Strategy

Because this is a skill change, testing follows documentation TDD principles.

### RED Cases To Preserve

Use morning journal as the concrete baseline failure:

- agent tries to crop final runtime assets from a full mock
- package lacks `asset-manifest.json`
- package leaves generated assets outside `docs/designs/<slug>/`
- package validates despite missing component asset dimensions
- package validator scans `prototype/node_modules/` and reports third-party README dead links
- package claims fidelity with screenshots but no source-vs-implementation comparison or QA report

### Unit Tests

Add tests in `plugins/superpowers-asset-compounding/tests/test_asset_scripts.py`:

- `create` emits `asset-manifest.json` template or clear `asset_strategy: none`
- `check` fails rich package with missing manifest
- `check` fails missing manifest final path
- `check` fails dimension mismatch
- `check` fails transparent asset without alpha
- `check` ignores `prototype/node_modules/`, `.npm-cache/`, and `dist`
- `check` fails missing `design-qa.md` when screenshots exist
- `check` passes a minimal valid rich package with source image, generated option,
  manifest assets, screenshots, QA report, checklist, and tokens

### Skill Pressure Tests

Use at least three pressure scenarios before editing the skill body:

1. **Sunk cost pressure**: source mock already looks good; agent is tempted to
   code immediately. Expected behavior: stop for asset inventory.
2. **Shortcut pressure**: user says "just crop it, good enough". Expected
   behavior: explain why final runtime assets cannot be cropped from full mock
   and propose atomic asset generation.
3. **Handoff pressure**: screenshots exist but no comparison/QA report.
   Expected behavior: refuse handoff until rendered QA gate is complete.

## Acceptance Criteria

- `create-ui-design-package` skill document contains explicit staged gates for
  brief, visual iteration, approved source, asset inventory, atomic assets,
  prototype, rendered QA, contracts, and closeout.
- Templates and task pack make asset manifest and QA evidence unavoidable for
  rich UI packages.
- Validator passes the existing smoke package and fails the new negative cases.
- Validator no longer reports third-party README dead links from generated
  frontend dependency/cache/build directories.
- Morning journal package remains valid after migration or compatibility handling.
- Existing Superpowers archive/problem/inbox flow remains unchanged outside
  design package integration points.

## Migration And Compatibility

Existing packages without manifest should not be silently declared complete.

Compatibility path:

- packages with no bitmap assets may add `asset_strategy: none`
- packages with bitmap assets should add `asset-manifest.json`
- legacy `assets/components/asset-samples/` remains accepted during migration
- new packages should use `assets/component-assets/`

## Open Questions

- Should `design_package.py check` require `design-qa.md` only after prototype
  exists, or always for final package status?
- Should asset helper commands live in a new `design_assets.py`, or as subcommands
  under `design_package.py assets ...`?
- Should `asset_strategy` live in `asset-manifest.json` only, or also be echoed
  in `START_HERE.md` for human scanning?

## Recommended Implementation Slices

1. **Spec And Test Baseline**
   - add negative tests for manifest absence, dependency directory ignore, and
     QA report requirement
   - confirm current behavior fails
2. **Manifest And Template Gate**
   - add `asset-manifest.json` template/schema
   - update templates and skill hard gates
3. **Validator Hardening**
   - implement manifest checks
   - ignore dependency/cache/build directories
   - require QA report when screenshots exist
4. **Asset Helper**
   - implement asset dimensions/alpha/preview helper
   - add Windows-friendly tests
5. **Morning Journal Compatibility Check**
   - validate current `docs/designs/morning-journal-note-ui`
   - update docs if migration is needed

