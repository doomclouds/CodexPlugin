---
name: workflows
description: 根据用户需求创建、更新、保存和执行结构化工作流，支持条件、循环、并行、节点过程、检查点恢复和跨项目复用。
---

# Workflows

工作流只有一种协议：`schemaVersion: 1` 的结构化 JSON。执行器和面板使用同一流程树；不要生成 JavaScript 工作流、AST 标签、旧 `script` 字段或旧运行兼容方案。复杂业务交给 agent / command；编排关系必须显式声明。

先读实际工具返回，再根据需求操作。完整字段、表达式和示例见 [接口参考](references/runtime.md)。

## 先确认实际上下文

1. 调用 `workflow_get_capabilities`，核对当前聊天加载的版本和可用功能。安装成功不代表该连接已重载。
2. 调用 `workflow_get_projects`，确认真实项目归属。面板固定当前项目聊天，不用历史路径或目录存在性伪造绑定，不切换已有运行项目。
3. 读取已有定义和运行时，使用当前 revision 与实例 ID；不要按节点标题、数组位置或最后一次 Boolean 推断身份。

## 创建与执行

- 通过 `workflow_preview` 提交 `{projectPath, definition, args?, grants?, limits?, sourceDefinition?}`。preview 校验并保存，不执行。
- 定义格式为 `{schemaVersion:1,name,description,parameters?,steps}`。节点 ID 唯一；条件、循环、并行、异常和清理是显式结构。
- 用户已授权执行时，使用返回的 `id`、最新 `revision` 调用 `workflow_start`。只授权设计时先展示具体预览。
- 运行后用 `workflow_get_run` 和 `workflow_get_node_process` 查看真实状态；不要把预览、测试替身或工具启动说成模型已完成任务。
- 需要界面时用 `workflow_open_panel` 打开官方 MCP App 资源。localhost 仅供开发，不作为默认产品入口。

## 编排结构

`choice` 按声明顺序选择第一个为 true 的 case，否则进入 default；无更新等合法业务结果应由 choice 路由，不制造假失败。`parallel` 明确 fail-fast 或 all-settled；分支各自读取独立的已提交 JSON 数据上下文，文件读取仍面向同一执行工作区。`map` 开始时冻结集合与唯一 itemKey。`repeat` 明确 maxIterations，可选前测 while 或后测 until，不能两者并用。`try`、`catch`、`finally` 保留主错误和清理归属。

表达式仅支持 JSON、字段 ref 和受支持的 op，无 eval、文件访问、网络或隐藏任务调用。条件严格 boolean。下游读取已提交结果；分支内节点不能被分支外直接引用，外部读取容器 output。repeat.until 可读本轮 body 输出；while 不能引用尚未执行的本轮节点。

`subflow` 固定版本或内联定义；`expand` 只能生成同格式结构，校验并持久冻结后执行。展开权限是原 Run 授权子集，不能新增未经授权的命令、网络或写范围；恢复重用已冻结展开结果，不重新问模型换一条流程。

## 工具与权限

`agent` 使用真实 Codex 原生工具和明确授权的 MCP。不要只给用户 MCP 而忽略原生文件、命令和修改能力，也不要声称继承父聊天的专有 App/桌面工具。

Run 的 grants 分别声明 `allowWrite`、`networkAccess`、`allowedMcpServers`、`allowedMcpTools`、`workspaceMode`、`approvalMode`。默认不开写入和网络，MCP 默认为空。需要直接开发原项目时明确选择 local 并授权写入；需要先审查差异时选择 snapshot；需要完整 Git 历史时选择 git-worktree。

agent 默认 mode=read；写节点必须 mode=write，且 Run 允许写入。command 声明精确 argv 与 effect=read|write，不能借 read 标签执行写操作。MCP 白名单不代替工具本身审批；自动审核仍可能拒绝，不得切换工具、扩大范围或通过 finally 绕过拒绝。

普通工具调用错误返回同一 agent 上下文供模型纠正。schema 检查返回格式，accept 检查节点验收；maxRecoveryAttempts=0..2 控制有限的同线程结果修正。合法的否定业务结果不应被 schema 限制成只能成功。

## 保存、更新与复用

用户希望复用时，使用 `workflow_save_template` 保存结构、默认输入与默认授权，不绑定项目和执行结果。更新前读取定义 revision；新版本只影响新 Run，不改历史快照。已有运行要改任务结构，创建新预览，不能把执行过的 Run 偷换定义。

跨项目复用时在目标项目创建新 Run，携带真实 `sourceDefinition:{id,revision}` 和完全对应的 definition；不同项目不共享结果、缓存或工作区。库更新不使旧 Run 自动使用新版本。

## 过程与恢复

节点过程使用明确 instanceId 和 attemptId。循环每轮、map 每项、不同子流程 frame 都有独立身份。`workflow_get_run` 可用 `scopeInstanceId` 获取该次激活和后代的投影，不根据最后一轮状态覆盖其他仍在运行的实例。

恢复保留当前代码，先读当前 Run 和恢复预览，再用当前 revision 和确认指纹继续。状态机直接读取已提交实例、控制游标和输出，不重放 JavaScript。文件或产物漂移时报告实际阻碍，不重置指纹、删除检查点或伪造结果。写操作已派发而结果未知时先核对真实效果并记录证据，不能自动重发。

暂停停止新派发并等待稳定点；停止等待真实 worker 退出。停止或删除 local Run 不回滚原项目。重试绑定真实实例，既有后继写入不能自动撤销或重复。已接受操作后若详情读取失败，重新读取状态，不能自动再次发送操作。

## 删除与交付

只有用户授权删除后，先 `workflow_preview_deletion`，检查准确范围、关联运行和阻碍，再使用同目标和最新 fingerprint 调用 `workflow_delete`。授权范围未变时无需重复询问。只清理运行自有数据；原项目、用户文件和已经交付的改动不属于删除范围。旧版数据不因不兼容自动删除。

执行完成后核对真实产物、工具结果与未验证事项。snapshot/git-worktree 按已授权范围审查并应用；local 改动立即生效，无需应用。提交、推送、发布和部署依照用户具体授权。报告区分单元替身、协议、真实 worker、宿主加载和当前聊天版本。
