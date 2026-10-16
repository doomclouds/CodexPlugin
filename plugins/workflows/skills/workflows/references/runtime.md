# Workflows 0.11.0 接口与定义

唯一协议为结构化 JSON；不接受 JavaScript `script`、旧 taskId 或旧数据格式。需要 Node.js >= 22.15.0 及内置 node:sqlite。先调用 capabilities，以当前连接真实返回为准。

## 创建和复用的工具格式

```json
{
  "projectPath": "由宿主或用户确认的项目目录",
  "definition": {
    "schemaVersion": 1,
    "name": "inspect-and-check",
    "description": "检查项目，按结果选择检查路径",
    "parameters": [
      {"name":"mode","label":"检查范围","type":"string","enum":["code","docs"],"default":"code"}
    ],
    "steps": [
      {
        "id":"route","type":"choice","label":"选择检查路径",
        "cases":[{
          "id":"code","label":"代码",
          "when":{"op":"eq","args":[{"ref":"args.mode"},"code"]},
          "steps":[{
            "id":"inspectCode","type":"agent","label":"检查代码",
            "task":"使用原生工具检查项目代码，简要报告观察事实，不修改文件。",
            "mode":"read"
          }]
        }],
        "default":[{
          "id":"inspectDocs","type":"agent","label":"检查文档",
          "task":"使用原生工具阅读项目说明，简要报告事实，不修改文件。"
        }]
      },
      {
        "id":"verify","type":"repeat","label":"最多三轮检查",
        "maxIterations":3,
        "until":{"op":"gte","args":[{"ref":"iteration"},1]},
        "steps":[{"id":"round","type":"transform","value":{"ref":"iteration"}}]
      }
    ]
  },
  "args":{"mode":"code"},
  "grants":{
    "allowWrite":false,
    "networkAccess":false,
    "allowedMcpServers":[],
    "allowedMcpTools":{},
    "workspaceMode":"snapshot",
    "approvalMode":"never"
  },
  "limits":{"maxReadWorkers":2,"maxCalls":20,"timeoutMs":600000,"maxTokens":0,"maxInstances":1000}
}
```

此对象交给 `workflow_preview`，返回 `{run}`。预览不执行；按用户授权，用 `workflow_start({id:run.id,revision:run.revision})` 开始。循环示例是确定性的结构演示；transform 不调用模型，也不能冒充测试或构建结果。

保存时 `workflow_save_template({definition,args?,grants?,limits?})` 返回 `{template}`。更新传 `id` 和当前 `revision`；读取 `workflow_get_template({id,revision?})` 返回 `{template}`，包含冻结定义和 plan。复用时传完全相同的 definition 和 `sourceDefinition:{id,revision}` 创建新项目 Run。定义更新生成新 revision，不改历史 Run。

## 节点完整字段

所有节点都有 `id`、`type`、可选 `label`。id 使用字母开头的字母、数字、短横线、下划线，最多 80 字符，同一份定义内唯一。未知字段拒绝，不会静默忽略。

| type | 必填 | 可选 |
| --- | --- | --- |
| agent | task 表达式 | mode=read/write；model；reasoningEffort；schema；accept；maxRecoveryAttempts=0..2 |
| command | argv 表达式数组；effect=read/write | networkAccess；protectedPaths；timeoutMs；idempotent |
| transform | value 表达式 | 无 |
| wait | message 表达式 | schema |
| subflow | ref:{id,revision} 或 definition（二选一） | args 表达式 |
| expand | task 表达式 | 无 |
| choice | cases:[{id,when,steps}]；default:[] | case.label |
| parallel | branches:[{id,steps}]；policy=fail-fast/all-settled | concurrency；branch.label |
| map | items；itemKey；steps | concurrency |
| repeat | maxIterations；steps | while 或 until（二选一，可都省略为固定轮数） |
| try | steps；catch 或 finally（至少一个） | catch:[]；finally:[] |

agent.task / wait.message 在运行时求值；agent.task 必须非空字符串。command.argv 每项必须为不含 NUL 的字符串，不通过 shell 隐式解释。effect 标签不代替底层沙箱。保护目录仅允许相对 `.agents` / `.codex` 内的必要目录，受实际工作区与授权校验约束。

repeat.iteration 从 0 开始；while 在执行本轮前检查，until 在本轮提交后检查；达到 maxIterations 后正常退出，不代表业务验证已经通过。需要业务成功验收时，后续 choice 明确判断结果。循环中 state 表示上一轮提交的输出，第一轮为 null；until 可读本轮 body 节点输出。

choice 按顺序选择第一个 true，默认分支 id 为 default，不能把 case 命名为 default。parallel 默认不猜失败策略，必须显式 policy；all-settled 返回各分支 status 与 output/error。map 冻结本次输入集合，itemKey 求值必须唯一；item/key 只在 map 的有效作用域可用。

try.catch 与 finally 可读取 error。暂停、等待和停止控制不冒充业务异常。finally 不能绕过审批或扩大原授权，清理成功不覆盖主失败。

subflow 的 ref 在预览时冻结到准确版本；内联定义的节点处于独立输出作用域。expand 输出同格式定义，先校验并保存再执行；恢复使用已冻结定义，不重新生成。不能通过动态展开添加原定义未声明的命令授权。

## 表达式

- 普通 JSON 字面量和对象/数组递归求值。
- `{literal:JSON}` 原样返回数据，里面的 ref/op 不解释。
- `{ref:"args.name"}`、`{ref:"steps.inspect.output.changed"}`、`{ref:"steps.inspect.status"}` 读取明确字段。
- `{op:"eq",args:[left,right]}` 使用受支持算子。

支持 eq、ne、lt、lte、gt、gte、and、or、not、add、sub、mul、div、concat、get、coalesce、length。not/length 需要一个参数；比较、sub/div/get 两个；其余至少一个。and/or 短路，coalesce 只跳过 null，不吞掉缺失引用错误。比较只接受同类数字或字符串，算术只接受数字，除零或非有限结果失败。

分支、并行、map、repeat 和 try 内部节点输出不能被容器外直接读取；外部读取 `steps.<container>.output`。禁止前向、自引用与跨分支读取；只读取已提交值。item/key/iteration/error 受词法作用域限制。原型键、eval、隐藏 I/O、函数和非 JSON 数据均拒绝。

定义上限为 512 KiB、500 个节点、24 层结构；表达式有深度和项数上限；每个 repeat 最多 1000 轮，并发最多 32。Run 另有总实例、活动调用、时间和 Token 限制。Token 总量包含原生工具与上下文输入，复杂任务不宜设置过低预算。

## 读取、过程与控制

| 工具 | 参数要点与返回 |
| --- | --- |
| workflow_get_capabilities | {}；当前连接能力与版本 |
| workflow_get_projects | {}；真实宿主项目归属 |
| workflow_list_runs | projectPath?、offset?、limit?；{runs} |
| workflow_get_run | id、scopeInstanceId?；{run,projection} |
| workflow_get_node_process | id、instanceId、attemptId?、detail=brief/developer；{process} |
| workflow_get_events | id、after?、limit?；{events} |
| workflow_get_checkpoints | id；{checkpoints} |
| workflow_pause / workflow_stop | id、最新 revision；{run} |
| workflow_preview_recovery | id、revision、instanceId?；fingerprint/canResume/blockers |
| workflow_resume | id、revision、recoveryFingerprint；{run} |
| workflow_retry_node | id、revision、instanceId、recoveryFingerprint；{run} |
| workflow_resolve_wait | id、revision、instanceId、value；{run} |
| workflow_preview_unknown | id、instanceId；fingerprint 与核对要求 |
| workflow_resolve_unknown | id、revision、instanceId、resolution、fingerprint、evidence，completed 可传 output |
| workflow_review | id、revision；{run}，包含差异指纹 |
| workflow_apply | id、revision、fingerprint；{run} |
| workflow_preview_deletion | kind=run/definition、id、revision；fingerprint 与范围 |
| workflow_delete | 相同目标与最新 fingerprint |

恢复前先检查 canResume；明确重试节点时，恢复预览和 retry_node 使用同一个 instanceId。unknown 不能靠普通 resume 清除；需要实际检查效果、记录 evidence，再按预览指纹确认 completed 或可安全 retry。等待输入通过 resolve_wait 提供，之后另行检查恢复。

全局默认模型由 `workflow_get_execution_settings({projectPath})` 和 `workflow_update_execution_settings({projectPath,revision,model?,reasoningEffort?})` 管理。agent 明确覆盖时写在定义节点本身；已开始的 Run 保持自己的快照。更新默认值不会替换已运行实例的模型。

scopeInstanceId 必须是真实实例 ID；repeat/map 可选其独立 scope 实例，查看该轮/该项所有子节点。subflow/expand 局部 id 通过 frame 隔离，不能拿显示图中的 namespace ID 当作 instanceId。未观察的路径保持 planned；active 实例不能因后来一轮结果变灰。

workflow_get_run 的实例列表是控制状态摘要，不包含节点完整输出。核对结果时，用 workflow_get_node_process 的 instanceId 和可选 attemptId 单独读取；detail=developer 返回原始 JSON 输出（单份最多 512 KiB），brief 提供有界摘要。不要把显示摘要或被省略字段当作实际业务输出。

## 存储和删除边界

默认根目录为系统主目录下的 `.local/state/codex-workflows`，或 WORKFLOWS_DATA_DIR。新格式保存在 `structured-v1/workflows.sqlite` 和同版本运行自有目录。旧 JSON 不加载、不迁移、不自动删除。SQLite 提交不保证任意外部系统恰好执行一次；不确定的副作用必须单独核对。

删除定义包含其全部 revision 和准确关联运行；不能按相同标题猜关联。活跃、尚未退出或 unknown 写活动会阻止删除。原项目、已交付改动与用户配置不属于运行自有数据。local 的停止或删除不回滚已生效修改。删除失败按实际剩余对象处理，不声称清理成功。
