# OpenDesign Motion：当前源码与交付链只读研究

研究日期：2026-10-17。对象为用户指定的 [nexu-io/open-design](https://github.com/nexu-io/open-design)。本报告补查该项目自己的 Motion；它不代替 Claude Motion 的产品、宿主和执行链研究，也不证明本仓 Design 已实现这些能力。

## 1. 版本、方法与结论边界

本次通过公开 Git 远端核对 `refs/heads/main`，其当前值仍为 [`78d5637cb49da07e81314d1544b5fc6d37c95084`](https://github.com/nexu-io/open-design/commit/78d5637cb49da07e81314d1544b5fc6d37c95084)，提交时间为 **2026-10-16 06:52:55 UTC**。这与此前静态设计参考报告相同；此前没有覆盖这里的 Motion 链。本文的“新发现”表示新增研究范围，不能表述为已发现一个更新的提交。

方法为固定 SHA 的完整 Git 树清点、公开源文件和清单读取、精确源文件 REA 静态分析。没有安装依赖、运行上游脚本、启动 OpenDesign、执行样片、调用模型或生成影片。已有 MP4 只核对树中存在，未下载观看或解码。本报告把状态分成：**源码实现存在、模板/参考存在、目录指针、声明或未知**。测试文件存在只证明有相应断言，不能写成本次测试通过。

可确认的产品形态是：独立的 Motion design 创建入口，搭配可编辑 HTML/GSAP 合成、统一时间轴、宿主预览活动控制、音轨同步，以及 Electron 逐帧和 FFmpeg MP4 交付链。它并非只扩充风格标签；同时，目录里的每个“视频模板”也不都包含动画工程。

## 2. 入口与实际包范围

### 2.1 创建路由与功能 Skill 分开

[`apps/web/src/components/home-hero/chips.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/web/src/components/home-hero/chips.ts#L227) 的 `motion-design` 项将新项目设为 `video`，并写入 `intent: motion-design`、`videoModel: hyperframes-html`。它与普通视频模型入口和 HyperFrames 入口分别登记。[`facets.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/web/src/components/plugins-home/facets.ts#L133) 还将 Motion 模板与一般视频模板区分，以便 Use 路径回到对应任务路由。

[`skills/motion-design/SKILL.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/motion-design/SKILL.md) 的 frontmatter 则是 `mode: utility`。它负责 brief、节拍、构图、文字、运动连续性和实现工艺，工具权限、项目创建和最终交付仍由当前宿主任务承担。OD Next 的 [`motion-design.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/scenarios/od-next-strategy/assets/task-profiles/motion-design.md) 包含同类任务指导。不能把“选中 Skill”解释为自动取得渲染、外部服务或宿主 UI 权限。

### 2.2 三种模板不能混计

| 范围 | 固定提交中的实际内容 | 能确认到哪一步 |
| --- | --- | --- |
| 五个首页 Motion 视频示例 | `motion-showreel`、`motion-ui-morph`、`motion-product-promo`、`motion-visual-lesson`、`motion-future`，各有清单、Skill、`example.html`、本地封面、音轨和所需素材 | 原始动画源码和素材随仓库存在；本轮未播放或导出 |
| `motion-frames` | 清单为 `mode: prototype`、`scenario: marketing`；示例以 CSS 循环、海报构图为主 | 是动效原型示例，不应算入上述五个影片模板 |
| `plugins/_official/video-templates/` | 共 **63** 个模板目录；**23** 个含 `source/`，**40** 个只有 `open-design.json` 与 `template.json` | 23 个包含实际工程文件；40 个属于提示词/目录记录，不能称 63 套可本地渲染源码 |

23 个源码模板中，22 个有预制 `preview.mp4`；`frame-data-rollup` 有 React/TSX 和 `registerRoot` 源码、预览 PNG，树中没有预制 MP4。预制文件存在不证明当前系统可重渲染它。

五个首页模板的来源、改编和时长记录在 [`docs/motion-template-sources.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/docs/motion-template-sources.md)。它声明这些作品参考公开传播的影片重新用代码创作；播放量、保真度和“原创配乐”是其记录或作者声明，本次没有独立复核。不得据此取得原作者视频、角色、音乐或商标的重用授权。

## 3. Skill：哪些完整随包、哪些只作发现入口

| Skill | 本地可恢复内容 | 明确边界 |
| --- | --- | --- |
| [`motion-design`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/motion-design/SKILL.md) | 原创工艺指导；按作品用途拆 brief、代表帧、节拍、主次运动、可 seek 实现与交付检查 | 不是模板，也不是独立引擎。其 [`SOURCES.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/motion-design/SOURCES.md) 说明借鉴公开方法，没有 vendored 上游引擎、角色、样片或整套风格库 |
| [`motion-lab`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/motion-lab/SKILL.md) | 9 个文件；索引及 basic/text/interaction/advanced 四类参考，保留 **160** 条记录的参数与 HTML/CSS/JS 示例 | 未包含原 Next.js 站点和预览组件；所用 GSAP/Three.js 等仍要由实际工程提供。160 是记录数量，不是本次验收通过数量 |
| [`oil-motion`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/oil-motion/SKILL.md) | 32 个文件；媒体处理 Python 脚本、TS 控制器、运行时及 QA 文档。`interactive-motion.ts` 有帧随动和分段播放实现 | 将生成素材交给宿主，移除了上游专有供应商客户端与凭据界面；本轮未运行脚本或控制器 |
| [`huashu-art-motion`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/huashu-art-motion/SKILL.md) | 10 个文件；35 张配方、9 张解说语法、craft 和通用 Canvas helper 文本 | 这是工艺/helper 适配，不是完整上游整片引擎；未包含人物素材、完整样片、字体、语音供应商或独立导出器 |
| [`remotion`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/remotion/SKILL.md) | 一个分类和触发说明条目 | 正文要求另取上游完整 bundle；不能把该条目当作已内置 Remotion 工具链 |
| [`video-hyperframes`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/video-hyperframes/SKILL.md) | HTML 分帧/自动播放模板与 frame/duration/transition 注释约定 | 描述其输出可供后续转换，不等于所查模板自身就执行了 MP4 编码 |

这些包采用“路由先确定任务，按需读工艺和参考”的方式。值得迁移的是任务适用性、真实输入、源代码和宿主合同的分离，不能把所有素材数量相加后称作统一引擎能力。

## 4. 工程表示和统一时间控制

### 4.1 主要影片格式是 HTML 与本地资产

[`hyperframes-scaffold.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/hyperframes-scaffold.ts) 支持项目内 `.hyperframes-cache/<id>` 或 `motion-source/<id>`；创建 `hyperframes.json`、`meta.json`、`index.html`，在 `motion-source` 路径另复制本地 `gsap.min.js`。配置中的 registry URL 仍是远端指针，不意味着整个 HyperFrames registry 已随包复制。

主体 HTML 使用 `data-composition-id`、`data-duration`、`data-width`、`data-height`，可附 fps、poster 时间；通过 `window.__timelines[compositionId]` 注册 GSAP 主时间轴。源文件中的 `od-motion-output` 区分视频与交互用途，MP4 位置用相对 `link[rel=alternate][type=video/mp4]` 声明。普通源码和本地资产是可编辑事实源，不是另造一个只存在于聊天的镜头 JSON。

[`motion-source-player.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/packages/contracts/src/runtime/motion-source-player.ts) 的校验要求视频 duration 为正、主时间轴存在、`timeScale` 为 1、真实时间轴长度与主体 duration 一致，且主轴不额外 repeat/delay。它阻止通过整体改速“凑齐”时长。这里的时间契约已落实为运行时检查，不能只从 Skill 中推断。

### 4.2 播放与宿主活动协议已有实现

同一文件注入 source player，暴露 play、pause、seek、replay、setMuted、state；点击作品可控制播放，音轨从主轴时间推导本地播放位置。缩略图静音；页面隐藏与离开会暂停；读取模板时间轴最多等待约 15 秒后提示未就绪。

[`motion-preview-activity.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/web/src/runtime/motion-preview-activity.ts) 在宿主端为 iframe 全生命周期绑定活动状态，通过 request/probe/activity 消息和每个文档的实例 ID 重新协商。它检查消息来自当前 iframe；WindowProxy 跨导航仍存在，因此不把旧文档 ID 永久缓存为新文档身份。隐藏或停放的预览不会因重载而继续发声。

这些是播放协议与代码时间轴。**本次没有观察到可据此证明的完整可视化多轨关键帧编辑器**；不能把 `__timelines` 或一个 scrub 控件直接描述为 AE 式时间线产品。

### 4.3 Remotion 模板存在，但不能扩大已核实执行范围

[`frame-data-rollup/source/`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-data-rollup/source/Root.tsx) 含真实 `Composition`、`useCurrentFrame`、`spring`、`interpolate` 和 `registerRoot`，可从实际数据计算柱高与数字。它不是静态 HTML 冒充 React 动画。

但其 [`template.json`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-data-rollup/template.json) 的 `engine: remotion`、`sourceEntry`、MP4/WEBM 是包内声明。所查 daemon [`models.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/models.ts#L196) 注册的是 `hyperframes-html`，[`media/index.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/index.ts#L3880) 的实际本地分支要求 HTML 合成目录；daemon 依赖清单未包含 Remotion。模板提到外部 html-video/Remotion adapter，本次没有沿外部仓库安装或运行它。因此只能确认“原生 Remotion 源码模板存在”，不能宣称该 TSX 模板已经由当前 OpenDesign 本地分支一键渲染或支持 WEBM。

## 5. 预览、逐帧和 MP4 导出链

1. `media generate` 的 `hyperframes-html` 分支要求真实合成目录和三份基础文件；它不接受只有代理计划的影片，也不在这个分支回退成 stub。入口和工程内路径检查在 [`media/index.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/index.ts#L3880)。
2. 默认交给已有桌面 `desktopFrameRenderer`；没有桌面 renderer 时明确失败。只有显式配置 `HYPERFRAMES_BROWSER_PATH` 才走配套 HyperFrames CLI，未观察到这里自动下载第二个 Chrome 的逻辑。[`hyperframes-runtime.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/hyperframes-runtime.ts) 解析包内 CLI 与浏览器 runtime；daemon 固定依赖 HyperFrames **0.8.1**。
3. [`injectHyperFramesFrameBridge`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/index.ts#L4048) 在作者代码前设置 render 标记，避免播放器 UI、自动墙钟播放或海报定位进入捕获。bridge 等待播放器就绪、seek 完成和合成/绘制，再提供 `__odFrameRenderer.ready/seek`。
4. [`apps/desktop/src/main/frame-capture.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/desktop/src/main/frame-capture.ts) 是实际 Electron 实现：独立隐藏窗口，`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`，禁新窗口和页面导航；按 `frameIndex/fps` seek，通过 CDP 截 PNG。总捕获预算 5 分钟，另有阶段预算；frame 数和 fps 有上限，finally 清理 debugger/窗口。它不是仅在文档里建议“用 Electron”。
5. daemon 用 FFmpeg 将帧编码为 H.264/yuv420p MP4、处理奇数尺寸并启用 faststart。严格 Motion 音轨先从捕获 DOM 中移除，交由 FFmpeg 混音；因此 desktop 捕获器拒绝残留 audio 与严格 Motion 后续音轨编码并不矛盾。普通旧 HyperFrames 音频不能据此假定全部兼容。
6. [`motion-delivery.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/artifacts/motion-delivery.ts) 从实际源码读取 MP4 相对路径与音频策略，核对项目边界及请求输出；导出后检查 MP4 header、解出一帧，并检查 required/silent 音频结果。技术校验明确不评判创意质量。

音频解析在 [`hyperframes-audio.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/src/media/hyperframes-audio.ts)：最多 32 轨、仅合成目录内真实相对文件，要求起点/时长/音量有效；不接受循环、播放速率和未预裁切媒体偏移。编码按实际时间延迟、裁剪、淡出、混合并补齐到影片长度。不能等同于可自由编辑的 DAW 或已经具备音乐生成能力。

一个必须保留的细节：当前 bridge 调用 `renderSeek(time,{suppressEvents: !motionVideo})`，严格视频分支实际传 false；而 Skill 和模板测试强调画面还应在 suppressEvents=true 时正确 seek。不能把两者简写成“所有导出都禁用回调”；未来移植要明确渲染契约，并实际验证回调独立性。

## 6. 测试证据与本次没有证明的内容

| 仓库内存在的检查 | 实际断言范围 | 本次状态 |
| --- | --- | --- |
| [`e2e/ui/motion-template-export.test.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/e2e/ui/motion-template-export.test.ts) | 五张本地封面、完整构图、导出隐藏 controls、正序与逆序 seek 的 Canvas 输出一致；首个 gallery 用了标准 mocks | 已读源码；未运行，不能称五支影片已验收 |
| [`motion-video-clock.test.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/tests/media/motion-video-clock.test.ts) | 时间轴长度/改速等时钟约束 | 已读范围内有断言；未运行 |
| [`media/hyperframes.test.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/tests/media/hyperframes.test.ts) | 合成预检、CLI/桌面分支、音轨边界；其中部分 renderer 是 fake CLI 或受控替身 | 不能把替身写出的字节当本次真实 MP4 |
| [`motion-audio-delivery.test.ts`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/apps/daemon/tests/motion-audio-delivery.test.ts) | 真实源码输出合同与音轨交付路径的回归用例 | 未运行 |
| 22 个预制 preview.mp4 | Git 树确认文件存在 | 未观看、未解码，未复现生成 |

未确认内容包括：当前构建在所有平台的原生 FFmpeg/Electron 运行结果、长片性能、每种字体的实际中文覆盖、所有 Skill 示例的无障碍/卸载行为、每支片的连续播放与听感，以及 Remotion 模板是否另有完整接通路径。源文件描述的愿景、代码注释里的“verified”和样片数量都不能替代这些验证。

## 7. 逐包许可与来源边界

这里登记的是所读取版本的**许可声明及来源链**，不是对所有媒体权利的法律结论。具体复制时仍须按实际文件、第三方资产和依赖版本保留通知；本轮没有把任何上游 Skill/模板正文或代码复制进本仓发布插件。

| 包或范围 | 实际观察的许可/归属 | 不能从中推出什么 |
| --- | --- | --- |
| OpenDesign 原创应用、contracts、`motion-design` | 根 [`LICENSE`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/LICENSE)、package.json 为 Apache-2.0；`motion-design/SOURCES.md` 说明原创与借鉴边界 | 根许可不覆盖一切第三方素材或外部引擎 |
| `motion-lab` | 本地 [`LICENSE`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/skills/motion-lab/LICENSE) 为 MIT；适配方说明上游 README 声明 MIT、其固定上游 checkout 无独立 LICENSE。上游固定为 `fbfda036aadbc1b46547bce8a7a57ec12bf73485` | 不是对原站所有资产的重新授权；须保留该声明出处和贡献者归属 |
| `oil-motion` | 本地 MIT，版权为 Lin Zhihuang；上游固定 `07e31f2265f80caa8f2c1df825d85ac24a46307c` | 已移除的服务客户端、演示媒体和凭据系统不在本包能力内 |
| `huashu-art-motion` | 本地 MIT，alchaincyf；上游固定 `d861767d180008d27675819932070a670a3ae43f` | 适配包主动排除了另有条件的字体、人物、音频和完整 renderer，不能反向补作随包资产 |
| 五个首页 `motion-*` 影片模板 | 各清单为 Apache-2.0；来源文档记录对公开影片的改编 | 不是原视频、人物、音乐或品牌资产的许可证明 |
| `motion-frames` | 清单为 MIT | 不能因为名字相近改套五支影片的 Apache 声明 |
| 23 个源码视频模板 | 22 个清单 Apache-2.0；`frame-product-promo-30s` 为 MIT；详见下表与 [`HYPERFRAMES-ATTRIBUTIONS.md`](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/HYPERFRAMES-ATTRIBUTIONS.md) | 对其它工作室的风格归因不代表其认可或授权；预览文件另按实际来源处理 |
| 40 个仅清单/提示词目录 | 36 个声明 CC-BY-4.0，4 个声明 Apache-2.0，逐条列于下表 | 不是 40 套本地引擎；外链图片/视频及生成模型的条件不能由提示词许可代替 |
| 模板自带 GSAP **3.12.5** | vendored 文件头指向 GSAP standard/Club 条款，保留 GreenSock 版权 | 不能改写为 Apache/MIT，或把另一个版本的政策直接套给这份字节 |
| daemon GSAP **3.14.2** | [精确版本 npm 元数据](https://registry.npmjs.org/gsap/3.14.2) 指向 GSAP no-charge standard license | 这是独立版本与条款来源；并非根 Apache 授权 |
| vendored Three.js **0.160.0** 与字体 | Three.js 文件头 SPDX MIT；文档列字体为 SIL OFL，已读取 Inter、Unbounded 的包内 OFL 文本 | 未逐字体做字形覆盖或商标核验；不能删掉字体各自通知 |
| HyperFrames **0.8.1** | [精确版本 npm 元数据](https://registry.npmjs.org/hyperframes/0.8.1) 为 Apache-2.0 | 本次未安装；它的所有传递原生依赖不是已逐项审计 |
| `@ffmpeg-installer/ffmpeg` **1.1.0** | [精确版本 npm 元数据](https://registry.npmjs.org/@ffmpeg-installer/ffmpeg/1.1.0) 为 LGPL-2.1 | 元包声明不替代各平台实际 FFmpeg 二进制及构建选项的许可/通知检查 |
| `remotion` 目录条目、TSX 模板的外部 Remotion import | 一个是目录指针，一个的模板源码清单为 Apache-2.0；上游 runtime 未随本次取证安装，实际版本与许可另查 | 不能把模板许可当作外部 Remotion 库的许可，也不能声称其渲染器已随 OpenDesign daemon 接通 |

### 7.1 63 个视频目录的逐包声明

以下每个链接固定到同一 SHA 的清单。`源码` 表示树中存在 `source/`，不表示本次已运行。`提示词/元数据` 表示该目录只有两份 JSON，不把远端预览当本地源码。

| 目录（固定清单） | 本地形态 | 清单许可 |
| --- | --- | --- |
| [3d-animated-boy-building-lego](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/3d-animated-boy-building-lego/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [a-decade-of-refinement-glow-up](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/a-decade-of-refinement-glow-up/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [ancient-guardian-dragon-rescue](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/ancient-guardian-dragon-rescue/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [ancient-indian-kingdom-fpv-video](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/ancient-indian-kingdom-fpv-video/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [animation-transfer-and-camera-tracking-prompt](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/animation-transfer-and-camera-tracking-prompt/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [beat-synced-outfit-transformation-dance](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/beat-synced-outfit-transformation-dance/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [character-intro-motion-graphics-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/character-intro-motion-graphics-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-birthday-celebration-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-birthday-celebration-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-dragon-interaction-flight](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-dragon-interaction-flight/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-east-asian-woman-hand-dance](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-east-asian-woman-hand-dance/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-emotional-face-close-up](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-emotional-face-close-up/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-marine-biologist-exploration](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-marine-biologist-exploration/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-music-podcast-and-guitar-technique](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-music-podcast-and-guitar-technique/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-route-navigation-guide](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-route-navigation-guide/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-street-racing-sequence-for-seedance-2](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-street-racing-sequence-for-seedance-2/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cinematic-vampire-alley-fight-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cinematic-vampire-alley-fight-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [crimson-horizon-sci-fi-cinematic-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/crimson-horizon-sci-fi-cinematic-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [cyberpunk-game-trailer-script](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/cyberpunk-game-trailer-script/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [forbidden-city-cat-satire](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/forbidden-city-cat-satire/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [frame-bold-poster](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-bold-poster/open-design.json) | 源码 | Apache-2.0 |
| [frame-bold-signal](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-bold-signal/open-design.json) | 源码 | Apache-2.0 |
| [frame-build-minimal](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-build-minimal/open-design.json) | 源码 | Apache-2.0 |
| [frame-creative-voltage](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-creative-voltage/open-design.json) | 源码 | Apache-2.0 |
| [frame-data-chart-nyt](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-data-chart-nyt/open-design.json) | 源码 | Apache-2.0 |
| [frame-data-rollup](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-data-rollup/open-design.json) | 源码（Remotion TSX） | Apache-2.0 |
| [frame-decision-tree](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-decision-tree/open-design.json) | 源码 | Apache-2.0 |
| [frame-electric-studio](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-electric-studio/open-design.json) | 源码 | Apache-2.0 |
| [frame-glitch-title](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-glitch-title/open-design.json) | 源码 | Apache-2.0 |
| [frame-kinetic-type](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-kinetic-type/open-design.json) | 源码 | Apache-2.0 |
| [frame-light-leak-cinema](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-light-leak-cinema/open-design.json) | 源码 | Apache-2.0 |
| [frame-liquid-bg-hero](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-liquid-bg-hero/open-design.json) | 源码 | Apache-2.0 |
| [frame-logo-outro](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-logo-outro/open-design.json) | 源码 | Apache-2.0 |
| [frame-nyt-graph](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-nyt-graph/open-design.json) | 源码 | Apache-2.0 |
| [frame-pentagram-stat](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-pentagram-stat/open-design.json) | 源码 | Apache-2.0 |
| [frame-play-mode](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-play-mode/open-design.json) | 源码 | Apache-2.0 |
| [frame-product-promo-30s](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-product-promo-30s/open-design.json) | 源码 | MIT |
| [frame-product-promo](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-product-promo/open-design.json) | 源码 | Apache-2.0 |
| [frame-swiss-grid](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-swiss-grid/open-design.json) | 源码 | Apache-2.0 |
| [frame-takram-organic](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-takram-organic/open-design.json) | 源码 | Apache-2.0 |
| [frame-vignelli](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-vignelli/open-design.json) | 源码 | Apache-2.0 |
| [frame-warm-grain](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/frame-warm-grain/open-design.json) | 源码 | Apache-2.0 |
| [hollywood-haute-couture-fantasy-video-prompt](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/hollywood-haute-couture-fantasy-video-prompt/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [hunched-character-animation](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/hunched-character-animation/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [live-action-anime-adaptation-water-vs-thunder-breathing-duel](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/live-action-anime-adaptation-water-vs-thunder-breathing-duel/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [luxury-supercar-cinematic-narrative](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/luxury-supercar-cinematic-narrative/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [magical-academy-storyboard-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/magical-academy-storyboard-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [modern-rural-aesthetics-healing-short-film-video-prompt](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/modern-rural-aesthetics-healing-short-film-video-prompt/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [nightclub-flyer-atmospheric-animation](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/nightclub-flyer-atmospheric-animation/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [retro-hk-wuxia-film-aesthetic](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/retro-hk-wuxia-film-aesthetic/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [seedance-2-0-15-second-cinematic-japanese-romance-short-film](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/seedance-2-0-15-second-cinematic-japanese-romance-short-film/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [seedance-2-0-80-year-old-rapper-mv](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/seedance-2-0-80-year-old-rapper-mv/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [sequence-and-movement-instruction-for-martial-arts-video](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/sequence-and-movement-instruction-for-martial-arts-video/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [soul-switching-mirror-magic-sequence](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/soul-switching-mirror-magic-sequence/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [toaster-rocket-jumpscare](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/toaster-rocket-jumpscare/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [traditional-dance-performance](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/traditional-dance-performance/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [vfx-text-cursor](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/vfx-text-cursor/open-design.json) | 源码 | Apache-2.0 |
| [video-seedance-desk-hologram-ar-realdesk](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/video-seedance-desk-hologram-ar-realdesk/open-design.json) | 提示词/元数据 | Apache-2.0 |
| [video-seedance-three-kingdoms-guanyu-slaying-yanliang](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/video-seedance-three-kingdoms-guanyu-slaying-yanliang/open-design.json) | 提示词/元数据 | Apache-2.0 |
| [video-seedance-three-kingdoms-lyubu-yuanmen-archery](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/video-seedance-three-kingdoms-lyubu-yuanmen-archery/open-design.json) | 提示词/元数据 | Apache-2.0 |
| [video-seedance-three-kingdoms-zhaoyun-cradle-escape](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/video-seedance-three-kingdoms-zhaoyun-cradle-escape/open-design.json) | 提示词/元数据 | Apache-2.0 |
| [vintage-disney-style-pirate-crocodile-animation](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/vintage-disney-style-pirate-crocodile-animation/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [viral-k-pop-dance-choreography](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/viral-k-pop-dance-choreography/open-design.json) | 提示词/元数据 | CC-BY-4.0 |
| [wasteland-factory-chase](https://github.com/nexu-io/open-design/blob/78d5637cb49da07e81314d1544b5fc6d37c95084/plugins/_official/video-templates/wasteland-factory-chase/open-design.json) | 提示词/元数据 | CC-BY-4.0 |

## 8. REA 记录、覆盖与复核入口

REA 对精确文件调用 `analyze_javascript_application`，之后用 `inspect_analysis_view` 从保留 Evidence 读取事实，未调用目标代码。下载后增补文件会改变研究目录整体 digest，故不同批次的目录 digest 不应被误解为上游提交变化。

| 批次 | 精确范围 | 保留 Evidence 与结果 |
| --- | --- | --- |
| A | `motion-delivery.ts`、`video.ts` 请求构造、source-player 合同、宿主 activity、artifact export/cover、product-promo HTML、Remotion Root/DataRollup/entry | `ev_22a4be15c81ba240d5aaf3bc044db9d46189f7f9d0bdcf5465aab4ec99dd74c9`；读取 98,605 bytes，9 JS/TS 文件，0 parse failures。HTML 的 4 个 inline body 未自动分析，另在 C 补齐 |
| B | `media/index.ts`、hyperframes audio/runtime/scaffold/models、oil 控制器，以及提取的播放器/模板脚本 | `ev_73050818ff32ba30ad110eb0619e8ae4b86299ca185d8b005341202cbb536123`；11 文件，272,705 bytes，0 parse failures；semantic graph 达到每文件 10,000、总 40,000 节点限额，部分截断，不能把缺失关系当不存在 |
| C | 从 source-player 的 PLAYER template 静态提取的脚本，加 product-promo 在原 HTML 第 45、606、627、643 行开始的 4 段原始 inline JS | `ev_e67700865b6821f7bcf4e5628fc92262538eb86c59b380a6765f7cfd384a5ba1`；5 文件，54,475 bytes，0 parse failures，未触及节点限额；静态动态调用关系仍有 unknown，未作行为运行证明 |
| D | `apps/desktop/src/main/frame-capture.ts` 与 desktop package.json | `ev_ed39eb25ad891803fa36a360bec92cc78f0ac3e78cb53e18c0550c5b022ede7c`；11,966 bytes，1 JS/TS 文件，0 parse failures；识别到 1 个 BrowserWindow、4 个显式 webPreferences；其它桌面模块未隐式展开 |

C 的提取只复制 script 文本，对 PLAYER 内四处已知常量插值作字面替换，不使用 eval 或运行原始模板。播放器派生 JS SHA-256 为 `0fa56c8649deabe6679035d7930604a95153d3bd54f1ff7666517800d4a847a7`；派生目录 artifact SHA-256 为 `d1bbf75a2f5fe29b9f36ea1f75d0812fd51c663429ff7108ec13f3cf6bd6f84f`。它们是分析载体 hash，不是可发布的上游新源码。

已读取的事实视图包括 `ev_3bcc3d2a9fb6204d85c0ef587b845980683a3d1c452f38f7d3f7b62ba74216eb`、`ev_9a716ba7bddb2cf7c8e031585a2854e2c572cd81e570b8f40652622130e697eb`、`ev_595689133683842e786f29a47f27bad0d426dda7fb396860d23148209619697c`。视图页耗尽只表示该筛选结果读完；全文关系覆盖仍按父 Evidence 的 partial/unknown 处理。

## 9. 对本项目可迁移的原创实现方向

这些是研发建议，不是已实现能力，不以 OpenDesign 替代 Claude Motion 对标：

1. **先按输出性质路由。** 成片采用确定时间驱动、帧率/尺寸/时长和可编辑源；网页交互采用 scroll/pointer/state 驱动，不能为了能导出 MP4 而丢掉交互。
2. **同一工程、同一时钟。** 预览、seek、回放和离线逐帧消费同一个合成与资产清单；把随机种子、资源就绪、时长和声音策略写成可校验字段，避免两套视觉实现漂移。
3. **检验作品中的事件。** 从受众和表达目标推导主物、动作、结果、节拍与停留；工艺参考和模板只按需读，持续发散的构图与动作不能被固定卡片数量代替。
4. **诚实区分三层完成。** 工程结构有效、真实帧可渲染、连续观看/听感/交互已验收分别记录；预制封面和编码成功不充当创意或交互验收。
5. **受限、可取消的渲染任务。** 捕获阶段、帧数/尺寸/总预算、音频和退出清理都可观察；未完成的帧与源码只作未验收私有草稿，不伪完成、自动 apply 或无界反复渲染。
6. **按资产记录来源。** 参考方法优先原创转述；确需代码时逐项固定上游、版本、许可与变更。发布包只依赖随包存在的资源，不能把目录指针或开发机上的第三方技能当作已实现插件依赖。

本次没有修改 Design 插件、加入 Motion 依赖、执行上游流水线或发布任何更新。
