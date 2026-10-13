# CodexPlugin

多个独立 Codex 插件的开发仓库。插件源码集中维护，各插件分别构建、安装和演进。

## 当前目录

```text
.agents/plugins/marketplace.json  本仓库的本地插件目录
plugins/
  workflows/                    第一个插件：工作流基础骨架
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
```

`dev:workflows` 启动 stdio MCP 服务，等待 MCP 客户端发送请求，没有网页界面。`npm run check` 执行类型检查、构建、仓库结构检查及插件的协议冒烟验证。

单独构建插件：

```powershell
npm run build --workspace=@codex-plugin/workflows
```

## 新增插件

1. 在 `plugins/<name>/` 创建插件，名称使用小写短横线形式。
2. 添加 `plugin.json` 和所需技能。需要本地服务时，再添加 `mcp.json`、源代码及自己的 `package.json`；运行入口必须对应实际构建产物。
3. 在 `.agents/plugins/marketplace.json` 增加条目。`source.path` 从仓库根目录解析，例如 `./plugins/<name>`。
4. 给有运行时的插件提供 `build`、`typecheck` 和必要的 `smoke` 脚本，运行相关检查。

市场文件只描述可安装的插件，创建它不会安装插件或修改用户配置。各插件的 `runtime/` 是随 Git 提交的自包含运行包，GitHub 安装不需要在宿主运行 npm install 或构建。修改源代码后先构建、验证，再与运行包一起提交。

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

已实现模板列表、脚本读取和当前能力查询。真实代理执行、恢复日志和 UI 尚未接入。使用方式与后续设计见 [插件说明](plugins/workflows/README.md)；宿主扩展边界见 [能力核对](docs/codex-extension-boundaries.md)。
