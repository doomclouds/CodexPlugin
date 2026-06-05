# Codex Deep Research M1 设计

- 日期：`2026-06-05`
- 目标插件：`codex-deep-research`
- 目标版本：`0.2.0`
- 状态：`Accepted`
- 范围：真实研究闭环、来源/claim/投票状态文件、引用报告、Windows 可观察窗口

## 背景

v0 已经交付 CLI、运行目录、`start/status/watch/report/cancel/list` 和可安装 Windows CLI，但真实运行结果仍然只生成 scope/search angles，没有收集来源，也没有抽取、验证和带引用的报告。M1 的目标是把插件从 research planner 提升为可用的 deep research runner。

## 目标

- `start` 后 runner 必须执行 `planning -> searching -> collecting -> extracting -> cross_checking -> voting -> synthesizing -> verifying -> completed`。
- 研究过程必须写出机器可读文件：`sources.jsonl`、`claims.jsonl`、`votes.jsonl`、`decisions.jsonl`。
- `status` 和 `watch` 必须能看到每个阶段的 queued/running/completed 变化，以及 agent role/persona/objective。
- 报告正文只能使用通过裁决的 finding；每个事实性 finding 必须带 source id 引用。
- `report.sources.md` 必须列出实际收集到的来源；不能再输出空来源占位。
- 默认后台 runner 不弹 Windows 控制台；显式传 `--open-console` 时，打开一个 watcher 终端显示实时事件。
- 每个 run 目录必须包含人类可读的主题文件，避免 `.codex-deep-research/runs/<run_id>/` 只靠 ID 无法识别研究内容。

## M1 研究能力边界

M1 使用现有 `CodexExecWorkerClient` 作为主 agent 执行器，不先接专门搜索 API。每个 agent 都使用结构化 JSON schema 输出，runner 负责把输出落盘、去重、排序、投票和报告生成。

M1 支持三类来源：

- `web` / `official_docs` / `github`：由 search/collect worker 返回 URL、标题、摘要、质量评级和摘录。
- `repo` / `command`：由 repo source provider 从当前仓库文档、README、spec、plan 和相关源码中检索候选来源。
- `mcp`：M1 保留类型，不主动调用 MCP provider。

如果外部 search worker 无法获取来源，runner 仍必须使用 repo provider 的本地相关文档作为来源，并产出 partial-but-cited 报告；不能回退成无来源报告。

## Workflow

1. `planning`
   - planner 生成 3-6 个 search angle。
   - 写 checkpoint `001-scope.json`。

2. `searching`
   - 对每个 angle 启动 `searcher` worker。
   - 同时运行 repo provider，从当前仓库读取相关 spec/plan/archive/source 文件。
   - 合并 search results，按 canonical URL/path 去重。
   - 写 `sources.jsonl`，状态更新 `sourcesCollected`。

3. `collecting`
   - 对每个 source 启动 `collector` worker，生成 excerpt、summary、quality/freshness/relevance。
   - 大文本写入 `artifacts/sources/<source_id>.md`。
   - source 状态更新为 `fetched` 或 `failed`。

4. `extracting`
   - 对每个 fetched source 启动 `extractor` worker。
   - 每个 source 最多抽取 `maxClaimsPerSource = 5` 条 falsifiable claims。
   - 写 `claims.jsonl`，状态更新 `claimsExtracted`。

5. `cross_checking` / `voting`
   - 对 central/supporting claim 运行 3 个 verifier persona：`strict_quorum_judge`、`source_quality_voter`、`freshness_or_scope_voter`。
   - 写 `votes.jsonl`。
   - 裁决规则：`validVotes >= 2 && refutations < 2` 保留；`refutations >= 2` 标记 `refuted`；少于 2 有效票标记 `unverified`。
   - 写 `decisions.jsonl`，状态更新 confirmed/weakened/refuted/unverified。

6. `synthesizing`
   - synthesizer 基于 confirmed/weakened claim 生成 finding。
   - report writer 生成 `report.md`、`report.summary.md`、`report.sources.md`。

7. `verifying`
   - report verifier 检查正文 source id 是否存在且 status 为 `fetched`、`extracted` 或 `verified_used`。
   - 校验失败时重写报告一次；仍失败则 state=`partial`，报告顶部标注原因。

## Windows Console Behavior

默认：

- `start` 使用 `detached: true`、`stdio: "ignore"`、`windowsHide: true` 启动 runner。
- 不弹后台控制台。

显式观察：

- `start --open-console` 在创建 run 后打开新的 Windows Terminal / PowerShell / cmd fallback。
- 新窗口执行 `codex-deep-research.cmd watch <run_id>`。
- watcher 输出 phase、task queued/started/completed/failed、source/claim/vote/decision 事件。

调试：

- `run <run_id>` 仍支持前台执行。
- M1 不默认把完整 prompt 写入磁盘；`--debug-prompts` 仍只记录 manifest 标志。

## Run Discoverability

run 目录名继续使用稳定 `run_id`，不把问题文本塞进目录名。原因是研究问题可能很长、含特殊字符或泄露敏感信息，直接进入路径会带来跨平台和隐私问题。

每个 run 创建时写入：

- `TITLE.txt`：一行短标题，最多 80 个字符，适合资源管理器预览。
- `QUESTION.md`：完整研究问题、创建时间、mode/depth、run id。
- `.codex-deep-research/runs/INDEX.md`：按时间倒序列出最近 run 的标题、run id、状态文件和报告路径。

`status` 和 `list` 后续可读取这些文件显示标题，但 M1 的最低要求是文件落盘可读。

## 验收标准

- 对题目“对比 Claude Code 最近新推出的 dynamic workflow，研究如何在 Codex 中实现类似能力”运行插件，最终 `state` 为 `completed` 或带引用的 `partial`。
- `sources.jsonl` 至少包含 3 个来源；repo fallback 可计入来源，但报告必须明确其来源类型。
- `claims.jsonl` 至少包含 3 条 claim。
- `votes.jsonl` 至少包含 6 条 vote。
- `decisions.jsonl` 至少包含 3 条 decision。
- `report.md` 至少包含 3 个 source id 引用。
- `report.sources.md` 不允许出现 `_No sources were collected by this v0 run._`。
- `watch` 能看到 search/fetch/extract/verify/synthesize 阶段事件。
- 默认 `start` 不弹控制台；`start --open-console` 会打开 watcher 控制台。
- run 目录包含 `TITLE.txt` 和 `QUESTION.md`；`runs/INDEX.md` 能显示本次研究主题和 run id。

## 非目标

- M1 不实现浏览器自动抓取渲染页面。
- M1 不接付费专用搜索 API。
- M1 不开放用户自定义 JS workflow。
- M1 不承诺跨平台 watcher 终端；Windows 是本次目标。
