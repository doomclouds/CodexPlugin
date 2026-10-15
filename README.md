# CodexPlugin

<img src="assets/marketplace-icon.png" alt="Codex Plugin Workspace 图标" width="64" height="64">

多个独立 Codex 插件的开发仓库。插件源码集中维护，各插件分别构建、安装和演进。

## 当前目录

```text
.agents/plugins/marketplace.json  本仓库的本地插件目录
plugins/
  workflows/                    动态工作流、独立定义库与任务面板
scripts/validate-plugins.mjs     清单、目录和组件路径检查
docs/codex-extension-boundaries.md  宿主能力与产品讨论依据
```

每个插件使用根级 `plugin.json`、可选的 `mcp.json` 和 `skills/`。运行时源码放在该插件内部。真正需要复用的实现出现后，再提取共享包。

## 开发

需要 Node.js 22 或更新版本，以及 npm。项目当前使用 TypeScript、esbuild 和 npm workspaces；提交的锁文件固定依赖。MCP 构建产物打包运行依赖，复制插件时无需携带根目录的 `node_modules`。

```powershell
npm ci --ignore-scripts
npm run check
npm run dev:workflows
npm run prototype:workflows
```

`dev:workflows` 启动 stdio MCP 服务。`prototype:workflows` 是开发用的布局预览；真实面板通过 MCP App 资源与宿主工具调用接入。`npm run check` 执行类型、构建、结构、独立 MCP 包和运行时、文件、模板、面板检查，测试替身不调用模型。可选 `npm run smoke:real --workspace=@codex-plugin/workflows` 调用真实模型验证完整流程。

单独构建插件：

```powershell
npm run build --workspace=@codex-plugin/workflows
```

## 新增插件

1. 在 `plugins/<name>/` 创建插件，名称使用小写短横线形式。
2. 添加 `plugin.json` 和所需技能。需要本地服务时，再添加 `mcp.json`、源代码及自己的 `package.json`；运行入口必须对应实际构建产物。
3. 在 `.agents/plugins/marketplace.json` 增加条目。`source.path` 从仓库根目录解析，例如 `./plugins/<name>`。
4. 给有运行时的插件提供 `build`、`typecheck` 和必要的 `smoke` 脚本，运行相关检查。

市场文件只描述可安装的插件，创建它不会安装插件或修改用户配置。各插件的 `runtime/` 是随 Git 提交的自包含运行包，GitHub 安装不需要在宿主运行 npm install 或构建。发布插件文件的变化时，保持插件清单、package.json 和 MCP serverInfo 版本一致并递增版本；先构建、验证，再与运行包一起提交，避免复用旧安装缓存。

## 从 GitHub 安装和同步

使用 GitHub 市场源，不从本地开发目录安装：

```powershell
codex plugin marketplace add doomclouds/CodexPlugin --ref main
codex plugin add workflows@codex-plugin-workspace
```

更新远端市场后，重新安装对应插件以刷新运行包：

```powershell
codex plugin marketplace upgrade codex-plugin-workspace
codex plugin add workflows@codex-plugin-workspace
```

新增工具在当前 App 中是否立即可用，应以宿主实际加载结果为准；CLI 安装成功和当前聊天已加载是两项验证。

## Workflows

`workflows 0.9.0` 支持从面板选择工作流、填写其声明的可选或必填参数，再启动、停止和恢复执行。流程图展示节点的实际状态；插件默认模型与思考深度可修改，节点可单独覆盖。真实 worker 使用原生 Codex 工具与已授权 MCP。网络、文件写入与工具范围分别声明。支持文件快照、完整独立 Git checkout，以及直接修改原项目的本地模式；隔离模式结束后审查并按授权应用，本地模式改动立即生效。具体业务由工作流表达，不为每种任务增加专用插件代码。

从项目聊天打开 Workflows；插件不提供主窗口侧栏的全局入口。面板固定使用当前聊天所属项目，不能切换目录。独立工作流库保存脚本和默认输入，不绑定项目；跨项目复用时，在目标项目聊天中载入定义并创建独立运行。没有参数声明的工作流可以直接启动。面板按宿主上下文继承主题、样式变量、字体与字号。宿主尚未提供主对话模型与思考深度，未配置的节点使用运行开始时记录的工作流默认值。

0.2.1 使用固定面板资源地址并在启动时缓存 HTML，兼容旧版地址，防止升级删除旧缓存后面板资源不可读。仍连接 0.1.4 的宿主必须重新加载服务。故障与修复范围见 [升级修复记录](docs/workflows-panel-upgrade-fix.md)。

商城与插件图标使用 Image Gen 生成，资产和提示词见 [图标说明](assets/icon-prompts.md)。Workflows 图标已接入插件清单。当前 Codex 的“市场”来源列表固定显示通用图标，市场接口只提供显示名称；仓库商城图标用于仓库及产品展示素材，不能替换该列表图标。

使用见 [插件说明](plugins/workflows/README.md)，深入分析见 [Claude 实现研究](docs/workflows/claude-implementation-analysis-2026.md)，开发记录见 [设计记录](docs/workflows/design.md) 与 [运行时设计](docs/workflows/runtime-design.md)，Claude 依据及差异见 [参考说明](docs/workflows/claude-reference.md)。宿主扩展边界见 [能力核对](docs/codex-extension-boundaries.md)。

[0.2.0 验证记录](docs/workflows-0.2-verification.md) 区分自动测试与本机真实执行；[主题检查](design-qa.md) 记录开发浏览器的样式与窄窗口验证。[旧宿主记录](docs/mcp-app-host-verification.md) 只适用于 0.1.4 原型，不能证明新版原生宿主验收。构建与检查不会自动安装或提交推送；这些动作按用户请求执行。

[0.4 系列验证记录](docs/workflows-0.4-verification.md) 记录参数、节点设置、真实 worker 与各次定向检查的范围。

[0.5.5 验证记录](docs/workflows/0.5.5-verification.md) 记录项目聊天入口、失败结果检查、停止原因和只读命令诊断的验证范围。

[0.5.6 验证记录](docs/workflows/0.5.6-verification.md) 记录隔离维护的逐步骤保护目录授权和删除路径别名修复。

[0.5.7 验证记录](docs/workflows/0.5.7-verification.md) 记录大差异的完整校验、有界预览及审查失败恢复。

[0.5.8 验证记录](docs/workflows/0.5.8-verification.md) 记录有界 MCP 视图、历史与产物分页以及完整状态保护。

[0.5.9 验证记录](docs/workflows/0.5.9-verification.md) 记录新聊天缺少 projectId 时的可信目录归属修复。

[0.5.10 验证记录](docs/workflows/0.5.10-verification.md) 记录项目运行下拉框和删除后的状态同步修复。

[0.6.0 验证记录](docs/workflows/0.6.0-verification.md) 记录本地原地修改、模式选择、检查点恢复与删除边界。

[0.6.1 验证记录](docs/workflows/0.6.1-verification.md) 记录普通目录中嵌套 Git 仓库的恢复边界补丁。

[0.6.2 验证记录](docs/workflows/0.6.2-verification.md) 记录节点 MCP 授权、慢同步续租及实时节点日志修复。

[0.6.3 验证记录](docs/workflows/0.6.3-verification.md) 记录本地检查点的内部 Git 引用隔离、严格旧版校验与重新检查入口。

[0.6.4 验证记录](docs/workflows/0.6.4-verification.md) 记录本地 Git 元数据写入授权，以及无新代码仍继续构建的真实执行验证。

[0.6.5 验证记录](docs/workflows/0.6.5-verification.md) 记录 MCP 失败诊断保留与当前节点执行范围提示。

[0.6.6 验证记录](docs/workflows/0.6.6-verification.md) 记录原生自动审核、审批方式选择与拒绝后停止的验证范围。

[0.7.0 设计与验证](docs/workflows/0.7.0-verification.md) 记录同节点工具纠错、有限结果恢复、命令证据和原始失败来源；[Claude Code 对照研究](docs/workflows/claude-reliability-2026-10-15.md) 区分静态证据与实现取舍。

[0.8.0 节点检查点验证](docs/workflows/0.8.0-verification.md) 记录稳定边界落盘、恢复预览、历史尝试和意外退出测试；[Claude Code 检查点研究](docs/workflows/claude-checkpoint-2026-10-15.md) 区分进度恢复与文件回退。

[0.9.0 控制流与进程验证](docs/workflows/0.9.0-verification.md) 记录真实分支与循环观测、右侧节点过程、全屏入口和服务生命周期；[浏览器验收](docs/workflows/0.9.0-design-qa.md) 区分概念图、替身 worker 与真实交互。
