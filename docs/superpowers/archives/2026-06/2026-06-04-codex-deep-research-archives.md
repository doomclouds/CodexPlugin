# Codex Deep Research v0

- Date: `2026-06-04`
- Topic slug: `codex-deep-research`
- Status: `Archived`
- Scope: `Plugin`
- Tags: `codex-plugin`, `deep-research`, `workflow`, `runner`, `subagents`

## Summary

本归档记录 `codex-deep-research` v0 的首个可用插件骨架：它把 Codex 中的 dynamic workflow research 设想落到一个可安装的插件、一个可由 skill 启动的 TypeScript runner，以及一套可观察、可取消、可读取报告的运行目录协议。v0 的重点不是完整自动研究质量，而是先把插件入口、异步运行状态、并发/worker 抽象、报告骨架和后续 search/fetch/verify 扩展点打通。

## Delivered Scope

- 新增 `plugins/codex-deep-research` 插件，包含 `.codex-plugin/plugin.json`、README、`skills/deep-research/SKILL.md`、TypeScript runner package 和 dependency-free installed wrapper。
- 将 `codex-deep-research` 加入仓库 marketplace 和根 README，使它可通过 `codex-deep-research@codex-plugin` 被发现和安装。
- 实现 runner CLI：`start`、`run`、`status`、`watch`、`report`、`cancel`、`list`，运行产物默认写入 caller workspace 的 `.codex-deep-research/runs/<run_id>/`。
- 实现 run store、status、events、checkpoint、bounded scheduler、persona/context/prompt primitives、fake worker 和 `codex exec --json` worker。
- 实现 v0 workflow skeleton：规划 scope、写 checkpoint、生成 `report.md`、`report.summary.md`、`report.sources.md`，并提供 source id/status citation verifier。
- 安装后 wrapper 支持无 `dist/`、无 `node_modules/` 的 clean cache 场景下运行 dependency-free 的 `list/status/watch/report/cancel/help`。
- `cancel` 使用 cooperative cancellation：写 marker、更新 status/events，并在 workflow final completion 前保护 `cancelled` 终态不被 `completed` 或 cancellation emit failure 覆盖。
- `watch` 支持持续 tail events，并在 terminal status 后做 final drain，降低漏掉最后事件的风险。

## Out of Scope

- v0 不实现完整 search/fetch/extract/verify pipeline，也不生成机器可读审计文件或 `tasks.jsonl`。
- v0 不支持自定义 `--output`，运行目录固定为 `.codex-deep-research/runs/<run_id>/`。
- v0 不实现 `pipeline` primitive，不提供 claim decision consistency verifier，也不保证每个事实性结论都有真实外部来源引用。
- v0 cooperative cancellation 不负责 kill detached OS process；它只保证 runner 状态和事件语义一致。
- clean installed wrapper 的 `start/run` 仍需要 built runner 或 repository dev dependencies；dependency-free installed commands 只覆盖观察和管理类命令。

## Verification Snapshot

- Task-level subagent workflow：8 个实现任务均经过实现子代理、规格复审子代理和代码质量复审子代理；最终全分支回归审查返回 `Approved` / `No blocking findings`。
- Final tests：`npm test` 通过，`12` test files / `71` tests passed。
- TypeScript checks：`npm run typecheck` 通过，exit 0。
- Build：`npm run build` 通过，exit 0。
- Source development smoke：`npm --prefix plugins\codex-deep-research run dev -- list` 通过，当前无 runs，输出为空。
- Installed wrapper smoke：`node plugins\codex-deep-research\scripts\run.mjs list` 和 `node plugins\codex-deep-research\scripts\run.mjs --help` 均通过。
- Clean tracked-copy smoke：`installed-runner.test.ts` 覆盖仅跟踪文件副本、显式无 `dist/` 和无 `node_modules/` 的 wrapper 场景。
- Git hygiene：`git diff --check c66db1d...HEAD` 通过；feature worktree `git status --short --branch` 仅显示 `## feature/codex-deep-research-v0`。

## Source Documents

- Spec: [Codex Deep Research 设计](../../specs/2026-06-04-codex-deep-research-design.md)
- Visual: None found for this topic.
- Plan: [Codex Deep Research Implementation Plan](../../plans/2026-06-04-codex-deep-research-implementation-plan.md)

## Related Problems

- [PostCompact Hook Output Schema Problem](../../problems/2026-06/2026-06-02-postcompact-hook-output-schema-problem.md)
- [Stop Plan Boundary Closeout Noise Problem](../../problems/2026-06/2026-06-03-stop-plan-boundary-closeout-noise-problem.md)
- [Subagent Lifecycle Asset Protocol Conflict Problem](../../problems/2026-06/2026-06-03-subagent-lifecycle-asset-protocol-conflict-problem.md)

## Notes

- 本次开发严格在 `.worktrees/codex-deep-research-v0` 隔离工作区完成；没有 push。
- 评审中多次发现“文档承诺超过 v0 实现”的问题，因此 archive 明确记录 v0 边界，避免后续把完整 deep research 能力误认为已经交付。
