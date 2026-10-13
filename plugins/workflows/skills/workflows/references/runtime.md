# Workflows 接口与脚本参考

本文只说明已实现的操作接口，不依赖开发仓库、设计文档或其他技能。文件引用均相对于当前技能目录；项目位置必须从当前用户任务或宿主上下文取得。

## 调用接口

| 工具 | 关键输入与结果 |
| --- | --- |
| `workflow_get_capabilities` | 无参数；返回运行版本、执行器和恢复能力 |
| `workflow_list_templates` | 无参数；返回内置与已保存定义摘要 |
| `workflow_get_template` | `id`；返回脚本，用户定义还含默认输入、写入范围、限制和版本 |
| `workflow_save_template` | `script`，可选 `args`、`allowWrite`、`limits`；更新已有定义需其当前 `revision` |
| `workflow_preview` | 必须有 `projectPath` 和 `script`；可选 `args`、`allowWrite`、`limits`；返回未执行的 `run` |
| `workflow_update` | `id`、当前 `revision`、新 `script` 和 `args`，可选 `allowWrite`；保存后需用户重新开始 |
| `workflow_list_runs` | 可选 `projectPath`；返回已保存运行 |
| `workflow_get_run` | `id`；返回计划、任务尝试、日志、结果与差异 |
| `workflow_stop` | `id`；停止派发、中断活跃 worker，退出并保存后返回 |
| `workflow_open_panel` | 无参数；打开面板，不启动 worker |

`projectPath` 是本次目标项目的绝对路径，由调用者提供，不使用发布者机器目录。写入需 Git 仓库根目录、预览 `allowWrite: true` 和任务 `mode: "write"`。`args` 可为任意 JSON 值，缺省为对象。

`workflow_start`、`workflow_resume`、`workflow_cancel_task`、`workflow_apply`、`workflow_panel_lease` 由面板调用。用户点击开始和恢复后才运行；查看最终差异并点击应用后才修改项目。不能绕过面板自行启动或应用。

预览与定义的 `limits` 支持 `maxReadWorkers`、`maxCalls`、`timeoutMs`、`maxTokens`。默认只读并发 4，最多 16；调用上限默认 1000，总时限默认 1 小时。token 门槛默认 0，即不限；按真实报告用量限制后续派发，已运行任务可能超过门槛，不代表账单上限。

## 脚本

首条语句是纯字面量 `export const meta`，主体是普通 JavaScript，允许顶层 `await` 和 `return`。metadata 含小写短横线 `name`、非空 `description` 和可选阶段数组 `phases`；阶段有 `title` 和可选 `detail`。

```javascript
export const meta = {
  name: "review-files",
  description: "审查用户指定文件并汇总结果",
  phases: [{ title: "审查" }, { title: "汇总" }],
};

if (!Array.isArray(args.files) || args.files.length === 0) {
  throw new Error("需要用户提供待审查文件列表");
}
phase("审查");
const reports = await pipeline(args.files, file =>
  agent(`只读审查 ${file}，报告有证据支持的问题。`, { label: file }),
);
phase("汇总");
return await agent(`合并并核实这些结果：${JSON.stringify(reports.filter(Boolean))}`);
```

| API | 行为 |
| --- | --- |
| `args` | 本次输入，文件列表由用户提供，推荐相对于目标项目 |
| `agent(prompt, options?)` | 返回 worker 文本；有 `schema` 时返回 JSON；异常可以捕获 |
| `parallel(functions)` | 接受函数数组，等待全部并按输入顺序返回；失败项记日志并返回 `null` |
| `pipeline(items, ...stages)` | 各输入独立通过阶段，保持结果顺序；异常或 `null` 停止该输入，其他输入继续 |
| `phase(title)` | 设置之后任务的默认阶段 |
| `log(message)` | 写入运行日志 |
| `return value` | 返回最终 JSON 值或文本 |

`agent` 选项为 `label`、`phase`、`mode`、`model`、`schema`、`isolation`。默认只读；`isolation: "worktree"` 当前等价于写入快照。未指定模型时使用用户默认模型。只接受 JSON schema，不能传入 Node 对象或可执行函数作为 schema。

脚本可依据结果决定分支、循环和新增任务。循环必须有清晰的结束条件。脚本自身不访问文件、shell、网络、时钟、随机数、定时器或模块。具体读取、修改和测试交给 worker；没有 `budget.remaining()` 或其他未列出的 Claude 接口。

## 停止、恢复与应用

停止显示 `stopping` 时仍在等待实际退出；`stopped` 才表示进度已保存。取消单个任务按失败处理，脚本可以捕获或以 `null` 汇总。整个运行中断会保留工作区，未完成任务恢复时从任务开始重新执行。

恢复重放脚本，按调用序校验 prompt 和规范化选项。匹配的完成结果可复用；中断任务重新执行；第一个失败或指纹变化使该位置及之后的缓存失效。跨项目复用定义创建新的运行，不使用另一项目的缓存或快照。项目变化、快照缺失和版本冲突按工具实际错误处理。

写入只在独立快照中进行，同时最多一个写入 worker。全部执行结束后统一呈现实际差异、日志和测试报告；当前项目基线或审查指纹变化时拒绝覆盖。应用成功不创建提交，也不推送或部署。
