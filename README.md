# CodexPlugin

<img src="assets/marketplace-icon.png" alt="Codex Plugin Workspace 图标" width="64" height="64">

多个独立 Codex 插件的开发仓库。插件源码集中维护，各插件分别构建、安装和演进。

## 当前目录

```text
.agents/plugins/marketplace.json  本仓库的本地插件目录
plugins/
  design/                       本地设计画布、原型与 Codex 生成
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

## Design

`design 0.2.0` 开发版提供真实 HTML/React/TSX/CSS 设计项目：可运行交互预览、源码定位和窄范围属性修改、真实组件导入、设计系统、评论、历史恢复及自包含 HTML/源代码 ZIP 导出；本机有 Chromium 时可渲染 PNG/PDF。原有多画板图层编辑器继续保留。默认由当前聊天调用工具；可选独立模式通过本机 Codex app-server 沿用 ChatGPT 登录，不需要 API Key。

源码更新同时校验修订与文件哈希。组件静态打包、页面接入、编译、实际截图和交互验收分别验证；不把模板或通过结构检查当作设计完成。对标 Claude Design、Open Design 与 Huashu Design 的实际作品和完整工作流仍在迭代，当前未宣称体验对等或超越；Motion 的独立时间线与视频交付尚未实现。

```shell
codex plugin marketplace upgrade codex-plugin-workspace
codex plugin add design@codex-plugin-workspace
```

使用见 [Design 说明](plugins/design/README.md)。安装后需核对新聊天是否实际加载 `design_open_editor` 等工具。

## Workflows

`workflows 0.11.0` 使用 X6 画布与 ELK 自动布局，沿用单一结构化 JSON 定义与持久执行状态机。条件、循环、并行、异常处理、固定子流程和动态展开都显式声明；执行和面板来自同一棵流程树，实际状态由独立节点实例、尝试与跳转事件投影。删除旧 JavaScript 编排、源码推图和脚本重放。

0.10.0 起不兼容 0.9.x 及之前的脚本、定义、运行或检查点，不自动迁移或删除旧数据；0.11.0 沿用 0.10.0 的结构化存储格式。升级前应停止旧运行；安装成功不代表当前桌面聊天已重载。AI 通过工具创建和更新定义，用户无需编写脚本。定义可保存到库并在其他项目创建独立运行；面板固定当前项目聊天。

真实 worker 继续使用 Codex 原生工具与授权 MCP。本地、文件快照、独立 Git checkout 分别控制文件执行位置；文件写入、网络和工具范围独立授权。检查点保留当前代码并继续未完成实例；写入结果未知时先核对实际效果，不盲目重发。

使用见 [插件说明](plugins/workflows/README.md)，编排和接口见 [发布 Skill](plugins/workflows/skills/workflows/SKILL.md)，架构决策见 [0.10.0 设计方案](docs/workflows/execution-visualization-plan-2026-10-16.md)。工程研究和验证文档不作为插件执行依赖。
