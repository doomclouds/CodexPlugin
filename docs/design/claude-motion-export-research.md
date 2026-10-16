# Claude Motion 公开导出客户端：工程与帧接口研究

核验日期：2026-10-17（Asia/Shanghai）。本文补充 [本机 Motion REA](claude-motion-rea-contracts.md)，只做读取与静态分析，不实现 Motion 插件。

**结论：公开的 `umiyosh/motion-render` 客户端提供了直接面向 Claude Motion 的工程读取、存储展开和按时间取帧合同。** 这些是作者客户端实际使用的字段与调用，不是 Anthropic 发布的稳定规范；仓库里的播放器是测试替身，不能据此宣称已经获得或运行真正的 Motion runtime。

## 1. 官方确认到哪一层

**[官方公开]** Claude Motion 使用代码驱动文字、图表、形状和图片的动画，可通过聊天或编辑器修改细节，支持 MP4 导出；目前是 Team/Enterprise 的 beta。官方帮助页同时明确其不是生成写实视频的视频模型。[Claude Motion 使用说明](https://support.claude.com/en/articles/17454997-get-started-with-claude-motion)。

**[未知]** 此页及 [Artifacts 产品页](https://claude.com/features/artifacts) 没有公开本轮需要的具体 `type_url`、Motion 实例 `SKILL.md`、播放器源文件或时间轴 schema。官方 `claude.ai` 页面在当前 web 读取通道受到 robots 限制；没有绕过限制、使用登录凭据或调用逆向私有接口。

## 2. 固定来源与许可证检查

研究对象是作者自己的 [公开仓库固定版本](https://github.com/umiyosh/motion-render/tree/0086da2f5f3f1a443e6734213f0367e612526e41)，不是搜索聚合站的二次转载：

- Commit：`0086da2f5f3f1a443e6734213f0367e612526e41`。
- Commit 时间：`2026-10-14T19:57:20+09:00`；两个 package 的版本均为 `0.4.0`。
- 通过匿名 Git 只读获取，禁用 credential helper、全局配置与交互提示；未安装依赖、执行 npm scripts、启动浏览器或运行这些文件。
- GitHub API 的匿名请求遇到 rate limit 403；未为此读取或使用凭据。固定提交使用公开 Git ref 核对，精确文件使用该提交的 Git object 读取。

**[来源元数据观察]** 固定提交的完整文件树没有 `LICENSE`、`COPYING` 或 `NOTICE` 文件；根 package 和技能 package 未声明 `license`。以下逐文件未发现独立许可证、SPDX 或授权头，不能把公开可读等同于可按 MIT/Apache 复制。本文只写原创合同摘要，不把作者实现、播放器或 Skill 正文收入插件。

| 本轮读取文件 | SHA-256 | 文件级许可观察 |
| --- | --- | --- |
| `skills/motion-render/SKILL.md` | `befd2221d2b6ad85ca36cee2ca009e92a6a4f7251bd259a512780b18fe16131c` | 未发现声明 |
| `scripts/store.ts`（同技能下） | `a0c46eb0a37959bb10ad3efcd15c7900f668b79db94c50dd34562043b127e128` | 未发现声明 |
| `scripts/render.ts` | `3c238b4fbe86326756f04455f66f7071c6c05833275870ffcb882ab475fc669d` | 未发现声明 |
| `scripts/cli.ts` | `3864b6912e5bae7b221fe89ec9fd4d2b1b80ec3fa8125415d7553c5de979c925` | 未发现声明 |
| `scripts/work.ts` | `2a3bd4007536bae52bbd597488df4fa1a6542183ced2fb5ce978e9a71e37ad2b` | 未发现声明 |
| `scripts/audio.ts` | `6b729eadd4e753b2a48d49387b0c58e87bed9bb6f9e13303848734b8033c1acf` | 未发现声明 |
| `scripts/json.ts` | `c1350fe9b624c1f793fb17956690367d0c95969602b6d32f0ab394fab4954345` | 未发现声明 |
| `tests/fixtures/player/artifact-type/app.js` | `2b25ea4e023bc58e2ee2c89109fdc8125e77e2fa3592eb6db7019c01f0b2c3f8` | 未发现声明；是测试替身 |

这份表只覆盖上述研究文件；没有复制运行时，也没有把依赖包的许可证当作这些源文件的许可证。

## 3. 取得的工程合同：作者如何从 Motion 读取内容

**[作者接口约定]** 固定版 [Skill 第 103—118 行](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/skills/motion-render/SKILL.md#L103) 使用 `Artifact.quickstart/list` 动态寻找类型地址；没有固化一个通用 Motion `type_url`。创建后遵循返回的类型指导，再读取 `index.html`、`artifact-type/app.js`、`artifact-type/app.css`；另用 `ArtifactData` 读取 `modules` 集合和 `film/script` 文档。这里只观察到作者要求的工具流程，没有执行其中的创建或读取私有作品。

**[作者实现观察]** [store.ts 第 12—43 行](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/skills/motion-render/scripts/store.ts#L12) 接受 `{data: ...}` 包装或直接对象：`modules/*.json` 中的 `text` 展开为同名模块，去掉最后一层 `.json`；例如 `scenes.json.json` 展开为 `modules/scenes.json`。`film/script.json` 的 `code` 写成 `cut.js`，没有此文档时采用 `window.CUT = kit.scenes()`。非内联资产只列出待补的名字，需另行准备，不能把 `prepare` 完成当作资产闭包已齐全。

**[推断]** 这与本机 CLI 恢复的“类型固定文件 + 实例自身内容/存储”分离合同相吻合，明显比“场景 JSON 直接当成最终视频”更丰富。但 `modules` 内的完整语言、`kit` API、所有场景属性和编辑器可修改范围仍没有由官方材料证实。

## 4. 按时间取帧：客户端实际调用的播放器接口

**[作者实现观察]** [render.ts 第 58—146、168—210 行](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/skills/motion-render/scripts/render.ts#L58) 期待以下合同；下表是接口摘要，不是完整官方 schema：

| 环节 | 客户端读取或传入的字段 |
| --- | --- |
| 工程输入 | `title`、`script`、`modules[{name,kind,text}]`、`assets[{name,mime,base64}]` |
| 播放器入口 | 打开 `index.html#tools`，等待 `window.__animation` |
| 装载 | `__animation.load(film)`；检查返回的 `error` 或 `meta` |
| 时间信息 | `meta.duration` 与 `meta.parts[{key,a0,dur}]`；作者按秒解释开始与时长 |
| 取帧 | `__animation.frame(t,{scale:1})`，读取返回字符串中的 base64 数据 |
| 诊断 | `__animation.consoleLog()`；过滤并报告非普通日志 |

**[未知]** 客户端声明不等于真实播放器实现。尚未确认帧的确定性、音画同步、字体保真、任意时刻的完整加载条件、原生编辑器如何修改这些模块，也没有从公开实例恢复实际 `app.js/app.css`。

## 5. MP4 路径属于作者客户端，不能归为官方编码器

**[作者实现观察]** [cli.ts 第 75—119、130—147 行](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/skills/motion-render/scripts/cli.ts#L75) 逐次请求 `frame(i/fps)` 并将帧写入 FFmpeg 管道；默认帧率由该客户端设为 30。它会混入作者额外生成的旁白与配乐；这些外部音频步骤不构成 Claude Motion 官方音频能力的证明。

**[作者实现观察]** [work.ts 的 placeOnFilm](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/skills/motion-render/scripts/work.ts#L165) 用场景 ID 匹配 `meta.parts.key`，按播放器给出的 `a0` 放置旁白；场景缺失会失败，旁白超长会警告。这提供了有用的工程边界，但其旁白时长算法与默认值属于作者实现。

**[未知]** 官方“Export → MP4”是否使用相同入口、帧率、FFmpeg 或本地渲染，仍未确认。不能因为客户端能写一条本地编码路径，就声称已逆向出官方导出服务。

## 6. 静态 REA 与测试替身的证明边界

本轮对精确提交取得的 `store.ts/render.ts/cli.ts/work.ts` 实际调用 `analyze_javascript_application`，明确指定目录和四个 `source_paths`：读取 22,199 字节，4 个文件解析成功，0 解析失败。应用图、语义图均 partial，但未触及截断；11 个相关文件未选，794 个语义 unknown 保留。`inspect_analysis_view` 对 store/render 模块事实翻页读取 32/32 条，只表示这个保留视图已读完，不表示运行或集成完成。

- 分析父 Evidence：`ev_d8df354539b2a3674db83750123e5266307afbd449b9ec6edcb91b64fe66cc9f`。
- 返回与导出事实：`ev_74334006a8692d43e35f7929bb0a394dd6c4ab2e80cda97eada95acdf846b87a`、`ev_5e2efc542129d210b9a0ccc9d769f2a35b583c6b284f09d272f3e4d05bc317ac`。
- 读取的精确源、提交信息与逐文件 hash 清单只在本机临时目录 `claude-motion-public-2026-10-17`；不进入发布包。

**[作者测试观察]** [播放器 fixture 第 1 行](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/tests/fixtures/player/artifact-type/app.js#L1) 明确声明它是 Motion player 的 stand-in。它将示例场景顺序排列，用不同纯色代表当前场景。因此，即使该仓库 smoke test 通过，也只能支持客户端驱动和编码流程的对应范围，不能证明真实 Claude Motion 画面、场景语义或当前服务端合同。

## 7. 已缩小的缺口

| 问题 | 当前状态 |
| --- | --- |
| Motion 是代码动画并可导出 MP4 | 官方确认 |
| 类型固定文件、模块内容、脚本与资产如何被该客户端读取 | 已有固定提交的作者源码观察 |
| 实例内容可能通过 ArtifactData 存储，而非只上传页面文件 | 作者流程与本机通用类型合同交叉支持；未做实机交叉验证 |
| Motion 的通用 `type_url`、完整实例 Skill、实际播放器源码 | 尚未获得；作者也动态发现类型，不提供固定地址 |
| 官方完整场景/时间轴、稳定版本及导出编码实现 | 尚未知；不能以客户端类型声明或 stub 补造 |
| 在 Codex 中是否可直接复制运行时使用 | 本轮没有复制许可或真实运行时；仅可据已确认合同研究独立实现 |

下一份最有价值的证据是公开可读取的真实 Motion 工程，或用户明确提供的非私密导出，其中含类型版本、实际播放器、模块和资产。无需为继续研究先创建或发布远端项目。

## 8. 公开作品与历史链接追踪的收口

**[作者原始资料观察，2026-10-17 补充]** 本轮继续读取了固定提交可达的全部 26 条公开提交记录，以及其中 17 个涉及中英文 README 的历史提交，共核对 31 份存在的 README 快照。相关作品链接只有 5 个 GitHub attachment 地址，没有发现 `claude.ai` 作品地址、Motion 类型地址或工程下载地址。这个结论只覆盖该仓库的上述历史文件，不代表整个互联网或作者所有材料。

当前 [英文 README 的 Demo](https://github.com/umiyosh/motion-render/blob/0086da2f5f3f1a443e6734213f0367e612526e41/README.md#L16) 指向 [演示附件](https://github.com/user-attachments/assets/b62fe703-223d-478e-9e9b-3239a48ba1ea)。该原链接在 web 通道重定向为 MP4 对象，通道随后报告无法读取且不可重试；未绕取临时签名地址。它是成片入口，不能提供播放器、`kit` 或工程模块实现。

**[作者公开问题观察]** [Issue #13 的 Current state](https://github.com/umiyosh/motion-render/issues/13) 明确说明该客户端只从 Chromium 捕获画面，不捕获 Motion 工程原有声音，声音由自己的混音步骤产生。这进一步限定了本地导出的证明范围；它不能证明官方音轨或官方导出器已被复现。已读的另一条当前公开议题 [#11](https://github.com/umiyosh/motion-render/issues/11) 是外部语音/配乐提供方扩展，也未提供真实 Motion 工程。

**[执行与覆盖边界]** 作者公开主页的完整仓库列表在当前通道受到 restricted 限制，未绕过，也没有假定已读完其 24 个公开仓库。当前仓库树没有 `examples` 或真实播放器文件；最早的客户端渲染脚本也只是调用已导入播放器的 hook，未附其实现。此前已读的官方 Motion 帮助与 Artifacts 产品页没有把浏览者导向可读取的工程源文件。本轮没有因此猜测 UUID、创建项目、发布作品或运行第三方脚本。

**[仍可做的独立验证]** 可在未来实现中用原创、受控的时间函数和帧序列验证本地取帧、取消、错误保留和编码合同，但它只验证自己的实现；不能称为 Claude Motion 兼容性验证。要继续核对 Claude 的真实场景语义，仍需要公开工程或获准读取的实际类型/工程产物。README 历史链接索引与源快照 hash 仅保存在本机临时分析目录。
