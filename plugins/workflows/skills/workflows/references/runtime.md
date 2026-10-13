# Workflows 接口与脚本参考

本文说明插件操作接口。所有引用位于当前技能目录；项目、可执行文件和数据位置从用户任务、宿主或系统 API 获取，不使用发布者机器目录。

## 工具流程

常用流程：代理根据用户任务生成脚本 → `workflow_preview` → 已授权时 `workflow_start` → `workflow_get_run` → 核对结果与差异 → 已授权时 `workflow_apply`。面板是查看与操作入口，不是聊天执行的前置要求。

| 工具 | 关键输入与结果 |
| --- | --- |
| `workflow_get_capabilities` | 返回实际服务版本、执行器、网络与工作区能力 |
| `workflow_list_templates`、`workflow_get_template` | 列出或读取独立工作流定义 |
| `workflow_save_template` | `script`；可选 `args`、`allowWrite`、`networkAccess`、`allowedMcpServers`、`allowedMcpTools`、`workspaceMode`、`maintenance`、`limits`；更新已有定义需 `revision` |
| `workflow_preview` | `projectPath`、`script`；可选输入与执行范围；返回未执行的 `run` |
| `workflow_update` | `id`、当前 `revision`、`script`、`args`；可选执行范围；已有工作区时不能改变范围 |
| `workflow_start`、`workflow_resume` | `id`、当前 `revision`；已授权聊天调用不传 `leaseId`，面板调用传活跃租约 |
| `workflow_get_run`、`workflow_list_runs` | 读取实际计划、状态、任务、日志、报告、差异和维护审查；列表可按 `projectPath` 筛选 |
| `workflow_stop` | `id`；停止派发、中断活跃执行，等待退出并保存 |
| `workflow_cancel_task` | `id`、`taskId`；按用户请求取消一个任务 |
| `workflow_apply` | `id`、当前 `revision`；按应用授权处理完成的审查，保留冲突与当前项目改动 |
| `workflow_open_panel` | 打开实际任务面板，不开始执行 |

`workflow_panel_lease` 仅供面板维护生命周期。聊天启动不需要面板租约，不借用其他面板租约。

`args` 可为任意 JSON 值，默认对象。写入需要 Git 仓库根目录、`allowWrite: true` 和对应任务 `mode: "write"`。`networkAccess` 默认 `false`，`workspaceMode` 默认 `"snapshot"`；`"git-worktree"` 用于需要 Git 元数据的隔离维护。网络与写入授权相互独立：只读任务可以用 `allowWrite: false`、`networkAccess: true` 进行已授权 native fetch/search，仍不能写文件。联网须有用户授权且预览显式声明。`allowedMcpServers` 默认空数组，仅列出用户已配置且本任务授权的 MCP 服务名称，不包含 Workflows；`allowedMcpTools` 按服务映射到实际工具名称数组，与用户已有配置取交集并保留审批。只读 worker 仅允许明确 readOnlyHint=true 的 MCP 工具，写入按工具授权限制。不继承父聊天专有 apps/连接器。

`limits` 支持 `maxReadWorkers`、`maxCalls`、`timeoutMs`、`maxTokens`。默认只读并发 4，最多 16；写入同时最多一个。默认调用上限 1000、总时限 1 小时，token 门槛 0 表示不限。token 门槛控制后续派发，不代表账单上限。

## 编排脚本

首条语句是纯字面量 `export const meta`，包含小写短横线 `name`、非空 `description` 和可选 `phases`；阶段有 `title` 和可选 `detail`。主体为普通 JavaScript，允许顶层 `await`、`return`、分支和有限循环。

```javascript
export const meta = {
  name: "review-files",
  description: "审查指定文件并汇总有证据支持的问题",
  phases: [{ title: "审查" }, { title: "汇总" }],
};
if (!Array.isArray(args.files) || args.files.length === 0) {
  throw new Error("需要待审查文件列表");
}
const reports = await pipeline(args.files, file =>
  agent(`只读审查 ${file}，报告有证据支持的问题。`, { label: file, phase: "审查" }),
);
phase("汇总");
return await agent(`核实并汇总：${JSON.stringify(reports.filter(Boolean))}`);
```

| API | 行为 |
| --- | --- |
| `args` | 本次 JSON 输入，文件名推荐相对于目标项目 |
| `agent(prompt, options?)` | 返回真实 worker 文本；指定 `schema` 时返回 JSON；错误可捕获 |
| `parallel(functions)` | 等待函数数组全部完成，保持顺序，失败项记日志并返回 `null` |
| `pipeline(items, ...stages)` | 各输入独立推进；异常或 `null` 停止当前输入，其他输入继续 |
| `operation(stepId)` | 执行维护计划中该 ID 的预声明 argv；不能传新命令或 shell 字符串 |
| `phase(title)`、`log(message)` | 设置默认阶段或写入实际运行日志 |
| `return value` | 返回最终 JSON 值或文本 |

`agent` 选项包含 `label`、`phase`、`mode`、`model`、`schema`、`isolation`。默认只读；模型按用户选项或可用默认配置处理。只接受 JSON schema，不接受可执行函数。脚本自身不能直接访问文件、shell、网络、模块、时钟、随机数或定时器；没有未列出的 Claude API。

## 原生工具与可选维护计划

worker 通过官方 app-server 具备原生文件读取、命令执行和补丁修改能力；写入由任务 mode 与隔离沙箱限制，网络命令需 networkAccess 授权。脚本中的 `agent()` 交给 worker 自主使用这些工具及明确开放的 MCP。一般分析、修改和测试不必预声明为维护步骤；脚本可直接根据 worker 结果分支、循环和并行调度。

桌面专有工具、Image Gen、原生 UI、父聊天专有 apps 或连接器不全量继承，不把这些能力混入已配置 MCP 白名单。需要上述能力时按实际宿主工具可用性处理。

`agent` 是适用于多种任务的通用 worker，可按白名单复用真实配置的 MCP。维护操作并非每个工作流必需；只读联网研究不需要开放写入或声明步骤。shell/build 维护要求 `allowWrite: true` 和 `workspaceMode: "git-worktree"`；需要确定性维护命令时，维护配置随预览和定义保存，不能由脚本增加命令：

```javascript
const maintenance = {
  steps: [
    { id: "fetch", command: ["git", "fetch", "--prune"], networkAccess: true, timeoutMs: 120000, retries: 1, idempotent: true },
    { id: "install", command: ["npm", "ci", "--ignore-scripts"], networkAccess: true, timeoutMs: 300000, retries: 0 },
    { id: "build", command: ["npm", "run", "build"], timeoutMs: 300000, retries: 0 },
  ],
  activation: {
    serverName: "target-server",
    command: "node",
    args: ["${WORKSPACE}/runtime/index.js"],
  },
};
```

此配置是接口用法示例；代理应按用户项目的真实命令生成计划，不能将示例当作未经检查的操作。`command` 是 argv 数组，不由 shell 解释。步骤的 `networkAccess: true` 还要求整个运行 `networkAccess: true`。`timeoutMs` 与 `retries` 为每步设置，retries 为 0—2。`idempotent` 默认 false；显式 true 是调用者检查真实操作后的声明，引擎不会根据命令名称猜测幂等性。自动重试要求 idempotent=true；运行中断、退出或丢失响应后，已经开始且未确认结果的非幂等步骤拒绝在恢复中自动重发。先检查既有副作用，再决定继续或另建计划。脚本按步骤 ID 调用，例如 `await operation("build")`，按实际错误决定停止或有限重试。

激活 `command` 是可执行文件，`args` 为数组；`${WORKSPACE}` 替换为本次保留的工作区。配置中的其他目录必须来自本次授权输入，不能引用发布者私有位置。只有完成审查并按授权应用后才处理激活配置。结果 `pending_restart` 表示等待宿主重载；`failed` 表示失败；仓库已应用但激活失败时 application 为 `partial`，以当前 revision 重试 apply 只重试激活并核对配置版本；`verified` 表示已通过实际验证。不能把配置更新当作当前聊天已经加载目标版本。

## 停止、恢复与应用

外部 MCP 写入和结果不确定的命令不承诺 exactly-once。缺失返回值不能证明操作尚未生效。

`stopping` 表示仍在等待退出，`stopped` 表示已保存。任务取消作为实际失败处理；脚本可捕获，或由并行 API 返回 `null`。整个运行中断保留工作区，未完成任务恢复时重跑。

恢复按调用序校验输入、任务和执行范围，复用有效完成结果；第一个失败或指纹变化使后续缓存失效。跨项目复用必须创建新运行。项目变化、工作区缺失、锁和版本冲突按实际工具错误处理。

完成后统一检查差异、维护审查、测试输出和报告。聊天可在已有应用授权时调用 `workflow_apply`，无需再进入编辑器；面板按钮仍保留。冲突时不覆盖。应用成功、激活配置更新、宿主重新加载、工具版本验证、提交和发布是不同结果，分别核对与报告。
