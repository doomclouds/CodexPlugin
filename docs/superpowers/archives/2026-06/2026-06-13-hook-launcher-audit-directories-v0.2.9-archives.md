# Hook Launcher Audit Directories v0.2.9

- Date: `2026-06-13`
- Topic slug: `hook-launcher-audit-directories-v0.2.9`
- Status: `Archived`
- Scope: `Feature`
- Tags: `asset-compounding`, `hook`, `launcher`, `audit`, `windows`

## Summary

本次交付修复 `superpowers-asset-compounding` hook 启动链路对裸 `python` 的依赖，并把审计目录从纯 session id 改成 `<project>--<session-id>`，让卡住或排障时能先看出是哪一个项目的 hook 记录。

## Delivered Scope

- `hooks.json` 不再直接执行裸 `python -c ...`，统一进入插件自带 launcher。
- 新增 `run_asset_hook.cmd` 和 `run_asset_hook.sh`：Windows 入口查找 Git Bash，shell 入口跳过 WindowsApps Python alias 后再执行 `asset_hook.py`。
- `state_path()` 改为使用 `<project>--<session-id>` 审计目录，`events.jsonl` 和 `state.json` 共享同一命名契约。
- 测试覆盖 hook 配置禁止裸解释器命令、launcher 文件存在、审计目录命名，以及旧 hook 状态测试的目录契约迁移。
- 插件 manifest 与 README 升级到 `0.2.9`，说明 launcher 和审计目录行为。

## Out of Scope

- 未在本轮更新本机已安装插件 cache；插件商城快照依赖远程仓库，本次按源码提交后再升级插件的顺序处理。
- 未迁移历史纯 session id 审计目录；`asset_hook_report.py` 继续通过递归扫描兼容旧目录。
- 未改变 Stop gate、plan-boundary 或 archive/problem 路由语义。

## Verification Snapshot

- RED: `test_hook_config_uses_launcher_instead_of_naked_interpreter` 先失败于 launcher 文件不存在。
- RED: `test_hook_state_directory_includes_project_name_and_session_id` 先失败于仍写入纯 `session-1` 目录。
- GREEN: `python -m unittest plugins.superpowers-asset-compounding.tests.test_asset_scripts` 通过，`Ran 57 tests ... OK`。
- Launcher smoke: `run_asset_hook.cmd` 在 Windows 上经 Git Bash 调用 `run_asset_hook.sh`，并能把 `SessionStart` JSON stdin 传入 `asset_hook.py` 返回 expected context。
- Auto Python smoke: 不设置 `CODEX_ASSET_PYTHON` 时，launcher 能避开 WindowsApps alias 并找到真实 Python 解释器。
- `git diff --check` 未报告空白错误，仅提示本机 LF/CRLF 换行提醒。

## Source Documents

- Spec: None found for this topic.
- Visual: None found for this topic.
- Plan: None found for this topic.

## Related Problems

- [WindowsApps Python Alias Hook Hang](../../problems/2026-06/2026-06-13-windowsapps-python-alias-hook-hang-problem.md)

## Notes

- 这轮来自真实 OpenHarnessTS/CodexPlugin hook 卡住排障：审计事件显示 hook 内部耗时正常，但残留进程卡在 `python` 启动层，说明需要修 launcher 而不是调 JSONL 锁。
