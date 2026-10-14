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

## 0.5.2 修复后的签名桌面 CLI 专项

0.5.2 源码加入 `agents.enabled=false`，继续使用 ephemeral worker 和原生工具。该专项在本轮 `runtime/script-worker.js` 构建后启动，以环境中的 `CODEX_CLI_PATH` 选择签名桌面 CLI，实际版本为 `codex-cli 0.162.0-alpha.17.2`。使用全新私有项目和状态，worker 仍逐个显式指定并核验 `gpt-6-luna/max`。

| 用例 | 模型调用 | 耗时 | reported totalTokens | 结果 |
| --- | ---: | ---: | ---: | --- |
| 原生工具和结构化返回 | 1 | 11.0 秒 | 20,137 | 通过；真实 `native:commandExecution` 读取随机标记；CLI configured |
| 左分支、循环、并行、pipeline 首轮 | 7 | 38.8 秒 | 89,798 | 7 个 worker 均完成且 CLI configured，整体工作流 completed；测试的业务断言失败：selected 得到 R，应为 L |
| 隔离写入、审查和应用 | 1 | 17.7 秒 | 44,259 | 通过；真实 `native:commandExecution` 和 `native:fileChange`；原项目应用前不变，差异和独立测试均通过 |
| 左分支原样诊断复跑 | 7 | 45.6 秒 | 90,047 | 通过；decision 的实际结构化 data 为 `{marker:"left"}`，循环 `[1,2]`，真实 parallel 重叠，pipeline `[null,4]` |
| 新状态左分支原样复跑 | 7 | 33.2 秒 | 89,938 | 通过；实际 decision 为 `{marker:"left"}`，循环 `[1,2]`，真实 parallel 重叠，pipeline `[null,4]` |
| 同批右分支原样复跑 | 7 | 37.0 秒 | 89,511 | 通过；实际 decision 为 `{marker:"right"}`，循环 `[1,2]`，真实 parallel 重叠，pipeline `[null,4]` |

专项累计 30 次真实模型请求、423,690 reported totalTokens，worker 本身均完成，没有模型或思考深度回退。其中第一批 9 次请求，增加 data 记录的诊断复跑 7 次请求，随后在新状态原样复跑左右分支共 14 次请求；最后这一批 reported totalTokens 为 179,449。

首轮分支失败仍保留为未知语义偏差：当时夹具未保存 exact structured data，不能据此确认模型返回了哪个 marker，也不能将根因断定为模型或编排实现。诊断复跑仅增加开发报告中的 `data` 记录，**没有修改提示、schema 或插件源码**，随后取得通过实证；复跑通过不能抹掉首轮失败。

今后的夹具记录结构化 data，便于区分模型内容、schema 契约、编排判断和工具执行的问题。业务工作流应对条件字段声明合适的枚举，并检查意外值；当前自由字符串示例默认落入右分支，所以无法在首轮给出更明确的错误位置。

三批专项的临时项目和状态均已清理，原始摘要分别保留在测试指定的外部报告文件中。这仍是源码 Engine 的专项，不能代替安装包 MCP 传输、真实 App 面板或嵌套协作功能的验收。

## 0.5.3 已安装完整包与真实授权 REA MCP

本专项使用从 GitHub 市场安装的 **0.5.3 完整缓存包**，将整个插件复制到新的私有目录。对 `runtime/index.js`、`script-worker.js`、`launcher.mjs` 和 `panel.html` 逐个核对复制前后的 SHA-256，再用 MCP SDK client 启动隔离包的正式启动器。没有导入开发源码 Engine，也没有以源码或仓库依赖补齐运行包。测试客户端自身及独立 CLI 预检属于仓库开发脚本。

签名桌面 CLI 仍为 `0.162.0-alpha.17.2`，由当前宿主环境选择；仅在该测试进程中用 PATH 精确选择此 CLI，不改用户配置。数据目录通过 `WORKFLOWS_DATA_DIR` 指向私有 fixture，目标项目是新建的空白 Git 测试仓库。

运行前先通过 CLI 公共 `config/read` 确认实际 server 名为 `rea`，再用公共 `mcpServerStatus/list` 查询该 server。实际返回 REA 6.4.0、173 个工具，`binary_session` 的声明为：

```json
{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
```

若工具缺少 `readOnlyHint: true`，脚本会报告 scope 不可用并停止，不升级写入授权或绕过声明。本轮真实工具满足只读要求。

正式执行范围为 `allowWrite: false`、`networkAccess: false`、`allowedMcpServers: ["rea"]`、`allowedMcpTools: {"rea":["binary_session"]}`。只有一个 `gpt-6-luna/max` worker，要求只调用一次 `binary_session({})`，不打开目标、不使用 shell/文件、其他 MCP、网络、构建或配置写入。

| 检查 | 实际结果 |
| --- | --- |
| 正式工具协议 | `workflow_get_capabilities` 返回 0.5.3；`workflow_preview` 为 draft 且无 task；随后 start/get 到 completed |
| 执行配置 | CLI 确认 `gpt-6-luna/max`，provenance 为 configured |
| 实际工具调用 | `toolsUsed` 只有 `mcp:rea/binary_session` |
| REA 事实 | `open: false`；package/server 版本均为 6.4.0；server 名 rea；catalog 工具数 173 |
| 身份交叉核验 | worker 返回的版本、工具数及 tools/combined catalog digest 与主聊天独立 `binary_session` 的对应事实完全一致 |
| 节点简要过程 | 正式 `workflow_get_node_process` 的 brief 读取成功，节点有真实活动与工具执行过程 |
| 项目保护 | Git 状态不变；没有隔离写入 workspace |
| 彻底清理 | 正式 preview_deletion/delete 返回 deleted=true、partial=false、remaining=[]、blocked=[]；list_runs 为空，run 目录与 `.deletions` 不存在 |

本轮 1 次真实模型请求，全程约 17.8 秒；用量上报为 input 34,385、output 906、total 35,291。随后清理整份自建 fixture（包括复制的包与私有状态），原安装缓存和用户数据保持原位。

该结果证明正式 **0.5.3 安装包 → MCP 工具协议 → 真实只读 worker → 精确授权的 REA MCP** 路径可用，补充前述源码矩阵；不证明所有 MCP、写入工具、目标分析或父 App 当前连接已加载新版。

开发入口为 `scripts/workflows-mcp-compatibility.ts`。复跑时必须提供当前主聊天独立读取的 REA 身份 JSON，通过 `WORKFLOWS_REA_EXPECTED_IDENTITY_FILE` 传入；它应只包含 open、packageVersion、serverName、serverVersion、mcpToolCount、toolsDigest、combinedDigest。脚本显式要求 `--real-workers`，预检不匹配或目标事实不同均报告实际失败，不循环放宽范围重试。
