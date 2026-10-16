# CodeProject 编辑器 IAB 验证清单

日期：2026-10-17。**本文件是待执行的验证设计，不是通过记录。** 子代理当前没有 IAB 表面；实际浏览器操作由主线执行。执行后逐项补充真实项目 ID、修订、截图、工具回读与失败边界，不按计划步骤推定结果。

范围：真实 stdio MCP 驱动的开发预览。即使本清单全部通过，也只证明该开发预览路径；Codex 原生 MCP App、ChatGPT 宿主、独立模型推理分别验收。样式数量和指导文本长度不计作视觉质量证据。本轮不启动独立模型生成、不向真实宿主发送模型消息、不安装或发布。

## 1. 进入条件与定位器

- 主线预览地址当前为 `http://127.0.0.1:59342/`，入口必须加载最后一次构建的 HTML。更新源文件后需重建、重启预览服务并刷新页面；地址和后台进程以主线实际状态为准。
- 使用主线已有 IAB 页面句柄，下例记作 `qa`。不要操作旧版原生面板或其他浏览器标签页。
- 先读 `qa.playwright.domSnapshot()`，确认“代码设计”“本地 MCP 已连接”与 CodeProject 控件存在。每批交互后读取新状态，再决定下一步。
- 建议在专用测试数据目录创建两个项目，命名 `Code QA A`、`Code QA B`。记录创建返回的真实 ID，不用名称代替 API 的 `projectId`。

当前源码提供以下稳定定位。优先用角色和名称；`data-*` 只用于没有独立语义名称的源码输入与局部属性。

| 对象 | IAB locator |
|---|---|
| 工作区入口 | `qa.playwright.getByRole('button', { name: '代码设计', exact: true })` |
| 项目选择 | `qa.playwright.getByRole('combobox', { name: '当前原型项目', exact: true })` |
| 新建项目入口 | 项目选择器 `.selectOption('__new__')` |
| 新建对话框 | `qa.playwright.getByRole('dialog', { name: '创建代码原型', exact: true })` |
| 设计/源码视图 | `getByRole('button', { name: '设计效果', exact: true })` / `name: '源码'` |
| 运行/选择模式 | `getByRole('button', { name: '交互', exact: true })` / `name: '选择'` |
| 视口选择 | `getByRole('combobox', { name: '预览尺寸', exact: true })` |
| 桌面原型 | `qa.playwright.frameLocator('.dc-frame:nth-child(1) iframe')`，下例记作 `desktop` |
| 手机原型 | 全部尺寸模式下 `frameLocator('.dc-frame:nth-child(2) iframe')`，下例记作 `mobile` |
| 源文件 | `getByRole('button', { name: '打开 src/App.tsx', exact: true })` |
| 源码输入 | `qa.playwright.locator('[data-source-input]')` |
| 选中文字 | `getByRole('textbox', { name: '选中元素文字', exact: true })` |
| 局部颜色 | `qa.playwright.locator('[data-selection-style="color"]')` |
| 属性提交 | `getByRole('button', { name: '应用到源码', exact: true })` |
| 撤销/重做 | `getByRole('button', { name: '撤销 ⌘Z', exact: true })` / `name: '重做 ⌘⇧Z'` |
| 评论输入 | `qa.playwright.locator('[data-comment-draft]')` |
| AI 模式/模型/方向 | `locator('[data-ai-mode]')` / `[data-ai-model]` / `[data-ai-direction]` |
| AI 需求 | `qa.playwright.locator('[data-ai-prompt]')` |

上表的 frame 序号只适用于“全部尺寸”，且模板顺序仍为桌面、手机时。切到单视口后重新读取 DOM，不沿用原序号。原型内容只能通过该 iframe 的 locator 操作，避免同名按钮误点到宿主。

## 2. 创建与真实 React 状态

1. 切到代码设计，项目选择器选 `__new__`；在对话框中填 `Code QA A`，选择名称含 `React 组件项目` 的模板按钮，点击 `创建项目`。
2. 确认文件面板有 `index.html`、`styles.css`、`src/main.tsx`、`src/App.tsx` 和 `package.json`；预览出现桌面/手机两个页面。通过 `design_code_get` 记录修订与各文件哈希，检查每个 iframe 的 `sandbox` 属性为 `allow-scripts allow-forms`，且编译 HTML 的 CSP 保留 `form-action 'none'` 禁止网络提交。
3. 点击宿主 `交互`，读取桌面任务的初始状态：三个 checkbox，其中第二个选中；`.count` 内容为 `1 / 3`。

可执行动作示例：

```js
await qa.playwright.getByRole('button', { name: '交互', exact: true }).click();
await desktop.getByRole('checkbox').nth(0).setChecked(true);
nodeRepl.write(await desktop.locator('.count').innerText());
await desktop.getByRole('textbox', { name: '添加今天的计划', exact: true }).fill('QA 新增计划');
await desktop.getByRole('button', { name: '＋', exact: true }).click();
nodeRepl.write(await qa.playwright.domSnapshot());
```

必须实际看到 `2 / 3`，随后列表出现 `QA 新增计划` 且总数变为 4、输入框清空。再点 `认识工作室`，状态文字应切换到模板的 React 说明；点 `开始今天的创作 ↗` 后，焦点应落到任务输入框。不能只凭按钮存在判通过。

以上操作改变的是 iframe 的真实 React 状态，**项目修订和源文件哈希应保持不变**。两视口使用同一源码、各有独立运行时，不能要求桌面刚新增的临时任务自动出现在手机 iframe。

再打开 AI 或元素面板、切换“选择/交互”，确认这些非代码编辑操作没有重启当前原型、清除任务状态。`design_code_get` 同修订读回及后台 `ifRevision` 轮询也不应重启它。

## 3. 元素编辑、源码回读与撤销重做

先选择确定为静态 literal 的标题，避免拿含 `<br>` / `<em>` 的整个 H1 当作可直接改写文本。

```js
await qa.playwright.getByRole('button', { name: '选择', exact: true }).click();
await desktop.getByRole('heading', { name: '把灵感，落在今天。', exact: true }).click();
nodeRepl.write(await qa.playwright.domSnapshot());
```

通过标准：Inspector 显示准确的 `src/App.tsx`、源范围与 SHA256，并显示多实例共享源码的提示；“选中元素文字”为原标题。填写 `让灵感，成为作品。`，局部颜色填写 `#245b44`，点击 `应用到源码`。

回读 `design_code_read_file {projectId: A, file:'src/App.tsx'}` 与项目修订，确认：

- JSX 的目标标题真实改变，颜色写入目标元素的合法样式；其他 React 事件、任务状态逻辑及组件定义仍存在。
- 当前修订对应的宽窄预览均显示新标题和颜色，不能仅看 Inspector 文本；查看实际截图和运行错误。
- 修改来自源文件；刷新项目后仍存在，非浏览器局部 DOM 装饰。

点击一次撤销，再读源文件与 `design_code_history`：目标文案/颜色应恢复，历史只新增预期撤销。点击非编辑面板、改变焦点、等待跨过属性 debounce 和一次轮询后再读历史，不能出现额外 `update`。随后重做应恢复该编辑，不能因旧草稿重放丢失 redo。

动态内容反例也必须测试：选择模板任务列表中的运行时任务文字。若选中的是祖先容器，或桥回报 `runtimeLiteralText:false` / `ancestorMapped:true`，Inspector 应说明动态内容并关闭直接文字输入；源码定位和 AI 入口仍可用。不能用 AST 的空容器 `editableText:true` 冒充运行时任务数据可直接改写。

## 4. 源码编辑与文件 CAS

1. 点击 `打开源码`，或文件面板的 `打开 src/App.tsx`。确认选中源范围与刚才目标相符，源码输入不是只读展示。
2. 用只读 DOM evaluate 取出 textarea 当前值，保存到 REPL 变量；在变量中将模板页脚的 `Built with React. © 2026` 改为 `Built with React. · QA 源改`，通过 textarea `.fill()` 回填，再点击 `保存源码`。
3. 确认预览页脚真实变化，源文件 hash 和项目修订更新，其他文件 hash 保持原样；撤销/重做分别恢复与重放该源码改动。
4. 输入未保存的草稿，点击 AI 生成、撤销或导出前应明确提示先保存/协调，不能把未保存文本假称已进入项目。
5. 并发用例：保留一个未保存源码草稿，通过真实 MCP `design_code_update` 对同一测试文件提交另一项已核对 hash 的修改。等待 UI 读取新修订：草稿文本保留，冲突提示出现，保存被阻止；服务文件不能自动变成旧草稿。“重新载入”应恢复当前服务器文件。

独立 API 负例：对旧 hash 或旧 revision 提交一次更新，必须拒绝且源码不变。不自动换新 hash 重试。该断言来自实际服务器回读，不能用 UI toast 代替。

## 5. 原子评论与稳定锚

重新在最新设计预览中选择静态标题，点击 `评论此元素`，填写 `QA：保留这个标题的阅读层级。`，点击 `添加评论`。

应回读到一条真实 comment；`design_code_add_comment` 在同一修订保存它与所需稳定源标记。记录 `comment.id`、`file`、`sourceId`，并在 `src/App.tsx` 核对对应源标记；若原来已有语义标记，应保持既有身份。

随后在源码开头添加无关换行并保存，使源 offset 改变。点击评论的 `.anchor` 按钮，iframe 应通过 `design:focus` 滚到并高亮同一标题；不能按旧 offset 指到别的元素。再次选择该元素，Inspector 和 comment 仍关联同一语义身份。

破坏锚点负例：在专用测试项目移除该源标记，保存并重编译。点击旧评论只能打开对应文件并明确报告失锚，不能猜测绑定到当前位置。**当前 UI 静态审查的已知缺口：评论卡片仅因存在 `sourceId` 显示“元素锚点”，并非持续与最新 registry 对照；若只在点击时报告失锚，应记录为 UX 缺口，不能写成已完整持续标记失锚。**

标记评论“已解决”，再“重新打开”，各读回真实状态；刷新项目后保持一致。未经选中元素的文件级评论可不插入元素标记，但应标明其文件定位层级。

## 6. 切项目与异步归属

创建 `Code QA B`，先用 HTML 模板。A、B 各记录真实 ID、入口与修订。

- 有脏源码时切项目应明确阻止或保留/协调草稿，不能静默丢弃。
- 无脏源码时切到 B，Inspector 不应残留 A 的可提交元素；新评论和文件保存必须属于 B。回到 A，先前源码和评论仍存在。
- 专门覆盖异步窗口：A 的保存/评论/提案应用请求已发出，随后切 B；结果返回后不能将 B 视图换回 A、替换 B 的哈希或把 A 的任务标成 B 的任务。
- 当前 UI 的 `hydrate` 可能在 mutation 返回后另读一次项目，因此应覆盖这段读取期间的切换，而非只测请求前切换。若无法稳定触发，标为未覆盖；不可据普通切换通过推定该竞态已消除。

HTML 项目还应在“交互”模式实际添加/勾选任务、打开和关闭说明对话框；这验证经典全局脚本路径，不用 React 项目通过替代。

## 7. AI 配置读取与无模型测试边界

点击 `AI`，确认默认值是“当前聊天模型”。视觉方向来自真实 `design_get_guidance`；选项数量不得硬编码断言，应和工具返回 ID 集合核对。宿主与原生下拉的正常、选中、禁用文字均须可读。

选择“独立本地 Codex”，只读取 `design_list_models`：目录与真实返回相符，错误时报告不可用；不得制造可用模型或将列出模型视为已获推理权限。再切回当前聊天。

本清单不点击 `开始本地生成`，也不向真实模型发消息。因此以下只能关联单独的协议/fixture 测试，**不能登记为真实模型或真实宿主已验**：

- running → completed/failed/cancelled，四项 verification 分别显示，不以 compiled/rendered 冒充 modelReviewed。
- completed 明确尚未应用，提案文件可查阅，应用按钮是独立动作；CAS 失败保留原提案。
- 按项目保存 job，切项目不会误应用；取消须来自实际 worker 退出结果。
- 当前聊天在宿主不支持 message 时提供完整可复制提示词，支持时是否真的进入同一聊天需要原生宿主单独验证。

host fallback 可在已核对 `bridge.prompt` 只返回 `sent:false` 的开发预览中验证：填写一条 QA 需求、保留选中源码和未解决评论，点击 `交给当前聊天`，应只生成可复制提示词，包含方向、项目、选中源与评论上下文。核对后复制按钮可实际复制内容，但不要粘贴发送给模型。该结果不证明真实宿主消息能力；不要伪造宿主消息或 job 事件。

## 8. 手机与导出

先将宿主“预览尺寸”选为 `viewport_mobile`，重新定位单 iframe；核对它实际是 390 × 844 的运行视口。检查标题断行、任务输入/按钮、横向溢出和主行动，不把桌面画布缩放当作响应式。

外层编辑器窄屏通过 IAB viewport capability 单独检查，结束后恢复默认 viewport。元素/AI 抽屉、项目选择、撤销和导出仍可操作；不要把产品原型的手机视口与编辑器自身窄屏混为一项。

导出先保存所有草稿。点击 `导出代码原型`，对话框内选择所需 viewport。等待真实下载事件的顺序：

```js
const downloadPending = qa.playwright.waitForEvent('download');
await qa.playwright.getByRole('button', { name: 'ZIP 完整代码与素材', exact: true }).click();
const downloaded = await downloadPending;
nodeRepl.write(await downloaded.path());
```

实际按钮名称应以当前 DOM snapshot 为准。ZIP 应含入口、真实 TSX/CSS/JS 与导入素材，源内容对应当前修订。HTML 应包含编译后的可运行页面，不能只是截图；PNG/PDF 必须有真实文件、正确媒体头/尺寸，并回看画面。没有宿主 download 能力时，测试 `design_code_save_export` 的真实路径回读；拒绝或取消下载不能写成已保存。

仅清理本轮自己生成并核对过的下载文件，不删除其他 Downloads 内容。记录截图和导出路径后由主线决定是否保留审阅材料。

## 9. Legacy 属性草稿专项回归

这项对应已发现的“撤销后旧输入自动 apply、redo 丢失”，在独立图层测试项目执行，不操作用户当前原生面板。

1. 切 `图层设计`，创建落地页测试项目，选择一个文本节点；以 `[data-prop="text"]` 输入独特标记，等真实保存并核对一次 apply。
2. 保持文本框焦点，点击一次撤销。读回原文和 history；跨过 450ms debounce 与一次轮询，再点属性页签等非编辑控件使焦点变化，重读 history：只能有预期 undo，不能有晚到的 apply。
3. 点击 redo，应回到标记文本，且只增加预期 redo。
4. 再测试“刚输入、450ms 内立即 undo”：允许先 flush 一次用户编辑，再执行一次 undo；之后不得追加旧值 apply。
5. 在 A 文本输入尚待保存时选择 B 文本。A 的编辑只能提交给 A；B 的文本、样式和节点 ID 保持原值。不能按同名 `prop-text` 草稿键把 A 的文案写到 B。
6. 对没有改变值的字段制造正常焦点切换，不应创建新修订。旧 detached input 的 change 也不得提交。

此专项最终应附真实 history 序列与源文案回读，不能仅写“防抖逻辑已修”。

## 10. 执行结果登记

| 项目 | 当前状态 | 执行后补充 |
|---|---|---|
| React 真实状态、持久源码编辑、宽窄视口 | 待实测 | 项目 ID / 修订 / 路径 / 前后截图 |
| 静态元素样式/文字、动态容器只定位 | 待实测 | sourceId / 文件 hash / 编译与运行结果 |
| 撤销重做及无晚到 apply | 待实测 | 真实 history 序列 |
| 文件 CAS 与保留冲突草稿 | 待实测 | 成功/拒绝请求与源文件回读 |
| 评论原子锚定、移位与失锚 | 待实测 | comment/source 身份与变化记录 |
| 项目切换与异步竞态 | 待实测 | A/B 身份、触发时序与结果 |
| 目录/方向配置、模型 job 协议 | 配置待实测；job 由独立协议测试覆盖 | 工具结果与测试名称；不宣称真实推理 |
| 真实导出与外层窄屏 | 待实测 | 文件头/内容/截图与视口恢复 |
| Codex / ChatGPT 原生 MCP App | 不在本清单开发预览结论内 | 各宿主独立验收记录 |
