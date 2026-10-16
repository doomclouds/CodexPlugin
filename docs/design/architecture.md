# Design 产品与架构

## 产品目标

用本地 Codex 完成从需求、设计系统和素材到可编辑设计、交互原型、工程文件与导出的闭环。对标 Claude Design 的核心工作方式，不依赖其私有服务或代码。

## 模型与登录

默认使用当前聊天。Skill 引导宿主模型读取项目、调用修改工具，MCP App 把选中元素、评论和需求返回当前聊天。该模式不启动额外模型会话，不接管登录。

可选独立模式使用本机 Codex app-server 的 stdio 协议、已有登录和真实模型目录。模型只生成经过验证的设计修改提案；服务端核对基础 revision 后才应用。模型任务、持久化和编辑器是不同层，模型完成不等于提案已经应用。

合作伙伴的 Sign in with ChatGPT 是外部应用的 OAuth 与套餐授权路径。当前插件已运行在本地 Codex 内，采用宿主聊天和已有 Codex 登录更直接；不实现额外 OAuth、API Key 或远端 ChatGPT MCP 服务。

## 数据与编辑

JSON 文档是唯一设计来源，使用稳定元素 ID、多个画板、嵌套节点、组件实例、令牌和评论。画布操作和模型操作都使用同一批量 JSON Patch 与 revision 检查，验证后原子保存。撤销、重做和历史恢复产生可审查状态，不依赖重新调用模型。

HTML、SVG、图像、PDF 和工程包均由同一文档生成。工程同步导出带有稳定元素 ID 与原始文档的 HTML；导入时读取可表达的文字、样式和位置修改，拒绝把任意代码视为完整双向设计模型。未知代码、复杂组件和框架工程通过当前 Codex 聊天分析，不伪称能够无损导入。

## 宿主边界

MCP 提供模型可调用的设计操作，MCP App 提供插件自己的画布界面。可用宿主上下文与消息接口将用户需求交给当前聊天；不支持时提供明确可复制需求，不显示虚构的已发送状态。CLI 仍可通过工具操作设计。

本地发布使用根级 plugin.json、mcp.json、skills 和自包含 runtime。所有发布引用在脱离开发仓库的目录检查。安装、推送和部署不属于本次本地开发与验证。

## 验证层次

分别验证文档与并发存储、真实渲染与源同步、隔离包 MCP、浏览器编辑交互、本地 Codex 真实生成以及宿主面板加载。协议测试替身只能证明协议分支；不得当成真实模型和宿主验收。

## 依据

- [Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT 套餐授权](https://developers.openai.com/siwc/token-sharing-open-source)
- [插件架构](https://developers.openai.com/plugins/concepts/plugins)
