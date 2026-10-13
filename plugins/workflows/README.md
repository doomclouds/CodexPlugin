# Workflows

工作流插件的基础骨架。当前目标是让插件目录、技能入口和 MCP 服务可验证，供后续产品讨论使用。

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

## 待沟通的产品边界

已确认第一版交互方向：插件任务面板，可查看每个 worker，支持停止和恢复。下面是执行归属的技术比较；独立 worker 是当前建议，执行实现仍待讨论。

- **当前聊天管理原生子代理**：Skill 引导当前聊天进行委派，插件提供模板、运行记录或辅助工具。上下文衔接直接，但插件不能假定它获得原生子代理调度器的完整控制权。
- **插件管理独立 worker**：本地服务通过 Codex app-server 驱动 worker 会话，自行实现并发、结果传递、取消、日志和恢复。更适合确定性脚本执行；上下文、工具、权限和界面需要明确适配。

界面与执行器分别设计。可以先提供工具结果；需要任务面板时，选择经目标宿主验证的 MCP App 入口或本地浏览器。标准插件不能预先承诺改造 Codex 原生子代理卡片或任意 App Tab。

离开聊天或关闭 App 后是否继续运行、自动重试和并行编辑的具体行为尚未决定。停止与恢复是已确认的产品目标，当前尚未实现。当前没有 `workflow_run` 工具，没有虚构代理适配器或模拟执行结果。
