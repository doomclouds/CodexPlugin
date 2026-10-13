# Workflows

动态工作流插件的基础骨架。目标是根据任务生成编排脚本，并在运行中按结果动态调度 worker。当前只实现可验证的插件目录、技能入口和 MCP 查询服务。

## 已实现

| MCP 工具 | 行为 |
| --- | --- |
| `workflow_get_capabilities` | 返回当前实现能力及待定设计；执行能力明确为 `false` |
| `workflow_list_templates` | 列出内置工作流示例 |
| `workflow_get_template` | 按目录 ID 读取示例脚本，不执行脚本 |

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

## 设计方向

已确认使用插件任务面板，支持停止与任务级恢复。第一版允许多个只读 worker 并行，以及 1 个使用独立工作区的写入 worker；可以修改代码和运行测试。关闭 App 时停止并保存进度，重新打开后由用户手动恢复。

开始前先展示动态脚本和计划，由用户点击“开始”；全部执行结束后统一展示差异、测试结果和 worker 报告，由用户点击“应用”，不自动合入当前项目。

具体规则和待定事项见 [动态工作流设计记录](docs/design.md)。当前建议通过 Codex app-server 管理独立 worker；面板布局、宿主 UI 入口和改动汇合的具体机制仍待确定。

当前没有 `workflow_run` 工具、真实执行器或任务面板，查询工具不会执行示例脚本。
