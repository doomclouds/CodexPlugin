# 包内设计案例

案例用于让模型看到完整构图、阅读密度与可运行源码之间的关系。有技能文件读取能力的当前聊天，先选最相关的一例，查看宽窄屏真实截图，再读 README，最后只读需要迁移的源码片段；其他当前聊天也可通过下面的参考工具得到真实图像与有界资料。不要把所有源码和图片一次塞入上下文，也不要将某例当成所有任务的模板。

这些案例是实质起点，不是风格或能力上限。已有品牌、用户内容与交付范围优先；先确定一个主方向，再判断是否需要借用某例的一个局部关系。不要把几例的完整字体、配色与密度一起搬进项目。示例数据保持其示例身份，换成真实内容后重新验证。

| 案例与入口 | 任务与构图 | 密度与字体角色 | 可借鉴的交互 |
| --- | --- | --- | --- |
| [一公里步行路上的热与荫](../assets/examples/editorial-atlas/README.md) · `editorial-atlas` | 中文长篇专题；热/荫字面、街道概念影像和连续路径主张共同开篇，再进入证据与方法 | 出版式展示与连续正文分工，街道影像不冒充现场采样 | 目录定位、字号调整、当前页标记、同尺度时段数据切换 |
| [操作控制台](../assets/examples/operations-console/README.md) · `operations-console` | 当前对象与异常恢复；连续证据、条件核对和恢复动作形成决策路径 | 稳定对象队列与连续证据工作面；风险、核验、备用与恢复清楚分级，普通信息与操作保持可读 | 搜索、筛选、排序、选择、本地诊断与受条件约束的示例恢复 |
| [间隙 · 活字与时间](../assets/examples/typographic-event/README.md) · `typographic-event` | 错位字面与真实留白；主题、日期、地点与日程属于同一活动排版系统 | 强尺度差、黑白与高饱和强调；大号无衬线展示与紧凑等宽信息 | 两日议程切换、报名对话框与本地表单反馈 |
| [弧光](../assets/examples/interactive-product/README.md) · `interactive-product` | 概念灯具、弧光字面与实际可调光域共享一个暗场 | 石墨灯体、浅色大字与克制场景控制，实际透明图像与代码光域分工 | 场景预设、亮度/色温/光束改变同一主画面、构造注释与恢复初始 |
| [展览观看路径](../assets/examples/museum-journey/README.md) · `museum-journey` | 原创器形、贯通空隙与光的三种观看；对象、章节与概念路径相互定位 | 暗场掠射光、衬线大字与完整对象形成策展秩序 | 章节切换、方向键与首尾键、当前位置/叙述/图层联动 |
| [汀间](../assets/examples/quiet-hospitality/README.md) · `quiet-hospitality` | 建筑日光与字面建立空间期待，随后将时间具体为本页停留计划 | 原创概念空间图、宋体展示与纸面日期；手机文字移出照片 | 日期、快捷夜数、原生房型/人数互斥选择、估算、校验与本页摘要 |
| [构材](../assets/examples/material-catalog/README.md) · `material-catalog` | 木层、纤维、颗粒的材质陈列与“表面之下”跨页，再过渡到共同尺度 | 纸灰与近黑出版关系，泥红标当前对象；摄影与几何分工 | 材料选择、规格身份联动、最多两项同尺度几何/数值比较与移除 |
| [河岸文化馆](../assets/examples/civic-wayfinding/README.md) · `civic-wayfinding` | 建筑平面、房间开口、目的地与逐段路线同步；不是真实地图 | 字母、房间开口与地图/索引/路线的身份共同建立公共导向 | 目的地、无台阶条件、路线联动、维护造成无路及恢复 |
| [间频](../assets/examples/audio-studio/README.md) · `audio-studio` | 原创系列封面、当前作品身份与一次主动试听任务 | 独立声音出版的封面轮廓、连续作品信息与克制播放控制 | 选轨、本地四秒合成播放/停止、参数联动；主动播放且默认静音 |
| [白纸索引](../assets/examples/independent-archive/README.md) · `independent-archive` | 展开的出版目录；折痕、编号、版次与全文阅读直接相连 | 双页纸面在手机转单页；资料身份与完整文章保留 | 标签筛选、完整文章展开/收起、返回原索引焦点 |

完整案例以同目录的 HTML、媒体、说明与许可为一组交付；有相对媒体引用时不能只拷一个 HTML。运行时导入这些实际资产后，编译导出才生成自包含 HTML。每例 README 是其哲学、问题、形式规则、实现机制与迁移边界的说明入口。目录名称本身不证明这些能力已经验收，采用前按实际文件核对。

案例都使用系统字体声明与回退，未提供独立品牌字体文件；实际字形由运行环境决定。图表数据、节点记录、活动、产品、展览、旅宿、材料、空间、声音与刊物均为示例或概念内容，不能移作真实测量、生产系统、馆藏考据、票务、库存、地图定位或设备控制。素材与代码的使用条件见各例说明及随目录提供的许可；不因形式完整就假定存在外部资产授权。网页交互不等于独立视频制作能力。

## 选择与冲突取舍

先用一句话确定本次主任务，再选最相关的一例；一件事只需要一个机制时，不必读取整份外观。已有系统锁定品牌与控件，案例只补关系。比如工作台需要活动页的时间分组，可以借分组方式，但保留工作台的密度与操作；缺少真实馆藏图片时，可以借诚实示意，不借虚构的历史和权威。

自动选择只处理一个清楚的任务关系。主次不明、存在否定/冲突，或本次只是局改与品牌保留时，可以明确选择 `none`，由任务形成自由方向；显式 `referenceId` 只决定送哪份材料，不表示它成为全页主方向。需要并列探索时，各候选独立比较，不把互不相容的候选拼接。

领域名称不能代替主任务。管理博物馆导览与酒店订单的运营工作台，仍先处理对象、表格、搜索与恢复；不会同时加载展览和旅宿的外观。公共服务中心的无台阶路线选择，以目的地和通行条件为主；展览中的章节观看，以对象与叙述为主。材料、公共导向与声音三种构图尚未选定时，可以分别探索，自动路径不会把三份材料合装成一个参考包。

## 有界参考工具与独立任务

`design_get_guidance` 返回小型案例目录；`design_get_reference` 接受上表中的一个真实 `referenceId`，可选 `views: ["desktop", "mobile"]`，省略时取两种，空数组只取文本。它返回所选例的说明、有限源码摘录、出处 hash 与实际 MCP 图像块，模型不需要文件或网络权限。先实际查看返回的图像，再决定借哪种关系；`design_code_guidance` 的参考选择摘要本身不含参考图，不能把拿到摘要称为已看图。

`design_code_request_generation` 的 `referenceId` 还支持 auto 与 none。独立 worker 不调用参考工具或自行找文件，由运行时把一个有界案例快照直接放进每轮输入：规则、说明、标明 partial 的源码摘录与最多两张参考图；四份工艺全文和整个案例库不会一起注入。初稿、修正和恢复审阅都保留可核对的快照身份，具体预算见 [独立代码生成任务](code-project.md#独立代码生成任务)。

参考图只展示案例的初始首视口，以 `design-reference` 标记；本次实际工作稿图另以 `current-work` 标记。得到参考图不代表生成的页面已经渲染、被看过或通过交互验收，参考图片的投递也不能代替本次作品的 `modelReviewed` 记录。不要让受限 worker 读取未获提供的路径或扩大权限。

## 看图与源码入口

| 案例 | 宽屏 | 窄屏 | 可编辑源 |
| --- | --- | --- | --- |
| 一公里步行路上的热与荫 | [desktop.png](../assets/examples/editorial-atlas/desktop.png) | [mobile.png](../assets/examples/editorial-atlas/mobile.png) | [index.html](../assets/examples/editorial-atlas/index.html) |
| 操作控制台 | [desktop.png](../assets/examples/operations-console/desktop.png) | [mobile.png](../assets/examples/operations-console/mobile.png) | [index.html](../assets/examples/operations-console/index.html) |
| 间隙 · 活字与时间 | [desktop.png](../assets/examples/typographic-event/desktop.png) | [mobile.png](../assets/examples/typographic-event/mobile.png) | [index.html](../assets/examples/typographic-event/index.html) |
| 弧光 | [desktop.png](../assets/examples/interactive-product/desktop.png) | [mobile.png](../assets/examples/interactive-product/mobile.png) | [index.html](../assets/examples/interactive-product/index.html) |
| 展览观看路径 | [desktop.png](../assets/examples/museum-journey/desktop.png) | [mobile.png](../assets/examples/museum-journey/mobile.png) | [index.html](../assets/examples/museum-journey/index.html) |
| 汀间 | [desktop.png](../assets/examples/quiet-hospitality/desktop.png) | [mobile.png](../assets/examples/quiet-hospitality/mobile.png) | [index.html](../assets/examples/quiet-hospitality/index.html) |
| 构材 | [desktop.png](../assets/examples/material-catalog/desktop.png) | [mobile.png](../assets/examples/material-catalog/mobile.png) | [index.html](../assets/examples/material-catalog/index.html) |
| 河岸文化馆 | [desktop.png](../assets/examples/civic-wayfinding/desktop.png) | [mobile.png](../assets/examples/civic-wayfinding/mobile.png) | [index.html](../assets/examples/civic-wayfinding/index.html) |
| 间频 | [desktop.png](../assets/examples/audio-studio/desktop.png) | [mobile.png](../assets/examples/audio-studio/mobile.png) | [index.html](../assets/examples/audio-studio/index.html) |
| 白纸索引 | [desktop.png](../assets/examples/independent-archive/desktop.png) | [mobile.png](../assets/examples/independent-archive/mobile.png) | [index.html](../assets/examples/independent-archive/index.html) |

## 迁移时保留机制，重做内容判断

1. 用一句话指出本次要借的关系：例如正文与旁注、列表与详情、标题与活动信息、输入与演示结果。说明为什么适合用户任务。
2. 有文件能力的当前聊天先看所选例的宽窄截图；通过工具或独立任务使用时，实际查看已提供的视图，未提供的视图不声称看过。截图只证明所捕获画面，不能证明未执行的状态。
3. 阅读实际提供的说明、素材/字体/交互边界和相应源码片段；完整本地源码只在有文件能力时按需读取。先复用用户真实组件和 token，不把例子的颜色、字级、圆角或示例品牌机械覆盖到项目。
4. 用本次真实内容、最长文本和目标状态落地，核对组件 API、来源身份与依赖；已有项目只改授权范围。
5. 运行实际页面，检查阅读、动作、焦点和窄屏；动效再补 [原型微交互](prototype-motion.md)，排印问题补 [排印工艺](typography.md)。源码和截图存在不等于用户项目已通过验收。
