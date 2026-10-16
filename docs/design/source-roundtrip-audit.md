# Design 0.3 源码工程往返审阅

**审阅结论推动本轮实现了“连接已有源码目录，比较差异后合回同一项目，再安全回写”。** 下文“实施前审阅”保留当时缺口和源码证据，“实施续记”记录随后获授权的实现与真实临时目录测试。不能用项目 JSON、截图生成或另建一次导入项目替代工程往返路径；UI 与原生宿主验收仍需单独完成。

本轮于 2026-10-17 先完成只读源码与已有测试审阅，后按明确授权实现并在受控临时目录实际操作；未启动浏览器或模型。实施前“确认”只表示由当时指定源码确定。主线的原生 MCP App、当前聊天改稿和设计样本 QA 不属于本轮源码同步 UI 的通过证据。

## 实施前审阅

## 证据范围

审阅时仓库基点为 `c3bb9b25ce4547c80f11ddd6950d723aba52498f`；工作区含未提交改动，不能以该提交代替本轮源码版本。关键文件 SHA-256：

| 文件 | 本轮读取内容的 SHA-256 |
| --- | --- |
| `plugins/design/src/code-project.ts` | `2a923bec8ac73db29d5df36e41ef8eebf74901f4237bcabcca48fadb57e945d6` |
| `plugins/design/src/code-server.ts` | `17786c5c6a99e6837630b51b7f660a6e92d908bb06d8254cdf55def4f67f2f86` |
| `plugins/design/ui/code-editor.ts` | `4c39231f19fd41544d2a5628601db1d030cb86b7bba2c371d22687d32b8b8091` |
| `plugins/design/ui/app.ts` | `059236ab9540d28d7c5b8181e968d6e8f87aa5d9aa61a439ef07eb6ff9241ec9` |
| `plugins/design/scripts/smoke.mjs` | `eb2a54df95ffce45e5efc90a98776860042fab8d7f6b44b096fa54ac8b25ebf2` |

行号按本轮版本记录，后续修改时应以符号和 hash 复核。

## 当前链路与确切边界

| 环节 | 实现证据 | 已有能力 | 未闭合的用户路径 |
| --- | --- | --- | --- |
| 目录导入 | [CodeProjectStore.importDirectory](../../plugins/design/src/code-project.ts#L162-L191) | 只读扫描源码、图片和字体，创建 schema 2 项目；HTML 可登记多页，不执行脚本或安装依赖 | 没有导入报告、目录连接身份或共同基线。重新导入创建新项目，不能延续原评论、页面身份和历史 |
| 普通工程运行 | [预览模块解析](../../plugins/design/src/code-preview.ts#L195-L229) | 使用真实相对模块、CSS、资产和内置 React；缺失依赖给出诊断 | 导入成功不等于原工程运行成功。普通依赖、别名、框架配置、服务器能力没有自动接入合同 |
| 插件内修改 | [update](../../plugins/design/src/code-project.ts#L138-L155)、[change/write](../../plugins/design/src/code-project.ts#L241-L276) | 整批文件修改同时校验 revision 和每个 expectedHash，内部项目原子保存；撤销/重做有真实历史 | 这些 hash 只保护插件内快照，不能自动表示磁盘目录仍与它一致 |
| 外部编辑回读 | [MCP 工具注册](../../plugins/design/src/code-server.ts#L30-L56)、[UI 轮询](../../plugins/design/ui/code-editor.ts#L916-L925) | 当前聊天可显式提交按 hash 合并后的源码；面板刷新插件内新修订 | 没有目录扫描、三方差异、合并或连接恢复工具。面板三秒轮询不是磁盘监听 |
| 源码目录导出 | [exportDirectory](../../plugins/design/src/code-project.ts#L194-L231) | 目录锁、同步清单、已有/缺失文件 hash、项目 revision、暂存区和写前复核；拒绝无关文件或外部改动 | 无 manifest 的原始目录不能首次回写；外部已改文件即使与项目目标内容相同也会被旧清单校验拒绝 |
| 部分写入 | [写入/异常处理](../../plugins/design/src/code-project.ts#L212-L229)、[MCP failure](../../plugins/design/src/code-server.ts#L22-L28)、[面板 unpack](../../plugins/design/ui/app.ts#L9-L16) | 已写文件后失败会返回 `EXPORT_PARTIAL`，不会伪称整体成功 | 没有持久恢复日志或恢复入口。MCP 丢弃 `directory/filesWritten`，面板又将结构化错误降为文字 Error |
| 工程交付 | [HTML/ZIP 导出](../../plugins/design/src/code-export.ts#L15-L30)、[UI 下载](../../plugins/design/ui/code-editor.ts#L731-L750) | ZIP 含真实 `source/`、项目描述与可运行 HTML，图片/PDF 来自实际渲染 | ZIP 仅包含已经进入 CodeProject 的文件，不能证明原目录完整；面板仅提供文件下载，没有目录连接/回写面板 |

已有测试覆盖导入不执行源码、跳过保留目录和符号链接，以及正常目录导出、外部改动拒绝和符号链接拒绝：[code-project.test.ts:79–129](../../plugins/design/tests/code-project.test.ts#L79-L129)。HTML 多页导入有专门断言：[code-pages.test.ts:91–97](../../plugins/design/tests/code-pages.test.ts#L91-L97)。隔离 MCP smoke 覆盖真实模板源码修改、预览、评论、修订和 HTML 导出，但没有调用目录导入或目录回写：[smoke.mjs:18–43](../../plugins/design/scripts/smoke.mjs#L18-L43)。本轮未将这些测试的存在写成已完成“原工程往返”验收。

## 四个具体断点

### 1. 原目录第一次回写即被视为无关文件

最小场景：用户目录只有 `index.html`、`styles.css` 和 `app.js`。调用 `design_code_import_directory`，在 Design 修改标题，再用 `design_code_write_directory` 指定同一目录。

**源码确认：此路径会被当前导出保护拒绝。** 导入仅返回新项目，不保存源目录清单；导出读不到 `.design-code-export.json`，于是 `old` 为 `undefined`。`check(name)` 将已有文件的 hash 与 `old?.hashes[name]` 比较，即使该文件仍与最初导入完全相同，也不等于 `undefined`，因而报 `Source changed outside Design or is unrelated`。这项保护应保留，但需要导入时建立可审查的原始基线，不能靠放宽“无关文件”检查修复。

目前可行的导出目标是新空目录，随后在该受管目录继续导出。它适合交付副本，仍不是用户原工程的连续编辑体验。

### 2. 合并源码意图后，同步清单仍停在旧内容

设首次导出基线为 B：`App.tsx=B1`、`styles.css=B2`。外部编辑器把 App 改为 E1，Design 把 CSS 改为 P2。当前模型可通过宿主文件工具读取 E1，再按插件当前 hash/revision 把 E1 合入同一项目；但目录清单仍记录 B1。再次导出对磁盘 E1 的检查仍失败，即便项目中的 App 也已是 E1。

缺少的不是让模型再抄一次全文，而是**确认 E1 已被合入后，安全推进共同基线的操作**。直接手改/删除 manifest、改用新目录或重建项目会绕开审查，且不能作为正常工作流。仅有 MCP 的宿主也缺少专用外部目录差异读取能力，不应假定所有当前聊天都附带本机 shell。

### 3. 一部分文件已落盘时，用户无法审查并继续

假设导出要更新 A 和 B：A 已 rename 成功，外部编辑器在 B 的写前复核前保存 B，随后导出失败。实现会报告部分写入，并在 `finally` 删除暂存区；旧 manifest 仍记录旧 A/B。下一次重试首先发现 A 不匹配旧 manifest，不能直接继续。项目历史只恢复插件内快照，不会撤销磁盘 A。

进程在 A 已写、manifest 尚未提交之间退出时，连内存错误中的 `filesWritten` 也没有可依赖的持久记录。若所有文件和 manifest 已提交后，最后一次项目 revision 复核才发现新修订，当前错误也仍归类为 `EXPORT_PARTIAL`，尚不能区分“文件部分写入”与“目录已完整导出某旧修订”。

目录锁仅协调遵守同一锁的 Design 进程。外部编辑器通常不遵守此锁；最终 `check` 与 `rename` 之间仍存在并发窗口，不能宣称通用文件系统上的多文件写入是全目录原子事务。

### 4. “完整工程”必须区分受管源码与旁路文件

当前导入只接受指定后缀，跳过 `.git/.codex/.agents/node_modules` 与内部清单；其他后缀也静默忽略。普通 React 工程可能含 `.scss`、`.yaml`、无扩展名 `LICENSE`、配置或其他资产。预览还会拒绝未打包的普通依赖和别名。反过来，`dist` 等生成目录未专门排除，会参与扫描并消耗预算。以上均应作为导入清单和编译诊断展示，不能仅说“已导入 N 个文件”就表示普通目录完整运行。

导入 UTF-8 使用默认 `TextDecoder`，会去掉 UTF-8 BOM。本轮仅以无文件写入的 Node 表达式验证：输入 `EF BB BF 61` 四字节解码并重编码后为一字节 `61`。因此未来的磁盘共同基线必须保存**原始字节 hash**，不能直接把已解码 CodeFile 的 hash 当作原目录字节证明。目录导出还会重写全部受管文件、使用暂存文件的权限；未变文件和原有文件元数据需有明确保留策略。

## 推荐下一项：显式源码连接与可恢复的差异应用

这是一个围绕同一工程身份的完整功能切片，不是自动 watcher，也不是新的截图模式。第一版只在用户明确选择目录和点击操作后执行；不运行依赖安装、构建脚本或后端。已有项目 revision/hash、真实预览与评论身份继续复用。

### 数据与用户操作

1. **建立连接。** 导入时保存私有 `SourceLink`：项目 ID、所选目录的规范身份、受管路径、原始字节 hash、共同基线内容/引用，以及包含/排除/不支持项报告。路径仅保存在本地连接数据，不写进可分发项目、ZIP 或 Skill；不改原目录就能先形成比较基线。已存在项目也应能在比较后显式关联目录，不能凭相似文件名自动认领。
2. **比较两端。** 用户点击“检查源码变化”，读取共同基线 B、插件项目 P 和磁盘 D。按文件显示仅项目改、仅目录改、双方同改、双方相同、增删、类型变化和不可读状态。纯文本提供有范围的三方差异；二进制只比较实际字节 hash 和元数据，选边时服务端搬运真实字节，不通过聊天转抄 base64。
3. **合并与回写。** 仅目录改可明确导入，只有项目改可明确写回；双方不同必须保留冲突并让用户/当前模型提交合并结果。同一文件双方已成相同内容可安全确认并推进基线，不再被旧 manifest 永久卡住。删除、重命名与页面/评论引用失效需明确展示；无法确定重命名时按“删+增”呈现，不能猜测。
4. **恢复。** 应用前持久保存操作日志、目标 revision、两端期望 hash、计划写/删路径和实际已完成步骤。中断重开后先比较现场，再提供“检查并继续”或“检查后回滚”；遇到后续外部改动暂停，不能用旧备份覆盖用户新保存。备份仅用于当前事务，成功后按有上限的保留策略清理。任何跨项目存储与源目录的应用都分阶段记录，不声称两端整体原子。

### 建议接口（尚未注册）

| 接口 | 输入要点 | 输出与约束 |
| --- | --- | --- |
| `design_code_connect_directory` | `projectId`、用户明确选择的 `directory`，可选导入基线标识 | 返回 `linkId`、受管/旁路文件报告和首次比较摘要；不直接写源目录，不以同名自动覆盖 |
| `design_code_compare_directory` | `projectId`、`linkId` | 返回不可变 `planId`、项目 revision、基线标识、磁盘清单摘要、逐文件状态；扫描不启动模型，不写任一端 |
| `design_code_read_directory_diff` | `planId`、项目相对 `file` | 返回受限文本 B/P/D 与三个 hash，或二进制元数据；源目录不能被任意工具参数越界替换 |
| `design_code_apply_directory_plan` | `planId`、`expectedRevision`、明确逐项选择与合并内容 | 执行前重新核对两端 hash、目录身份与计划，出现漂移整份计划失效；返回 `operationId` 和阶段，未完成时保留恢复记录 |
| `design_code_get_directory_operation` / `design_code_recover_directory_operation` | `operationId`，恢复需显式 `continue` / `rollback` | 返回实际已写、已删、未处理、需人工合并路径；恢复前重新读现场，不能自动重试或覆盖后续外部保存 |

MCP 错误必须保留结构化 `operationId/directory/filesWritten/filesDeleted/pendingFiles/phase`，面板显示对应路径和恢复行动。无需把所有内容塞进通知；“导出失败”后仍应看得到完整操作记录。

面板增加一个小型“源码目录”区域：显示已连接工程、基线、最近检查时间和差异数，提供“检查变化”“查看差异”“应用所选项”及中断记录。相对路径、文本变化、真实预览和当前聊天需求连续可达；当前聊天只收到相关 diff 与当前项目 revision，不被迫另建项目或重新生成设计。无宿主目录选择能力时可接受用户明确输入路径并核对，不展示假的选择器。

### 第一版验收合同

以下全部为待实现、待实测；同一组文件应经过真实 MCP 与宿主 UI 操作，不能只测试 store 或 JSON。

| 案例 | 具体操作 | 必须读回的结果 |
| --- | --- | --- |
| 原 HTML 工程首次往返 | 导入含 CSS、脚本、图片、嵌套第二页的真实目录；改标题；回写原目录 | 保持同一项目/页面/评论身份；相关文件真实改变，未改文件字节/元数据按合同保持；实际导航和交互仍可用 |
| 普通 React 工程 | 带 package 文件、相对组件、真实 CSS/图片和现有任务状态的工程导入；包含一个未支持依赖作负例 | 已包含、旁路和缺依赖逐项可见；可支持部分真实编译/运行，失败依赖不被假组件替代；回写保留未受管文件 |
| 非重叠两端编辑 | 外部改 App 文案，Design 改 CSS；比较后合并并回写 | 两项修改同时存在；同一项目新增真实修订；基线推进后再次检查无假冲突 |
| 同文件冲突与再次保存 | 两端分别改同一句；检查后外部再保存一次 | 三方内容均可核对，旧计划应用被拒绝；用户输入与外部新保存均保留，不只替换 hash 重试 |
| 增删与二进制 | 外部增图、改图、删 CSS；项目同时调整引用 | 二进制实际字节进入选定端；删除与引用失效清楚报告；无关文件不被认领或删除 |
| 部分写入与重开 | 在第一文件写入后制造第二文件写失败，再结束进程并重开 | 现场与日志可比较；明确已完成路径；继续/回滚不覆盖中断后的用户保存；只有 manifest 和必要文件达到一致才报告完成 |
| 导出与真实运行 | 同步完成后导出源码 ZIP 和离线 HTML，回读源码并操作目标任务 | 包含实际受管工程、依赖/旁路报告、真实素材和目标修订；截图之外验证交互与源码可继续修改 |

先完成这条工程往返切片，再增加自动检测、更多框架适配或大规模目录策略。现有保护应作为基础保留；不能以取消 hash 校验、删除 manifest 或默认重建项目换取表面的“同步成功”。

## 实施续记：本轮已落盘的切片

上节接口是实施前建议；本轮实际合同采用下列较小且完整的显式流程，尚未包含不可变 plan 或回滚。

- `design_code_import_directory` 在同一私有 CodeRecord 中保存 `sourceLink`，原目录只读，不写 manifest。`get`、历史快照和 HTML/ZIP 仍只使用 CodeProject；私有目录、基线及操作记录不进入交付元数据。
- `design_code_source_status` 返回连接位置与写入记录；`design_code_connect_directory` 为尚未连接的项目显式连接目录，字节不同的文件保留冲突。
- `design_code_compare_source` 返回真实两端与基线 hash。`design_code_pull_source` / `design_code_push_source` 要求准确项目修订、所选路径和看到的 `expectedDirectoryHashes`；服务端重新读取，并拒绝双方同文件变化。两端独立产生相同新内容也需显式确认。
- `design_code_read_source_difference` 返回当前两端真实文本或二进制元数据。`design_code_resolve_source` 按准确修订和两端 hash 明确选择项目或目录版本；它是用户审阅后的选边，**不是自动语义合并或三方原文比较**。
- 写回使用项目锁和目录锁、写前两次文件核对、写后实际 hash 回读。触碰源码前，先在同一私有记录持久保存全部逐文件 from/to hash 计划；正常完成或受控失败时再保存实际进度和基线，避免每个文件都重写最多 96 MiB 的完整历史。硬中断时 `design_code_recheck_source` 按已落盘计划和现场 hash 重建已完成项，后续新改动保留冲突，再由用户选择剩余安全变化；不自动继续，也不提供回滚。
- 面板增加“源码目录”、工程导入、可见位置与同步状态、文件选择、明确 pull/push、双端对照/选边以及未完成操作重查。结构化失败保留目录、实际已写与待处理路径。
- 展示用 ignored 摘要最多 200 项；安全判断另存完整 unsafe path 集合。双方都已不存在的空基线立即移除，写前验证私有 schema 和容量，避免正常增删长期累计导致项目不可读。

**真实检查范围：** `node --experimental-strip-types --test plugins/design/tests/source-roundtrip.test.ts plugins/design/tests/code-project.test.ts plugins/design/tests/code-pages.test.ts` 本轮执行通过 23 项、0 失败、0 跳过。新测试使用真实临时目录和 MCP Client/Server，没有模型调用；部分失败由真实目录写权限制造，未用返回值伪造成功。峰值容量测试明确构造合法私有记录，以验证“中间超预算、最终未超”的拒绝边界，不作为普通目录实测代替品。

| 本轮已执行案例 | 实际读回 |
| --- | --- |
| HTML 工程导入、改稿、写回原目录、外部修改拉回同一项目 | 原目录实际字节、未改文件 mtime、未受管 LICENSE、项目修订与源码 |
| React 工程导入、编译、修改、回写、外部修改、拉取后再编译 | 真实 TSX/CSS 与两次编译诊断；未做本轮浏览器交互验收 |
| 双端不同修改、过期比较、外部二次保存、显式冲突选边 | 拒绝旧 hash，保留磁盘手工修改，重新审阅后项目真实更新 |
| 第二个文件因权限失败、重开存储、失败后再次手工修改、重查并继续 | MCP 的 `directory/filesWritten/pendingFiles/operationId`、持久记录与最终两端字节 |
| BOM、增删、目录身份替换、tracked symlink 位于 200 项摘要之外 | 原始 BOM 字节保存；安全路径拒绝且外部目标内容不变 |
| 1200 个不同路径分批实际增删后重开项目 | 私有基线未积累空 tombstone，项目仍可读取 |
| 逐步骤的私有基线/日志容量峰值 | 即便批次最终未超预算，中间超限也在任何目录写入前拒绝，原目录保持原样 |
| 双方同样的新内容 | 普通 push 仍冲突；显式确认后推进基线，不重写磁盘文件 mtime |
| 私有信息隔离 | 当前 CodeProject 和实际 ZIP 不含测试目录绝对路径 |

**仍待验证或存在的边界：** 上述测试不等于原生 MCP App 的源码目录区域已被点击验收；亮暗与窄屏、焦点、冲突对照和连续操作由主线另验。普通工程的未支持后缀/依赖仍需看导入报告与真实编译诊断；本轮没有扩成任意框架开发服务器。外部编辑器不遵守目录锁，最终 hash 核对与文件系统 rename 之间仍有并发窗口，不能宣称绝对无丢失或全目录原子。写入时应避免两端同时保存同一文件。

持久 journal/recheck 仅覆盖**连接目录**。原 `design_code_write_directory` 指向其他目录仍沿用独立 manifest 保护；其部分失败虽保留已写路径，却没有同一恢复记录，需要人工检查文件和清单，不能把本轮恢复能力推广到所有导出。后续如需更强并发保障，应单独设计保留被替换文件、独占发布和现场恢复，不能只增加“安全”措辞。
