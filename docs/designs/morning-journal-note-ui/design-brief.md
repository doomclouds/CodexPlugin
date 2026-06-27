# Morning Journal Note UI Design Brief

- Design slug: `morning-journal-note-ui`
- Package mode: `new`
- Source package: `none`
- Date: `2026-06-27`

## Product Or Feature

绚丽、有美感、有个人记忆感的晨间日记笔记 UI，用于验证
`create-ui-design-package` 技能是否能完整支撑“视觉探索 -> 用户批准源图 ->
React 参考原型 -> 截图验收 -> token/contract/subagent 交付包”的流程。

## Primary job

让用户在清晨快速进入专注记录状态，完成当天的自由书写、意图设定、
感恩/优先事项记录，并保留轻量的历史入口。

## Target Surface

React Web 桌面优先界面，后续需要有窄屏响应式参考。

## Platform constraints

- Framework target: React reference prototype.
- Package target: `docs/designs/morning-journal-note-ui/prototype/`.
- Desktop-first, with one mobile/narrow QA screenshot required before final handoff.
- Emotional notebook style: colorful, immersive, textured, personal, and capable
  of making the user want to enter a writing flow.
- Avoid the flat gray-white SaaS/admin feeling seen in the first generated round.
- No marketing hero, no generic dashboard, no plain Notion-template treatment.
- This test package should expose skill workflow issues instead of hiding them in
  production app integration.

## Target User

重视晨间节奏和长期复盘的个人用户。用户需要低干扰地记录当天想法，
同时能轻触式完成 mood/energy、intention、gratitude、priorities 等结构化输入。

## Visual references

- Initial style choice from user: Option 1, quiet premium direction.
- Revision feedback from user: first generated contact sheet felt too simple,
  flat, ugly, and not emotionally compelling enough for diary writing.
- Revised direction: surprising beauty, colorful personal memory, and flow-state
  enjoyment.
- Generated exploration contact sheet:
  `assets/generated-options/v1-contact-sheet.png`.
- Product Design revised options:
  - `assets/generated-options/v2-option-01-dawn-atelier.png`
  - `assets/generated-options/v2-option-02-chromatic-memory-book.png`
  - `assets/generated-options/v2-option-03-flow-aurora-journal.png`
- Internal comparison:
  - Option A: cleanest writing-focused layout.
  - Option B: strongest balance of writing and morning check-in.
  - Option C: most complete workspace layout.
- Final user direction: combine option 3's implementation-friendly overall
  layout with option 1's richer emotional visual feeling.
- Approved source image:
  `assets/source/selected-ui-design.png`.
- Generated implementation assets:
  `asset-manifest.json` and `assets/components/asset-samples/`.

## Interaction level

Reference prototype. The prototype should be interactive enough to validate layout,
responsive behavior, basic input states, and visual fidelity, but should not become
production application code.

## Prototype mode

`reference`
