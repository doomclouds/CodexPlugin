# Design

`0.2.0` 本地设计工作台。默认使用真实 HTML、React、TSX、CSS 文件作为设计源，由当前聊天的模型直接修改工程；旧的多画板和图层文档继续保留。插件通过 MCP App 打开编辑器，预览、源码、选中编辑和导出使用同一份项目修订。

默认沿用当前宿主聊天及其已加载工具。可选独立 Codex 任务通过本机 `codex app-server` 使用已有 ChatGPT 登录，不要求 API Key，不读取或复制登录令牌。独立目录以本机 Codex 实际返回为准，不能把全部 ChatGPT 网页模型视为可用模型。工具和面板是否可用，以当前宿主实际加载结果为准。

## 使用

1. 调用 `design_get_capabilities`，确认版本和能力；用 `design_code_list` 打开已有工程，或用 `design_code_create` 创建 HTML / React 起点。
2. 调用 `design_open_editor`，默认进入代码模式。描述任务后，当前聊天使用 `design_code_list_files` / `design_code_read_file` 核对源码和 hash，再用 `design_code_update` 提交实际文件与准确 revision。
3. 通过 `design_code_preview` 检查编译诊断，用 `design_code_render` 获取真实图像、运行错误与布局信息。检查图片和目标操作后，再报告实际通过的范围。

编辑器提供源码、运行预览、元素选择、静态文字与内联样式修改、评论和版本恢复。动态表达式与复杂组件改动由当前模型修改源码，编辑器不会猜测并覆盖未知表达式。所有改动保留项目修订和文件 hash 检查，发生冲突时重新读取并合并意图。

设计指导按任务和投入组合：落地页、工作台、数据、编辑内容、品牌、组件、原型等分别处理，支持快改、标准、探索与精修。20 张原创方向卡只作起点，默认仅载入基础规则与摘要，选定方向才载入详情；用户的自由描述、已有品牌和局改范围优先。方向数量不是模板或设计能力上限，也不是视觉质量证明。

## 真实组件与素材

`design_code_import_directory` 读取用户明确选择的源码目录，创建独立代码项目，不安装依赖或运行项目脚本。普通预览支持内置 React 和项目中的相对模块、CSS、图片与字体；缺少的依赖会返回真实诊断。

已有 React 组件库使用 `design_code_import_components`：明确选择源根目录、组件入口及导出名，以及需要的 CSS、类型声明和用法说明。工具静态打包实际源码和选定目录内已有依赖，保留来源 hash、组件资料与使用说明。导入后还要在页面中引用组件、加载实际产生的样式，完成编译、浏览器运行与视觉检查，才能称为接入成功。它不执行后端代码，不自动安装包，也不保证任意框架或依赖都能迁移。

图片和字体可通过 `design_code_import_asset` 从明确选择的本地文件导入。预览默认限制外部网络；字体、图片与其他资源应在项目或运行包中实际存在。不能用远端链接、占位块或假数据冒充已完成素材与真实服务。

## 验证与模型任务

编译通过、截图生成、模型看图与交互验证分别报告。`design_code_render` 返回实际图像和观察到的运行/布局信息，不自动完成每条操作路径，也不输出客观质量分数。当前模型需要实际查看图片，并借助可用的宿主能力或用户操作核对关键状态；没有证据的部分明确标为未验证。

独立代码任务仅在用户选择时启动。默认总预算为 10 分钟，源码生成、编译、浏览器渲染和截图反馈共用该预算；最多三个同线程模型回合，包括初稿及最多两次修正。超时、权限拒绝或模型错误会明确结束，不自动切换模型或改用 API Key。当前工具不提供超时参数。

独立任务的 `completed` 表示代码提案经过其记录的编译、渲染和截图反馈流程，仍未应用。用 `design_code_apply_generation` 按原始 revision 和文件 hash 应用；该状态不等于所有交互、主题或视口都已验证。取消等待所拥有的任务退出。

## 交付与目录同步

代码项目通过 `design_code_export` 导出自包含 HTML、原始源码 ZIP、PNG 或 PDF。ZIP 包含 `source/`、可运行的 `prototype.html` 和项目描述；源码仍保留原有语言与工程结构。PNG/PDF 需要本机 Chromium，可用 `DESIGN_BROWSER` 指定可执行文件。宿主不能下载时，`design_code_save_export` 可保存真实文件到插件数据目录。

`design_code_write_directory` 把源码写入用户明确选择的目录，并记录同步清单。它检查项目修订、已有文件和外部改动，拒绝覆盖无关文件或未核对变化；部分写入也会明确报告。重新导入目录会创建新代码项目。要合并外部修改到已有项目，应先读取差异，再按当前 hash/revision 更新，不把目录导出当作任意框架的自动双向同步或部署。

## 旧图层模式

`design_open_editor` 的 `layers` 模式继续支持多画板、图层、设计令牌、结构化组件、图片、评论、撤销重做、历史恢复和 JSON Patch。它的组件是图层结构，交互合同为导航、链接和显隐；真实 React 组件与复杂状态使用代码模式。

旧模式保留 HTML / JSON / SVG / ZIP 和 Chromium PNG/PDF 导出。SVG 使用 HTML foreignObject，需要相应查看器。旧 Design JSON 与指定交换 HTML 的同步继续使用原有图层工具，不等同于任意源码工程导入。

项目和最近历史保存在本地，最多保留 50 版，单项目含历史的保存预算为 96 MiB。`DESIGN_DATA_DIR` 可指定数据目录。

## 当前边界

代码预览与组件导入已有实现，完整视觉保真、任意组件库兼容、所有关键交互与当前宿主效果仍需按实际任务验收，不宣称已全面达到 Claude Design。在线多人协作和云端分享未实现。

代码原型可以包含前端动效；独立 Motion 时间线、视频渲染与 MP4 导出尚未实现。

操作与参数见随包 [Design Skill](skills/design/SKILL.md) 和 [代码项目参考](skills/design/references/code-project.md)。

## 开发

需要 Node.js 22.15 或更新版本，以及 npm。正常检查不调用真实模型：

```shell
npm run typecheck --workspace=@codex-plugin/design
npm run build --workspace=@codex-plugin/design
npm run smoke --workspace=@codex-plugin/design
```

`npm run preview --workspace=@codex-plugin/design` 只用于开发预览；产品入口是 MCP App。运行包自包含，安装无需从开发仓库补依赖。安装更新不等于当前聊天已重新加载。构建和检查不包含安装插件、修改用户配置、提交、推送或部署。
