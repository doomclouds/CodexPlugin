# Codex Deep Research 插件设计草案

- 日期：`2026-06-04`
- 目标插件：`codex-deep-research`
- 目标版本：`0.1.0`
- 状态：`Draft`
- 范围：Codex 插件、异步研究 runner、TS workflow DSL、并发 agent 调度、研究报告生成

## 摘要

`codex-deep-research` 的目标，是在 Codex 中实现一个类似 Claude Code Dynamic Workflow
研究命令的深度研究插件。它不是一个简单的 prompt skill，而是一个本地异步 workflow runtime：

- 用户通过 Codex skill 启动研究；
- runner 在本地维护完整 workflow state；
- 多个 Codex worker 并发执行搜索、抓取、抽取、验证和综合任务；
- 每个 worker 只接收当前任务需要的上下文切片；
- 运行状态持续写入文件，支持 `status`、`watch`、`cancel`、`report`；
- 最终生成带来源、裁决、置信度和审计数据的 Markdown 报告。

第一版专注于 deep research，不把它扩展成通用动态工作流平台。架构上保留扩展点，让后续可以增加更多
workflow，但 v0 必须先把研究流程真实跑通。

## 参考输入

本设计参考仓库内 Claude workflow 文件：

`C:\WorkSpace\ResearchProjects\CodexPlugin\.claude\workflows\deep-research.js`

该文件的关键机制包括：

- `meta.phases` 声明 Scope、Search、Fetch、Verify、Synthesize 阶段；
- 常量控制研究预算和投票阈值，例如 `VOTES_PER_CLAIM`、`REFUTATIONS_REQUIRED`、
  `MAX_FETCH`、`MAX_VERIFY_CLAIMS`；
- 每个 agent 调用都有 schema 约束；
- JS 变量保存运行时状态，例如 `seen`、`dupes`、`budgetDropped`、`fetchSlots`、
  `allSources`、`allClaims`、`rankedClaims`；
- `pipeline` 实现 search 到 fetch 的流式推进；
- `parallel` 实现并发；
- Verify 阶段前存在明确 barrier，先收齐 claim pool，再排序和投票；
- 投票使用 3 票、2 票反驳 kill、有效票 quorum 的裁决方式；
- synthesis 失败时返回已验证 claims，避免整轮研究结果丢失；
- 最终返回 stats，方便观察 agent 调用量、来源数、claim 数和裁决结果。

Codex 版应吸收这些设计，但不直接执行用户自定义 JS。v0 只执行插件内置可信 workflow。

## 目标

- 在 Codex 中提供可启动、可观察、可取消、可恢复的 deep research 工作流。
- 支持异步运行：`start` 返回 `run_id`，runner 在后台继续执行。
- 默认支持最多 `120` 个逻辑任务，物理并发默认限制为 `8`。
- 将完整研究状态保存在 runner 内存和落盘文件中，而不是塞进模型上下文。
- 为每个 worker 动态构建最小 `PromptEnvelope`。
- 支持动态角色限定词，即 role + persona + params。
- 对事实 claim 做对抗式验证和投票裁决。
- 对 finding 和 recommendation 做二级裁决。
- 生成 Markdown 报告和机器可读审计文件。
- 默认把运行产物写入当前仓库 `.codex-deep-research/runs/<run_id>/`。
- 默认将 `.codex-deep-research/` 加入 `.gitignore`，避免污染业务仓库。

## 非目标

- v0 不做网页 dashboard。
- v0 不开放用户自定义 JS/TS workflow 执行。
- v0 不做通用 dynamic workflow marketplace。
- v0 不自动提交、自动 push 或自动创建 PR。
- v0 不默认保存完整 prompt。
- v0 不默认无限 agent 并发。
- v0 不承诺所有外部 provider 都完整覆盖；先完成 mixed research 的主流程。

## 插件目录

建议目录：

```text
plugins/
  codex-deep-research/
    .codex-plugin/
      plugin.json
    README.md
    package.json
    tsconfig.json

    skills/
      deep-research/
        SKILL.md

    runner/
      src/
        cli.ts
        workflow/
          deep-research.workflow.ts
          primitives.ts
          schemas.ts
        runtime/
          context-store.ts
          context-selector.ts
          prompt-builder.ts
          persona-registry.ts
          scheduler.ts
          checkpoint.ts
          reporter.ts
        workers/
          worker-client.ts
          codex-exec-worker.ts
        commands/
          start.ts
          status.ts
          watch.ts
          report.ts
          cancel.ts
          list.ts
```

skill 只负责识别用户意图、补足参数、调用 runner CLI、返回 `run_id` 和报告路径。研究逻辑必须放在
runner 中，便于命令行、skill 和未来 MCP 复用。

## 用户入口

Codex 内建议入口：

```text
npm --prefix plugins\codex-deep-research run dev -- start "研究 Codex plugin 是否适合实现 deep research"
npm --prefix plugins\codex-deep-research run dev -- status <run_id>
npm --prefix plugins\codex-deep-research run dev -- watch <run_id>
npm --prefix plugins\codex-deep-research run dev -- report <run_id>
npm --prefix plugins\codex-deep-research run dev -- cancel <run_id>
npm --prefix plugins\codex-deep-research run dev -- list
```

runner CLI 等价入口：

```text
codex-deep-research start "<question>"
codex-deep-research status <run_id>
codex-deep-research watch <run_id>
codex-deep-research report <run_id>
codex-deep-research cancel <run_id>
codex-deep-research list
```

常用参数：

```text
--mode mixed|web|repo
--depth quick|standard|deep
--max-concurrency 8
--max-tasks 120
--output <path>
--debug-prompts
--fail-fast
```

默认值：

```ts
mode = "mixed";
depth = "standard";
maxConcurrency = 8;
maxTasks = 120;
votesPerClaim = 3;
refutationsRequired = 2;
maxFetch = 20;
maxClaimsPerSource = 5;
failureMode = "partial_report";
debugPrompts = false;
```

## 运行数据目录

默认输出目录：

```text
.codex-deep-research/
  runs/
    dr_20260604_153012/
      manifest.json
      status.json
      events.jsonl
      tasks.jsonl
      sources.jsonl
      claims.jsonl
      evidence.jsonl
      votes.jsonl
      decisions.jsonl
      prompt_envelopes.jsonl
      report.md
      report.summary.md
      report.sources.md
      artifacts/
      checkpoints/
```

`.gitignore` 默认追加：

```gitignore
.codex-deep-research/
```

如用户指定 `--output docs/research/<name>`，则报告和审计产物写到指定目录。

## TS Workflow DSL

v0 采用插件内部可信 TS workflow DSL。该 DSL 是 runner 内部接口，不是开放给用户执行任意代码的沙盒。

核心 primitive：

- `phase(name)`：更新当前阶段，写入 `status.json` 和 `events.jsonl`。
- `agent(prompt, options)`：启动一个 Codex worker，要求结构化输出。
- `parallel(tasks, options)`：并发执行任务，受 `maxConcurrency` 限制。
- `pipeline(input, map, next)`：边生产边消费，支持 search 结果立即进入 fetch。
- `barrier(name)`：明确阶段屏障，例如 Verify 前必须收齐 claim pool。
- `checkpoint(name)`：保存状态快照，支持恢复。
- `emit(event)`：写入事件流，供 `watch` 展示。
- `salvage(reason)`：失败时生成 partial report。

示例形态：

```ts
phase("Scope");

const scope = await agent(scopePrompt, {
  role: "planner",
  persona: "angle_decomposer",
  schema: ScopeSchema,
  context: selector.scope(state),
});

const searchResults = await pipeline(
  scope.angles,
  angle => agent(searchPrompt(angle), {
    role: "searcher",
    persona: selectSearchPersona(angle, state),
    schema: SearchSchema,
    context: selector.search(state, angle),
  }),
  result => parallel(fetchTasks(result))
);

barrier("claims_collected");

const votes = await parallel(verifyTasks(rankedClaims), {
  concurrency: state.run.maxConcurrency,
});
```

## WorkerClient

runner 通过接口调用 Codex worker：

```ts
interface WorkerClient {
  run(task: WorkerTask): Promise<WorkerResult>;
}
```

v0 使用 `codex exec --json` 实现 `CodexExecWorkerClient`。原因：

- JSONL 事件是机器可读输出；
- 可以映射到 runner 的 `task.progress`、`task.completed`、`task.failed`；
- 便于实现 `status` 和 `watch`。

后续如 Codex SDK 更适合，只替换 `WorkerClient` 实现，不改 workflow DSL。

## WorkflowState

runner 必须持有完整状态，而不是依赖模型上下文保存历史。

```ts
interface WorkflowState {
  run: RunContext;
  phases: Record<PhaseName, PhaseState>;
  queues: TaskQueueState;

  sources: Map<SourceId, SourceCard>;
  claims: Map<ClaimId, Claim>;
  evidence: Map<EvidenceId, Evidence>;
  votes: Map<VoteId, Vote>;
  decisions: Map<ClaimId, ClaimDecision>;
  findings: Map<FindingId, FindingDecision>;
  recommendations: Map<RecommendationId, RecommendationDecision>;

  artifacts: ArtifactIndex;
  metrics: ResearchMetrics;
}
```

OS 环境变量只适合保存静态配置，例如 debug 开关、默认并发、CLI 路径。运行过程里的 sources、
claims、votes、decisions 必须保存在 `WorkflowState` 和落盘文件中，避免字符串化、串状态和泄露风险。

## Context Injection Contract

每次调用 worker 前，runner 通过 `context-selector` 从 `WorkflowState` 投影最小上下文：

```text
WorkflowState
  -> contextSelector.project(state, task)
  -> promptBuilder.build(role, persona, projectedContext, schema)
  -> WorkerClient.run()
  -> reducer.apply(result)
```

`PromptEnvelope`：

```ts
type PromptEnvelope = {
  run: {
    question: string;
    mode: "mixed" | "web" | "repo";
    depth: "quick" | "standard" | "deep";
  };
  task: {
    id: string;
    phase: PhaseName;
    role: Role;
    persona: string;
    objective: string;
  };
  constraints: string[];
  injected: Record<string, unknown>;
  outputSchema: JsonSchema;
};
```

`injected` 只能包含当前任务需要的数据。比如 freshness skeptic 只拿当前 claim、支持 quote、source
quality、publish date、已知反证和 freshness rubric，不拿全部 source pool。

## Persona Registry

role 表示能力职责，persona 表示当前任务限定词。

```ts
type Role =
  | "planner"
  | "searcher"
  | "collector"
  | "extractor"
  | "skeptic"
  | "voter"
  | "synthesizer"
  | "verifier";

type Persona = {
  id: string;
  role: Role;
  qualifier: string;
  when: PersonaRule[];
  rubric: string[];
  must: string[];
  mustNot: string[];
};
```

默认 persona：

- `planner:angle_decomposer`
- `searcher:official_source_first`
- `searcher:freshness_scout`
- `searcher:community_signal_scanner`
- `collector:primary_source_extractor`
- `extractor:falsifiable_claim_miner`
- `extractor:risk_extractor`
- `skeptic:counter_evidence_hunter`
- `skeptic:freshness_checker`
- `skeptic:source_quality_challenger`
- `skeptic:scope_boundary_checker`
- `voter:strict_quorum_judge`
- `voter:source_quality_voter`
- `voter:applicability_voter`
- `synthesizer:duplicate_merger`
- `synthesizer:technical_report_writer`
- `verifier:citation_integrity_checker`

选择规则示例：

```text
fast-moving topic + old source
  -> skeptic:freshness_checker

single weak source + strong claim
  -> skeptic:source_quality_challenger

comparison or recommendation claim
  -> skeptic:scope_boundary_checker

conflicting evidence exists
  -> voter:strict_quorum_judge
```

## 研究流程

生命周期：

```text
created
  -> planning
  -> searching
  -> collecting
  -> extracting
  -> cross_checking
  -> voting
  -> synthesizing
  -> verifying
  -> completed
```

终止状态：

```text
completed | partial | failed | cancelled
```

### Scope

planner 生成 `ResearchPlan`：

```ts
type ResearchPlan = {
  normalizedQuestion: string;
  angles: SearchAngle[];
  sourcePolicy: SourcePolicy;
  riskNotes: string[];
};
```

`SearchAngle`：

```ts
type SearchAngle = {
  id: string;
  label: string;
  query: string;
  purpose:
    | "primary_source"
    | "recent_update"
    | "technical_detail"
    | "contrarian"
    | "implementation"
    | "benchmark"
    | "policy_or_legal";
  preferredSources: SourceKind[];
};
```

默认生成 3-6 个 angle。技术问题默认覆盖官方文档、release notes、GitHub、benchmark、
社区反馈、反方限制。

### Search

Source provider 使用 adapter：

```ts
type SourceProvider =
  | "web"
  | "official_docs"
  | "repo"
  | "github"
  | "mcp"
  | "command";
```

不同问题走不同组合：

- 当前性问题：`web + official_docs`
- 代码仓库问题：`repo + command + git`
- GitHub 项目调研：`github + web`
- .NET / Azure：`official_docs + web + mcp`
- 本地能力检查：`command + repo`

### Dedup

参考 Claude JS 的 `seen Map + normURL`，Codex 版使用 `SourceFingerprint`：

```ts
type SourceFingerprint = {
  canonicalUrl?: string;
  host?: string;
  path?: string;
  titleHash?: string;
  contentHash?: string;
};
```

去重规则：

- 同 canonical URL 合并；
- 同 host/path 去 query 参数后合并；
- 同标题加高相似 snippet 合并；
- GitHub 同 issue、PR、commit 合并；
- 本地文件同 path 合并。

重复来源不直接丢弃，记录到 `dupes`，作为 source confidence 的辅助信号。

### Collect and Extract

成功抓取的来源生成 `SourceCard`：

```ts
type SourceCard = {
  id: string;
  kind: SourceProvider;
  title: string;
  urlOrPath: string;
  retrievedAt: string;
  publishedAt?: string;
  quality:
    | "primary"
    | "official"
    | "secondary"
    | "community"
    | "commercial"
    | "forum"
    | "unreliable";
  authorityScore: number;
  freshnessScore: number;
  relevanceScore: number;
  angleIds: string[];
  excerptRefs: string[];
};
```

大文本写入 artifact：

```text
artifacts/sources/src_001.md
artifacts/excerpts/src_001_excerpt_001.md
```

`SourceCard` 只保存摘要和引用，不把全文放入主 state。prompt 注入时按需摘取。

### Claim Verification

第一层裁决是单条 claim。

默认参数：

```ts
const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;
const MIN_VALID_VOTES = 2;
```

规则：

- 3 个 verifier 独立投票；
- 2 个有效反驳则 kill；
- 少于 2 个有效票则标记 `unverified`；
- 不确定默认降级，不默认保留；
- `survives = validVotes >= 2 && refutations < 2`。

输出：

```ts
type ClaimDecision =
  | "confirmed"
  | "weakened"
  | "refuted"
  | "unverified";
```

默认 3 票 persona：

```text
strict_voter
source_quality_voter
freshness_or_scope_voter
```

### Finding Decision

多个 claim 会聚合成 finding。finding 裁决关注：

- 是否有多个独立来源支持；
- 是否有反例或限定条件；
- 来源是否同质化；
- 是否存在时间敏感问题；
- 是否回答原始问题。

```ts
type FindingDecision = {
  decision: "include" | "include_with_caveat" | "appendix_only" | "drop";
  confidence: "high" | "medium" | "low";
  rationale: string;
  claimIds: string[];
  sourceIds: string[];
};
```

### Recommendation Decision

如果用户问的是选型、建议或是否执行，最终报告必须生成 recommendation 裁决。

```ts
type RecommendationDecision = {
  recommendation: string;
  strength: "strong" | "moderate" | "weak";
  appliesWhen: string[];
  avoidWhen: string[];
  evidenceFindingIds: string[];
  risks: string[];
};
```

recommendation 必须基于 finding，不允许直接基于未裁决 claim。

## 搜索停止条件

默认停止条件：

- 达到 `MAX_FETCH`；
- 每个关键 angle 至少有 1 个 high 或 medium source；
- 连续 3 次搜索没有新增高质量来源；
- source diversity 达到 source policy 要求；
- 用户取消；
- time 或 token budget 到顶。

运行报告必须包含三计数：

```text
queriesSent
sourcesCollected
sourcesCited
```

## 报告结构

默认输出：

```text
report.md
report.summary.md
report.sources.md
```

`report.md` 结构：

```md
# <研究问题>

## 摘要

## 结论强度

## 关键发现

### 1. <finding title>
- Confidence: high / medium / low
- Decision: include / include_with_caveat
- Evidence:
  - ...
- Caveat:
  - ...
- Sources:
  - [S1], [S4]

## 建议

## 不确定性与限制

## 被排除或削弱的说法

## 仍未回答的问题

## 来源
```

如果用户问的是事实研究，可以没有 `建议`。如果用户问的是选型或行动建议，则必须有 `建议`。

## 引用规则

硬规则：

```text
No fetched source, no citation.
No citation, no factual claim.
No decision, no report body.
```

具体规则：

- 只能引用 `sources.jsonl` 里存在的 source；
- 只能引用状态为 `fetched`、`extracted` 或 `verified_used` 的 source；
- search 结果但未 fetch 的 URL 不能进入正文引用；
- forum/blog 可以引用，但不能单独支撑 high confidence；
- commercial/marketing source 必须降权，除非只是引用其自述事实；
- fast-moving topic 必须展示 `retrievedAt`，尽量展示 `publishedAt`；
- quote 必须来自 `artifact/excerpt`，不能由模型凭记忆复述。

报告里使用 source id：

```md
根据官方 release note，X 在 2026-05 后发生了变化。[S3]

[S3]: https://example.com/release "official, retrieved 2026-06-04"
```

## Report Verifier

报告写完后必须跑 `report_verifier`，检查：

- 正文中的 source id 是否都存在；
- 每个事实 claim 是否能追溯到 finding、claim、source；
- `refuted` 和 `unverified` 是否误入正文；
- 是否引用未 fetch 的 search result；
- high confidence 是否被弱来源单独支撑；
- 是否遗漏重要 caveat；
- Markdown 链接是否可读。

校验失败时回到 synthesizer 修一次。最多重试 1 次，仍失败则输出 partial report，并在顶部标注原因。

## 可观测性

`status.json` 给人看：

```ts
type RunStatus = {
  runId: string;
  question: string;
  phase: PhaseName;
  state: "running" | "completed" | "partial" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  progress: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  research: {
    angles: number;
    sourcesCollected: number;
    sourcesFetched: number;
    claimsExtracted: number;
    claimsVerified: number;
    confirmed: number;
    weakened: number;
    refuted: number;
    unverified: number;
  };
  currentTasks: CurrentTaskSummary[];
  lastEvents: string[];
  output?: {
    reportPath?: string;
    summaryPath?: string;
  };
};
```

`events.jsonl` 给 `watch` 和审计使用：

```ts
type WorkflowEvent =
  | { type: "phase.started"; phase: PhaseName }
  | { type: "task.queued"; taskId: string; role: Role; persona: string }
  | { type: "task.started"; taskId: string }
  | { type: "task.completed"; taskId: string; artifactRefs: string[] }
  | { type: "task.failed"; taskId: string; error: string }
  | { type: "claim.decided"; claimId: string; decision: string }
  | { type: "checkpoint.saved"; checkpoint: string }
  | { type: "report.written"; path: string };
```

`status <run_id>` 示例：

```text
Run: dr_20260604_153012
Phase: Verify
State: running

Tasks: 8 running / 42 queued / 76 completed / 2 failed
Sources: 18 collected, 15 fetched
Claims: 41 extracted, 19 verified
Decisions: 8 confirmed, 4 weakened, 5 refuted, 2 unverified

Running:
- skeptic:freshness_checker claim_012
- voter:strict_quorum_judge claim_018
- extractor:falsifiable_claim_miner src_009
```

`watch <run_id>` tail `events.jsonl`，只显示增量事件。

## Checkpoint and Recovery

每个阶段结束写 checkpoint：

```text
checkpoints/
  001-scope.json
  002-search.json
  003-fetch.json
  004-verify.json
  005-synthesis.json
```

恢复策略：

- runner 启动时读取 `manifest.json`；
- 读取最新 checkpoint；
- 重放 checkpoint 之后的 `events.jsonl`；
- 找出 `running` 但无心跳的 task，标记为 `stale`；
- 可重试任务重新排队；
- 不可恢复任务标记 failed；
- 从最近稳定 phase 继续。

## Cancel

`cancel` 写入：

```text
cancel.requested
```

runner 看到后：

- 停止创建新任务；
- 已完成结果继续写入 state；
- 正在运行任务给短暂 grace period；
- 超时后终止 worker；
- 生成 partial report；
- 状态标记为 `cancelled` 或 `partial`。

## Failure Strategy

默认不因单个 agent 失败中断全局。

```ts
MAX_RETRIES = 1;
MAX_CONSECUTIVE_PROVIDER_FAILURES = 3;
FAILURE_MODE = "partial_report";
```

整体失败条件：

- Scope 阶段失败，无法生成研究计划；
- 状态文件损坏且无法恢复；
- 所有 source provider 连续失败；
- 用户显式设置 `--fail-fast`。

其他失败进入 partial report。

## Prompt Envelope 记录

默认保存脱敏 `prompt_envelopes.jsonl`：

- 保存 task id、role、persona、context refs、schema id、token budget；
- 保存注入变量摘要；
- 不保存完整网页正文、大段私有文件内容、疑似 secret；
- `--debug-prompts` 才保存完整 prompt。

这能让 100+ worker 的运行过程可复盘，同时默认不扩大敏感数据落盘面。

## v0 必做

- 插件目录 `plugins/codex-deep-research`。
- Skill 入口 `skills/deep-research/SKILL.md`。
- Runner CLI：`start`、`status`、`watch`、`report`、`cancel`、`list`。
- TS workflow runtime：`phase`、`agent`、`parallel`、`pipeline`、`checkpoint`、`emit`。
- Deep research workflow：
  - Scope：拆成 3-6 个 search angles；
  - Search：并发搜索；
  - Fetch/Extract：抓取来源并提取 falsifiable claims；
  - Verify：3 票对抗验证，2 票反驳 kill；
  - Synthesize：生成 Markdown 报告；
  - Verify Report：检查引用和裁决一致性。
- Runtime state 文件：`status.json`、`events.jsonl`、`tasks.jsonl`、`sources.jsonl`、
  `claims.jsonl`、`votes.jsonl`、`decisions.jsonl`、`checkpoints/`。
- 默认输出：`report.md`、`report.summary.md`、`report.sources.md`。
- 默认 `.gitignore`：`.codex-deep-research/`。

## v0 暂不做

- 不做网页 dashboard；
- 不开放用户自定义 JS/TS workflow 执行；
- 不做通用 dynamic workflow marketplace；
- 不做自动提交或自动 PR；
- 不默认保存完整 prompt；
- 不支持无限 agent 并发。

## 验收标准

- 能通过 skill 启动一次研究，并返回 `run_id`。
- `status <run_id>` 能看到阶段、队列、运行中任务、已完成任务、失败任务。
- `watch <run_id>` 能持续显示事件流。
- runner 中途失败或取消时能产出 partial report。
- `report.md` 中每个事实性结论都能追溯到 source。
- 未 fetch 的 search result 不能进入正文引用。
- `refuted` 和 `unverified` claim 不会进入正文，只能进入 appendix 或 audit。
- prompt envelope 默认脱敏保存，`--debug-prompts` 才保存完整 prompt。
- `.codex-deep-research/` 默认不污染 git。
- 本地测试覆盖 schema、去重、投票裁决、report verifier、checkpoint 恢复。

## 建议实现顺序

1. 创建插件骨架和 runner package。
2. 实现运行目录、manifest、status、events、tasks 写入。
3. 实现 CLI `start/status/watch/list/cancel/report` 的静态骨架。
4. 实现 `WorkerClient` 接口和 `codex exec --json` worker。
5. 实现 workflow primitive：`phase`、`agent`、`parallel`、`pipeline`、`checkpoint`、`emit`。
6. 实现 context store、context selector、prompt builder、persona registry。
7. 实现 deep-research workflow 主链路。
8. 实现 report writer 和 report verifier。
9. 补测试、README、skill 文档和插件 manifest。

## 设计风险

- `codex exec --json` worker 的真实事件粒度可能与 runner 期望不完全一致，需要以本机实测校准映射。
- 大量并发 worker 可能触发资源、速率或外部 provider 限制，必须保留 `maxConcurrency` 和 retry 上限。
- source provider 的可用性会随环境变化，v0 应允许 partial report。
- prompt envelope 脱敏规则必须保守，避免把私有仓库正文或 secret 默认落盘。
- report verifier 不能只做格式检查，必须检查 source id、claim decision 和正文引用的一致性。

