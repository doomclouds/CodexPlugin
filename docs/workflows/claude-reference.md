# Claude 动态工作流参考

本插件参考“脚本持有编排计划、worker 执行任务”的动态工作流方式，不调用 Claude 的执行器，也不宣称完整脚本兼容。

## 官方公开资料

[Claude Code 动态工作流文档](https://code.claude.com/docs/en/workflows) 公开 JavaScript、meta、agent、parallel、pipeline、phase、log 与 args。运行时隔离保存中间结果，脚本与 worker 权限分开。

[官方 Cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows) 展示 Agent SDK 启动、流式进度与保存脚本。动态 workflows 有公开入口，一般 subagents 或 agent teams 不是同一功能。

官方说明按调用序重放已保存结果，首个失败或 prompt 变化使后续缓存失效；结果属于原会话。脚本直接文件、shell、模块访问受限，时钟与随机数受限以稳定重放。行为随版本变化，本插件使用自己的明确契约。

## 本机静态核对

2026-10-13 对本机 Claude Code 2.1.296 做只读静态核对：

| 项目 | 记录 |
| --- | --- |
| 二进制 | 原生 arm64 Mach-O，版本目录 2.1.296 |
| SHA-256 | c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937 |
| 动态运行时片段 | 文件区间 208563796..208659093，共 95297 字节 |
| REA 证据 | ev_ae0ea5f4c4153cdcbe86cb6a3bb4ae88e7672edda09cabedd81f5073e34a042e |

静态片段确认 parallel 通过 Promise.allSettled 汇合，按输入位置返回，失败项为 null 并记错误；pipeline 逐输入推进，失败或 null 停止该输入后续阶段。直接 agent 异常可向脚本抛出。

这些是固定二进制的静态分析摘要。REA parse、符号或调用图不证明实际执行、宿主 UI 或全部动态分派。Claude 二进制、提取源码和完整片段没有提交到本仓库。

## 本插件采用与区分的规则

| 事项 | 本插件第一版 |
| --- | --- |
| 编排 | 独立 QuickJS WASM，普通分支循环控制真实 Codex worker |
| 汇合 | allSettled、输入顺序、失败为 null、流水线短路 |
| 权限 | 显式 mode read/write，预览写入许可与快照，外部工具和网络关闭 |
| 确认 | 用户先开始，完成后另行审查与应用，开始不授权自动合入 |
| 恢复 | 整次中断重跑未完成任务，可保留其前后独立完成缓存；首个失败或指纹变化使后续失效 |
| 定义 | 独立 templates/ 库，为不同项目创建不同运行 |
| 隔离 | 文件快照，isolation worktree 当前不创建 Git worktree |
| 未支持 | Claude 全部选项、stall 自动重启、交互问答、token budget API |

任务结果缓存与模型 prompt cache 不同。本插件复用保存结果，不据 Claude prompt-cache 机制推断 Codex 计费或命中率。契约见 [运行时设计](runtime-design.md)，使用见 [插件说明](../../plugins/workflows/README.md)。
