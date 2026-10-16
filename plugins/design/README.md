# Design

`0.1.0` 试用版。本地可编辑设计工作台，默认由当前 Codex 聊天生成和修改设计；可选独立 Codex 模式，通过本机 `codex app-server` 沿用已有 ChatGPT 登录。插件不要求 API Key，不读取或复制登录令牌。

包含多画板、图层与属性编辑、可复用组件、颜色与字体令牌、导航/显隐原型交互、元素评论、撤销重做、历史恢复、工程同步和导出。项目与最近历史保存到本地，最多保留 50 版，历史总量受 96 MiB 预算限制。模型提案完成、提案应用和宿主加载分别报告。

## 使用

在 Codex 新聊天中选择 Design，描述要设计的内容。先调用 `design_get_capabilities`，再创建或打开项目，并用 `design_open_editor` 打开画布。默认当前聊天模式，由同一聊天里的模型调用修改工具，画布自动读取新修订。独立模式可从本机 Codex 目录选择模型，完成的提案需要应用后才改变设计。

画布支持选择、平移、缩放、拖动、调整尺寸、文字和外观属性、图层操作、组合、组件实例、图片资产、设计系统和定位评论。界面支持的宿主消息、外链和下载能力通过握手检查；缺失消息接口时提供可复制提示词，缺失下载接口时可保存真实文件到插件数据目录。

AI 助手提供自动方向及编辑叙事、精密工具、直给结构、表达节奏、传承工艺、自然亲和六种方向。艺术指导覆盖受众、品牌、字体、配色比例、版式、留白、图像、交互状态与真实渲染审查，并同时提供给当前聊天和独立 Codex 生成。既有品牌和用户偏好优先，方向库不强制所有项目使用同一种风格。

## 交付与工程同步

导出 HTML、JSON、SVG 或 ZIP 不需要外部渲染服务。PNG/PDF 使用本机已安装的 Chromium 浏览器；可通过 `DESIGN_BROWSER` 指定可执行文件。SVG 包含 HTML foreignObject，需要支持 HTML 的 SVG 查看器，并非完整的通用矢量交换格式。

`design_write_project` 将设计 JSON、可运行 HTML 和同步清单写入明确选择的目录。外部编辑后，用 `design_project_sync_status` 检查，再用 `design_import_project` 导入。JSON 与 HTML 同时变化时明确指定权威源；源版本落后、文件在同步中变化或出现无法映射的 HTML 修改时会保留文件并报告冲突。HTML 支持已有文字和可表达外观/位置修改；结构修改使用 JSON 或让当前 Codex 聊天分析与转换。

## 当前边界

这是结构化设计文档驱动的试用版。真实前端组件包、任意代码项目预览、复杂交互、在线多人协作与云端分享尚未实现；不宣称已达到 Claude Design 完整体验。默认模型随当前宿主选择，独立模式只支持本机 Codex 实际提供的模型，不能将全部 ChatGPT 网页模型视为可用目录。

## 开发

```shell
npm run typecheck --workspace=@codex-plugin/design
npm run build --workspace=@codex-plugin/design
npm run smoke --workspace=@codex-plugin/design
```

默认通过 MCP App 打开编辑器。开发预览使用 `npm run preview --workspace=@codex-plugin/design`。运行包与技能全部包含在插件内，设计数据保存在用户数据目录，可用 `DESIGN_DATA_DIR` 指定。
