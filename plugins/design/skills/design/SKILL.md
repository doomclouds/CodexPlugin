---
name: design
description: 使用本地 Design 插件创建和编辑真实 HTML、React、TSX、CSS 代码设计、交互原型与设计系统。适用于页面设计、产品工作台、视觉探索、组件复用、源码往返、真实预览与交付。
---

# Design

先调用 `design_get_capabilities` 核对当前加载版本。以**真实代码项目**为设计源，默认使用当前聊天：由你直接读取和修改文件，沿用当前宿主的模型和授权。不要索取 API Key、复制登录令牌，或未经用户选择额外启动独立模型任务。

## 任务与艺术指导

新设计或整体改版前调用 `design_get_guidance`。阅读 [艺术指导](references/art-direction.md)，按任务、投入、内容、品牌和已有组件作决定。20 张方向卡是可组合的示例，默认只载入摘要，指定方向才读取其细节；自由需求不必映射到预设名称。

工作台优先对象、操作与恢复；编辑内容优先完整阅读；数据表达先核实来源、单位与编码；组件工作先确认实际 API、样式与依赖。探索按同一内容比较 2–3 种实质不同构图。局改保留既有语言和无关区域，不为改一段文字重做全页。不要把三卡片、渐变、大标题或某种固定配色当作所有任务的答案。

## 默认代码工作流

1. 用 `design_code_list` 查找现有项目；新项目用 `design_code_create`，模板是 HTML / React 起点，不是已生成结果。读取 `pages` 与 `defaultPageId`，用 `design_open_editor` 打开编辑器。每页由真实入口和路由定义，不能把复制预览尺寸称为新增页面。
2. 用 `design_code_list_files` 读取清单、项目 revision 和文件 hash，再用 `design_code_read_file` 读取相关源码。需要完整工程时可用 `design_code_get`，不要无故把图片/字体 base64 全量转抄给模型。
3. 用 `design_code_update` 一次提交相关文件的完整内容，携带准确 `expectedRevision` 和各文件 `expectedHash`；新增文件用 `expectedHash: null`。保留无关文件与用户手动修改。冲突后重新读取并合并意图，不能只换 revision/hash 盲目重发。
4. 用 `design_code_preview` 编译实际入口，先处理错误与缺失依赖。代码原型运行在与编辑器工具分离的预览中；不执行后端、安装依赖或运行用户包脚本。
5. 用 `design_code_render` 获取目标视口的真实图像、运行错误与布局观察，并实际查看图像。检查中文、长文本、素材、字体、密度、对齐、溢出与必要状态。关键动作还需通过实际操作读回状态；无可用操作能力时说明交互未验证。
6. 按用户确认的范围交付，区分代码已保存、提案未应用、编译通过、截图已生成、模型已看图与操作已验证。不要用协议测试或截图尺寸代替艺术和功能验收。

可用 `design_code_guidance` 把现有项目、设计系统、评论与本次需求整理给当前聊天；该工具不会启动独立推理。源码结构、组件接入和工具参数见 [代码项目参考](references/code-project.md)。

## 选择、评论与恢复

元素选择提供当前源码位置和文件 hash。简单静态文字或内联样式可用 `design_code_edit_element` 窄范围修改；带子元素、动态文字、展开属性或动态样式时，读取源码并由当前模型作准确修改，不覆盖未知表达式。

`design_code_add_comment` 以当前选择、hash 和 revision 建立源码锚与评论。收到评论不代表已经修改完成；更新后检查对应源码与真实输出，再在项目评论数据中反映处理状态。

代码版本使用 `design_code_history`、`design_code_undo`、`design_code_redo`、`design_code_restore`。操作均核对当前 revision，不用旧草稿覆盖恢复后的新版本。

## 设计系统、组件与素材

只读取用户明确选择的源目录和资产。`design_code_import_directory` 新建源码项目并建立私有目录基线；不会执行工程、安装依赖或改原目录。当前项目需要连接已有目录时用 `design_code_connect_directory`，日常回读不重新导入项目。

复用真实 React 组件时，用 `design_code_import_components` 显式指定根目录、组件入口/导出名、需要的 CSS、已有类型声明和用法。先看返回诊断和生成的项目内使用说明，再把实际组件和样式接入页面。**打包或登记成功仍需接入页面、编译、浏览器运行与视觉检查，才能称为接入成功。** 不猜 props、不以静态占位替代真实组件行为，也不承诺任意依赖或框架兼容。

本地图片/字体用 `design_code_import_asset` 导入实际字节，引用正确项目路径。默认预览限制外部网络；项目或运行包中不存在的字体、图片、脚本不能伪装成已加载。素材生成和外部获取只用当前宿主实际支持且已授权的能力，保留适用来源与许可。

## 可选独立 Codex 代码任务

用户明确选择独立模式后，先用 `design_list_models` 读取本机真实目录，再用 `design_code_request_generation` 启动。它使用已有 Codex ChatGPT 登录，不改用 API Key，也不把其他 ChatGPT 产品的模型列表当成本机能力。目录可见不保证推理权限；图像输入或浏览器不满足时明确失败，不伪造视觉验收。

任务默认总预算 10 分钟，初稿和最多两次修正共用最多三个同线程回合，编译、渲染和截图反馈不重置预算。用 `design_code_get_generation` 读取状态、日志与 `verification`。`modelReviewed` 表示截图反馈回合已经完成，不证明所有交互都被测试。

只有 `completed` 且有变更提案时才用 `design_code_apply_generation`，应用必须匹配原始 revision 和文件 hash。提案完成不表示已应用。取消用 `design_code_cancel_generation` 并等待退出；权限拒绝、模型错误、超时和取消不以自动切模型或更换凭据绕过。

## 导出与目录往返

代码工程用 `design_code_export` 输出自包含 HTML、源码 ZIP 或本机 Chromium 生成的 PNG/PDF。ZIP 保留原始源码、可运行原型和项目描述。下载能力不可用时，用 `design_code_save_export` 保存真实文件，以工具返回结果为准。

连接目录先用 `design_code_compare_source` 读取实际两端 hash；按当前 revision 和看到的 `expectedDirectoryHashes` 显式拉取或写回所选文件。双方同文件变化必须停止，读取两端内容后再明确解决；不能只换 hash 重发。部分写入先用 `design_code_recheck_source` 重查已写/待处理项，不自动重试。私有目录与基线不进可分发项目；不会自动监听或执行原工程。

用户明确指定其他目标目录后，`design_code_write_directory` 仍检查独立清单、revision 与外部变化，不覆盖无关文件。目录写入逐文件完成，外部编辑器不共享 Design 锁；不能声称全目录原子。项目撤销不会撤销原目录已落盘修改。源码目录不等于已部署服务，源码 ZIP 也不意味着任意框架可以脱离其运行条件直接启动。具体参数和恢复流程见 [代码项目参考](references/code-project.md)。

## 当前边界

在线多人协作、云端分享及独立 Motion 时间线、视频渲染、MP4 导出未实现。前端 CSS/JS 动效可以作为代码原型的一部分，但不等于已有视频制作产品。安装、配置、提交、推送、发布与部署按用户的具体授权执行。
