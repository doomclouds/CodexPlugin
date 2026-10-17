# 代码项目与真实组件

代码项目以真实 HTML、React、TSX、CSS 和项目资产为源。预览、元素定位、修改、导出及模型提案围绕同一个项目 revision。艺术决策见 [艺术指导](art-direction.md)。

## 项目、文件与冲突合同

项目使用 `schemaVersion: 3`，包含身份、名称、递增 `revision`、`defaultPageId`、真实 `pages`、文件数组、设计系统、评论和视口。`designSystem` 只包含 `components` 与 `notes`；令牌来自真实 CSS，不维护另一份元数据值。每页包含 `id`、`name`、自己的 `entry` 和项目内 `route`；不存在项目级 `entry`。默认页必须属于 `pages`，入口文件与规范化路由必须真实且唯一。旧开发格式明确拒绝，不自动迁移、改写或删除。

编辑器“页面总览”可同时显示 1–4 个真实页面，每页选择一个实际可用尺寸；每个 iframe 使用对应页的编译输出和源码注册表。比较方案时提交不同入口、路由和真实内容，再在总览中选择，不能将多个尺寸或截图当作多个设计方案。画板的选中、输入、评论与 AI 上下文使用实际来源页及尺寸；导航进入真实目标单页，返回总览保留会话内的页面组与视图位置。

编辑器每实例最多并发编译 2 页、保留 4 个实时 iframe（含隐藏板），UTF-8 预览 HTML、共享源码注册表与元数据缓存上限为 64 MiB。项目源文件和浏览器运行内存另计。可见板优先，超额有明确状态；释放隐藏板后重新进入会重置该板临时状态，源码仍保留。单页失败不代表其他板失败。

每个文件有项目相对 `path`、`content` 和 `encoding: "utf8" | "base64"`。路径必须留在项目内，不能指向宿主配置、`.git`、`.codex`、`.agents`、`node_modules` 或上级目录。不支持的格式会明确报告，不静默改写或删除原文件。

| 工具 | 输入与结果要点 |
| --- | --- |
| `design_code_list` | 列出代码项目 |
| `design_code_create` | `name`，`template: "html" | "react"`；返回实际起点工程 |
| `design_code_get` | 显式整份工程快照；`projectId`，可选 `ifRevision`，未变时避免重复传整份内容；局改优先使用下面的分页与窄读 |
| `design_code_list_files` | `projectId`、可选 `offset/limit/expectedRevision`；返回小摘要、计数与一页路径、编码、字节数和 `sha256`，不带全部元数据 |
| `design_code_read_metadata` | `projectId`、`section`，可选分页、准确 `key`、评论 `file` 和 `expectedRevision`；读取完整元数据条目或说明文本片段 |
| `design_code_read_file` | `projectId`、`file`；文本返回内容与 hash，二进制仅返回元数据 |
| `design_code_update` | `projectId`、当前 `expectedRevision`、`changes`；原子检查整批修改 |
| `design_code_update_comment` | `projectId`、`expectedRevision`、`commentId`、`changes: {text?, status?}`；只改一条评论并返回该评论与修订 |

`changes.files` 的每项包含：

- `path`：准确的项目相对路径。
- `content`：修改后的完整内容；删除已有文件时省略。
- `encoding`：写内容时可指定 `utf8` 或 `base64`。
- `expectedHash`：已有文件使用刚读取的实际 SHA-256；新文件使用 `null`。

删除要求已有文件的准确 hash，且不提供内容或编码。`changes` 也可完整更新 `pages`、`defaultPageId`、名称、设计系统、评论和视口。整节替换必须掌握同一修订的完整内容，不能把分页子集作为整节写回；日常单条评论使用窄工具。新增/移除页面与相应文件需在同批保持引用有效。不能因冲突而只替换 hash/revision 重发旧内容；重新读取后合并意图。每文件只在一批出现一次，保留无关文件。

当前项目上限为 500 个文件、每文本文件 1 MiB、每二进制资产 8 MiB、项目总量 32 MiB。最近历史最多 50 版，保存记录含历史的预算为 96 MiB。超限应缩小输入或交付范围，不绕过检查。

### 分页发现与准确元数据

`design_code_list_files` 默认每页 50 个文件，最大 100。其 `project` 只含 `schemaVersion`、身份/名称/修订/时间、`defaultPageId` 与文件、页面、视口、组件、评论的数量，以及按 Unicode 码点计数的 `noteCharacters`；不再把完整 `pages/comments/designSystem` 附在文件清单里。结果另有 `revision`、`total`、`offset`、`returned`、`nextOffset` 和 `files`。

`design_code_read_metadata.section` 为 `pages`、`viewports`、`components`、`comments` 或 `notes`。数组默认每页 10 项、最多 50 项，返回完整 `items`；`notes` 默认每页 4,000、最多 8,000 个 Unicode 码点，返回 `text` 和 `unit: "unicode-code-points"`，不会在成对代理项之间切开。每页都有 `projectId/revision/section/total/offset/returned/nextOffset`，其中 notes 的位置与数量也按码点计。

两种查询的结构化 JSON 最多 65,536 字节。字节预算可能使数组页提前结束，完整条目不会被截成摘要；以实际 `nextOffset` 为准，不按请求的 limit 猜下一页。`nextOffset: null` 表示结束，`offset == total` 是合法空尾页，越界会明确拒绝。

已知身份时用 `key` 准确读取页面/视口/评论 ID 或组件名称；不能同时传显式 `offset` 或 `limit`，notes 不支持 key。只有 comments 支持 `file` 过滤，可与 key 一起核对归属。未知 key/file、不支持的组合和多条同名组件会明确诊断，不能取第一条猜测。过滤后的 `total` 是匹配项数量。

从首页取得 revision，后续分页或准确项读取携带同一 `expectedRevision`。修订冲突后重读新首页或目标 key，协调意图；不能只换 revision 后继续旧游标。`design_code_read_file` 返回读取时的实际 revision，若与已收集元数据不符也要重新协调。仅需当前页面时，可从文件摘要的 `defaultPageId` 开始，按 key 读取 pages；需要组件或评论时再读对应节，不先下载整份工程。

## CSS 源码令牌

`design_code_list_tokens` 读取项目中的 CSS 文件和 HTML/HTM `<style>` 块，列出真实 `--自定义属性` 声明。它不执行 JavaScript，不扫描内联 style 属性、CSS-in-JS 或远端样式，也不计算浏览器级联、继承或当前元素的最终值。

| 参数 | 含义 |
| --- | --- |
| `projectId` | 当前项目 |
| `file` | 可选准确项目相对路径，筛选返回的声明；引用仍按项目源码扫描 |
| `offset`、`limit` | 从 0 开始分页；默认 100 项，每页 1–200 项 |

结果含 `projectId`、`revision`、`definitions`、`total`、`offset`、`nextOffset`、文件 hash 清单、`diagnostics` 和 `truncated`。每个声明包含 `sourceId`、`file`、`fileHash`、`name`、`value`、`important`、`selector`、`atRules`、行列和源区间，以及 `editable` 与可能的只读诊断。同名声明按各自文件、选择器和条件分别保留，不按变量名合并。

`references` 是已扫描源码中同名 `var()` 的位置，`referenceResolution: "syntactic-name"` 明确表示语法关联；它不证明引用实际由该声明供值。`sourceOnly: true` 也不表示源码已全部扫描：CSS 扫描预算为 8 MiB，最多记录 10,000 个声明、50,000 个引用，每声明最多返回 200 个引用；超限或解析失败必须结合 `truncated` 与诊断说明，不能据此断言其他声明或引用不存在。

`design_code_edit_tokens` 接受 `projectId`、当前 `expectedRevision` 和 1–100 项 `edits`，每项为 `{sourceId, file, fileHash, value}`。单值最多 16,384 字符。它核对整批精确声明身份与原文件 hash，只替换选定值区间后以一次项目更新提交，保留周围源码和原有 `!important`；不能通过值注入额外声明、规则或改变 `!important`。有注释或格式导致无法无损定位时返回只读诊断，改用正常源码更新并验证效果。

返回 `{project, changes, unchanged}`；整批值均未改变时不增加 revision。有一项陈旧、重复、不可编辑或不合法时整批失败，不覆盖源码。重新读取后核对文件、作用域与意图，不用新 hash 包装旧声明，也不将旧暂存按变量名自动套用。编辑器暂存与源码编辑草稿分别保留；先处理源码草稿，再提交令牌。成功后检查目标页面的实际样式与交互；源码值改变不保证所有同名引用都会受影响。

## 编译、预览与元素修改

`design_code_preview` 按真实页面入口编译，返回自包含预览 HTML、编译诊断与 `sources`。页面入口可以是 HTML；React 通常从 HTML 引用真正执行 `createRoot` 的 TSX 入口。直接 TSX 默认导出组件也可由预览挂载；不要重复挂载已有入口。

页面和尺寸是独立身份。`viewports` 的可选 `pageId` 限定该尺寸所属页；没有该字段的尺寸可共享。需要指定页面的预览、渲染与导出使用真实 `pageId`，不能把另一个页面的专属尺寸套到当前页。页面内导航只映射到项目声明的真实页面或当前页位置，不把外部服务伪装成本地页面。

普通预览支持包内 React / React DOM、项目中的相对 JS/TS/TSX/JSX/CSS/JSON 导入及图片/字体资产。其他裸依赖不会自动安装或被模拟；需要包含实际可用的项目源码或经过明确组件导入的运行产物。预览不是任意框架开发服务器，不执行后端和包脚本，默认限制外部网络。

编辑器将原型放入与工具主界面隔离的运行环境，选择模式拦截选择，预览模式运行真实页面事件。不要移除隔离或将项目脚本放入拥有 MCP 桥能力的编辑器主页面。

`SourceElement` 提供 `sourceId` 对应的文件、源区间、标签、静态文字可编辑性和 `fileHash`。使用当前预览的选择，不猜源码偏移：

- `design_code_edit_element` 需要项目 revision、`sourceId`、当前 `fileHash`，以及 `text` 或允许的 `styles` 字符串值。
- 仅静态字面文字和可确定的内联样式可窄范围编辑。动态表达式、嵌套内容或样式归属不确定时，读取源码让当前模型处理。
- `design_code_add_comment` 使用同样的选择/hash/revision 建立源码锚和评论。完成修改后核对实际来源和画面，再用下面的窄工具反映评论处理状态。

读取评论用 `design_code_read_metadata` 的 comments 节，按 ID 或文件明确范围。`design_code_update_comment` 的 `changes` 至少包含 `text` 或 `status` 一项；text 必须有非空白内容且最多 10,000 字符，status 为 `open` 或 `resolved`。返回 `{projectId, revision, comment, unchanged}`，不附整份工程；值未变时不增加修订或历史。保存原子核对当前修订，只更新该条正文/状态，保留其源锚、创建时间、其他评论与所有源码。它不提供重新绑定锚的能力；旧身份或冲突需重读并核对，不能换 revision 盲重发。

评论指向源码身份，不保证条件内容当前可见；共享组件可能在多个页面或位置出现。编辑器分别显示核对中、有效、失锚或未知，失锚后回到文件核对，不能按旧偏移猜绑。仅评论或设计系统说明等描述性元数据变化，且全部源码和预览设置一致时，保留预览输入与组件状态；首次给未标记元素建立锚点属于源码修改。源码变化、切页或显式刷新可能重建原型，不声称跨重编译恢复临时状态。

默认仅核对已显示页面与明确入口候选。需要确认其他页面的共享源码时使用“核对全部页面”，按需低优先编译其注册表，不实例化最多 32 页的所有尺寸。其余未核对页面仍须说明，不能把局部未找到当作全项目失锚；注册表被逐出后也要重新核对。

`design_code_history` 一次返回当前 `revision`、`versions` 元数据和实际 `canUndo/canRedo`；不能从版本号或保留版本数量猜测撤销栈。恢复操作仍需准确当前修订，历史读取不会返回源码快照或私有目录连接。

## 真实组件导入

`design_code_import_components` 只读取用户明确选择的真实源目录，静态验证组件导出并保存可编辑源码闭包。参数为：

| 参数 | 必须明确的内容 |
| --- | --- |
| `projectId`、`expectedRevision` | 当前目标代码项目及修订 |
| `libraryName` | 可选独立库名，默认 `design-system`；1–48 字符，以小写字母开头，仅小写字母、数字及单个连字符分段 |
| `directory` | 用户选择的绝对源根目录，应包含组件及所需的已有依赖 |
| `entries` | 每项指定项目内组件 `path`、导入别名 `name`，可选 `exportName` 和真实 `usage` |
| `cssFiles` | 需要一起引用的实际 CSS 相对路径；未选择的外部样式不能假定存在 |
| `typeFiles` | 用户选择的已有 `.d.ts` 类型源码；缺失时不推测 props/API |
| `notes` | provider、主题、组件组合与已知限制等可执行说明 |

入口别名必须是唯一合法 JavaScript 标识符，导出名为 `default` 或实际命名导出。所有源码、依赖、CSS、图片和字体均须在选定根目录内；缺少依赖、越界或无法确定的动态依赖会失败。工具不自动安装包、不运行项目构建脚本、不执行用户后端代码，不保证任意组件库都兼容。

导入在**用户代码项目**中生成 `components/<libraryName>/index.ts`，真实 re-export 所选组件。返回的 `paths` 包含 `libraryName`、`prefix`、`entry`、`guide` 和 `provenance`，后续使用实际返回路径。原 TSX/JS/CSS、类型和注释保存在该子树的 `source/`，包依赖映射到 `dependencies/`，图片和字体是独立 CodeFile 字节，未全部内联到 CSS。源代码的静态 import/export/require 和 CSS 资源引用改为实际相对路径；import 与 require 的包条件分支分别解析。静态 bundle 只验证导出，不作为交付或预览入口；预览直接编译这些源码，修改相应 TSX/CSS 后无需运行额外 rebuild 工具。

先读取 `guide` 路径对应的真实文件与诊断。指南为 `docs/<libraryName>-guide.md`，来源记录为 `docs/<libraryName>-provenance.json`。入口已引用用户明确选择的 CSS，组件内 CSS import 也保留；不要引用不存在的编译产物。来源记录保存 `sourceHashes`、`fileMap` 和 `licenses`；许可每项为 `{sourcePath,path,sha256}`，对应实际复制的原文与原始字节 hash，须随工程保留。只发现和保留已读模块、资源至所选根目录内相邻的 LICENSE/OFL/NOTICE 等文件，未发现实际许可时明确报告，不能推测授权完整。这些路径指运行时用户工程文件，不是技能包前置资料。

每次导入只追加一个新命名库。已有命名空间、指南或来源路径被占用、任一输出路径冲突或组件别名与已有组件重名时，整批拒绝，不覆盖或删除原文件，也不替换设计系统组件记录或说明。重复导入同一库不会自动更新或跳过；需要独立副本时选择新库名和不冲突的别名。修改已有组件使用正常源码更新，保留用户手改、额外文件、其他库、说明与评论。最终保存仍核对当前 revision，导入过程中发生的项目修改不能被覆盖。

无法封闭的动态 import/require、require 值别名、`new URL`、worker、query 模块变换、相对/外部 SVG 二级资源等会明确拒绝；静态 srcSet 列表需改为明确资产导入表达式。组件 prop 或 CSS-in-JS 的动态资源输入若有诊断，接入页面时须提供真实项目资源并实际检查，不能以导入成功宣称资源完整。保留类型源码不等于完整 TypeScript 类型检查；复杂包类型入口需提供可解析的声明源码。映射碰撞、越界和超预算均停止导入，不覆盖同名源码。

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

`design_code_request_generation.referenceId` 可选 `auto`、`none` 或 [案例索引](examples.md) 中的一个 ID；工具参数与 `design_get_guidance` 返回的目录给出当前可用 ID。默认 auto 在单个明确任务关系匹配时选一例；局改、修复或保留既有系统的请求不自动强加案例，多关系、否定/冲突或无匹配时也可不选。none 明确不选案例，显式 ID 只指定提供哪份材料，不表示它能覆盖主任务或换掉已有品牌。扩充目录不会增加单轮案例数量、图像或文本预算，也不会重选恢复中的材料快照。

独立 worker 没有文件、网络、MCP 或其他工具权限。运行时提供真实参考快照：原创规则、所选例的完整说明（最多 5,000 字符）、最多三段标明 `partial` 的源码摘录（每段最多 2,000、合计最多 6,000 字符），以及按实际审阅视口类别提供的参考 PNG；不提供四份工艺全文或整个案例库。摘录可能从声明或函数中截断，不能当作完整可运行文件。参考视图跟随每个审阅页面使用的前两个匹配视口：宽度不超过 600 时归 mobile，其余归 desktop，每类只发一次。

参考包的 metadata 与 content 文本 JSON 合计最多 14,000 字符，最多两张图，每图最多 2 MiB、合计最多 3 MiB，包的序列化字节最多 5 MiB；超预算或缺失实际资源会明确失败，不默默丢弃指定参考。项目生成上下文（含完整源码与元数据）另有 2 MiB 上限，原始任务 prompt 最多 30,000 字符；每轮文本总计最多 2.5 MiB、参考与作品图字节总计最多 64 MiB、整轮序列化输入最多 90 MiB。超限应明确缩小范围或采用当前聊天的按需工具，不截去用户需求或擅自扩大权限。

`reference` 返回实际选择、原因、文件 hash、快照 digest 与预算；`referenceTurns` 记录当前 job 最多三轮的 turnId、阶段、准备/投递/完成状态，以及参考和作品各自的图片 hash 与作品源 digest。准备尚未投递时 turnId 可为空，获得实际回执后才记录身份。这些是材料与回合身份，不证明模型理解程度或设计质量。参考 PNG 以 `design-reference`、工作稿图以 `current-work` 分别标记并作为独立图像输入；参考图不计作作品已渲染或 `modelReviewed` 证据。

最多三个同线程模型回合：初始真实文件提案，以及最多两次源码/截图反馈修正。生成、编译、浏览器检查与模型回看共享同一总预算，不为修正重置。它只修改私有提案副本；本轮文本提案支持新增/改写文本文件，二进制替换另用素材工具。

运行时检查当前目录中的模型图像输入能力和本地 Chromium。缺失时明确失败；权限拒绝、模型错误、取消或超时不能靠自动切模型或凭据绕过。明确选择本次审阅的真实页面和尺寸；实际覆盖范围以任务记录为准，不能代表其他页面或所有交互已经验收。

`design_code_get_generation` 返回状态、日志和 `verification.compiled/rendered/modelReviewed/viewports/pages`。`modelReviewed` 记录截图反馈回合完成，`pages` 记录实际覆盖页；没有自动交互验收字段。`completed` 的提案用 `design_code_apply_generation` 按原始 revision 和文件 hash 应用，不能套用到已经变化的工程。取消用 `design_code_cancel_generation` 并等待所拥有的任务退出。

当前私有草稿格式为 2，内部参考材料快照格式为 3。通过 `design_code_resume_generation` 显式开始新审阅时，继续使用支持格式的原快照，不因安装目录或案例更新而重新选例；重新编译、渲染后再审阅实际工作稿。新 job 记录本次回合，`resumedFrom` 指向来源草稿。`design_code_list_drafts` 分别返回当前 `drafts` 与不支持的 `unsupported`；旧草稿格式 1，以及草稿格式 2 中嵌入的旧参考材料格式 1 或 2，均明确不兼容。原文件不改不删，不提供迁移或旧规则恢复入口，也不将这些文件伪装成可继续审阅的当前草稿。

## 导出与版本

`design_code_export` 接受 `format: "html" | "zip" | "png" | "pdf"`，页面和尺寸使用工程中的 `pageId` / `viewportId`。可选 `expectedRevision` 锁定已查看的工程修订；不符时拒绝导出，先读取最新设计再确认意图。编辑器导出携带其当前修订。导出前必须修复相关页面的编译错误。

- HTML：包含实际运行代码、样式和允许的资产的自包含原型，多页工程保留真实页面导航。
- ZIP：`source/` 原始项目文件、`prototype.html` 可运行原型、`design-project.json` 项目描述。
- PNG/PDF：用本机 Chromium 按选定视口渲染或打印；不能将成功生成文件当作视觉验收。

### 重新打开 Design 工程 ZIP

编辑器“打开 Design 工程”选择本地 ZIP，提交后创建新副本。尚未提交时关闭不会保存；提交后的“关闭/后台完成”只离开对话框，任务成功后仍会保留实际创建的副本，并提供显式打开入口。晚到结果不应覆盖当前项目或未保存草稿。

`design_code_import_project` 接受：

| 参数 | 含义 |
| --- | --- |
| `file` 或 `dataBase64` | 二选一；明确选择的绝对本地文件，或规范 base64 ZIP 字节 |
| `name` | 可选副本名称；省略则保留原名 |
| `expectedSha256` | 可选 ZIP 字节 SHA-256；身份不符时拒绝保存，不代表数字签名或来源认证 |

只接受当前 `schemaVersion: 3` 的原生导出包：根目录 `design-project.json`、`prototype.html`，以及与清单逐字节一致的完整 `source/`。支持普通 stored/DEFLATE ZIP；拒绝越界、重名、符号链接、加密、多磁盘、ZIP64、额外未声明文件和损坏校验。输入与展开内容均最多 32 MiB，宿主可能有更小的实际上传限制。旧开发格式明确拒绝，不迁移或改写原文件。工具不把任意源码 ZIP 当成 Design 工程，不运行原型或源码，不自动安装依赖；后续预览仍使用真实源码编译。

返回 `project`、文件元数据 `files`、`archiveSha256` 和 `importedFrom: {projectId, revision}`。新项目使用新身份、当前创建时间、修订 1 和单条 import 历史；完整保留文件字节/编码、页面 ID/入口/路由、默认页、视口、设计系统、评论 ID/锚点。原项目和旧历史保持原状，旧工程的私有目录连接不继承。需要写回磁盘时，为新副本明确选择连接目录；不得根据归档原始身份猜测用户本地路径。

`design_code_export` 返回 `delivery`、原始文件的 `bytes`，以及 `artifactId`、`projectId`、`revision`、`pageId`、`format`、`sha256`、`filename`、`mimeType`、`expiresAt`。原始文件不超过 3,145,728 字节时为 `delivery: "inline"`，同时返回真实 `dataBase64`；更大时为 `delivery: "artifact"`，不返回 `dataBase64`，继续用同一 `artifactId` 保存。快照身份对应这一次实际导出的字节；后续项目修改或切页不改变该快照。

当 `delivery: "artifact"` 或宿主下载不可用时，用 `design_code_save_export`，唯一输入为 `{artifactId}`，保存这份原始字节到插件数据目录，返回真实路径与同一快照身份。它不会重新读取或导出当前项目。在缓存可用期内，成功保存后的重试返回原路径。用户取消下载后不自动保存。快照仅属于当前服务会话，最多保留 10 分钟；缓存最多 16 项、总计 64 MiB，单个导出最多 32 MiB，容量逐出也会提前失效。过期、逐出或服务重启后明确失败；需要新快照时显式重新导出，不把更新后的内容冒充原下载。以工具实际返回结果为准，不伪造下载链接。

代码版本恢复使用 `design_code_history/undo/redo/restore` 与准确 revision。

代码中的 CSS/JS 动效可以真实运行；独立 Motion 时间线、视频渲染、MP4 导出、在线多人协作和云端分享不在当前实现内。
