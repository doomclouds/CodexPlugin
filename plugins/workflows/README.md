# Workflows

<img src="assets/workflows-icon.png" alt="Workflows 产品图标" width="64" height="64">

`0.2.2` 提供动态工作流第一版：预览 JavaScript 脚本后启动真实 Codex worker，按结果分支、循环和调度任务；支持停止、磁盘保存和手动恢复。写入先在独立快照中完成，全部执行结束后统一审查，再由用户点击“应用改动”。

需要 Node.js 22 或更新版本、支持 `app-server` 的 Codex CLI 和已有登录。插件不负责登录或修改全局配置。打开面板前核对工具返回的运行版本；安装版本和当前连接的服务版本可能不同。

## 使用

1. 描述任务，让 Codex 起草脚本，明确输入、结束条件和是否需要写入。
2. 打开 Workflows 面板，填写目标项目的绝对路径、脚本和 JSON 输入。写入任务选择允许写入；目标必须是 Git 仓库根目录。
3. 点击“保存预览”。此时不启动 worker。检查项目、脚本、输入与写入范围后点击“开始”。
4. 在“任务”和“日志”中查看真实结果、执行尝试、线程标识、用量和命令输出。任务数按脚本执行动态增加。
5. 点击“停止”后等待“已停止”。结果、日志和快照改动保留；重新打开只加载记录，点击“恢复／继续”才重新执行。
6. 执行完成后查看统一差异和 worker 的实际验证报告，点击“应用改动”。冲突时保留当前项目，先处理冲突或创建新的预览。

宿主没有提供项目目录时，手动填写，不从插件启动目录猜测目标。测试由真实 worker 执行并报告；面板不显示固定的示例测试通过数。应用不会提交、推送或部署。

## 工作流库与跨项目复用

编辑区的“保存到工作流库”保存脚本、默认输入、默认写入范围和限制，不绑定项目、运行结果或快照。定义按 `meta.name` 标识；更新已有定义需要当前 `revision`，避免覆盖另一处更新。

选择定义，点击“载入到新运行”，填写项目 A 并保存预览。再次载入同一定义，填写项目 B，可创建独立运行。修改定义不会自动替换已保存的运行。

例如保存以下只读定义：

```javascript
export const meta = {
  name: "review-files",
  description: "逐文件审查，再汇总有证据支持的问题",
  phases: [{ title: "审查" }, { title: "汇总" }],
};

const findings = await pipeline(args.files, file =>
  agent(`只读审查 ${file}，返回有证据支持的问题。`, { label: file, phase: "审查" }),
);
phase("汇总");
return await agent(`汇总并排除误报：${JSON.stringify(findings.filter(Boolean))}`);
```

对应 MCP 参数如下；`script` 表示上述脚本文本，`projectAPath` 和 `projectBPath` 由用户提供，不预设机器目录：

```javascript
workflow_save_template({ script, args: { files: ["src/Example.cs"] }, allowWrite: false });

workflow_preview({ projectPath: projectAPath, script, args: { files: ["src/Example.cs"] } });
workflow_preview({ projectPath: projectBPath, script, args: { files: ["src/Other.cs"] } });
```

库同时列出内置定义与用户定义。内置 ID 为 `review-changes`；用户定义 ID 为 `saved:<meta.name>`。保存定义、读取定义和保存预览都不启动 worker。当前没有定义删除、导入导出或远端同步入口。

## 工具与执行边界

| 工具 | 行为 |
| --- | --- |
| `workflow_get_capabilities` | 返回当前执行器、恢复与面板能力 |
| `workflow_list_templates`、`workflow_get_template` | 列出、读取内置或保存的定义 |
| `workflow_save_template` | 保存独立定义 |
| `workflow_preview`、`workflow_update` | 保存或更新计划，不执行 |
| `workflow_list_runs`、`workflow_get_run` | 读取真实运行、任务、结果和差异 |
| `workflow_open_panel` | 打开任务面板 |
| `workflow_stop` | 中断 worker，等待退出并保存 |
| `workflow_start`、`workflow_resume` | 用户面板动作，要求当前版本和有效租约 |
| `workflow_cancel_task` | 面板取消单个任务，其他任务由脚本决定 |
| `workflow_apply` | 面板应用最终审查的差异并检查冲突 |
| `workflow_panel_lease` | 维护面板生命周期，失联到期停止运行 |

开始、恢复、单任务取消和应用仅声明给 App。Codex 可以起草和保存预览；用户开始与应用是两个独立步骤。

脚本由 Worker 线程内的 QuickJS WASM 执行，不使用 Node `vm`。脚本只调用编排 API，不能直接访问文件、shell、网络、定时器或模块；时钟和随机数不可用。`parallel()`、`pipeline()` 按输入顺序返回，单项失败记日志并返回 `null`，流水线遇 `null` 停止该输入。直接 `await agent()` 的错误可由脚本捕获。

只读 worker 默认最多 4 个，可配置为 1—16。写入任务显式设置 `{ mode: "write" }`；同一数据目录下的多个服务进程同时最多 1 个写入 worker。只读沙箱禁止写入，但读取范围不限于 `cwd`。写入只允许修改快照；外部 MCP、apps、插件、其他代理和网络关闭，不自动提升权限或回答交互请求。

快照保留当前 tracked 脏内容和未忽略的 untracked 文件，不复制原 `.git`。忽略的新增构建产物不进入最终差异；已跟踪文件即使匹配忽略规则，仍可审查。内部相对符号链接保留；外部链接和符号链接父目录拒绝复制或应用。

## 数据与恢复

默认数据目录为 `~/.local/state/codex-workflows`，通过 MCP 进程的 `WORKFLOWS_DATA_DIR` 可改址：

```text
<data>/
  templates/<name>.json             独立定义库
  wf_<24位十六进制ID>/
    run.json                       计划、状态、任务、尝试、结果、日志和差异
    baseline/                      开始时文件基线
    workspace/                     worker 使用的快照
    apply-transaction/             应用记录与暂存内容
  locks/                           定义、写入槽位和项目应用锁
```

只读运行不创建文件快照。定义与运行记录分开；跨项目复用定义不共享任务缓存。

恢复按调用顺序重放。匹配 prompt 和选项的已完成任务可复用；整次停止时中断的任务重新执行，可保留其前后独立完成的缓存。首个失败或调用指纹变化使该位置及后续缓存失效。项目变化使只读缓存全部失效；已有写入快照的运行要求新建预览。快照缺失时明确失败，不静默重建。

正常关闭面板会停止其启动的运行，MCP 正常关闭也等待退出并保存。面板每 5 秒续租，租约有效期 90 秒；关闭事件未送达时由到期检测兜底。异常退出后的记录重新加载时整理为已停止或应用失败，用户手动继续。实际宿主事件送达仍需新版验证。

## 源码构建与验证

发布完整插件目录，保留技能参考文件及全部清单引用资源。esbuild 将 MCP、内嵌 WASM 的脚本 Worker 和面板打包到 `runtime/`。`${PLUGIN_ROOT}` 定位真实入口，不依赖宿主工作目录；GitHub 市场安装直接使用运行包，不需要仓库外依赖或宿主构建。

单独使用插件源码时，在插件目录安装声明的开发依赖即可构建和检查，不需要父工程配置：

```sh
npm install --ignore-scripts
npm run typecheck
npm run build
npm run smoke
```

日常检查覆盖类型、构建、结构、独立 MCP 包、沙箱、调度、持久化、工作区、模板与面板。测试中的 adapter 与协议进程夹具不调用模型。可选真实验证会调用模型：

```powershell
npm run smoke:real
```

`ui://workflows/panel.html` 是稳定的自包含 MCP App 资源，支持全局和会话入口。初次连接和更新时应用宿主主题、颜色、字体 CSS、字号、行高和相关变量；缺失变量使用回退。

## 升级后的宿主连接

面板入口使用稳定的 `ui://workflows/panel.html`，避免每次发布改变宿主保存的资源地址。新服务同时保留 `ui://workflows/prototype/0.1.4.html`、`ui://workflows/panel/0.2.0.html` 与 `ui://workflows/panel/0.2.1.html` 兼容地址；这些地址都返回同一份当前面板 HTML。服务在启动时将 HTML 读入内存，因此以后安装新包移除旧缓存文件，也不会让已启动的新服务读取面板时出现文件不存在错误。

GitHub 市场升级完成不代表已经运行的 MCP 进程重新加载。旧进程可能仍持有已被更新移除的缓存目录，或无法识别新版资源地址。升级后需要重新加载宿主中的 Workflows MCP 连接，再打开面板；兼容地址只能由新版服务提供，不能修复仍运行的旧进程。`workflow_get_capabilities` 和 `workflow_open_panel` 的结果包含 `version`，可与安装版本核对；面板工具的资源地址应为上述稳定地址。

详细调用说明见技能目录内的 [接口与脚本参考](skills/workflows/references/runtime.md)。该资料随插件发布，不依赖开发工程。
