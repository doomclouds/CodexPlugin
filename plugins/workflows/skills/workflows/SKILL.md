---
name: workflows
description: 根据用户任务生成、保存并执行 Workflows 动态工作流，支持跨项目复用、并行 worker、维护操作、停止恢复和改动应用。
---

先调用 `workflow_get_capabilities`，按当前服务返回的版本与能力工作。不把本地构建、安装结果或测试替身当作当前聊天已加载的执行器。具体字段见技能内的 [接口与脚本参考](references/runtime.md)。

## 根据任务创建并执行

用户描述目标后，由代理生成脚本、输入和执行范围，再调用 `workflow_preview` 保存计划。用户不需要打开编辑器手写 JavaScript；面板用于查看计划、进度、报告、差异，也保留操作按钮。

核对目标项目、允许写入的范围、是否需要网络、MCP 服务及工具授权、工作区类型、维护命令和激活配置。用户已授权创建并执行时，用预览返回的 `id` 和当前 `revision` 调用 `workflow_start`；聊天调用不传 `leaseId`。不要把已有授权拆成重复确认。用户只要求规划时，完成预览，不自行开始。

执行中用 `workflow_get_run` 读取真实状态、任务尝试、日志、用量与结果；需要多个记录时用 `workflow_list_runs`。等待运行达到真实终态，处理实际失败原因，不返回虚构结果。用户要求停止或取消任务时调用 `workflow_stop` 或 `workflow_cancel_task`，等待退出。恢复使用新读取的版本调用 `workflow_resume`；聊天启动的运行不依赖面板保持打开。

脚本首条语句必须是纯字面量 `export const meta`，含小写短横线名称、非空描述和可选阶段。使用 `args`、`agent`、`parallel`、`pipeline`、`operation`、`phase`、`log` 及普通分支循环，最终返回有用结果。循环须有结束条件；不得直接调用 Node、文件、shell、网络、模块、定时器、时钟或随机数。

实际读取、命令执行和修改由 `agent` 内的真实 Codex worker 完成。worker 通过官方 app-server 使用原生文件读取、命令执行及补丁修改能力，并按授权复用配置的 MCP；JavaScript 只负责动态编排，不需要为每类实际任务增加插件代码或维护步骤。网络开放后，原生命令也可在授权范围内访问网络。桌面专有工具、Image Gen、原生 UI 和父聊天专有 apps 不等于 worker 全量继承。

默认只读。`agent` 写入任务使用 `{ mode: "write" }`，同时预览 `allowWrite: true`；只读任务可并行。`parallel` 接受函数数组，失败项返回 `null` 并记日志；`pipeline` 各输入独立推进，失败或 `null` 停止该输入后续阶段。直接 `await agent` 或 `await operation` 的错误可以捕获。结构化 worker 输出传 JSON `schema`，不要假设文本自动变为 JSON。

## 网络、工作区与维护

`networkAccess` 默认 `false`，与 `allowWrite` 独立。只读联网研究可保持 `allowWrite: false` 和 `agent` 默认只读模式，仅按授权打开 `networkAccess: true`；这不会开放文件写入。只有用户任务已授权相应网络访问时设置 `true`；维护步骤仍须声明自己的 `networkAccess: true` 才能联网。不能用命令、临时环境或其他工具绕过关闭的网络。worker 不隐式继承外部工具或父聊天能力。需要已配置的 MCP 时，在 `allowedMcpServers` 明确列出授权服务名称，并以 `allowedMcpTools` 按服务列出授权的实际工具名称；默认服务和工具均未开放。只使用现有配置工具的交集，不绕过审批。只读 worker 仅使用明确 `readOnlyHint: true` 的工具；写入 worker 也按工具授权限制。不包含 Workflows 自身，避免递归调度。父聊天专有 apps/连接器不属于用户 MCP 配置，不能声称已继承或可调用。

工作区默认 `workspaceMode: "snapshot"`。需要 Git 元数据的维护任务使用 `"git-worktree"`，并明确 Git 仓库根目录。写入首先在隔离工作区完成；已有工作区的运行不能通过更新输入扩大或改变执行范围，需要另建预览。包含 Git 子模块的写入使用 Git 模式；已初始化模块保留独立副本，未初始化模块保留提交和未初始化状态，不自动联网下载。确需初始化时，在计划中明确声明操作及网络授权。

`agent` 用于通用分析、编程及已授权 MCP 任务，不要求为每种需求修改插件或添加维护命令。`operation` 是可选的确定性维护能力，shell/build 维护需要 `allowWrite: true` 与 `workspaceMode: "git-worktree"`。通用只读联网任务不需要维护步骤。维护命令必须在 `maintenance.steps` 中预声明 `id` 和 `command` argv 数组。脚本只调用 `operation(stepId)`，不能提供新命令或拼接 shell。每步可声明网络访问、超时和有限重试。`idempotent` 默认 `false`，只有核对实际命令后才能显式声明重复执行不会新增副作用。`retries > 0` 需要 `idempotent: true`。已开始却未确认结果的非幂等 operation，恢复时拒绝自动重发；先核验实际效果，不能把“没有收到结果”当作“没有发生副作用”。以实际退出、输出、日志与审查结果判断完成，不把启动进程当作成功。

需要应用后激活 MCP 时，在 `maintenance.activation` 声明 `serverName`、可执行文件 `command` 和 `args`。插件路径参数使用 `${WORKSPACE}`，由运行时替换为本次保留工作区；不能固化开发者机器目录。只运行已声明的激活配置。配置更新或进程启动不等于当前宿主已经重载；`pending_restart` 仍需宿主重新加载及实际版本核对，只有 `verified` 才可称激活已验证。

## 保存、复用与恢复

用 `workflow_list_templates`、`workflow_get_template` 查看内置或保存的定义。用户希望复用时，用 `workflow_save_template` 保存脚本、默认输入、写入和网络范围、MCP 服务和工具授权、工作区类型、维护计划及限制。定义不绑定项目或运行结果；ID 为 `saved:<meta.name>`，更新前读取当前定义版本。

同一定义为不同项目创建独立预览，不借用另一项目的缓存或工作区。库定义更新不自动更改历史运行。恢复重放脚本，复用有效结果，重跑中断任务；按实际缓存失效和范围检查结果处理。快照缺失、项目变更或版本冲突时，不静默重建后声称已恢复。外部 MCP 写入及未知结果没有 exactly-once 保证，应核对实际状态后继续。

## 审查、应用与交付

执行完成后检查真实 worker 报告、维护输出、测试结果和统一差异，保留未验证事项。用户已授权应用改动时，用当前 `revision` 调用 `workflow_apply`；授权仅涵盖规划或执行时，先提供具体差异再请求应用授权。面板也可审查和应用。

`application: "partial"` 表示已有部分应用，但仍有阶段未完成；可能是子模块应用尚未完成，也可能是仓库及子模块均已应用后激活失败。用 `workflow_get_run` 核对应用记录、实际错误和当前项目状态，读取新的 revision 后按已有授权重试 `workflow_apply`，核验已完成部分并继续未完成阶段。只有仓库及子模块均已应用、仅激活失败时，重试才只处理激活。

基线、范围或审查指纹变化时按工具冲突处理，不自动覆盖。应用、激活配置更新、宿主重载和版本验证分别报告。提交、推送、发布和部署按用户具体授权执行；已有授权不重复询问。

优先使用真实 MCP 工具与 MCP App 面板；localhost 仅供开发预览。主题和字体继承宿主。报告须区分协议测试、测试替身、真实 worker 执行及当前宿主验证。
