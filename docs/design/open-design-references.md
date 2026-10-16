# Huashu Design 与 OpenDesign 参考研究

研究日期：2026-10-17。结论：应吸收两者的**按任务组合设计知识、从既有品牌与源码推导、真实画面评审**的方法。当前六个视觉方向可以保留为起点，但不应继续承担全部需求识别、组件设计、状态覆盖和验收规则。

本次只做公开仓库浅克隆与静态阅读，没有安装技能、运行目标代码、发布或执行其安装命令。下文区分已存在的文件、仓库自述与本项目建议；未将星标数、模板数量、“还原率”或获奖级措辞视为效果证明。案例仅核实源码、配套文件和依赖，未在本轮运行或完成视觉验收。

## 1. 固定研究版本与许可

| 仓库 | 分支、固定提交 | 已核实许可 | 阅读边界 |
|---|---|---|---|
| [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design) | `master`，[`3bd465d7ad29ffcb284113beb48910b469f00797`](https://github.com/alchaincyf/huashu-design/commit/3bd465d7ad29ffcb284113beb48910b469f00797)，提交时间 2026-10-13 | 根 [`LICENSE`](https://github.com/alchaincyf/huashu-design/blob/3bd465d7ad29ffcb284113beb48910b469f00797/LICENSE)：MIT，版权标注为 alchaincyf（花叔 · 花生） | `SKILL.md`、设计/排印/品牌/评审/验证 references、showcase 索引、代表 HTML 与测试提示 |
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | `main`，[`78d5637cb49da07e81314d1544b5fc6d37c95084`](https://github.com/nexu-io/open-design/commit/78d5637cb49da07e81314d1544b5fc6d37c95084)，提交时间 2026-10-16 UTC | 根 [`LICENSE`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/LICENSE)：Apache-2.0；子包可能另有许可 | 工作流协议、prompt 组合、craft、代表 skills、OD Next prototype profile、两个设计系统包与两个模板 |

OpenDesign 并非每个目录都包含完整上游能力。例如 `skills/design-review/SKILL.md`、`skills/design-consultation/SKILL.md`、`skills/color-expert/SKILL.md`、`skills/apple-hig/SKILL.md`、`skills/design-md/SKILL.md` 是指向其他仓库的目录条目，正文要求另取上游 bundle。它们证明了分类与发现方式，不能证明 OpenDesign 已随包包含这些上游脚本和参考资料。不要把这些条目直接转成我们的可用执行能力。

## 2. 值得借鉴的组织方式

### Huashu：从设计推理到可见变体

入口 [`SKILL.md`](https://github.com/alchaincyf/huashu-design/blob/3bd465d7ad29ffcb284113beb48910b469f00797/SKILL.md) 按原型、幻灯片、动画、评审、品牌资产等任务路由。具体知识另置于以下原始路径：

- `references/design-context.md`：优先读取用户设计系统、组件实现、已发布产品和品牌资产，提取精确 token 与布局值。
- `references/typography.md`：先判断内容类型、语言、层级与行长，再选字体；有独立中文排印规则。
- `references/design-styles.md`：每项同时给适用任务、视觉特征、HTML 实现方式及素材限制，价值在这些可执行字段。
- `references/brand-asset-protocol.md`：将真实 logo、产品图、界面截图与品牌禁区纳入设计输入。
- `references/critique-guide.md`：先检查概念与内容的关系，再评层级、细节和功能；提供问题对应修复方向。
- `references/verification.md`：区分真正渲染、缩略图、控制台检查、多视口与交互检查。

其重要启发是：风格名称只负责提出可能性，具体产物仍须由内容、语言、素材和技术能力推导。字体名和色值不能替代这个过程。

### OpenDesign：任务、模板、品牌与基础工艺分别组合

[`docs/skills-protocol.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/docs/skills-protocol.md) 与 [`craft/README.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/craft/README.md) 明确区分四类内容：

| 类别 | 原始路径 | 对我们有用的职责 |
|---|---|---|
| 工作流技能 | `skills/<name>/SKILL.md` | 如何完成需求提炼、品牌提取、实现或后续润色 |
| 可渲染模板 | `design-templates/<name>/` | 某类交付物的结构、入口和示例 |
| 设计系统 | `design-systems/<name>/` | 品牌说明、语义 token、组件、素材与来源 |
| 基础工艺 | `craft/*.md` | 按任务载入排印、状态、表单、可访问性与动效规则 |

协议声明只注入 `od.craft.requires` 列出的 craft 文件；本轮没有将它解释为文件内的语义段落裁剪。`design-systems/README.md` 则把 `manifest.json`、`DESIGN.md`、`tokens.css` 作为可校验的包契约，丰富包还能包含组件样例、预览页和来源证据。适合迁移的是这种**可寻址、可选择、可追溯**的组织方式。

[`docs/prompt-composition.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/docs/prompt-composition.md) 还记录了 legacy、OD Next、daemon 与 API prompt 路径发生规则漂移的问题。这是维护教训：本项目的当前聊天与独立 Codex 路径应共用一份规范构造器，宿主桥协议也应来自同一契约。

## 3. 首批建议：15 项高价值指导

下列为本项目建议，不表示已经实现。新增条目应表达适用条件、操作方法与验收点，而不是又一组默认配色。

| # | 建议方向或规则 | 匹配任务与具体改进 | 原始依据 |
|---|---|---|---|
| 1 | 既有设计上下文优先 | 先读真实 token、布局和组件源码；局部改稿锁定无关区域，避免一律重做全页 | Huashu `references/design-context.md`；OpenDesign `skills/frontend-design/SKILL.md` |
| 2 | 把模糊需求拆成独立轴 | 明确受众、主任务、语言、密度、版式、情绪、素材和限制；缺项可以作明确假设，不把“专业”自动映射成蓝色 SaaS | OpenDesign `skills/design-brief/SKILL.md`；prototype task profile |
| 3 | 中文与混排排印 | 按内容推字号音阶、中文行高与行长；核对字体回退和真实加载结果，避免中文继承拉丁文紧行高/负字距 | Huashu `references/typography.md`；OpenDesign `craft/typography.md` |
| 4 | 内容推导色板与语义颜色 | 从现有品牌或真实图片采样，区分背景、文本、行动和状态；对比检查覆盖选中、悬停、禁用与原生下拉选项 | Huashu `references/design-styles.md` 色彩推导；OpenDesign `craft/color.md`、`craft/accessibility-baseline.md` |
| 5 | 状态完整的表单与数据界面 | 对实际有状态的区域覆盖加载、空、错误、正常和边界；失败保留输入，明确恢复动作，避免只画填满数据的一屏 | OpenDesign `craft/state-coverage.md`、`craft/form-validation.md` |
| 6 | 密度与响应式由任务决定 | 工作台优先扫描和操作效率，阅读页优先行长；窄屏重新组织内容与行动，使用同一份源码检验宽窄视口 | Huashu `references/typography.md`；OpenDesign `skills/frontend-design/SKILL.md`、prototype task profile |
| 7 | 按频率与因果选择动效 | 高频工具操作减少等待；状态变化用一致反馈，尊重减少动态效果；不为“高级感”强加滚动劫持 | OpenDesign `skills/emil-design-eng/SKILL.md`、`skills/emilkowalski-motion/SKILL.md`、`craft/animation-discipline.md` |
| 8 | 有证据的局部润色 | 先查看当前页面，选影响最大的几处修复，保留业务和品牌；每条发现关联前后画面、源文件和实际验证 | Huashu `references/critique-guide.md`、`references/verification.md`；OpenDesign `skills/impeccable-design-polish/SKILL.md` |
| 9 | 紧凑工程与运营工具 | 表格、列表、数字对齐、单位和时间范围优先；高频操作靠近对象，避免营销式大标题和空 KPI 卡片 | OpenDesign `apps/daemon/src/prompts/directions.ts` 的 `tech-utility`；Huashu 功能主义网格社区 |
| 10 | 瑞士结构与文档导航 | 清晰列网格、细分隔线、目录与代码层级；适合 API 文档、设计规范和技术品牌，颜色不代替信息结构 | Huashu Swiss Monochrome / Utility-First Colorful Docs；OpenDesign `design-templates/docs-page/` |
| 11 | 媒体编辑粗野主义 | 巨字与小正文建立明确观点，用规则线和模块网格承载真实信息；适合媒体专题，避免让“粗野”变成低可读性 | Huashu `references/design-styles.md` 的 Editorial Brutalism |
| 12 | 孟菲斯几何拼贴 | 活动、实验品牌可用受控错位、几何形状和对照色；实际做旧纹理与摄影缺失时明确降级，不能伪称已有素材 | 同文件的 Memphis Maximalism |
| 13 | 亲和游戏化教育 | 圆润形态、可按压反馈与真实进度组成一套语言；进度和奖励必须来自原型状态，不能靠假指标填充 | 同文件的 Friendly Geometric Candy；OpenDesign `craft/state-coverage.md` |
| 14 | 明暗画廊与内容策展 | 摄影、作品集和产品陈列让图片成为主角，UI 退让；没有高质量合法图片时不要用占位色块声称完成画廊效果 | 同文件的 Gallery Dark / Kenya Hara White Gallery |
| 15 | 复古未来图录 | 科技发布与文化专题可用档案式文字、轨道/索引结构和受控色彩；文化参照与产品事实分别核实，别默认霓虹暗场 | 同文件的 Cosmic Retro-Futurism；Huashu `references/brand-asset-protocol.md` |

其中 1–8 是基础能力，9–15 是可按内容选取的专门表达。现有“编辑叙事、精密工具、直给结构、表达节奏、传承工艺、自然亲和”可映射到这些规则与子方向，保留熟悉入口，同时摆脱每个大类只有一段固定 recipe 的限制。

## 4. 可追溯的代表案例

“存在源码”不等于“交互已测”或“离线可直接发布”。以下案例适合进一步抽选验证。

| 案例及原始路径 | 已核实内容 | 适合怎样使用 | 当前边界 |
|---|---|---|---|
| Huashu `assets/showcases/website-saas/saas-{pentagram,build,takram}.{html,png}` | 同一场景有三种 HTML 和配套截图，索引说明了网格、留白、图表关系 | 用相同内容比较真实设计差异，而非仅在选择器更换风格名称 | 所查 Pentagram HTML 引用 Google Fonts 与 `unpkg.com/lucide@latest`；不能直接当作我们的自包含模板 |
| Huashu `assets/showcases/website-devdocs/devdocs-{pentagram,build,takram}.{html,png}` | 同一文档主题的多个排版版本 | 比较导航、代码区域与阅读层级；抽取结构原则 | 品牌与示例内容不是我们的真实产品数据；需重新实现和宽窄屏验收 |
| Huashu `demos/c6-expert-review.html` | 有评审展示、雷达图相关 SVG/JS 与外部字体引用 | 参考如何呈现“保留什么、修什么、为何修” | 演示图形和分数不是测量服务，不能给我们的产物自动制造高分 |
| OpenDesign `design-templates/dashboard/{SKILL.md,example.html}` | 原型结构、内联图表和 `data-od-id` 区域标记；示例存在按钮 | 借鉴后台分区和可定位区域，在本项目实现真实筛选/操作状态 | 本轮所查 example 未发现脚本；技能还要求 plausible 指标，不适合照搬为真实数据或已实现操作 |
| OpenDesign `design-templates/docs-page/{SKILL.md,example.html}` | 三栏阅读结构、章节锚点和区域标记 | 借鉴阅读行长、目录、逻辑方向 CSS 和窄屏折叠 | Skill 明写复制按钮可只有视觉；我们的交付应实现复制或不显示该按钮。示例里的 shell 命令只作样例，未执行 |
| OpenDesign `design-systems/shadcn/`、`design-systems/apple/` | 含 manifest、设计文档、token/组件/预览路径与证据文件；已读 manifest 与证据/使用说明 | 参考完整设计系统包、组件索引与来源追踪的组织形式 | `source/evidence.md` 明确是整理后的 bundled fixture，未声称新近抓取官方品牌；不能称为官方设计系统或官方资产 |

可直接追溯的索引：[Huashu showcase index](https://github.com/alchaincyf/huashu-design/blob/3bd465d7ad29ffcb284113beb48910b469f00797/assets/showcases/INDEX.md)、[OpenDesign dashboard](https://github.com/nexu-io/open-design/tree/78d5637cb49da07e81314d1544b5fc6d37c95084/design-templates/dashboard)、[OpenDesign docs-page](https://github.com/nexu-io/open-design/tree/78d5637cb49da07e81314d1544b5fc6d37c95084/design-templates/docs-page)、[设计系统包说明](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/design-systems/README.md)。

## 5. 对本插件的具体落地建议

### 按需指导与模型上下文

建议将指导组合为：**共同执行边界 + 当前品牌/组件摘要 + 一个任务 profile + 必要 craft + 可选表达方向 + 本次选中源码/评论**。

1. 共同边界保留当前源码、哈希、修订、授权范围和真实验证要求；代码模式与图层模式的能力描述分别生成，不能把图层的有限交互表带进代码原型。
2. 新设计按任务补 brief；既有设计的局部修改只载入相关 craft，先保留原语言。不要为每次改颜色重新问十个问题或重新选三版。
3. 指导条目登记稳定 ID、适用任务、输入要求、动作、检查点、限制、原始提交/路径和许可。只把用户指定方向或真正相关段落放入 prompt，避免每次注入整库。
4. 先用文件清单和组件索引确定读取范围，再读取相关源码；传入精确 hash、选择修订、稳定锚与待处理评论。素材传路径/摘要，实际图片通过图像能力审阅，不能用一串说明代替看图。
5. 生成后由真实编译、`design_code_render` 的图像与运行信息、关键交互验证推动修正。结构校验、lint 与截图尺寸只能证明各自范围，不自动证明“视觉优秀”。

### 视觉验收

每次需要验收的改动至少留下：项目修订、视口、实际画面、运行错误、已操作路径和剩余问题。按任务检查：

- 中文标题、长文本、字体回退、行高与溢出；宽窄视口中的阅读顺序与主行动。
- 控件正常、选中、禁用、焦点及展开状态的可读性，尤其原生 select/option 等截图容易遗漏的状态。
- 主流程真实状态变化、空/错误状态与失败后的输入保留；演示数据标明来源或示例身份。
- 局部编辑后无关区域保留，源码仍可编辑，撤销/重做不会被旧草稿回写破坏。
- 导出的 HTML/源码包与当前修订一致；所有实际依赖随交付包含。

评审输出优先写“问题—用户影响—源位置—修复—验证结果”。不把风格偏好、未经校准的雷达图或主观分数伪装为客观质量检测。

## 6. 不直接吸收的约定

- Huashu 的固定三方向停轮、十问流程、Gate 文件、推广水印和版本检查是其产品选择；本插件按用户意图与既有授权决定流程，不机械继承。
- 不将字体、米色、紫色、圆角、卡片等逐项永久禁用。既有品牌优先；检查其是否有任务理由和可读性，而非用新模板替代旧模板。
- OpenDesign `skills/gpt-tasteskill/SKILL.md` 包含模拟随机执行输出、强制 GSAP 和固定 AIDA 等规则。不能伪造执行，也不应给所有界面强加营销结构、动画库和占位图服务。
- OD Next `plugins/_official/scenarios/od-next-strategy/assets/task-profiles/prototype.md` 存在写出文件即交付、不再预览的约定。**不采纳**：本项目明确要求真实渲染与操作验证。
- OpenDesign 文档页的视觉复制按钮、dashboard 的 plausible 数据、Huashu Tweaks 的浏览器存储，不能等同于我们的真实功能、真实数据或源码持久化。特别是无 `allow-same-origin` 的原型 iframe 不能假定可使用 localStorage。
- 参考库内部的色彩、字体、强调次数、字号比例等硬规则互有张力；抽选时要形成适用于任务的统一规则，并保留品牌例外。不要拼接成彼此矛盾的超长系统提示。

## 7. 包内摘选与署名方案

本轮研究只新增这份文档，尚未把第三方文本、代码、素材或模板加入发布包。后续如决定摘选：

1. 优先自行总结上述 15 项方法，保留本报告的固定来源；需要原文或实现时逐项登记来源、提交、改动说明与许可。
2. Huashu 摘选保留 MIT 版权和许可。OpenDesign 按实际子包处理：`skills/frontend-design/LICENSE.txt` 为 Apache-2.0；`skills/emil-design-eng/LICENSE` 为 MIT，标注 Matt Pocock；`skills/gpt-tasteskill/LICENSE` 为 MIT，标注 Leonxlnx。根目录 Apache-2.0 不能覆盖子包的来源核查。
3. `craft/README.md` 还注明对 MIT 的 Refero 内容作了改编。拟摘选的具体文件应保留相应来源链；若包含 Apache 许可材料，按其文件要求保留许可、改动标记和适用通知。
4. 品牌参考、商标、摄影、字体与图标另核实实际使用权和分发文件；品牌名并不意味着随包取得官方素材授权。当前 curated fixture 也不能升级为官方背书。
5. 发布 Skill 的摘选放在它自己的 `references/`、`assets/` 等目录；版权说明与许可证也随该 Skill 包含。`SKILL.md` 只用包内相对路径，不引用本报告、开发仓库、临时克隆或全局技能。
6. 示例若进入产品，去掉远端 `latest`、CDN 和本机依赖，改用包内允许分发的文件；在脱离开发仓库的发布包中验证传递引用、离线渲染和真实交互。

建议先落地任务/craft 路由、中文排印与状态检查、证据式评审，再试做 3–5 个经过隔离验证的案例。模板库规模留待真实复用需求驱动。
