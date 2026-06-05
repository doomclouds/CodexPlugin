# Codex Deep Research Windows CLI Packaging

- Date: `2026-06-04`
- Topic slug: `codex-deep-research-windows-cli-packaging`
- Status: `Archived`
- Scope: `Plugin`
- Tags: `codex-plugin`, `deep-research`, `windows-cli`, `packaging`

## Summary

本归档记录 `codex-deep-research` 从插件内 TypeScript runner 迁移为仓库级源码工程和插件内预构建 Windows CLI 的交付。目标是让安装后的插件可以直接运行 deep research runner，避免每个客户端在插件 cache 中再执行 `npm install` 或 TypeScript build。

## Delivered Scope

- 将 TypeScript runner package、测试和构建配置从 `plugins/codex-deep-research` 移到 `src/codex-deep-research`。
- 新增 `src/codex-deep-research/scripts/build-windows-cli.mjs`，用 esbuild 生成 `plugins/codex-deep-research/bin/codex-deep-research.mjs` 和 `codex-deep-research.cmd`。
- 更新 `deep-research` skill 和 README，使安装后入口统一为 `bin\codex-deep-research.cmd`。
- 更新 installed-runner 测试，覆盖无 `dist`、无 `node_modules` 的干净插件副本，并验证 `.cmd` help 入口。

## Out of Scope

- 本次只交付 Windows CLI shim；Linux/macOS shell shim 和 native executable packaging 暂不做。
- 本次不扩展 deep research 的 search/fetch/verify 能力，只调整安装包运行方式。
- 本次不改变 Codex marketplace 安装/升级协议。

## Verification Snapshot

- `npm --prefix src\codex-deep-research test` 通过，`12` test files / `72` tests passed。
- `npm --prefix src\codex-deep-research run typecheck` 通过，exit 0。
- `npm --prefix src\codex-deep-research run build` 通过，生成插件内 `bin` CLI。
- `node plugins\codex-deep-research\bin\codex-deep-research.mjs --help` 通过。
- `plugins\codex-deep-research\bin\codex-deep-research.cmd --help` 和 `list` 通过。
- `git diff --check` 通过，只有 Windows 换行提示。

## Source Documents

- Spec: [Codex Deep Research 设计](../../specs/2026-06-04-codex-deep-research-design.md)
- Visual: None found for this topic.
- Plan: [Codex Deep Research Implementation Plan](../../plans/2026-06-04-codex-deep-research-implementation-plan.md)

## Related Problems

- None.

## Notes

- 打包过程中发现并修复两个可复现问题：重复 shebang 会导致 `.mjs` 语法错误；ESM bundle 打入 CJS 依赖时需要通过 `createRequire` 支持动态 require Node 内置模块。
