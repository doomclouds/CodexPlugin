# Asset Compounding Audit and Closeout v0.3.2

- Date: `2026-06-26`
- Topic slug: `asset-compounding-audit-closeout-v0.3.2`
- Status: `Archived`
- Scope: `Plugin feature release`
- Tags: `asset-compounding`, `hooks`, `audit`, `closeout`, `archive`

## Summary

本次归档收敛了 `superpowers-asset-compounding` 的 v0.3.2 审计与收尾能力：Stop hook 不再把任意 `asset_gate:` 文本当成有效完成信号，而是要求结构化字段齐全；同时为只做 merge 同步、没有编辑和验证痕迹的会话提供低噪音放行路径。配套的审计报表补齐了时间窗、仓库、原因过滤和归档能力，让审计记录能持续沉淀而不是堆在活动目录里。

## Delivered Scope

- Stop hook 在清理 closeout 状态前校验结构化 `asset_gate`，避免无效 handoff 混过最终关口。
- 仅包含 merge 收尾且没有编辑、验证、资产改动、候选信号和验证证据的会话会以 `merge_only_closeout` 自动放行。
- 命令分类覆盖常见 Python、pytest、Vitest、Node 和 PowerShell 读写命令，同时继续只保留脱敏后的种类、哈希和长度。
- `asset_hook_report.py` 支持 `--since`、`--until`、`--repo`、`--reason`、`--active-only`、`--archives-only` 过滤，并输出 session signal summary。
- `asset_hook_report.py archive` 能把符合条件的审计会话移动到 `_archives/<date-range>/<hash>/`，并写出 `manifest.json`。
- 插件 README 与 manifest 已更新到 v0.3.2 发布说明。

## Out of Scope

- 不引入数据库、后台服务或外部索引。
- 不记录原始 prompt、命令文本、diff、命令输出、完整仓库路径或 secrets。
- 不根据 hook 事件自动写入仓库内的 archive/problem/inbox 资产。

## Verification Snapshot

- Focused metadata regression test: OK.
- Asset script unit suite: 111 tests OK.
- Plugin manifest JSON validation: valid.
- Archive asset validator: OK.
- Superpowers index check: OK.
- Whitespace check: passed.

## Source Documents

- Spec: [Asset Compounding Audit and Closeout v0.3.2 Design](../../specs/2026-06-26-asset-compounding-audit-closeout-v0.3.2-design.md)
- Visual: None found for this topic.
- Plan: [Asset Compounding Audit and Closeout v0.3.2 Implementation Plan](../../plans/2026-06-26-asset-compounding-audit-closeout-v0.3.2.md)

## Related Problems

- [Stop Plan Boundary Closeout Noise Problem](../../problems/2026-06/2026-06-03-stop-plan-boundary-closeout-noise-problem.md)
- [WindowsApps Python Alias Hook Hang](../../problems/2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md)

## Notes

- 审计归档目录的身份由已归档文件哈希表的有序摘要决定，因此同一批次内容会得到稳定且可追溯的 dated + content-addressed 路径。
