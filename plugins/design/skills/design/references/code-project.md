# 代码项目与真实组件

默认代码项目以真实 HTML、React、TSX、CSS 和项目资产为源。预览、元素定位、修改、导出及模型提案围绕同一个项目 revision；它与旧图层文档分别保存。艺术决策见 [艺术指导](art-direction.md)。

## 项目、文件与冲突合同

项目包含身份、名称、递增 `revision`、入口 `entry`、文件数组、设计系统、评论和视口。每个文件有项目相对 `path`、`content` 和 `encoding: "utf8" | "base64"`。路径必须留在项目内，不能指向宿主配置、`.git`、`.codex`、`.agents`、`node_modules` 或上级目录。

| 工具 | 输入与结果要点 |
| --- | --- |
| `design_code_list` | 列出代码项目，不混入旧图层项目 |
| `design_code_create` | `name`，`template: "html" | "react"`；返回实际起点工程 |
| `design_code_get` | `projectId`，可选 `ifRevision`；未变时避免重复传完整源码 |
| `design_code_list_files` | 返回项目元数据、文件路径、编码、字节数和 `sha256` |
| `design_code_read_file` | `projectId`、`file`；文本返回内容与 hash，二进制仅返回元数据 |
| `design_code_update` | `projectId`、当前 `expectedRevision`、`changes`；原子检查整批修改 |

`changes.files` 的每项包含：

- `path`：准确的项目相对路径。
- `content`：修改后的完整内容；删除已有文件时省略。
- `encoding`：写内容时可指定 `utf8` 或 `base64`。
- `expectedHash`：已有文件使用刚读取的实际 SHA-256；新文件使用 `null`。

删除要求已有文件的准确 hash，且不提供内容或编码。`changes` 也可更新入口、名称、设计系统、评论和视口。不能因冲突而只替换 hash/revision 重发旧内容；重新读取后合并意图。每文件只在一批出现一次，保留无关文件。

当前项目上限为 500 个文件、每文本文件 1 MiB、每二进制资产 8 MiB、项目总量 32 MiB。最近历史最多 50 版，保存记录含历史的预算为 96 MiB。超限应缩小输入或交付范围，不绕过检查。

## 编译、预览与元素修改

`design_code_preview` 解析真实入口并返回自包含预览 HTML、编译诊断与 `sources`。入口可以是 HTML；React 通常从 HTML 引用真正执行 `createRoot` 的 TSX 入口。直接 TSX 默认导出组件也可由预览挂载；不要重复挂载已有入口。

普通预览支持包内 React / React DOM、项目中的相对 JS/TS/TSX/JSX/CSS/JSON 导入及图片/字体资产。其他裸依赖不会自动安装或被模拟；需要包含实际可用的项目源码或经过明确组件导入的运行产物。预览不是任意框架开发服务器，不执行后端和包脚本，默认限制外部网络。

编辑器将原型放入与工具主界面隔离的运行环境，选择模式拦截选择，预览模式运行真实页面事件。不要移除隔离或将项目脚本放入拥有 MCP 桥能力的编辑器主页面。

`SourceElement` 提供 `sourceId` 对应的文件、源区间、标签、静态文字可编辑性和 `fileHash`。使用当前预览的选择，不猜源码偏移：

- `design_code_edit_element` 需要项目 revision、`sourceId`、当前 `fileHash`，以及 `text` 或允许的 `styles` 字符串值。
- 仅静态字面文字和可确定的内联样式可窄范围编辑。动态表达式、嵌套内容或样式归属不确定时，读取源码让当前模型处理。
- `design_code_add_comment` 使用同样的选择/hash/revision 建立源码锚和评论。完成修改后核对实际来源和画面，再反映评论处理状态。

## 真实组件导入

`design_code_import_components` 只读取用户明确选择的真实源目录，静态打包组件及其闭包。参数为：

| 参数 | 必须明确的内容 |
| --- | --- |
| `projectId`、`expectedRevision` | 当前目标代码项目及修订 |
| `directory` | 用户选择的绝对源根目录，应包含组件及所需的已有依赖 |
| `entries` | 每项指定项目内组件 `path`、导入别名 `name`，可选 `exportName` 和真实 `usage` |
| `cssFiles` | 需要一起打包的实际 CSS 相对路径；未选择的外部样式不能假定存在 |
| `typeFiles` | 用户选择的已有 `.d.ts` 等类型声明；缺失时不推测 props/API |
| `notes` | provider、主题、组件组合与已知限制等可执行说明 |

入口别名必须是唯一合法 JavaScript 标识符，导出名为 `default` 或实际命名导出。所有源码、依赖、CSS、图片和字体均须在选定根目录内；缺少依赖、越界或无法确定的动态依赖会失败。工具不自动安装包、不运行项目构建脚本、不执行用户后端代码，不保证任意组件库都兼容。

导入会在**用户代码项目**中生成真实运行模块、实际发出的 CSS、API 资料、来源 hash 与使用说明；这些是运行时项目输出，不是技能包前置文件。先读取返回的 `guide` 路径和诊断，再决定接入方式。通常运行入口是 `vendor/design-system.js`；只有确实发出 `vendor/design-system.css` 才加载它。项目内生成的说明和 provenance 也应保留，不能把来源 hash 当作视觉保真证明。

从页面所在目录计算相对导入路径，使用实际导入别名与类型合同；根据用户提供的约定添加 provider、主题与必要 props。随后：

1. 在真实页面或目标流程中实例化组件，加载实际样式与资产。
2. 编译并处理诊断，核对组件 API 与运行错误。
3. 回看目标视口真实图像，检查主题、字体、布局和状态。
4. 实际操作本次关键行为；未测交互或无法对比参考效果时明确说明。

返回 `requiresIntegration: true`、模块存在或编译打包成功，只表示导入阶段完成。完成上述适用步骤后，才能称为该页面接入成功；不能据此宣称整个组件库已通过保真验收。

## 图片、字体与既有目录

`design_code_import_asset` 接受明确选择的本地 `file`、目标项目相对 `targetPath`、项目 revision 和目标文件 `expectedHash`，直接导入资产字节。图片和字体无需经过模型文本上下文转抄。来源和分发许可仍需确认；远端链接不是已随交付包含的资源。

`design_code_import_directory` 读取明确的本地目录并**创建新项目**，可指定入口。它跳过保留目录，不跟随目录符号链接，不安装依赖、执行脚本或修改原目录。

`design_code_write_directory` 接受目标目录和当前 revision，导出实际源文件及 `.design-code-export.json` 清单。它拒绝覆盖无关文件、已变化文件或更新版本目录；写入中发现变化会报告冲突，部分写入会带明确错误状态。先核对实际结果再继续。

目录回读不自动合并进已有项目。需要保留同一项目时，读取外部差异，取得项目当前 hash/revision 后用 `design_code_update` 合并。原始 TSX 或其他源码仍需要相应运行条件；可直接打开的离线交付使用编译后的 HTML。

## 四种验证证据

| 证据 | 能说明什么 | 仍需另核对 |
| --- | --- | --- |
| 编译通过 | 当前入口依赖图与语法可以生成原型 | 视觉、真实业务逻辑与目标交互 |
| 截图/渲染完成 | 浏览器产生实际画面，并观察到相应运行与布局信息 | 模型是否查看图片、所有状态是否可读 |
| 模型看图 | 当前模型或独立反馈回合得到实际图像并进行审查 | 未操作的按钮、保存、筛选、提交与异常恢复 |
| 交互验证 | 指定动作真实执行且状态读回符合预期 | 未覆盖路径、主题、数据条件和其他视口 |

`design_code_render` 返回实际 PNG、项目 revision、视口尺寸、布局 metrics、运行错误和被阻止请求数量。它不会自动点遍按钮或证明业务正确，不生成客观质量分数。用当前宿主实际支持的操作能力或用户操作核对关键状态；没有能力或证据时明确未验证。

## 独立代码生成任务

默认仍是当前聊天直接使用源码工具。用户明确选择后，`design_code_request_generation` 才创建独立本地任务；可用 `design_list_models` 读取真实目录，使用可选 `model` 指定其中模型。

独立任务使用已有 Codex ChatGPT 登录；不复制凭据、不切换为 API Key。当前代码默认总预算为 `600000ms`（10 分钟），运行时构造器允许的上限是 `900000ms`（15 分钟），当前 MCP 启动工具没有 `timeoutMs` 参数。

最多三个同线程模型回合：初始真实文件提案，以及最多两次源码/截图反馈修正。生成、编译、浏览器检查与模型回看共享同一总预算，不为修正重置。它只修改私有提案副本；本轮文本提案支持新增/改写文本文件，二进制替换另用素材工具。

运行时检查当前目录中的模型图像输入能力和本地 Chromium。缺失时明确失败；权限拒绝、模型错误、取消或超时不能靠自动切模型或凭据绕过。浏览器按当前工程前两个视口进行该流程的检查，不代表工程里所有视口或所有交互已经验收。

`design_code_get_generation` 返回状态、日志和 `verification.compiled/rendered/modelReviewed/viewports`。`modelReviewed` 记录截图反馈回合完成；没有自动交互验收字段。`completed` 的提案用 `design_code_apply_generation` 按原始 revision 和文件 hash 应用，不能套用到已经变化的工程。取消用 `design_code_cancel_generation` 并等待所拥有的任务退出。

## 导出与版本

`design_code_export` 接受 `format: "html" | "zip" | "png" | "pdf"`，可选工程中的 `viewportId`。导出前必须修复编译错误。

- HTML：包含实际运行代码、样式和允许的资产的自包含原型。
- ZIP：`source/` 原始项目文件、`prototype.html` 可运行原型、`design-project.json` 项目描述。
- PNG/PDF：用本机 Chromium 按选定视口渲染或打印；不能将成功生成文件当作视觉验收。

工具返回真实导出字节；宿主下载不可用时，用 `design_code_save_export` 保存到插件数据目录。以工具返回的文件和结果为准，不伪造下载链接。代码版本恢复使用 `design_code_history/undo/redo/restore` 与准确 revision。

旧图层格式与交互见 [图层文档参考](document.md)。代码中的 CSS/JS 动效可以真实运行；独立 Motion 时间线、视频渲染、MP4 导出、在线多人协作和云端分享不在当前实现内。
