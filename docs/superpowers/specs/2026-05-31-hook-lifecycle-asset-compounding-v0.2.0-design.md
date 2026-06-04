# Hook 生命周期资产复利 v0.2.0 设计草案

- 日期：`2026-05-31`
- 目标插件：`superpowers-asset-compounding`
- 目标版本：`0.2.0`
- 状态：`Draft`
- 范围：插件 hooks、生命周期状态、Superpowers 工作流集成

## 摘要

`superpowers-asset-compounding` v0.2.0 的目标，是把资产复利从“仓库
`AGENTS.md` 里写一大段提醒”升级成“由 Codex hooks 驱动的生命周期协议”。

当前 v0.1.4 插件已经提供了可用的 skills 和确定性脚本，但工作流仍然依赖主代理主动记得执行
`AGENTS.md` 里的长篇规则。LightRAGNet 最近的开发过程已经暴露了这个弱点：
spec、plan、archive、problem、inbox 和 completion gate 都存在，但当模型专注于代码、测试、
commit、push 时，资产收尾仍然可能被漏掉。

v0.2.0 应通过 Codex hooks 让资产工作更难被忘掉：

- 子代理只上报可复用资产候选，不直接写资产；
- 主代理统一负责 route 判断和资产写入；
- `Stop` 在当前 turn 收尾前做最后门禁；
- `PostToolUse` 根据工具事实更新轻量 session 状态；
- `PreCompact` 和 `PostCompact` 在压缩前后保留 pending 资产信号；
- `AGENTS.md` 只保留仓库级检索锚点，不再承载完整通用资产流程。

## 目标

- 减少对 `AGENTS.md` 长提示词的依赖。
- 在真正需要的时候注入精简、生命周期相关的资产上下文。
- 让子代理稳定输出 `asset_candidates`。
- 防止子代理独立写入或路由 archive/problem/inbox。
- 让主代理在 meaningful closeout 前做一次明确的 `asset_gate` 判断。
- 在上下文压缩前后保存 pending asset candidates。
- 让 hooks 保持确定性、本地化、可审计、可安全信任。
- 在设计确认并实现后，将插件版本从 `0.1.4` 升级到 `0.2.0`。

## 非目标

- hooks 不应静默写入 archive/problem/inbox。
- hooks 不替代现有 writer skills。
- 不依赖 `UserPromptSubmit` 作为资产生命周期主链路。
- 不对每个小改动或闲聊 final 都强制资产门禁。
- 第一阶段不立即删除所有 `AGENTS.md` 资产指导；先验证 hook 行为，再做缩减。
- 在本地实测前，不假设子代理内部工具调用与主代理工具调用触发完全相同的 hooks。

## 当前问题

### 长提示词债务

LightRAGNet 的 `AGENTS.md` 现在包含大量资产复利规则：检索顺序、脚本命令、路由边界、
completion gates、inbox 规则、最终 `asset_gate` 要求等。这些内容能提升召回，但也占用上下文，
并且把流程逻辑塞进了自然语言说明。

### 主代理记忆依赖

当前工作流依赖主代理主动记得：

- 搜索相关资产；
- 运行 `asset_status.py`、`asset_closeout.py` 或 `check_completion_gate.py`；
- 区分 requirement archive 和 problem gate；
- 收集 reviewer/subagent candidates；
- 在 final 里输出可审计的 `asset_gate` block。

即使代码、测试、commit 和 push 都成功，这些动作仍然可能被漏掉。

### 子代理信号丢失

很多可复用信号其实来自子代理：review findings、测试抖动、provider quirks、tool quirks、
可疑竞态、验证异常等。如果子代理最终报告没有输出 `asset_candidates`，主代理很可能根本看不到这些线索。

### Completion gate 语义模糊

`check_completion_gate.py` 通过，只能证明某些结构检查和候选扫描没有报错。它不能替代主代理对
“完整需求是否需要 archive”“同线程失败模式是否需要 problem/inbox”的最终判断。

这个边界应该由生命周期机制兜住，而不是埋在一大段提示词里。

## Hook 策略

v0.2.0 应在插件中内置 `hooks/hooks.json`。如果需要，也可以在 `.codex-plugin/plugin.json`
里显式声明 hook 路径；但 Codex 默认就可以从启用插件的 `hooks/hooks.json` 加载 hooks。

hook 命令使用 Python 脚本，建议结构：

```text
hooks/
  hooks.json
  asset_hook.py
```

`asset_hook.py` 根据输入里的 `hook_event_name` 分发到不同处理逻辑。除非单文件明显过大，否则第一版先保持单文件，
减少插件结构复杂度。

插件 hooks 会收到 `PLUGIN_ROOT` 和 `PLUGIN_DATA`。运行时状态应写入 `PLUGIN_DATA`，不要直接写仓库文件。
只有主代理明确调用 writer skills 时，才写入仓库内的 Superpowers 资产。

## 生命周期设计

### SessionStart

用途：在 session/start/resume 时注入一次极短的资产协议入口。

行为：

- 检测当前 repo 是否存在 `docs/superpowers`。
- 如果不存在，不做任何事。
- 如果存在，追加简短 developer context：
  - 当前仓库启用了 hook-assisted asset compounding；
  - 子代理只上报候选，主代理负责判断和写入；
  - meaningful closeout 需要显式 `asset_gate`。

这一层用于替代长期常驻的超长 `AGENTS.md` 通用资产规则。

### SubagentStart

用途：告诉子代理如何上报资产信号。

行为：

- 给子代理注入精简的子代理专用协议。
- 要求子代理最终 handoff 必须包含：

```text
asset_candidates:
  - none
```

或一组具体候选。

对子代理的约束：

- 不直接写 archive/problem/inbox。
- 不做 route 决策，除非主代理明确委托。
- 不修改 `docs/superpowers`，除非主代理明确委托它执行资产写入任务。
- 将证据、症状、失败尝试、review findings、tool quirks 等作为 candidates 上报。

### SubagentStop

用途：校验并收集子代理 candidates。

行为：

- 读取 `last_assistant_message`。
- 如果包含 `asset_candidates`，解析并存入 `PLUGIN_DATA`。
- 如果缺少 `asset_candidates`，并且子代理看起来执行了实现、审查、调试或验证工作，则要求子代理继续一轮补 handoff。
- 如果 `stop_hook_active=true`，不再继续，防止无限循环。

否定模式：

- 不做 route 判断。
- 不写 archive/problem/inbox。
- 不运行主代理 closeout。
- 不触发 git/final-response enforcement。

待实测项：

- 当前 Codex build 中，子代理内部普通工具调用是否会触发 `PreToolUse`、`PostToolUse` 或 `Stop`。
- 如果会触发，这些 handler 必须识别子代理上下文，并切换为 no-op 或子代理专用行为。

### PostToolUse

用途：根据真实工具事件更新生命周期状态。

第一版支持的信号：

- `apply_patch`：记录本 turn 发生了文件编辑。
- shell 命令包含 `dotnet test`、`npm test`、`npm run build`、`dotnet build` 等：记录验证证据。
- shell 命令包含 `git commit`、`git push`、`git merge` 或 PR 相关命令：标记接近 closeout 边界。
- 工具结果涉及 `docs/superpowers`：标记资产文件发生变化。

行为：

- 在 `PLUGIN_DATA` 中写入紧凑 JSON 状态。
- 只有 closeout-sensitive 信号才追加额外上下文。
- 不尝试撤销已经执行的工具副作用。
- 不把它当成完整 enforcement 边界，因为当前 Codex hooks 对 shell/unified exec 的覆盖可能并不完整。

### Stop

用途：当前 turn 结束前的最终收口门禁。

行为：

- 读取插件状态和 `last_assistant_message`。
- 如果本 turn 看起来做了 meaningful development，但 final response 缺少 `asset_gate:`，则要求 Codex 自动继续一轮。
- 如果 `stop_hook_active=true`，不再继续，只给出 warning/context，避免循环。
- 如果只是闲聊、只读查询或低价值 cleanup，允许正常结束。

自动续跑提示词草案：

```text
Run the asset-compounding closeout gate for this turn. Include an auditable
asset_gate block with event_type, route, reason, evidence, related_assets,
asset_candidates, deferred_signals, and next_step. If no asset is needed,
choose route: none and give the concrete reason.
```

注意：`Stop` 不是“需求完成”的语义事件。它只表示当前 Codex turn 准备结束。hook 必须基于累计状态和 final 消息内容判断，
不能假设业务任务一定完成。

### PreCompact

用途：上下文压缩前保存 pending asset state。

行为：

- 如果存在 pending subagent candidates 或 closeout signals，将紧凑状态快照写入 `PLUGIN_DATA`。
- 如果压缩发生时仍有未处理 candidates，追加短 `systemMessage`。

### PostCompact

用途：上下文压缩后恢复精简资产上下文。

行为：

- 如果存在 pending 快照，注入短提醒：
  - pending candidates 数量；
  - 是否检测到 meaningful work；
  - 推荐下一步 gate 命令。
- 不注入完整资产策略。

### UserPromptSubmit

默认资产行为：禁用。

原因：

`UserPromptSubmit` 每次用户提交 prompt 都会触发，更适合做用户输入审查或风险判断，不适合作为资产生命周期主链路。
资产复利应该由工作流事件和工具事实驱动，而不是依赖自然语言关键词匹配。

未来可选用途：

- 对“跳过验证”“跳过资产归档”等危险请求给出风险提示；
- 检测误粘贴 secret；
- 做安全审查。

它不进入主资产 route。

## 状态模型

状态按 `session_id` 和可用的 `turn_id` 进行作用域隔离。

草案结构：

```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "turnId": "...",
  "cwd": "...",
  "repoHasSuperpowersAssets": true,
  "meaningfulWorkSignals": [
    "edited-files",
    "verification-ran",
    "git-closeout"
  ],
  "verificationEvidence": [
    {
      "command": "dotnet test ...",
      "status": "observed",
      "summary": "tool output observed"
    }
  ],
  "subagentCandidates": [
    {
      "agentId": "...",
      "agentType": "...",
      "candidate": "..."
    }
  ],
  "assetFilesChanged": false,
  "stopContinuationUsed": false,
  "subagentContinuationUsed": {
    "agent-id": true
  }
}
```

hook 只保存紧凑摘要，不保存 secrets、大段命令输出、完整 transcript 或完整 diff。

## 主代理 closeout 合约

最终 route 仍由主代理负责。

meaningful work 的 final response 需要包含：

```text
asset_gate:
  event_type: implementation-boundary | requirement-archive | bugfix-root-cause | user-validation-feedback | ci-release-feedback | post-release-warning | cleanup-only
  route: none | inbox | update-existing | archive | new-problem | both
  reason: <one concrete sentence>
  evidence: <commands, review, user feedback, or script result>
  related_assets: <none or paths>
  asset_candidates: <none or collected candidates>
  deferred_signals: <none or revisit signals>
  next_step: <none or writer skill/script>
```

如果 route 不是 `none`，主代理应继续使用现有 skills 和脚本：

- `compound-development-asset`：搜索相关资产并辅助 route；
- `archive-superpowers-feature`：写 requirement archives；
- `write-superpowers-problem`：写 inbox/problem assets；
- 写入后运行现有验证脚本。

## AGENTS.md 缩减策略

v0.2.0 hooks 验证可用后，仓库 `AGENTS.md` 应只保留仓库级锚点：

- asset root 路径；
- 检索目录；
- 脚本无法推断的 repo-specific warnings。

通用资产工作流规则应回到插件 hook context 和 skill docs 中。

不要第一阶段立刻删除大段规则。先发布 hooks，在 LightRAGNet 上验证行为，再单独做一次 cleanup 缩减。

## 第一阶段实现切片

1. 新增插件内置 `hooks/hooks.json`。
2. 新增 `hooks/asset_hook.py`，支持：
   - `SessionStart`;
   - `SubagentStart`;
   - `SubagentStop`;
   - `PostToolUse`;
   - `Stop`;
   - `PreCompact`;
   - `PostCompact`。
3. 为 hook 输入/输出行为补单元测试。
4. 增加 `/hooks` trust review 的本地集成说明。
5. 将插件版本从 `0.1.4` bump 到 `0.2.0`。
6. 同步 local plugin cache。
7. 验证 source 和 cache 插件。

## 验证计划

最低验证：

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest discover -s tests
python <develop-local-codex-plugin>\scripts\sync_local_plugin_cache.py superpowers-asset-compounding
python <develop-local-codex-plugin>\scripts\validate_local_plugin.py superpowers-asset-compounding
```

手动验证：

- 使用 `/hooks` review 并 trust 插件内置 hooks。
- 启动一个小型子代理任务，确认 `SubagentStart` 注入了上报协议。
- 确认子代理缺少 `asset_candidates` 时，`SubagentStop` 最多要求继续一轮。
- 确认主代理执行 meaningful work 且 final 缺少 `asset_gate` 时，`Stop` 最多续跑一轮。
- 确认 `stop_hook_active=true` 能防止无限续跑。
- 确认闲聊、只读查询或 no-op 工作不会强制 asset closeout。

## 待确认问题

- 当前 Codex build 中，普通 tool hooks 是否会在子代理内部执行。
- 当前 Windows Codex build 中，unified exec 路径上报的 tool name 具体是什么。
- `PostToolUse` 第一版是否只记录 closeout-sensitive shell commands，还是也记录每个编辑路径用于 route suggestion。
- `Stop` 要求 `asset_gate` 的条件，是只看实现文件变化，还是 docs/specs/plans 变化也算。
- v0.2.0 是否同 PR 缩减 LightRAGNet `AGENTS.md`，还是等 hook 验证后再做 follow-up cleanup。

## 验收标准

- 子代理能稳定收到精简资产上报协议。
- 子代理 final 缺少 `asset_candidates` 时，最多被要求继续一次。
- 子代理候选会存给主代理，不会直接写资产。
- 主代理 meaningful closeout 缺少 `asset_gate` 时，最多被要求继续一次。
- hook state 能通过 compact summary 在压缩前后保留。
- `UserPromptSubmit` 不参与资产生命周期主链路。
- 版本 bump 和 cache sync 后，插件验证通过。
- 设计支持后续减少 `AGENTS.md` 中的通用资产策略内容。
