# Design 0.4.0 验证与安装记录

日期：2026-10-17。**0.4.0 已从 GitHub 市场安装，独立安装进程回读版本 0.4.0 与 41 个工具；当前聊天仍实际加载 0.3.0，需要重启后另验新版原生面板。** 不将安装、开发预览或 stdio 验证合称原生体验通过。

## 本版具体变化

- 源码目录连接与共同基线保存在私有记录，导入只读。新增状态、连接、比较、拉取、回写、重查、两端对照和显式选边八个工具；项目、页面、评论和历史沿用同一工程身份。
- 应用时重新核对项目修订与看到的目录 hash；同文件两端变化先审阅。旧对照失效后，弹窗内说明原因、禁用两端应用并提供真正的重新读取，不自动重试写入。
- 连接目录写入前持久保存完整计划，结束或受控失败后保存进度；硬中断通过原计划与实际文件 hash 重查。避免每个文件都重写完整工程历史。未连接目录的普通导出仍只有 manifest 保护，不能使用同一恢复声明。
- 评论聚焦和直接点选返回一致的真实 DOM 证据；只有运行时文字与源码静态文字相符才开放窄范围文字编辑。运行时插入 TextNode、子组件和动态表达式继续只定位。
- 修复发布检查的 TypeScript 嵌套模板误报，并保留实际依赖、透明类型包装、转义私密路径和技能传递引用的检查。

没有恢复图层文档、旧格式迁移、API Key 路径或 Motion 占位工具。独立模型任务与服务端能力未因这些测试被自动启动。

## 检查与真实操作

| 检查 | 实际结果与范围 |
| --- | --- |
| 整仓 `npm run check` | 类型、构建、清单及隔离 smoke 通过；Design 85/85，0 跳过；Workflows 463/466，3 个既有跳过 |
| 发布检查最后两处修复 | 定向 `npm run test:portability` 28/28，`npm run validate` 两插件通过；没有为了这些校验器改动重复未变的 Design/Workflows 套件 |
| 最后 UI 措辞/恢复保护收尾 | Design 类型检查、重新构建通过，随后实际浏览器回归与隔离 smoke 通过 |
| 最终隔离发布包 | 0.4.0、41 个工具、真实 React/多页、持久化、稳定评论、冲突与不支持文件保留均通过；0 模型回合 |
| 原目录往返开发预览 | 项目 `code_096b31c362384c7eb3daa951fc89d588`：导入→项目修改→原目录首次写回→外部改动拉回→双端冲突→外部再次保存→拒绝旧选择→重新读→明确选边；最终 revision 8、6 文件全部一致、评论 1 条保留 |
| 局部编辑回归 | 真实点选和评论聚焦后均出现正确静态文字输入；从 Inspector 修改只改变目标文字，其他文件和评论保留 |
| 冲突反馈 | 中文 alert 在当前弹窗内可见，旧快照按钮 disabled；重新读取实际得到外部新文字后才恢复选择。部分写入不冒称“未写入”，未重查操作继续禁用选边 |
| 输入状态 | 阅读项目 `code_184b181caeba4a48a4d6fc71e7467e52` / revision 1：搜索 hash 后切 AI/文件面板并经过同修订轮询，输入和 3 个结果仍在 |
| 剪贴板实际限制 | 同一 Design 沙箱拒绝自动复制时，显示可选文本对话框；完整 96 字符获焦点且全部选中，关闭后焦点回到复制按钮 |
| 明暗主题 | 实际看图核对源码目录选中标签、普通按钮和键盘焦点；两主题焦点框均 3px solid。此项不替代全部 hover/disabled/原生 select 状态矩阵 |

主题实测配色：暗色选中标签前景 `rgb(216,240,214)` / 背景 `rgb(52,84,60)`，焦点框 `rgb(182,226,188)`；亮色选中标签前景 `rgb(35,77,52)` / 背景 `rgb(224,236,223)`，焦点框 `rgb(43,106,71)`。未声明整套界面符合某项认证。

目录并发、BOM、符号链接、基线预算和真实权限失败的测试范围与剩余文件系统窗口，见 [往返审阅](source-roundtrip-audit.md)。完整作品与实际操作记录见 [SHIFT](verification/shift-source/README.md) 和 [R-A](verification/reading-source/SOURCE.md)。它们各一份，没有配对候选、三方实测或独立人工评审。

## GitHub、安装与当前聊天

- 发布源码与运行包提交：`1ed55dbf51817e45898429db92e615a51f3c7c4d`，已推送 `doomclouds/CodexPlugin` 的 main。
- `codex plugin marketplace upgrade codex-plugin-workspace --json` 返回 errors 为空，市场快照实际为上述提交。
- `codex plugin add design@codex-plugin-workspace` 安装 `design/0.4.0`。五项安装文件与源码构建的 SHA-256 严格一致。
- 从安装目录新启的 stdio MCP 实际回读：0.4.0、41 工具、八个源码连接工具全部存在；对原验收项目只读比较返回 revision 8、6 文件全部一致，0 模型回合。
- 同期当前聊天的 `design_get_capabilities` 仍返回 0.3.0。没有把旧面板当成新原生面板，也没有强制关闭用户的 Codex；新版原生验收在重启加载后继续。

| 安装文件 | SHA-256 |
| --- | --- |
| `runtime/index.js` | `88f5023cb14a1196ebc1907d652a8654728891acbdea46d43da49801b6f13b79` |
| `runtime/panel.html` | `ecce535a1b6103bd6574c4eeab7354ded710cf277e70f69d6c3181f929526589` |
| `runtime/react-vendor.js` | `6efd5c2c79e64091051f466a8f36fa29d1e10ffaa6b19b35c4dbfb88912006f4` |
| `runtime/vendor/esbuild-wasm/esbuild.wasm` | `b1831a5c0f6cf688034fb94d0419812f165ea316a3380d3fc00a151e562d2eaf` |
| `plugin.json` | `86111c8fb35268c78ff7bd841207a36d122c3336649b59141dbbad21a1a99c18` |

## Motion 研究与阶段边界

[Claude ArtifactData REA](claude-motion-data-rea.md) 已补出实际工具注册、请求适配、版本条件、批量与部分失败边界；[播放器合同研究](claude-motion-rea-contracts.md) 记录了进一步检查的精确范围。仍未取得真实 Claude Motion 实例 Skill、专用播放器或完整场景 schema，不从通用数据服务反推这些实现。

[OpenDesign Motion 源码研究](open-design-motion-research.md) 已确认实际 HTML/GSAP、统一播放、逐帧与 MP4 导出代码链，并区分 23 个源码模板和 40 个元数据条目及其逐包许可；未执行上游、未将源码存在当作运行和成片质量证据。

目标继续推进；当前没有足够证据声称静态设计或 Motion 已超越竞品，也未关闭全部 [静态验收门槛](static-quality-gates.md)。下一轮的原生加载、完整连续改稿、对照作品与 Motion 实例证据仍分别保留。
