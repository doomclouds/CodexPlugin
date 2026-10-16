# Claude Code 2.1.296 设计指导与 Skill 载入链研究

研究日期：2026-10-17（Asia/Shanghai）。范围是本机公开发布程序、从其 Bun 容器精确恢复的资源，以及 Anthropic 官方公开仓库。本文是开发研究，不是发布 Skill 的执行依赖。

**结论：Claude 的设计方法不能概括成六种或几十种风格。** 本轮恢复了本地完整的 `artifact-design` 艺术指导、图表与图解专家资料及其注册链；它们先判断任务、内容和已有设计系统，再决定处理强度、字体、版式、颜色和验证。独立 `ClaudeDesign` 工具还会从云端获取实时设计约定；该部分正文没有恢复。`frontend-design` 则在官方公开插件仓库存在，本机发布程序中观察到的是安装推荐，不能把公开插件、内嵌 Artifact Skill 和云端 Design prompt 混为一套。

## 1. 证据范围与操作边界

本轮没有运行 Claude、执行提取的 JavaScript 或验证脚本、登录 Claude 云端、调用模型、读取私有项目或凭据。Bun 资源中的安装、构建、发布、联网等文字均作为分析数据，没有执行。

样本完整 SHA-256：`c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`。Mach-O `__BUN/__bun` 文件偏移为 `68206592`，区段大小 `171766891`，图数据起点 `68206600`。本轮按尾部 `Offsets` 与 `CompiledModuleGraphFile` 表恢复 `2609` 个模块记录；每条记录为 `52` 字节，模块表文件偏移 `239816222`。这些是该样本参数，不是跨版本格式承诺。

从表中读取了 `27` 个名称为 `SKILL-*` 的 Markdown 资源。部分是 zstd 压缩，部分使用 Bun 的 UTF-16LE 字符串存储；后者不能直接按 UTF-8 搜索，否则会误判为无内容。解压和转码只处理字节，不执行目标代码。

| 标识 | 工具与范围 | 实际结果 | 限制 |
| --- | --- | --- | --- |
| R1 | REA `analyze_javascript_application`，明确选择 11 个注册、载入和工具文件 | `356667` 字节，11 个 JS 解析成功，0 个解析失败 | 整体图为 partial，绝对 Bun 路径、动态调用和未选依赖仍有 unknown |
| R2 | REA `inspect_analysis_view`，精确检查 `H1t`、`SKILL_MD` 导出、载入引用与源位置 | 检查页 `42/42` 行已穷尽 | 只穷尽该页；不能声称覆盖整个应用。`H1t` 的 SequenceExpression 求值未被工具完整解释 |
| R3 | REA 补充分析页面合同包装、Artifact 注册和较大提示模块 | `4788863` 字节，3 个 JS 解析成功，0 个解析失败 | 语义图达到节点预算并截断；不用它证明全局缺失或完整行为 |
| B1 | Bun 表定位、原始切片比对、SHA-256、zstd 解压及声明编码转码 | 直接恢复下文所列 Skill 与 references | 这是静态字节证据，不等于该账号或宿主实际启用 |
| P1 | Anthropic 官方公开 `frontend-design` 当前主分支 | 查证存在独立插件与 Skill | 公开主分支可能不同于本机版本；没有检查本机已安装插件状态 |

R1 父 Evidence：`ev_88f7eaf9eeb73b6d68fdc583160ecab70e1678c60b6275a55f376973484478e0`。R2 检查 Evidence：`ev_43296809639fea66febed038d607c2ad5e66ebe9194a07d7d44ea2a22c435f73`。R3 父 Evidence：`ev_927d42f8014b59ad006ac5c3731ca1bcb375f941ae75114fb8336de6b313b0f6`。分析容器摘要：`9c98d60c13940c44bc5e1cdcb2f9ed52241529d63153cbbe87ac2c26919bae76`。

完整 Evidence 仅保存在本机临时分析包 `/tmp/claude-design-guidance-rea-evidence.json`，未纳入仓库。原始正文、解码资源及提取清单在 `/tmp/claude-design-guidance-2.1.296/`；它们不是插件资源，也不是使用本文的前提。

## 2. 注册入口与内容来源

### 2.1 `artifact-design`：完整的本地艺术指导

静态载入链为：

```text
chunk-yy4ay7w5.js 的 Ge()
  → zs({ name:s3, description:Vn, whenToUse:zn, userInvocable:false, ... })
  → chunk-g5m3cxby.js: s3 = "artifact-design"
  → getPromptForCommand() 调用 H1t()
  → chunk-6xrdcseg.js: 动态 import chunk-fdxb3vb4.js
  → SKILL_MD = Je("/$bunfs/root/SKILL-10242110.md.zst", import.meta.dirname)
  → chunk-chkhyhk3.js: 读取资源，识别 zstd 魔数，解压并转 UTF-8
  → 去除 frontmatter，替换 dataviz 占位提示，再经 M4o 加入适用的页面合同
```

这里的动态 `import` 仍然指向随包文件，**不是从服务器下载正文**。`chunk-v6b7qas5.js` 的 `zs/JNs` 负责将其转换为 `source: "bundled"` 的 prompt 型 Skill；带 `files` 的 Skill 另有包内资源解出和边界检查。

`Xn()` 仅在 `tengu_cobalt_plinth_dataviz` 门控开启且注册表含 `dataviz` 时加入图表提示。基础正文已在本地，门控影响提示组合与功能可见性，不能据此宣称任何账号一定获得该功能。

恢复的 metadata：

```yaml
name: artifact-design
description: Design guidance and fundamentals for Artifacts.
when_to_use: Load before writing any artifact, including a skill-instructed Markdown one - Markdown is never a shortcut past the design pass.
```

注册还设置 `isEnabled: tP`、`userInvocable: false`。它是模型写作前使用的基础指导，不是一个要求用户先选择风格的菜单。

正文解压后 SHA-256：`dc8b8f4adc295a46cd3cedb0739c7fe6fa405e600fb29238577badd66a27b7b5`，共 `20994` 个 UTF-8 字节、`88` 行。以下仅为中文分析，没有把正文收入发布包。

### 2.2 `dataviz`：有方法、参考资料和验证器的专家路径

注册链是同一注册模块中的 `Po()` → `name: ZNn`；常量 `ZNn = "dataviz"`。`Io()` 加载 `chunk-bn3yxas8.js`，后者导出本地 `SKILL_MD` 与 `SKILL_FILES`。它与 `artifact-design` 分工：前者决定图表如何诚实表达数据，后者继续约束承载图表的页面。

需要区分注册名与文件 frontmatter：运行时注册名为 `dataviz`，资源 frontmatter 的 `name` 却是 `Data Visualization`。实际调用身份由注册表决定，不能只从 Markdown 文件名或首行猜测工具名。

资源 frontmatter 的完整 description 如下，保留它是为了复核触发范围，未复制 Skill 正文：

```yaml
name: Data Visualization
description: >
  Produce a chart, graph, dashboard, or any data visualization that reads as one
  system - elegant, accessible, and consistent in light and dark - BRAND-NEUTRAL,
  shipping a placeholder palette to swap for your own. Read this BEFORE generating
  ANY chart (bar, line, area, heatmap, scatter,
  sparkline, donut), choosing chart colors, building a stat tile / meter / KPI row,
  or laying out a dashboard. Teaches a design-system-AGNOSTIC method: a form
  heuristic, a color formula with a runnable validator, mark specs, and interaction
  rules. The method is invariant; a design system plugs in its own ramps and
  surfaces. A validated default palette is documented in `references/palette.md`
  -- swap that file's values for your brand's. Triggers on: "chart", "graph", "plot", "data viz", "dashboard",
  "analytics", "visualize data", "categorical colors", "sequential / diverging
  palette", "stat tile", "sparkline", "heatmap", "legend", "axis", "tooltip",
  "chart colors", "color by series".
```

运行时 `hs` 的完整 description 还要求在选择图形、颜色、KPI 或布局前加载，覆盖 HTML/React、内联 SVG、各种绘图库及导出图像；当目标是宿主指定的原生文档连接器时，优先交付其可操作的数据图表，而不是丢失数据交互的截图。这里是语义概述；具体连接器可用性没有实测。

随包资源包括：

| 包内参考 | 解决的问题 | 恢复状态 |
| --- | --- | --- |
| `references/choosing-a-form.md` | 先判断数据任务，再决定是否需要图表和选什么形式 | 本地 UTF-16LE 资源已转码 |
| `references/color-formula.md` | 分类、顺序、数量、正负与状态的颜色职责及计算检查 | 本地已恢复 |
| `references/marks-and-anatomy.md` | 标记、间距、标签、图形骨架和数字信息 | 本地已恢复 |
| `references/interaction.md` | tooltip、hover、筛选与时间范围 | 本地已恢复 |
| `references/components.md` | 组成图表的真实 HTML 部件 | 本地已恢复 |
| `references/anti-patterns.md` | 失真的编码、过多颜色、裁切与交互错误 | 本地已恢复 |
| `references/palette.md` | 可替换的具体调色板实例 | 本地 zstd 资源已恢复 |
| `scripts/validate_palette.js/.py` | 可运行的数值验证器 | loader 引用和路径已确认；本轮未执行，也未复制其实现 |

这套方法把系列可区分、明度/彩度、色觉差异模拟、背景对比和模式一致性作为计算问题；其阈值绑定具体模拟模型与实例，不能抄出几个数字后声称它们是所有设计的通用标准。调色板只是参数，不能替代数据语义与编码关系。

### 2.3 图解和可复用 Artifact 组件

`artifact-diagramming` 注册为模型可调用 Skill，动态 import 的目标仍是本地 `chunk-e3s1k7xm.js` → `SKILL-kyber1ah.md`。metadata 为：

```yaml
name: artifact-diagramming
description: Diagramming know-how for Artifacts - when a picture earns its place, how to draw one that shows the real mechanism, and the inline-SVG mechanics that keep it legible in both themes.
```

其方法关注真实机制、关系变化、重要边界和箭头语义，以及 SVG 在两种主题中的可读性；不把系统名称装进几个方框就算作解释。

`artifact-components` 的 `St()` → `Et()` → `chunk-nk7tdb79.js`，加载本地 Markdown 与 decision 组件脚本、样式、token 和骨架。metadata 为：

```yaml
name: artifact-components
description: "Embed reusable artifact components in any HTML artifact - first entry: the workshop decision component (clickable option rows backed by a machine-readable record the session reads back). Use when a non-workshop artifact should carry decisions the reader answers from the published page, or to look up a component's exact scripts, styles, markup contract, and composition limits."
```

它处理读者选择与可机器读取的决定记录，不是新增一个视觉皮肤。`workshop`、`prototype`、report/data-table/explainer 等本地资源也已恢复，但本轮主要跟进的是它们与基础指导的路由关系，没有声称恢复所有组件的运行行为。

### 2.4 `frontend-design`：公开插件，不能误当成本机内嵌正文

本机提示模块 `chunk-sfn1dbxq.js` 包含安装 `frontend-design@claude-plugins-official` 的推荐；本轮恢复的 27 个 `SKILL-*` 资源中，没有识别出对应的内嵌 `frontend-design` 正文。这是限定范围内的观察，不证明本机未安装此插件，也不证明云端绝不提供其他版本。

Anthropic 官方公开仓库确有独立 [Frontend Design 插件](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/README.md) 和 [Skill 原文](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)。2026-10-17 读取的公开版面向新 UI 和已有界面的视觉重塑，强调内容特异的设计判断、刻意的字体与空间决策及避免模板惯性。它没有把能力边界定义为固定六种风格。公开文件的许可另有说明，本文未把其完整正文或其他专有 Skill 复制进我们的插件。

## 3. 真正的艺术指导内容

以下是对本地资源的归纳，不是对 Skill 的逐段翻译，也不是已实现功能清单。

| 决策层 | 本地观察到的方法 | 对我们的含义 |
| --- | --- | --- |
| 用户与已有系统 | 用户明确要求优先，其次使用已有 token、主题和组件，再补设计者判断 | 接收实际系统输入，不能用预设覆盖品牌或局部修改意图 |
| 任务处理强度 | 备忘、计划和 demo 可以克制；要保留或分享的产品界面、活动页等需要更有辨识度的处理 | 先做任务路由，再谈风格；不为每个任务都造巨型 hero |
| 主体特异性 | 从领域术语、单位、材料、内容结构和真实目标形成差异 | “这是哪一个业务”应当在页面中可见，而非只在 prompt 里有名字 |
| 字体与阅读 | 正文行长、标题层级、不同角色、真实 fallback、文字节奏共同决定阅读 | 字体列表数量不等于排版能力；中文回退与实际字形加载也要验证 |
| 颜色与主题 | token 形成共同来源；宿主背景、显式主题和系统主题都要考虑 | 不能只测默认亮色；有意单主题要显式处理背景与所有颜色 |
| 布局与重复 | 空间关系、对齐、内容驱动高度、响应式和局部滚动优先 | 卡片、圆角、边框和阴影按语义使用，不能平均分给所有区块 |
| 页面静止状态 | 初始画面就应表达工作内容；示例数据必须说明，不能用等待动画隐藏内容 | 截图和真实首屏验收应覆盖已加载状态及有意义的空状态 |
| 原型行为 | 输入、状态和真实数据能力需要区分；共享/持久化能力取决于运行时实际授权 | 代码能响应点击不等于已有云端数据库或多人协作 |
| 审阅预算 | 使用可用的预览反馈，按任务风险选择检查；避免无界反复打磨 | 检查必须有范围和停止条件；不能把检查次数照搬成质量保证 |

本地正文也明确警惕多种模型惯性组合：例如固定的暖纸色、展示衬线和陶土强调色，或固定深底加单一高饱和点缀。**我们的现有模板中也有类似组合，因此“换成另一种流行标签”不是完整整改。** 用户明确要求某种组合时应照做；没有要求时，应从主体和内容得出有理由的选择。

字体和依赖加载属于宿主合同。本地 Artifact 指导允许的 Google Fonts、特定 CDN 与页面运行时做法，不能直接搬到当前 Design 插件。我们的预览默认阻止外部网络，应该使用随包或项目内字体、明确的系统回退和已包含的依赖；声明了字体名不代表实际加载成功。

## 4. 云端动态内容与仍未知的部分

| 对象 | 能确认的来源 | 本轮能否恢复正文 |
| --- | --- | --- |
| `artifact-design` 基础指导 | 本地 zstd Markdown + 本地门控组合 + 页面合同包装 | 是 |
| `dataviz`、图解、decision 组件和模板指令 | 本地 Markdown、压缩资源及 loader | 相关资源是；运行效果未执行 |
| `ClaudeDesign.get_claude_design_prompt` | `ClaudeDesign` 代理经 `tools/call` 发给 `/v1/design/mcp` | 否；未访问服务器 |
| Claude Design 的设计系统组件指南 | 实时工具目录与指定项目/设计系统输入 | 未得到返回正文，不能假装与本地基础 Skill 相同 |
| Artifact 类型目录及类型 `SKILL.md` | `/api/frame/types/...` 的读取/描述链 | 客户端获取与处理路径可见，实际目录及具体类型正文未恢复 |
| Artifact runtime capabilities | 控制面返回能力目录、版本和定义 | 本地有装配逻辑，当前账号实际返回值未知 |
| 用户已有品牌资料、组件说明、token 与字体 | 用户指定的设计系统或项目 | 本轮不读私有项目；只恢复消费合同 |
| 官方 `frontend-design` 插件 | 官方公开仓库及独立插件安装机制 | 当前公开版可读；不能据此确认本机已安装或与 2.1.296 同版 |

`ClaudeDesign` 的本地工具 description 要求尽早请求实时约定。其代理先执行 `tools/list` 获取操作和 schema，再将具体 `operation` 作为远端工具调用；本地没有把完整设计系统指南写死。`/design` 注册则是带子命令的控制入口，并设置 `disableModelInvocation: true`；不能把这个控制命令本身当成全部艺术指导。

另一个已经恢复的本地 `design-sync` 合同说明：真实组件代码、`.d.ts` API、组件用法说明、provider 包裹方式、token、CSS 与字体闭包分别供运行时和设计模型消费。它强调设计模型只拿到导出的资料，不能假定模型会去猜客户源码里的类名或主题约定。详细工程链见 [既有 REA 工作流研究](claude-design-rea-workflow.md)，本轮未重新执行同步或上传。

## 5. 可迁移为原创规则的任务路由

以下是本项目的原创建议，**尚未因本文自动实现**。规则应依据任务和证据形成约束，六个预设方向仅作为例子，不再作为“可设计范围”的穷举。

| 输入任务 | 先解决什么 | 应加载的专业规则 | 首要交付与失败条件 |
| --- | --- | --- | --- |
| 读者按顺序阅读的文章、报告或提案 | 一条论点、证据顺序、阅读深度 | 长文排版、标题与注释、引用和图文关系 | 可读的正文结构；只有巨型标题和卡片摘要不算完整报告 |
| 高频操作的工作台、设置或管理界面 | 核心操作、状态和异常恢复 | 信息密度、表单、表格、键盘与反馈 | 可实际完成的任务路径；控件无效或错误无恢复路径即失败 |
| 品牌页、活动页、作品展示 | 主体记忆点与下一步行动 | 内容概念、图片语言、排版性格和节奏 | 主构图与业务相关；只换模板配色或假图片即失败 |
| 比较候选方案、让用户做决定 | 真正的差异、代价和决定依据 | 对比结构、选择记录、评论闭环 | 能指出选择会改变什么；选项卡片看着不同但没有实质差异即失败 |
| 图表、指标和分析页面 | 数据来源、单位、任务和比较关系 | 数据编码、比例、标签、可访问的替代读取方式 | 数据和图形一致；假数字、失真比例或筛选后语义漂移即失败 |
| 架构、机制或过程解释 | 因果、边界和关键流转 | 图解语法、箭头含义、前后差异 | 能解释机制；只有名称方框和无语义箭头即失败 |
| 复用已有设计系统 | 实际组件 API、依赖、样式、字体与 provider | 组件用法合同、构建和参考效果验证 | 使用真实可运行组件；猜出来的类名、prop 或静态假组件即失败 |
| 验证新产品想法的原型 | 用户假设、关键交互、真实与模拟边界 | 状态机、任务路径、示例与反馈 | 可运行的假设验证；把模拟数据说成实时能力即失败 |

同一个页面可组合多条路线，例如运营工作台需要操作界面规则和数据编码规则；品牌页内一张图表仍需经过图表规则。不能只因为出现“复古”“极简”等形容词就忽略功能与内容。

## 6. 原创的设计决策矩阵

每个任务输出一份可执行的设计约束，而不是强迫选择一个风格标签。建议至少记录下列维度：

| 维度 | 要做出的判断 | 落到代码/内容中的证据 | 不合格表现 |
| --- | --- | --- | --- |
| 主体与受众 | 谁在什么情境下要理解或完成什么 | 真实术语、内容优先级、主要行动与支持证据 | 换个品牌名仍然适用于任何项目 |
| 表达强度 | 克制、鲜明或实验性的程度及原因 | 标题尺度、视觉重心、图像比例与细节投入 | 所有页面都同样热闹，或都被压成通用后台 |
| 信息密度 | 连续阅读、快速扫描或高密度操作 | 栏宽、分组、行高、表格密度与渐进展开 | 为了“高级感”删除必要数据，或填满无意义装饰 |
| 空间关系 | 稳定轴线、交错叙事或受控不对称 | 网格、对齐、间距级差和宽窄屏重排 | 为了显得有设计感制造随机错位 |
| 字体角色 | 正文、展示、数据、操作各自怎样服务内容 | 可加载字体/系统回退、字号比例、数字与中文样本 | 只有字体名，没有加载、字形和阅读效果依据 |
| 颜色职责 | 品牌强调、状态、系列身份、数量和背景分别如何编码 | 语义 token、面积主次、对比与模式检查 | 多个不相关职责共用一个强调色，或颜色顺序随数据筛选改变 |
| 图像语言 | 图片要说明、证明还是建立语境 | 合法可用资产、裁切规则、图片与正文关系 | 缺图却谎称生成成功，或装饰图冒充真实数据 |
| 交互与动态 | 哪些动作真实实现，动态效果为何存在 | 状态、事件、focus/hover、减少动态偏好和恢复路径 | 存在纯装饰按钮；用动画掩盖未实现内容 |
| 系统一致性 | 哪些来自既有品牌，哪些是本次新增 | 组件真实 API、token、字体与样式闭包 | 换了皮肤却破坏已有组件约定 |
| 验收范围 | 此次究竟看过哪些状态与尺寸 | 修订号、构建结果、真实渲染、图像反馈和目标动作回读 | 用一次截图或协议测试笼统声称“视觉与交互全通过” |

建议将这些约束存成工程自己的设计说明，允许用户使用自由描述、参考图或已有系统。预设可以帮助起步，但新增方向不应被迫等待插件增加一个枚举 ID。当前六个方向 API 是有限预设；未来增加自由约束与专业路由，比把枚举简单扩成三十项更有价值。

## 7. 失败检查与验证闭环

这些是建议的实现目标，本文没有替代真实验收：

1. **结构与依赖**：工程路径、导入、组件 API 和资产闭包都成立；缺少依赖、字体或图片时明确失败或说明降级，不能静默伪造成功。
2. **初始状态**：主要内容可见，工作台有真实数据或明确示例；空状态给出任务线索，不靠滚动触发才出现正文。
3. **文本与字体**：核对长中文、短标签、数字和实际字体加载。computed `font-family` 字符串本身不能证明所有字形来自目标字体。
4. **布局与主题**：检查用户需要的宽窄尺寸和主题，避免全页横向溢出、遮挡、裁切和主题混色。有意单主题也要显式保证背景与控件可读。
5. **数据与图解**：比对原始数据、单位、比例、基线与标记；系列颜色稳定，必要的值可直接或以表格读取，机制图能指出因果与差异。
6. **目标交互**：实际执行本次关键动作并读回状态；还要覆盖相关错误、取消或恢复路径。静态截图不证明提交、保存、筛选或导航正确。
7. **内容辨识度**：检视最显眼的选择是否由主体和任务支持。若只改名字就能移用到任意行业，应重做概念或内容结构，而非随机换一个标签。
8. **源码保留与应用**：选中编辑对应正确文件与源区间；应用前核对 revision 和文件 hash，保留无关修改。模型得到截图、修改提案完成与用户工程已经应用是不同状态。

本地 Artifact 指导有明确的有限检查预算和发布取舍。这说明应设计有界流程，不说明我们应该机械照搬“只能看一次”。我们的目标包括源码往返、实际交互和本地可恢复状态，检查应按任务风险、已有失败和剩余预算分配；通过的检查不重复，失败后修复关联部分。

## 附录：关键切片定位

| Bun 原名称 | 文件偏移 | 原始长度 | 用途 |
| --- | ---: | ---: | --- |
| `chunk-yy4ay7w5.js` | 204636736 | 233145 | 注册 `artifact-design`、`dataviz`、图解、组件、原型及控制命令 |
| `chunk-g5m3cxby.js` | 193707717 | 1085 | 规范调用名常量 |
| `chunk-6xrdcseg.js` | 204629449 | 1623 | `H1t` 和门控提示组合 |
| `chunk-fdxb3vb4.js` | 223355432 | 768 | 基础设计 Skill 的压缩资源 loader |
| `SKILL-10242110.md.zst` | 237327418 | 8519 | 本地完整基础设计指导 |
| `chunk-bn3yxas8.js` | 223227351 | 1628 | dataviz 的正文、参考和验证器索引 |
| `SKILL-8zd8x5rj.md` | 237456038 | 16068 | UTF-16LE 图表 Skill；转 UTF-8 后为 8034 字节 |
| `chunk-e3s1k7xm.js` | 223230360 | 736 | 图解 Skill loader |
| `SKILL-kyber1ah.md` | 237335938 | 4057 | 图解正文 |
| `chunk-nk7tdb79.js` | 223228980 | 1379 | 可复用 decision 组件和 Skill 索引 |
| `SKILL-fjp06kkf.md` | 237283333 | 6887 | 组件使用 Skill |
| `chunk-xnkq6d5e.js` | 220390501 | 57822 | ClaudeDesign 远端操作代理 |

`SKILL-10242110.md.zst` 原始 SHA-256：`762195330a008f6da7a468ebd41bef51fb421f536c0737ab79e2a5fd76aeaf82`；解压后：`dc8b8f4adc295a46cd3cedb0739c7fe6fa405e600fb29238577badd66a27b7b5`。dataviz 原始 UTF-16LE SHA-256：`1f494d9efa11c0868f9f00dc65f7906c56f6b8e5753f17311ace9a3dbf3bbc94`；转 UTF-8 后：`7c0d30f047fa1bf2bfd90579b3ea3372b634a96393047d5f3edb1155563d514a`。必须区分原始资产身份与解码产物身份。
