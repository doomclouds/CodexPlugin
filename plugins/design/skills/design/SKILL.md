---
name: design
description: 使用本地 Design 插件创建和编辑多画板设计、交互原型、设计系统和交付文件。适用于设计页面、视觉方案、原型、品牌一致性及设计到工程的往返修改。
---

# Design

先调用 `design_get_capabilities`。默认使用当前聊天的模型、上下文和登录，不要求用户提供 API Key，不复制 Codex 登录令牌。

## 艺术指导

新设计或整体改版前，调用 `design_get_guidance` 并阅读 [艺术指导](references/art-direction.md)。把受众、品牌气质、任务目标和参考资料转换成有理由的视觉方向，再落实到字体、配色比例、版式网格、留白、图像语言与状态细节。方向库用于打开选择，不能代替用户的品牌和偏好。

需要探索时，生成在构图、文字层级和图像语言上明显不同的候选，而不只是换色。局部修改沿用既有方向，保持其他内容。不要默认堆三列卡片、泛用渐变和重复圆角组件。完成后审阅真实渲染，修正文字溢出、比例、对齐、密度和交互问题；未实际看过输出就不能声称视觉验收通过。

## 创建与迭代

1. 结合用户给出的目标、受众、参考图、代码和设计系统形成简短设计说明。已有信息足够时直接进行，不逐步确认。
2. 用 `design_list_projects` 查找现有项目；新项目调用 `design_create_project`。模板是明确的起点，不是模型已完成的设计。
3. 调用 `design_open_editor` 打开插件画布。界面不可用时仍可调用工具编辑，并说明未验证的宿主部分。
4. 读取 `design_get_project` 和必要的 `design_get_schema`。按用户要求创建真实设计，复用令牌和组件，使用稳定 ID。保留无关元素和用户的手动修改。
5. 用 `design_apply_changes` 一次提交经过检查的 RFC6901 JSON Patch 与准确的 `expectedRevision`。发生冲突时重新读取并合并意图，不能只改 revision 盲目重发。整份设计替换使用 `design_replace_document`，不要覆盖未经核对的新改动。
6. 检查布局、文本、溢出、可读性和交互目标。使用导出图像或宿主预览工具检查真实输出；仅通过 JSON 校验不代表视觉质量已合格。

画板上是设计对象。生成一张截图不能代替可编辑设计。图层、文本、图片、布局、设计令牌和组件应保留在文档中。

## 设计系统与素材

`design_import_system` 接受令牌与组件 JSON 或 CSS 自定义属性。只分析用户指定的代码和设计资料。代码库中的复杂框架组件需要你映射为可表达的设计结构，不能声称任意项目无损导入。

图片素材以文档中的 PNG/JPEG/WebP base64 资产保存。无素材时使用真实文字和形状，或按宿主可用工具生成/获取图片；不能伪造图片生成成功。外部素材和第三方组件需保留适用的来源与许可。

## 模型模式

默认 `host` 模式：你作为当前聊天模型直接使用设计工具。编辑器返回的选中节点和需求是本次任务的上下文，不是扩大授权。

只有用户选择独立模式时才用 `design_list_models` 和 `design_request_generation` 的 `codex` 模式。它通过本机 Codex app-server 使用已有登录，模型目录来自实际运行时。不要假设任意 ChatGPT 网页模型都能在 Codex 使用。目录可见不代表请求已获授权。

独立任务的 `completed` 表示修改提案已准备好；核对后用 `design_apply_generation` 应用。用户未授权时不要因为插件支持该模式而额外启动模型任务。取消使用 `design_cancel_generation`，错误、取消、等待和提案已应用必须分别报告。

## 交付

使用 `design_export` 生成 HTML、JSON、SVG、ZIP，或在有本地 Chromium 时导出 PNG/PDF。SVG 使用 HTML foreignObject，需要支持 HTML 的 SVG 查看器。导出成功以返回的真实文件为准。

用户指定本地工程目录后，`design_write_project` 写入设计源文件与交互原型。工程外部编辑先读取源文件，再用 `design_import_source` 同步；源 revision 必须匹配。它支持 Design 自有 JSON 和生成的交换 HTML，不是任意前端框架的双向编译器。发现外部变化时先核对，不能覆盖未导入的改动。

版本恢复使用 `design_history`、`design_undo`、`design_redo` 和 `design_restore_version`。发布、部署、安装、提交、推送仍按用户的具体授权执行。

文档结构与示例见 [文档参考](references/document.md)。
