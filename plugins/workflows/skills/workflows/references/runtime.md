# Workflows 接口与脚本参考

本文说明插件操作接口。所有引用位于当前技能目录；项目、可执行文件和数据位置从用户任务、宿主或系统 API 获取，不使用发布者机器目录。

## 工具流程

常用流程：代理根据用户任务生成脚本 → `workflow_preview` → 已授权时 `workflow_start` → `workflow_get_run` → 核对结果与差异 → 已授权时 `workflow_apply`。面板是查看与操作入口，不是聊天执行的前置要求。

| 工具 | 关键输入与结果 |
| --- | --- |
| `workflow_get_capabilities` | 返回实际服务版本、执行器、网络与工作区能力 |
| `workflow_get_projects` | 读取宿主本机项目和真实聊天归属；面板固定当前项目，无归属时提示从项目聊天打开，不提供目录切换 |
| `workflow_get_execution_settings` | 可选 `projectPath`；返回默认配置、实际模型目录及其深度选项。无效默认配置保留原因与目录，供用户修正 |
| `workflow_update_execution_settings` | 当前 `revision`；可选 `model`、`reasoningEffort`；全量替换插件自己的默认设置，省略字段清除对应覆盖 |
| `workflow_list_templates`、`workflow_get_template` | 列出或读取独立工作流定义 |
| `workflow_save_template` | `script`；可选 `args`、`allowWrite`、`networkAccess`、`allowedMcpServers`、`allowedMcpTools`、`workspaceMode`、`maintenance`、`limits`；更新已有定义需 `revision` |
| `workflow_preview` | `projectPath`、`script`；可选输入、执行范围、`sourceDefinition: { id, revision }`；服务端校验来源版本与实际脚本，返回未执行的 `run` |
| `workflow_update` | `id`、当前 `revision`、`script`、`args`；可选执行范围；已有工作区时不能改变范围 |
| `workflow_start`、`workflow_resume` | `id`、当前 `revision`；已授权聊天调用不传 `leaseId`，面板调用传活跃租约 |
| `workflow_list_runs` | 可选 `projectPath`、`offset`、`limit`（默认 100、最多 200）；返回 `listSummary: true`、`totalRuns`、`nextOffset` 和轻量运行摘要，不包含完整控制范围 |
| `workflow_get_run` | `id`；返回保留完整脚本、输入和授权范围的有界详情；可选 `artifactOffset`、`artifactLimit`（默认 20、最多 200）读取维护产物页 |
| `workflow_get_node_process` | `id`；以 `taskId`、`phase` 或 `scope: "workflow" | "unphased"` 选择过程，默认 `detail: "brief"`；开发详情显式传 `"developer"` |
| `workflow_preview_deletion` | `kind: "run" | "definition"`、`id`、当前 `revision`；定义可传额外 `runIds`；返回 `preview`，含实际范围、`fingerprint`、`canDelete`、大小和 `blocked` |
| `workflow_delete` | 预览的同一目标字段及最新 `fingerprint`；返回 `deletion.deleted`、`partial`、已删对象和 `remaining`，仅在全部清理完成时报告成功 |
| `workflow_stop` | `id`；停止派发、中断活跃执行，等待退出并保存 |
| `workflow_cancel_task` | `id`、`taskId`；按用户请求取消一个任务 |
| `workflow_apply` | `id`、当前 `revision`；按应用授权处理完成的审查，保留冲突与当前项目改动 |
| `workflow_open_panel` | 从项目聊天打开实际任务面板，不开始执行；只注册 thread 入口，无项目归属时显示提示并禁用操作 |

`workflow_panel_lease` 仅供面板维护生命周期。聊天启动不需要面板租约，不借用其他面板租约。

历史列表可能因传输预算返回少于请求 `limit` 的记录，使用实际 `nextOffset` 翻页，不自行加上请求大小。选中摘要后须用 `workflow_get_run` 读取完整控制范围，不能以缺失字段构造空脚本或空授权。`maintenanceReview.artifacts` 是当前页，`artifactCount` 是真实总数，`artifactOffset` 是页起点，`nextArtifactOffset` 是后页起点；可按后页起点继续调用 `workflow_get_run({ id, artifactOffset, artifactLimit: 100 })`。分页片段用于展示，不覆盖主运行的脚本、输入、权限或审查指纹。

`operationAccepted: true`、`listSummary: true` 与 `projectionError: { code, message }` 表示变更动作已接受，返回的 `run` 仅为真实身份与状态摘要。随后读取详情；详情失败不能解释为动作未发生，也不能自动重发启动、恢复或应用。未确认详情时仍可按明确要求用运行 ID 停止。

面板固定使用当前项目聊天，不提供主窗口侧栏的全局入口或项目目录切换。没有 `currentProjectId` 或归属尚未确认时，不读取全局运行历史、模型目录或启动任务。Agent 仍可按用户明确授权的 `projectPath` 调用 `workflow_preview` 等工具；程序化目标不会改变面板归属。已有运行固定绑定创建时的 `projectPath`，不能移到其他项目。

宿主当前真实调用方的显式项目 ID 优先；若这个本地 Codex 聊天没有项目 ID，服务端可用它的宿主 `cwd` 与本地项目根目录的实际路径做唯一精确匹配。成功返回 `contextSource: "thread"`、`currentProjectId` 和 `bindingSource: "thread-cwd"`，前端继续固定该项目。严禁用插件进程 `cwd`、任意工具参数、旧运行、其他聊天或父目录替代匹配。无法唯一确认时保留返回的 `reason`，不自动选择其他项目。

跨项目复用时，从目标项目聊天读取定义并创建独立运行。读取定义后传入其实际 `id`、`revision` 和脚本作为来源；改写脚本后先保存新定义版本，再关联。新定义使用随机初始版本，更新递增；删除后重建须重新读取版本，不沿用旧预览。

主界面是工具栏和横向执行图，参数、设置、历史、差异审查及节点过程放在弹窗中。阶段连线展示阶段顺序，不自动还原脚本的条件分支、循环回边或完整依赖图。分支和有限循环仍由 JavaScript 执行。

## 准备与节点过程

启动先进入 `preparing`，`preparation.stages` 记录实际环境核对、项目检查、工作区准备等阶段。执行中的任务尝试记录活动；`progressSequence` 用于过程刷新，不能当作修改操作的 CAS 版本，变更仍用新读取的 `revision`。

`workflow_get_node_process` 的选择器择一使用：`taskId` 看一个实际任务，`phase` 看一个阶段，`scope: "workflow"` 看整个运行及准备过程，`scope: "unphased"` 看未分阶段的任务。默认 `brief` 返回简要动作、状态、耗时和错误，不包含提示词及原始输出。`developer` 增加相关节点的有限已记录日志，不能把缺少日志当作任务没有执行。

面板断线冻结最后一次已读取的记录并暂停操作；重连重建租约、读取服务端实际状态，不自动恢复或重跑。面板租约丢失会停止它启动的运行；用户明确继续时再以当前 revision 恢复。

macOS 桌面项目接口通过宿主动态环境提供。启动器优先选宿主 Node，用 `process.execve` 原地替换，要求初始 Node.js 22.15 或更新版本；Windows 和普通 CLI 沿原启动。不得固定运行时或管道地址、关闭宿主鉴权、读取私有界面数据库或冒用其他聊天身份。安装更新不等于真实 App 聊天已加载新版，应在宿主重载后核对实际服务与项目查询。

## 删除范围与失败重试

删除须有用户授权，并先调用 `workflow_preview_deletion`。`kind: "run"` 删除一个运行；`kind: "definition"` 删除保存的定义及通过来源记录可靠关联的运行，可追加明确选择的旧运行 `runIds`。不按名称推断关联，内置定义不可删除。预览只读取，不停止运行或删除文件。

返回的 `preview.target` 是规范化目标，`runs`、`definition`、`objects`、`totalFiles`、`totalBytes` 说明实际清理范围；`blocked` 说明执行、准备、应用、引用或文件归属等阻碍。`canDelete: true` 后，用同一目标的 `kind`、`id`、`revision`、可选 `runIds` 及 `fingerprint` 调用 `workflow_delete`。范围或文件发生变化时重新预览，不手工绕过阻碍。

完整清理覆盖该范围的定义、运行、日志、结果、隔离工作区、缓存、事务、控制文件及删除元数据，不留下永久墓碑或隐藏运行目录。已交付到原项目的文件与提交、用户全局设置和其他工作流不属于删除范围。原项目的快照临时文件只按自有事务记录、文件身份和摘要核验后删除；旧文件归属不明时阻止删除。

`deletion.deleted: true` 表示全部清理完成。`partial: true` 或非空 `remaining` 需要报告实际剩余对象；相关记录只保留用于重试的只读摘要和 `deletionTarget`，禁止启动、恢复、更新和应用。按摘要中的原目标重新预览，取得新指纹后继续清理；全部完成后摘要和删除元数据也删除。删除不承诺回滚原项目已接受的改动。

`args` 可为任意 JSON 值，默认对象。写入需要 Git 仓库根目录、`allowWrite: true` 和对应任务 `mode: "write"`。`networkAccess` 默认 `false`，`workspaceMode` 默认 `"snapshot"`；`"git-worktree"` 用于需要 Git 元数据的隔离维护，也支持子模块及嵌套模块的提交、初始化状态、独立副本与产物检查点。未初始化模块不会自动下载，初始化须显式计划和授权。快照写入含子模块时提示改用 Git 模式。网络与写入授权相互独立：只读任务可以用 `allowWrite: false`、`networkAccess: true` 进行已授权 native fetch/search，仍不能写文件。联网须有用户授权且预览显式声明。`allowedMcpServers` 默认空数组，仅列出用户已配置且本任务授权的 MCP 服务名称，不包含 Workflows；`allowedMcpTools` 按服务映射到实际工具名称数组，与用户已有配置取交集并保留审批。只读 worker 仅允许明确 readOnlyHint=true 的 MCP 工具，写入按工具授权限制。不继承父聊天专有 apps/连接器。

`limits` 支持 `maxReadWorkers`、`maxCalls`、`timeoutMs`、`maxTokens`。默认只读并发 4，最多 16；写入同时最多一个。默认调用上限 1000、总时限 1 小时，token 门槛 0 表示不限。token 门槛控制后续派发，不代表账单上限。

## 编排脚本

首条语句是纯字面量 `export const meta`，包含小写短横线 `name`、非空 `description` 和可选 `phases`、`parameters`；阶段有 `title` 和可选 `detail`。主体为普通 JavaScript，允许顶层 `await`、`return`、分支和有限循环。

`parameters` 声明面板输入项：`name` 对应 `args` 字段，`label` 是显示名称，`type` 为 `string`、`number`、`boolean` 或 `string[]`，可选 `required`、`description`、`placeholder`、`multiline`。字符串编号和链接保持原值；参数不会触发流程选择或生成。未声明参数的旧工作流继续接受原有 JSON 输入。

```javascript
export const meta = {
  name: "review-bug",
  description: "分析指定 Bug",
  parameters: [
    { name: "bug", label: "Bug 号或链接", type: "string", required: true },
    { name: "description", label: "补充描述", type: "string", multiline: true },
  ],
  phases: [{ title: "分析" }],
};
phase("分析");
return await agent(`分析 Bug：${args.bug}\n补充描述：${args.description ?? ""}`);
```

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

`agent` 选项包含 `label`、`phase`、`mode`、`model`、`reasoningEffort`、`schema`、`isolation`。默认只读；模型按用户选项或可用默认配置处理。只接受 JSON schema，不接受可执行函数。脚本自身不能直接访问文件、shell、网络、模块、时钟、随机数或定时器；没有未列出的 Claude API。

预览、更新和定义保存可传 `nodeSettings`，值为 `{ model?, reasoningEffort? }`，键为 `phase:<已声明阶段标题>` 或 `task:<实际任务的零起始 index>`。节点设置优先于脚本设置，未设置则使用本次运行默认快照；首次启动解析插件默认或 Codex CLI 配置。模型和深度按实际目录校验，不自行替换为其他模型。运行期间不要修改节点配置，改变已停止运行的节点配置时创建新预览。主对话模型目前不由标准面板自动提供。

## 原生工具与可选维护计划

worker 通过官方 app-server 具备原生文件读取、命令执行和补丁修改能力；写入由任务 mode 与隔离沙箱限制，网络命令需 networkAccess 授权。脚本中的 `agent()` 交给 worker 自主使用这些工具及明确开放的 MCP。一般分析、修改和测试不必预声明为维护步骤；脚本可直接根据 worker 结果分支、循环和并行调度。

桌面专有工具、Image Gen、原生 UI、父聊天专有 apps 或连接器不全量继承，不把这些能力混入已配置 MCP 白名单。需要上述能力时按实际宿主工具可用性处理。

`agent` 是适用于多种任务的通用 worker，可按白名单复用真实配置的 MCP。维护操作并非每个工作流必需；只读联网研究不需要开放写入或声明步骤。shell/build 维护要求 `allowWrite: true` 和 `workspaceMode: "git-worktree"`；需要确定性维护命令时，维护配置随预览和定义保存，不能由脚本增加命令：

```javascript
const maintenance = {
  steps: [
    { id: "fetch", command: ["git", "fetch", "--prune"], networkAccess: true, timeoutMs: 120000, retries: 1, idempotent: true },
    { id: "install", command: ["npm", "ci", "--ignore-scripts"], networkAccess: true, timeoutMs: 300000, retries: 0 },
    { id: "build", command: ["npm", "run", "build"], timeoutMs: 300000, retries: 0, protectedPaths: [".agents/skills"] },
  ],
  activation: {
    serverName: "target-server",
    command: "node",
    args: ["${WORKSPACE}/runtime/index.js"],
  },
};
```

此配置是接口用法示例；代理应按用户项目的真实命令生成计划，不能将示例当作未经检查的操作。`command` 是 argv 数组，不由 shell 解释；绝对工具／脚本路径可以读取，不能据此扩大写权限。每次命令的临时目录和 npm/XDG 缓存默认位于隔离工作区并在退出后清理；argv、HOME、PATH 与全局配置保持原值，显式缓存参数仍由真实沙箱检查。步骤的 `networkAccess: true` 还要求整个运行 `networkAccess: true`。`timeoutMs` 与 `retries` 为每步设置，retries 为 0—2。`idempotent` 默认 false；显式 true 是调用者检查真实操作后的声明，引擎不会根据命令名称猜测幂等性。自动重试要求 idempotent=true；运行中断、退出或丢失响应后，已经开始且未确认结果的非幂等步骤拒绝在恢复中自动重发。先检查既有副作用，再决定继续或另建计划。脚本按步骤 ID 调用，例如 `await operation("build")`，按实际错误决定停止或有限重试。

`protectedPaths?: string[]` 是单步骤预声明的最小目录授权，只在该 `operation` 执行时生效。示例中的 `build` 只有在任务明确要求更新既有 `.agents/skills` 时才保留此字段；普通构建应省略。路径相对于本次隔离工作区，必须是 `.agents` 或 `.codex` 内已经存在的真实目录，优先最小子目录；不允许绝对路径、`..` 或任意符号链接及跳转链。权限不会传给其他步骤或 `agent` worker；预览、保存定义、读取及复用时保留在对应 `maintenance.steps` 项内。调整路径授权须创建新预览，保留工作区的旧运行不能增加权限。

激活 `command` 是可执行文件，`args` 为数组；`${WORKSPACE}` 替换为本次保留的工作区。配置中的其他目录必须来自本次授权输入，不能引用发布者私有位置。只有完成审查并按授权应用后才处理激活配置。激活结果 `pending_restart` 表示等待宿主重载；`failed` 表示失败；`verified` 表示已通过实际验证。不能把配置更新当作当前聊天已经加载目标版本。

## 停止、恢复与应用

`workflow_resume({ id, revision, retryFromTaskId: "task_2" })` 显式重新执行该实际节点并使后续结果失效，保留前面的有效结果、原执行范围、模型快照与尝试历史；不自动识别任意业务字段为任务失败。目标必须存在，且运行已停止或失败。后续已有非幂等命令开始时拒绝重复，不绕过未知结果保护。原项目或快照变更仍须通过恢复检查，重试参数不放宽范围或检查点校验。

`failureContext.kind: "review"` 是任务完成后的审查失败；面板单独显示“改动审查”失败卡，已成功任务保留完成。全部任务为 `completed` 时，按已有授权重试使用 `workflow_resume({ id, revision })`，不追加 `retryFromTaskId`，以普通有效缓存回放重新生成审查。仍有失败或中断任务时，面板保留普通“继续”，恢复可能重新执行这些任务，不能承诺只重建审查。脚本业务结果失败和明确要求重新执行 worker 的情形仍使用节点重试，不混为同一动作。

`diff` 保留完整的 `files` 及应用校验 `fingerprint`。存储中的 `text` 最多保留 4 MiB 预览，工具读取默认再限制到 256 KiB；默认日志最多传输 128 KiB，维护审查不重复顶层差异文本。`previewTruncated: true` 明确表示文本不完整，`totalBytes` 是完整差异的字节数，`contentSha256` 是完整差异的 SHA-256。面板显示部分预览提示、完整字节数、摘要及完整文件清单。不能把预览摘要当作完整内容或声称已展示全部变更；有界传输不裁切保存的原始记录，应用仍核对完整差异，处理完整清单，而不是只处理预览文本。

外部 MCP 写入和结果不确定的命令不承诺 exactly-once。缺失返回值不能证明操作尚未生效。

`stopping` 表示仍在等待退出，`stopped` 表示已保存。任务取消作为实际失败处理；脚本可捕获，或由并行 API 返回 `null`。整个运行中断保留工作区，未完成任务恢复时重跑。

恢复按调用序校验输入、任务和执行范围，复用有效完成结果；第一个失败或指纹变化使后续缓存失效。跨项目复用必须创建新运行。项目变化、工作区缺失、锁和版本冲突按实际工具错误处理。

完成后统一检查差异、维护审查、测试输出和报告。聊天可在已有应用授权时调用 `workflow_apply`，无需再进入编辑器；面板按钮仍保留。冲突时不覆盖。应用成功、激活配置更新、宿主重新加载、工具版本验证、提交和发布是不同结果，分别核对与报告。

`application: "partial"` 表示已有部分应用，但仍有阶段未完成；可能是子模块应用尚未完成，也可能是仓库及子模块均已应用后激活失败。先用 `workflow_get_run` 核对应用记录、实际错误和当前项目状态，再以新读取的 revision 按已有授权重试 `workflow_apply`，核验已完成部分并继续未完成阶段。只有仓库及子模块均已应用、仅激活失败时，重试才只处理激活并核对配置版本。
