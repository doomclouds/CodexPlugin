# 本机 MCP App 面板验证

验证日期：2026-10-13。插件版本：`workflows 0.1.4`，来源为 GitHub 市场 `doomclouds/CodexPlugin`。当前面板是示例数据交互原型，未接入真实 worker。

## 已验证的范围

- 类型检查、构建、独立运行包启动及 MCP 协议验证通过。
- `workflow_open_panel` 返回只读原型信息，工具元数据声明 `global` 与 `thread` 入口。
- `resources/read` 返回 `ui://workflows/prototype/0.1.4.html`，MIME 为 `text/html;profile=mcp-app`，资源包含自包含的面板和标准 MCP Apps 客户端。
- 浏览器开发预览验证了动态新增任务、停止收尾、手动恢复与结果复用、最终差异审查、示例应用与冲突。320px 窄窗口未发现横向溢出。

## App 内嵌加载

已通过本机 App 主日志确认以下实际链路：

```text
插件深链
→ /mcp-app/workflows/workflow_open_panel
→ workflow_open_panel 工具调用完成
→ ui://workflows/prototype/0.1.4.html 资源读取成功
→ sandbox_requested
→ guest_attached
→ widget_frame_committed
→ widget_running
```

对应事件标明 `conversationSurface=codex`、`displayMode=fullscreen`、`server=workflows`。这是 App 内的插件视图，不是 localhost 浏览器页面。

该全局视图使用自己的内部会话，当前聊天的 CUA MCP Apps 列表没有暴露该页面，因此空列表不能当作加载失败证据。原始 App 日志没有加入仓库。

当前可打开的入口：

```text
codex://plugins/workflows%40codex-plugin-workspace/app/workflow_open_panel?path=%2F
```

## 尚未验证或实现

- App 内的像素、按钮点击和 `ui/initialize` 的完整交互尚未单独验证。`widget_running` 不能代替这些验证。
- `thread` 会话侧栏入口已注册，但实际通过侧栏菜单打开仍需验证。
- 真实代理、工作区写入、停止／保存、持久化恢复和应用改动尚未实现。原型只模拟内存状态；它不修改真实文件。

结论限于本机当前安装包及该版本资源。后续宿主或插件版本变化，仍需检查相应入口与交互。
