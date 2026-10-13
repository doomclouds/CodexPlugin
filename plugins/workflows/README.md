# Workflows

动态工作流插件的基础骨架。目标是根据任务生成编排脚本，并在运行中按结果动态调度 worker。当前实现 MCP 查询服务，以及使用示例数据的面板原型；真实执行器尚未接入。

## 已实现

| MCP 工具 | 行为 |
| --- | --- |
| `workflow_get_capabilities` | 返回当前实现能力及待定设计；执行能力明确为 `false` |
| `workflow_list_templates` | 列出内置工作流示例 |
| `workflow_get_template` | 按目录 ID 读取示例脚本，不执行脚本 |
| `workflow_open_panel` | 返回 MCP App 面板原型，按钮只演示本地状态，不启动代理或修改文件 |

`skills/workflows/SKILL.md` 引导 Codex 查看模板和起草工作流。示例放在 `workflows/review-changes.workflow.js`，展示审查、核实和汇总的编排思路。

示例使用 Claude 风格的 `export const meta` 加脚本体，并含顶层 `return`；这是需要专门运行时处理的 DSL 草案，不是可直接用 Node 执行的 ES module。它的语法还不是本项目最终契约。

## 构建与验证

从仓库根目录执行：

```powershell
npm ci --ignore-scripts
npm run check
```

esbuild 将运行依赖打包为 `runtime/index.js`，`mcp.json` 使用 `${PLUGIN_ROOT}` 定位这个真实入口。运行包与源代码一同提交到 GitHub，供远端市场安装直接使用。源码和构建产物均从自身文件位置定位模板，不依赖宿主工作目录。分发时保留 `plugin.json`、`mcp.json`、`package.json`、`runtime/`、`skills/` 和 `workflows/`；不需要打包 `node_modules`。

协议冒烟验证将构建产物复制到仓库外、不含依赖的临时目录，启动真实子进程，检查工具发现、目录读取、能力返回和未知 ID。验证不调用模型，不读取登录凭据，也不安装插件。

## 面板原型与宿主入口

面板使用“概览、任务、差异、日志”四个区域；示例覆盖待开始、运行、停止与恢复、执行完成、应用和冲突。全部交互使用内存示例数据，不是实际任务运行记录。状态草案见 [面板与状态](docs/panel-state.md)。

插件通过 `ui://workflows/prototype/0.1.3.html` 提供自包含 MCP App 资源，MIME 为 `text/html;profile=mcp-app`，声明会话面板与全局插件入口。宿主读取资源并在 iframe 中承载，标准 `App.connect()` 完成握手；这不是修改 Codex 原生子代理卡片的接口。App 入口是否实际可用，以宿主验证为准。

开发时可以运行以下命令，从输出的 loopback 地址预览。这个临时网页只用于开发与布局检查，不是正式面板的默认打开方式：

```powershell
npm run prototype:workflows
```

## 设计方向

已确认使用插件任务面板，支持停止与任务级恢复。第一版允许多个只读 worker 并行，以及 1 个使用独立工作区的写入 worker；可以修改代码和运行测试。关闭 App 时停止并保存进度，重新打开后由用户手动恢复。

开始前先展示动态脚本和计划，由用户点击“开始”；全部执行结束后统一展示差异、测试结果和 worker 报告，由用户点击“应用”，不自动合入当前项目。

具体规则和待定事项见 [动态工作流设计记录](docs/design.md)。当前建议通过 Codex app-server 管理独立 worker；面板布局、宿主 UI 入口和改动汇合的具体机制仍待确定。

当前没有 `workflow_run` 工具、真实执行器或真实任务面板数据。面板的“开始、停止、恢复、应用”按钮仅用于交互原型。
