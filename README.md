# CodexPlugin

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

`workflows 0.2.0` 已接入第一版动态执行器：预览 JavaScript 后在插件面板开始，按结果分支、循环并调度真实 Codex worker；停止后保存并手动恢复。写入在独立快照完成，全部结束后统一审查，用户点击应用才修改项目。

独立工作流库保存脚本和默认输入，不绑定项目；同一定义可以为多个项目创建独立运行。面板按宿主上下文继承主题、样式变量、字体与字号。

使用见 [插件说明](plugins/workflows/README.md)，规则见 [设计记录](plugins/workflows/docs/design.md) 与 [运行时设计](plugins/workflows/docs/runtime-design.md)，Claude 依据及差异见 [参考说明](plugins/workflows/docs/claude-reference.md)。宿主扩展边界见 [能力核对](docs/codex-extension-boundaries.md)。

[0.2.0 验证记录](docs/workflows-0.2-verification.md) 区分自动测试与本机真实执行；[主题检查](design-qa.md) 记录开发浏览器的样式与窄窗口验证。[旧宿主记录](docs/mcp-app-host-verification.md) 只适用于 0.1.4 原型，不能证明新版原生宿主验收。本次开发和检查不包含安装插件、修改用户配置、提交或推送。
