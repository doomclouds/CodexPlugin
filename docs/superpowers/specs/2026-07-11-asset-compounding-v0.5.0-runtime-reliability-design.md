# Superpowers Asset Compounding v0.5.0 Runtime Reliability Design

- Date: 2026-07-11
- Topic slug: asset-compounding-v0.5.0-runtime-reliability
- Status: Approved
- Scope: plugins/superpowers-asset-compounding

## 目标

将 superpowers-asset-compounding 从“能力完整但运行语义有盲点”收敛为可靠性基线。v0.5.0 只修复真实审计已经证明的状态、会话归档、验证结果、Stop 门限、平台启动和审计归因问题；不新增资产类型、路由枚举或 UI workflow。

## 已确认事实

| 观察 | 结论 |
| --- | --- |
| 556 条事件无 JSONL 损坏，Hook 内部 p95 为 18ms | 保留 JSONL 格式，不做全量审计重构。 |
| state.json 是无锁 read-modify-write | 状态更新必须成为一次加锁事务。 |
| report 以 state.json 是否存在判断 current | state 必须显式记录会话 closed 生命周期。 |
| 23 次验证全为 observed | 退出码必须适配嵌套和规范文本工具响应。 |
| Stop 在 no-work 之前校验 gate | Stop 必须先判断 hard closeout work。 |
| cleanup 文本关键词会误放行 | 删除非结构化 cleanup auto-allow。 |
| Windows launcher 中位约 526ms，事件无版本字段 | Windows 走安全直连快路径，事件写版本与构建指纹。 |
| hooks.json 只有 Windows PowerShell 命令 | 用 command 加 commandWindows 的平台覆盖。 |

## 设计

### 状态事务与会话生命周期

- 新增 state_transaction(event) 上下文，覆盖完整的 load、mutate、atomic replace。
- 锁文件沿用 JSONL 的跨平台文件锁；写入在同目录临时文件完成后使用 os.replace。
- 新 state 使用 schemaVersion 2，新增 lifecycle: active 或 closed、closedAtUtc、pluginVersion、pluginFingerprint。
- SessionStart 和 PostToolUse 将 closed state 重开；所有允许结束的 Stop 分支关闭 state。
- report 只把 lifecycle 为 closed 的 state 视为可归档。缺少 lifecycle 的历史 state 保守视为 current，不自动移动。

### 验证结果正规化

- extract_exit_code 支持顶层、嵌套 mapping/list 和严格行级 Exit code: 整数或 Return code: 整数。
- 状态为 passed、failed、observed；observed 使用 verification-observed signal，不再冒充完整验证。
- 事件仅保存 exitCode、exitCodeSource、响应形态标签，不保存原始 response、工具输出、提示或完整命令。

### Stop 门限

- Stop 先计算 has_stop_closeout_work；没有 hard work 直接允许，即使最后消息有残缺 asset_gate。
- event_type、route、reason、evidence 永远强制。
- related_assets、asset_candidates、deferred_signals、next_step 只在 Stop 中允许默认 none，并记录 defaultedFields。
- check_completion_gate.py 的显式 require-asset-gate 仍为严格模式，要求所有字段。
- 删除文字关键词 cleanup 放行。cleanup 必须使用 event_type: cleanup-only 与 route: none 的有效 gate。
- push-only 与 merge-only 保留，但也关闭会话 state。

### 平台启动与审计身份

- hooks.json 使用 POSIX shell launcher 作为 command，Windows cmd launcher 作为 commandWindows。
- Windows cmd 优先运行实际可执行且非 WindowsApps alias 的 Python；找不到时保留 Git Bash 到 shell launcher 的 fallback。
- launcher 传入 ASSET_HOOK_LAUNCHER；事件记录 launcherKind。
- 每条事件追加 pluginVersion 和基于 plugin.json、hooks.json、asset_hook.py 计算的 pluginFingerprint。
- report 聚合版本、构建指纹、launcher、验证状态及 active、closed、legacy 会话数。

## 非目标

- 不自动修复、隔离或删除历史审计数据。
- 不重新引入已撤回的 UI design package。
- 不添加第七个 skill。
- 不把审计事件变成原始日志采集器。

## 兼容性

- v1 events 继续可读，缺少新字段显示为 unknown。
- legacy state 没有 lifecycle 时保持保护，用户仍可用 include-current 显式归档。
- 现有 asset route 值和六个 skill 都不变。

## 验收

1. 并发 state 更新不丢 evidence 或 signal。
2. allow 后 state 关闭，新的 PostToolUse 可重开。
3. 默认 archive 选 closed state，不动 active 和 legacy state。
4. 嵌套和文本退出码能得到 passed 或 failed；未知响应只得到 observed。
5. no-work 加残缺 gate 允许；hard work 缺核心字段仍 block；仅缺辅助字段时 Stop 允许并记 defaultedFields。
6. remove failed; issue unresolved 不会绕过 gate；有效 cleanup-only / none gate 可以关闭。
7. POSIX 与 Windows 都有真实注册命令；Windows 在有真实 Python 时走直连。
8. 事件与 report 能显示版本、指纹、launcher 和验证状态，且不泄漏原始响应。
9. 全量 unittest、manifest JSON、completion gate、diff check 通过，README 和 release assets 同步到 0.5.0。
