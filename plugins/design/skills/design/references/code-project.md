# 代码项目与真实组件

代码项目以真实 HTML、React、TSX、CSS 和项目资产为源。预览、元素定位、修改、导出及模型提案围绕同一个项目 revision。艺术决策见 [艺术指导](art-direction.md)。

## 项目、文件与冲突合同

项目使用 `schemaVersion: 2`，包含身份、名称、递增 `revision`、`defaultPageId`、真实 `pages`、文件数组、设计系统、评论和视口。每页包含 `id`、`name`、自己的 `entry` 和项目内 `route`；不存在项目级 `entry`。默认页必须属于 `pages`，入口文件与规范化路由必须真实且唯一。

每个文件有项目相对 `path`、`content` 和 `encoding: "utf8" | "base64"`。路径必须留在项目内，不能指向宿主配置、`.git`、`.codex`、`.agents`、`node_modules` 或上级目录。不支持的格式会明确报告，不静默改写或删除原文件。

| 工具 | 输入与结果要点 |
| --- | --- |
| `design_code_list` | 列出代码项目 |
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

删除要求已有文件的准确 hash，且不提供内容或编码。`changes` 也可完整更新 `pages`、`defaultPageId`、名称、设计系统、评论和视口。新增/移除页面与相应文件需在同批保持引用有效。不能因冲突而只替换 hash/revision 重发旧内容；重新读取后合并意图。每文件只在一批出现一次，保留无关文件。

当前项目上限为 500 个文件、每文本文件 1 MiB、每二进制资产 8 MiB、项目总量 32 MiB。最近历史最多 50 版，保存记录含历史的预算为 96 MiB。超限应缩小输入或交付范围，不绕过检查。

## 编译、预览与元素修改

`design_code_preview` 按真实页面入口编译，返回自包含预览 HTML、编译诊断与 `sources`。页面入口可以是 HTML；React 通常从 HTML 引用真正执行 `createRoot` 的 TSX 入口。直接 TSX 默认导出组件也可由预览挂载；不要重复挂载已有入口。

页面和尺寸是独立身份。`viewports` 的可选 `pageId` 限定该尺寸所属页；没有该字段的尺寸可共享。需要指定页面的预览、渲染与导出使用真实 `pageId`，不能把另一个页面的专属尺寸套到当前页。页面内导航只映射到项目声明的真实页面或当前页位置，不把外部服务伪装成本地页面。

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

`design_code_import_directory` 读取明确的本地目录并**创建新项目**，可指定入口。它跳过保留目录、不跟随符号链接，不安装依赖或执行脚本。导入同时建立私有源码连接与原始字节 hash 基线，**不写原目录或 manifest**。受管源码和未纳入文件的说明可在编辑器“源码目录”查看。

| 工具 | 参数与作用 |
| --- | --- |
| `design_code_source_status` | `projectId`；读取私有连接位置与最近写入记录，不扫描目录 |
| `design_code_connect_directory` | `projectId`、`expectedRevision`、用户明确选择的绝对 `directory`；为尚未连接的项目建立只读连接。仅相同文件形成基线；不同内容保留冲突，空目录可作为首次写回目标 |
| `design_code_compare_source` | `projectId`；实际读取两端 hash，返回当前 `revision`、`files` 和 `checkedAt`。每项含 `path/projectHash/directoryHash/baseProjectHash/baseDirectoryHash/status`，状态为 `synced/project/directory/conflict` |
| `design_code_pull_source` | `projectId`、`expectedRevision`、所选 `paths`、`expectedDirectoryHashes`；只允许目录单端变化，原子更新同一项目的源码、历史和私有基线 |
| `design_code_push_source` | 同上；只允许项目单端变化，写回连接目录；每步核对目录身份、文件 hash，持久记录进度，未改文件不重写 |
| `design_code_read_source_difference` | `projectId`、`file`；读取项目与目录当前文本和 hash，二进制只返回元数据；共同基线只保存 hash，不提供虚构的三方原文 |
| `design_code_resolve_source` | `projectId`、`expectedRevision`、`file`、`expectedProjectHash`、`expectedDirectoryHash`、`choice: project/directory`；**明确审阅后选一端覆盖另一端**，执行时仍核对两端。不是自动合并 |
| `design_code_recheck_source` | `projectId`；对中断写入按实际 hash 重查已完成与待处理项，不自动写入或重试 |

`expectedDirectoryHashes` 是所选路径到比较中 `directoryHash` 的映射；不存在的文件为 `null`。先读比较，再携带看到的值；发现旧修订、外部再次保存或双方同文件变更时停止，不替换新 hash 盲目重发。新增、删除、图片和字体使用真实字节；删除仍需保持页面、组件、评论引用有效。复杂引用调整由当前聊天协调后再检查，不默默删掉元数据。

源码连接的绝对目录、基线和写入日志只保存在本地私有记录，不属于可导出的 CodeProject。重新导入仍是新项目；日常回读应通过连接工具保留同一项目身份、页面和评论。不存在自动监听，也不因扫描而启动模型。

`design_code_write_directory` 指向当前连接目录时复用安全写回；指向**其他目录**仍使用独立 `.design-code-export.json` 保护，不能覆盖无关或外部已改文件，不把私有连接转移过去。原始 TSX 仍需相应运行条件；直接打开的离线交付使用编译后的 HTML。

持久日志和 `design_code_recheck_source` **仅用于已连接目录的写回**。其他目录的清单导出若部分失败，会报告实际已写路径，但没有同一恢复日志；需先审查实际文件与旧清单，不盲目重试，也不删除清单绕过保护。

目录写入是逐文件操作，不是全目录事务。出现 `EXPORT_PARTIAL` 时保留 `operationId/directory/filesWritten/pendingFiles/savedRevision`，先用状态工具和 `design_code_recheck_source` 读取现场，再选择剩余安全变化继续。中断后的用户保存仍是外部修改，不能用旧日志覆盖。项目撤销只恢复插件内源码，不自动撤销磁盘目录。目录锁仅协调 Design 进程；对不遵守该锁的外部编辑器，写前复核与实际落盘之间仍存在文件系统并发窗口，不能承诺全局原子或无限制自动恢复。

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

独立任务使用已有 Codex ChatGPT 登录；不复制凭据、不切换为 API Key。默认总预算为 `600000ms`（10 分钟），最大预算为 `900000ms`（15 分钟）；以当前工具合同与任务返回值为准。

最多三个同线程模型回合：初始真实文件提案，以及最多两次源码/截图反馈修正。生成、编译、浏览器检查与模型回看共享同一总预算，不为修正重置。它只修改私有提案副本；本轮文本提案支持新增/改写文本文件，二进制替换另用素材工具。

运行时检查当前目录中的模型图像输入能力和本地 Chromium。缺失时明确失败；权限拒绝、模型错误、取消或超时不能靠自动切模型或凭据绕过。明确选择本次审阅的真实页面和尺寸；实际覆盖范围以任务记录为准，不能代表其他页面或所有交互已经验收。

`design_code_get_generation` 返回状态、日志和 `verification.compiled/rendered/modelReviewed/viewports/pages`。`modelReviewed` 记录截图反馈回合完成，`pages` 记录实际覆盖页；没有自动交互验收字段。`completed` 的提案用 `design_code_apply_generation` 按原始 revision 和文件 hash 应用，不能套用到已经变化的工程。取消用 `design_code_cancel_generation` 并等待所拥有的任务退出。

## 导出与版本

`design_code_export` 接受 `format: "html" | "zip" | "png" | "pdf"`，页面和尺寸使用工程中的 `pageId` / `viewportId`。导出前必须修复相关页面的编译错误。

- HTML：包含实际运行代码、样式和允许的资产的自包含原型，多页工程保留真实页面导航。
- ZIP：`source/` 原始项目文件、`prototype.html` 可运行原型、`design-project.json` 项目描述。
- PNG/PDF：用本机 Chromium 按选定视口渲染或打印；不能将成功生成文件当作视觉验收。

工具返回真实导出字节；宿主下载不可用时，用 `design_code_save_export` 保存到插件数据目录。以工具返回的文件和结果为准，不伪造下载链接。代码版本恢复使用 `design_code_history/undo/redo/restore` 与准确 revision。

代码中的 CSS/JS 动效可以真实运行；独立 Motion 时间线、视频渲染、MP4 导出、在线多人协作和云端分享不在当前实现内。
