# 2026-10-15 真实工作流稳定性矩阵

本轮手工测试使用真实 `WorkflowEngine`、`RunStore`、`TemplateStore` 和 `CodexAdapter`，PATH 中实际调用的 CLI 为 `codex-cli 0.162.1`。共调用 23 次 `gpt-6-luna`，每次显式指定思考深度 `max`。没有替换模型，没有模拟代理返回。22 次调用正常完成，另 1 次按用例设计主动取消。

模型目录实际列出 `gpt-6-luna` 支持 `max`；成功 worker 的执行记录均核对 CLI 返回的 `executionSettings`，要求 `model: gpt-6-luna`、`reasoningEffort: max`、`provenance: configured`。这证明 CLI 接受并确认执行配置，不能证明服务端每次推理的物理模型身份。

测试在系统 API 创建的三个一次性 Git 项目和独立状态目录执行，使用现有 Codex 登录。项目 A/B 各有不可提前猜测的随机标记。读取用例要求代理调用原生命令读取文件，返回的标记必须与实际文件逐字一致。没有启动、恢复、应用或删除用户真实 REA 工作流，没有修改用户 Codex 配置。

## 结果

| 用例 | 模型调用 | 耗时 | reported totalTokens | 核对的实际结果 |
| --- | ---: | ---: | ---: | --- |
| 原生工具和结构化返回 | 1 | 9.7 秒 | 23,231 | `native:commandExecution` 读取随机文件；结构化结果一致；CLI 确认模型和深度；过程序列有更新 |
| 左分支、有限循环、并行、pipeline | 7 | 43.6 秒 | 103,892 | 分支选 L；循环 2 次得到 `[1,2]`；两个 worker 实际时间重叠；pipeline 返回 `[null,4]` |
| 右分支、有限循环、并行、pipeline | 7 | 48.2 秒 | 103,803 | 分支选 R；第二轮同样验证循环、真实并行和 `null` 短路 |
| 失败捕获和调用预算 | 1 | 10.7 秒 | 23,516 | 首个 worker 真实读取；第二次调用被 `maxCalls: 1` 拒绝，脚本 `catch` 后正常完成，没有派发多余 worker |
| 取消 worker 和并行失败隔离 | 2 | 12.3 秒 | 34,816 | 观察到真实原生命令启动后取消目标 worker；目标记为 failed 并返回 `null`；另一 worker 正常完成；工作流 completed |
| 隔离写入、审查和应用 | 1 | 13.9 秒 | 49,779 | 原生命令和文件工具修复加法；应用前原文件及测试不变；差异只有 `sum.mjs`；隔离区和应用后项目的独立测试均通过 |
| 应用冲突 | 1 | 33.0 秒 | 68,916 | worker 创建文件后项目新增同名用户修改；应用返回 conflict，用户修改保持原样 |
| 停止、磁盘重开和恢复缓存 | 1 | 17.6 秒 | 23,261 | 已完成模型任务 retained；中断命令记为 interrupted；重开不自动执行；恢复时模型结果 cached，命令为第 2 次尝试 |
| 定义跨项目复用 | 2 | 19.6 秒 | 46,267 | 保存的定义不包含项目；A/B 创建不同运行，读取各自不同随机标记，保留同一定义来源，结果互不串用 |
| 实际进程崩溃和恢复 | 0 | 13.0 秒 | 0 | 真实 engine 与自有命令进程树 SIGKILL；锁过期后只恢复 stopped；完成的 identity 缓存重放；中断命令重新执行后 completed；总计 3 次原生命令尝试 |

总计 10 个用例均取得通过实证，reported totalTokens 为 477,481。该 token 数来自 app-server 的用量事件，包含其上报的输入；不等于计费 token 数。取消用例也保留终止前已收到的用量。

## 测试夹具修正

第一次崩溃注入在获取进程 ID 文件时失败：命令 adapter 当前不发出 `process` 事件，夹具因此未生成该文件。错误为 `ENOENT ... crash-pids.json`；该失败没有证明运行时恢复失效。

夹具改为只读取 `ps` 的 PID、PPID、PGID 数值，沿自建子进程树捕获后代；观察到命令真正执行后再注入崩溃。仅终止本用例拥有的进程与进程组。定向重测随后通过。此修正位于开发脚本，没有修改插件 adapter。

## 复跑

脚本位于仓库根级 `scripts/workflows-stability.ts`，不进入发布插件。它在执行前要求显式 `--real-workers`，模型固定为用户要求的 `gpt-6-luna/max`；不可用时明确失败，不退换模型。

```shell
WORKFLOWS_STABILITY_REPORT=/tmp/workflows-stability-report.json \
node --experimental-strip-types scripts/workflows-stability.ts --real-workers --cleanup
```

只复跑指定用例时，设置逗号分隔的 `WORKFLOWS_STABILITY_CASES`，例如：

```shell
WORKFLOWS_STABILITY_CASES=cancel-worker-parallel-failure-isolation,actual-process-crash-recovery \
WORKFLOWS_STABILITY_REPORT=/tmp/workflows-stability-focused-report.json \
node --experimental-strip-types scripts/workflows-stability.ts --real-workers --cleanup
```

`WORKFLOWS_STABILITY_CODEX` 可显式选择要验证的 Codex CLI；默认使用 PATH 中的 `codex`。`--cleanup` 只在报告保存在夹具目录外时清理本次创建的项目和状态，避免一起删除证据。报告包含每个用例的状态、耗时、用量、错误摘要和每次 worker 的实际确认配置，不复制 app-server 原始诊断或凭据。

开发脚本通过独立 TypeScript 检查：

```shell
./node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --allowImportingTsExtensions \
  --esModuleInterop --skipLibCheck scripts/workflows-stability.ts
```

## 验证范围

本轮直接调用源码 Engine 的生产实现，覆盖真实模型、原生工具、脚本执行、持久化、隔离工作区和应用。MCP 工具传输、已安装运行包、真实 App 面板和当前 REA 报错的验收需要另外记录，不能由此表代替。

有限循环经过两轮实测；这不保证无限循环或任意业务任务稳定。网络波动、远端副作用的幂等、长时间资源耗尽、真实 MCP 服务故障和 worker 内部协作子代理的恢复仍需各自用例。取消和崩溃仅针对私有 fixture，没有用用户项目做破坏性注入。

单次成功任务从 5–33 秒不等。本轮用于确定可复现的行为，样本不足以作性能基准或对长期稳定性作无条件保证。
