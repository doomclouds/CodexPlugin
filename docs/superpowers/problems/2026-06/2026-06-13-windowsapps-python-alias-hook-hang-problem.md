# WindowsApps Python Alias Hook Hang

- Date: `2026-06-13`
- Topic slug: `windowsapps-python-alias-hook-hang`
- Status: `Captured`
- Scope: `Environment`
- Tags: `hooks`, `windows`, `python`, `launcher`, `asset-compounding`

## Symptom

Codex 工具调用结束后一直停在 `Running PostToolUse hook: Recording asset closeout signals`，用户多次中断后仍会出现新的卡住 hook 进程。审计目录中能看到历史 `PostToolUse` 事件通常只有几毫秒，但当前卡住的进程没有写入对应完成事件。

## Trigger / Context

- 插件 hook command 使用裸 `python -c "...asset_hook.py..."`。
- Windows PATH 中 `python` 首位解析到 `C:\Users\10062\AppData\Local\Microsoft\WindowsApps\python.exe`。
- hook runner 在 Windows 上通过 PowerShell 启动命令，残留进程显示 WindowsApps Python alias 参与启动，部分命令行甚至出现 alias 被二次包装的形态。

## Root Cause

卡住发生在 `asset_hook.py` 业务逻辑之前，而不是 `events.jsonl` 文件锁内部。裸 `python` 在 Windows 上命中 WindowsApps alias / launcher 层，导致 hook 进程无法稳定进入脚本；因此 `stdin_timeout` 和 JSONL lock 超时都没有机会记录失败事件。

## Fix

- 将 `hooks.json` 从裸 `python -c ...` 改为插件自带 launcher。
- Windows 第一跳使用 `run_asset_hook.cmd` 查找 Git Bash，避免误用 WSL bash 或系统别名。
- 统一 shell 入口 `run_asset_hook.sh` 查找真实 Python，并跳过 WindowsApps Python alias。
- 加测试禁止 hook 配置中回归裸 `python`、`py`、`bash`、`node`、`npm` 命令。

## Why This Fix

只调大 `asset_hook.py` 的 stdin 或 lock 超时无法覆盖“脚本根本没有稳定启动”的故障层。把解释器解析前移到插件自带 launcher，并对 WindowsApps alias 做显式排除，可以在 hook 进入业务逻辑之前消除不稳定依赖；保留 `.sh` 作为统一执行入口也让 Linux/Git Bash 路径共享同一套 Python 选择规则。

## Recognition Clues

- `events.jsonl` 中已完成 hook 的 `durationMs` 很小，但当前 UI 仍卡在 hook status message。
- 进程列表中有残留 `asset_hook.py` 相关 `powershell.exe` / `python.exe`，命令行指向 `Microsoft\WindowsApps\python.exe`。
- 使用真实 Python 路径运行 `asset_hook_report.py` 秒回，而裸 `python` 或 `py` 探测卡住。
- 没有 `HookInput stdin_timeout` 事件，说明失败点早于脚本内 stdin 超时逻辑。

## Applicability / Non-Applicability

### Applies When

- Windows hook command 使用裸解释器名，且 PATH 里可能存在 WindowsApps alias、WSL shim、Store launcher 或其他 wrapper。
- hook 卡在 status message，但审计事件没有对应失败记录。
- 真实解释器路径可以正常运行同一 Python 脚本。

### Does Not Apply When

- `events.jsonl` 出现坏 JSONL 行或并发追加碎片；那属于 JSONL 写入锁问题。
- `asset_hook.py` 已记录 `stdin_timeout`、`invalid_json` 或明确异常事件；那说明脚本已经启动，应沿脚本内路径排查。
- Linux/macOS 上 `python` 解析到稳定虚拟环境或系统解释器，且无 alias/wrapper 参与。

## Related Artifacts

- Spec: `None yet.`
- Plan: `None yet.`
- Archive: [Hook Launcher Audit Directories v0.2.9](../../archives/2026-06/2026-06-13-hook-launcher-audit-directories-v0.2.9-archives.md)
- Related Problems:
  - [JSONL Hook Event Concurrent Append Corruption](./2026-06-06-jsonl-hook-event-concurrent-append-corruption-problem.md)
- Code or Test:
  - [hooks.json](../../../../plugins/superpowers-asset-compounding/hooks/hooks.json)
  - [run_asset_hook.cmd](../../../../plugins/superpowers-asset-compounding/hooks/run_asset_hook.cmd)
  - [run_asset_hook.sh](../../../../plugins/superpowers-asset-compounding/hooks/run_asset_hook.sh)
  - [asset_hook.py](../../../../plugins/superpowers-asset-compounding/hooks/asset_hook.py)
  - [test_asset_scripts.py](../../../../plugins/superpowers-asset-compounding/tests/test_asset_scripts.py)
