# Codex 插件的宿主扩展边界

核对日期：2026-10-13。依据为公开文档和本地 CLI 帮助；基础插件已从 GitHub 市场安装并启用，安装缓存中的 MCP 服务已验证。当前聊天的新增工具加载和 App 内 UI 入口尚未验证。

## 子代理：行为与显示是两层能力

自定义 agent 配置支持角色名称、说明、指令、模型及部分运行设置，配置位置包括 `.codex/agents/`。Skill 可以引导主聊天委派任务。这属于代理行为配置，不是修改原生卡片的渲染接口；插件清单如何分发这些配置，需要另行核对。[官方 Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

Hooks 包含 `SubagentStart`、`SubagentStop`，可以补充上下文。`statusMessage` 描述 hook 运行中的状态文字，不能当成向子代理卡片添加任意字段的接口。[官方 Hooks](https://learn.chatgpt.com/docs/hooks)

本次未找到公开的接口，允许插件替换原生子代理卡片布局、颜色或聊天 renderer。因此，本项目不把这些能力纳入已支持范围；这不等于证明宿主内部没有实现。

## Tab 和自有 UI

OpenAI 提供 MCP Apps 与 Extensions。插件注册自己的 UI resource，通过 UI bridge 交互；Extensions 的 `global`、`thread`、`file` 入口分别对应全局插件入口、会话内容 Tab 和文件查看器。它们允许添加自有界面，不能据此推出可以改写任意 App Tab。[Extensions 文档](https://developers.openai.com/plugins/build/extensions)

官方规范的 Platform Support 以 ChatGPT Work、Desktop 和移动端为对象，没有单列独立 Codex App。规范包含 `codex://` 深链，而当前 ChatGPT Desktop 文档说明保留该 scheme 是兼容行为。因此，不能仅凭深链或 Desktop 一词确认用户当前 App 支持全部入口。工作流面板的内嵌位置需要实机验证，设计上保留本地浏览器承载方式。[支持表](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#platform-support)、[深链说明](https://learn.chatgpt.com/docs/app/commands#deep-links)

当前会话另有 `codex-app-tools` 提供的 `open_in_codex` 工具，可打开文件、浏览器、终端和审查面板。Skill 可以在这些工具可用时协作使用；这是已安装插件提供的有限宿主操作，不是任意第三方 MCP 服务注册或替换原生组件的通用接口。

## 状态和执行接口

Codex app-server 提供 `thread/start`、`thread/resume`、`thread/fork`、`turn/start` 和 `turn/interrupt`；`outputSchema` 支持结构化结果。`thread/status/changed`、`turn/completed`、`item/*`、`thread/tokenUsage/updated` 可以驱动插件自己管理的任务面板，`thread/name/set` 可修改其管理的线程名称。[官方 App-server](https://learn.chatgpt.com/docs/app-server)

app-server 的执行事件不等于向现有 App 注入 UI。独立 worker 会话也不会自动成为当前聊天中的原生子代理卡片。插件需要明确来源上下文、工具、权限、工作目录及状态归属。

## 与 DeepSeek Harness 的区别

DeepSeek Harness 公开 Web Client slots，可使用 `ctx.slots.register()` 和 `ctx.slots.inject()` 向宿主插槽贡献组件；右侧 Sidebar 还有 Tab 注册及导航接口。它开放的是宿主组件插槽，扩展层次比 OpenAI 的插件 UI resource 和预设 entrypoint 更深。[Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)、[右侧 Sidebar](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right)

不能把“一切皆插件”的组件替换能力当作 Codex 插件现有能力。当前适合本项目的边界是：插件拥有自己的执行器、状态模型和可选界面，使用文档支持的宿主入口进行连接。

## 第一项产品决定

选择工作流中的代理由谁管理：

1. 主聊天委派原生子代理：上下文衔接直接，插件辅助编排与记录；完整脚本调度、取消和恢复需要验证控制能力。
2. 插件通过 app-server 管理独立 worker：适合并发、结构化结果、日志和恢复；需要实现上下文、权限及 UI 适配。

用户已选择第一版采用插件任务面板，支持多个只读 worker 并行和 1 个隔离的写入 worker。停止或关闭 App 时中断运行并保存进度，之后由用户手动恢复。当前建议由插件管理独立 worker；详细规则见 [动态工作流设计记录](../plugins/workflows/docs/design.md)。基础模板尚未接入代理执行或原生 UI 注入。
