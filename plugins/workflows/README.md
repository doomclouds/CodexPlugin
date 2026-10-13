# Workflows

<img src="assets/workflows-icon.png" alt="Workflows 产品图标" width="64" height="64">

`0.3.0` 让 Agent 根据任务创建和执行动态工作流。JavaScript 表达分支、循环、并行和按结果调度；真实 Codex worker 使用原生文件、命令和修改工具，以及本次授权的 MCP。运行可保存、停止、恢复、审查和跨项目复用。

需要 Node.js 22 或更新版本、支持 `app-server` 的 Codex CLI 和已有登录。安装版本与当前聊天实际加载的版本分别核对。插件不接管用户登录。

## 使用

1. 描述任务、目标项目和允许的操作。Agent 生成脚本、输入与执行范围，通过 `workflow_preview` 保存计划。预览不执行。
2. 已要求执行时，Agent 使用 `workflow_start` 启动；只要求方案时等待执行授权。无需打开面板手写脚本。
3. 用 `workflow_get_run` 或 Workflows 面板查看真实任务、日志与结果。需要停止时调用 `workflow_stop`，它等待实际 worker 退出后保存进度。
4. 重新打开只读取记录。明确要求继续时，Agent 用当前 revision 调用 `workflow_resume`。项目或维护产物变化可能使缓存无法安全重放，此时需要新预览。
5. 执行完成后审查差异和实际验证结果。在已授权的应用范围内调用 `workflow_apply`；也可以在面板中审查并操作。冲突保留当前项目，不覆盖后续编辑。

高级脚本编辑保留在面板中。目标目录由用户输入或宿主上下文提供，不从插件启动目录猜测。聊天启动不要求面板租约；面板启动绑定其生命周期，租约丢失会停止对应运行。

## 可表达的任务与工具

脚本通过 `agent()` 请求真实任务，代理可以读取项目、分析代码、运行命令、修改代码并测试。网络授权与文件写入授权分别声明；网络权限不代表发送消息、发布、部署或修改外部数据的业务授权。

外部 MCP 通过 `allowedMcpServers` 声明，`allowedMcpTools` 可进一步指定工具。有效集合保留用户已有的 allow/deny 和审批限制。只读文件沙箱不能让外部 MCP 自动只读；只读 worker 仅开放有只读声明的 MCP 工具，声明仍依赖服务端身份与实际权限。

这些能力足以组合审查与核实、批量处理、按发现修复和测试、联网研究、依赖构建和 Git 维护。具体命令、规则和结束条件是每次工作流的输入，不需要针对每种业务修改插件代码。独立 app-server 不能自动取得父桌面聊天的全部专属 apps、Image Gen、界面控制或交互式权限回调；缺少能力时明确报告，不返回模拟结果。

```javascript
export const meta = {
  name: "review-files",
  description: "逐文件审查，再核实和汇总问题",
  phases: [{ title: "审查" }, { title: "汇总" }],
};
const findings = await pipeline(args.files, file =>
  agent(`只读审查 ${file}，返回有证据的问题。`, { label: file }),
);
phase("汇总");
return await agent(`核实并汇总：${JSON.stringify(findings.filter(Boolean))}`);
```

`parallel()` 等待各任务并保留输入顺序，失败项为 `null`；`pipeline()` 按条目独立推进，`null` 停止该条目。直接 `agent()` 失败可以在脚本中捕获。脚本本身运行于 Worker 内的 QuickJS WASM，只使用编排 API；实际工具由代理执行，脚本不直接访问 Node、文件或网络。时钟和随机数禁用，以保持重放确定性。

## 工作流库与跨项目复用

`workflow_save_template` 保存脚本、默认输入、默认范围和限制，不绑定项目、结果或工作区。定义 ID 为 `saved:<meta.name>`，更新需要当前 revision。`workflow_list_templates` 和 `workflow_get_template` 读取内置与用户定义。对同一个定义，分别指定项目 A 和 B 创建独立运行，缓存和改动互不共享。

保存定义不会开始执行，修改定义不会替换已有运行。当前没有定义删除、导入导出或远端同步入口。运行时项目路径只写入用户的数据目录，不写回发布插件。

## 工作区、维护与应用

默认 `workspaceMode: "snapshot"`：写入先在独立文件快照进行，最终按基线检查并应用文件改动。该模式保留已有编辑，不保留完整 Git 历史，不用来拉取分支。

`workspaceMode: "git-worktree"`：为干净 Git 仓库创建包含历史、分支与远端配置的独立 checkout。它拥有自己的 `.git`，不共享原仓库的可写元数据。维护操作使用此模式；完成后核对原分支与 HEAD 基线，只快进到已经验证的提交，不重新查询浮动远端。未提交的源码改动不会被插件自动提交。

可选的 `maintenance.steps` 定义精确 argv、联网范围、超时和最多两次临时网络重试。脚本用 `await operation("step-id")` 执行；未声明的操作拒绝执行。自动重试须明确声明 `idempotent: true`。已开始但结果不确定的非幂等命令不会在恢复时重新发送，须核对实际效果后调整计划。此 API 用于需要确定命令的步骤，普通代理任务不要求声明全部 shell 命令。

`maintenance.activation` 可在审查后更新一个已有 stdio MCP 的 command/args。`${WORKSPACE}` 解析为保留的独立 checkout，构建产物经指纹检查。配置前像与私有备份保存在运行目录，以版本 CAS 写入，保留该服务器其他字段；不能安全回滚时明确失败。

仓库快进与配置激活是两个阶段。激活失败时状态为 `partial`，审查后可以重试尚未完成的激活。配置写入成功不代表当前桌面连接已刷新，状态为 `pending_restart`；应重新加载并核对实际服务身份，再判断是否生效。插件不把新进程探测当成父聊天已更新。

任意外部副作用无法承诺恰好执行一次。中断时应检查实际后置条件、固定提交与产物；非幂等远端写入需使用服务端幂等机制或明确核验，不能盲目重试。

## 保存位置

默认数据根目录由当前用户主目录解析为 `~/.local/state/codex-workflows`，可以通过 `WORKFLOWS_DATA_DIR` 指定。

- `templates/`：用户工作流定义。
- `wf_<id>/run.json`：脚本、输入、范围、状态、任务、尝试、结果与日志。
- 各运行目录：快照或 Git checkout、基线、应用事务、激活备份与控制请求。

这些是用户运行数据，不是发布包的一部分。构建产物被激活引用时，不能删除对应运行工作区。结果和日志可能包含项目内容，应按项目数据管理。

## 验证与开发

```shell
npm run typecheck
npm run build
npm run smoke
npm run smoke:real
node --experimental-strip-types scripts/real-protocol-smoke.ts --real-workers
```

普通检查不调用模型。两个真实验证入口显式调用已登录 Codex 的默认模型；协议验证使用一次性仓库与私有临时配置，检查原生工具、授权 MCP、拉取、联网安装、构建、停止恢复、持久化和审查应用，不修改用户真实 MCP 配置。测试环境目录按系统 API 创建，没有固化开发者目录。

`runtime/` 包含自包含服务与脚本执行器，面板由 MCP App 资源打开。开发用 localhost 预览不代表原生宿主验收。更新后旧进程缓存面板、脚本执行器与内置定义，避免删除旧安装目录导致运行资源失效；新的能力仍须重新加载新版服务后才能使用。
