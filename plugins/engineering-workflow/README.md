# Engineering Workflow

面向中文开发者和强模型的精简工程工作流插件。模型自行选择最小技能组合，插件只统一任务边界、仓库记忆和完成证据。

## 技能

| 类型 | 技能 | 用途 |
|---|---|---|
| 工作流 | `clarify` | 澄清会改变方案的关键歧义，维护必要的领域术语和 ADR。 |
| 工作流 | `plan` | 把复杂任务整理为验收条件、执行切片、进度和下一步。 |
| 工作流 | `build` | 在合适位置实现需求，并持续运行相关验证。 |
| 方法 | `tdd` | 用 RED、GREEN、REFACTOR 循环逐个实现可观察行为。 |
| 工作流 | `debug` | 通过复现、最小化、假设和回归测试定位根因。 |
| 工作流 | `explore` | 在一手资料研究和一次性原型之间选择最短探索路径。 |
| 工作流 | `review` | 检查需求实现、代码质量、安全和稳定性。 |
| 工作流 | `verify` | 独立核对验收条件，输出可复现的交付证据。 |

七个工作流技能加一个可选的 TDD 实现方法，允许模型自动调用，也可以显式使用 `$clarify`、`$plan`、`$tdd` 等名称。没有总路由器：强模型根据技能元数据选择最小链路。

`tdd` 不是 `plan → tdd → build` 中间的强制阶段。同一行为切片由 `build` 或 `tdd` 之一负责，不重复选择。用户明确要求测试先行时可以直接用 `$tdd` 完成实现；普通 `$build` 遇到核心规则、算法、状态机、解析、并发或高风险错误处理时也会遵循同一方法。文案、机械映射、生成代码和一次性原型不强制 TDD。

所有技能遵循同一份[项目连续性契约](references/continuity-contract.md)。单会话小任务不创建文档；已有仓库约定优先，没有约定的复杂任务默认只维护：

- `docs/domain/CONTEXT.MAP.md`：多领域导航；
- `docs/domain/<domain>/CONTEXT.md`：各领域的稳定语言；
- `docs/tasks/YYYY/MM/<slug>.md`：目标、`AC-*`、边界、计划、进度、证据、风险和下一步；
- `docs/adr/YYYY/MM/` / `docs/research/YYYY/MM/`：只在决定难逆或证据较长、可复用时拆分。

年月取资产创建时间；后续始终原地更新，不按当前月份搬文件。

仓库已有 Spec、Plan、Handoff 结构时原地维护，不强制迁移；但必须明确唯一任务状态来源，避免多份文档漂移。

新建资产使用 [`assets/templates/`](assets/templates/) 中的领域地图、领域上下文和任务模板。

## 推荐组合

- 小修改：`build → verify（按需）`
- 普通功能：`clarify（按需）→ plan（按需）→ build → review → verify`
- 核心逻辑或明确要求 TDD：`plan（按需）→ tdd → review → verify`
- 领域或架构未定：`clarify/explore → plan → build → review → verify`
- 疑难 Bug：`debug → tdd（适用时）→ review → verify`
- 外部事实或方案未知：`explore → plan（按需）→ build → verify`
- 跨会话暂停或恢复：任一技能更新任务文档的状态、证据和下一步

`review` 不是每个小修改的固定仪式；用户要求审查、发布门禁要求审查，或改动的安全与稳定性风险值得独立查看时再加入。

规格、Ticket、ADR、研究文档都按需生成。一天内能完成且边界清楚的任务，不应为了使用插件而制造额外资产。

## 验证

先按仓库根目录的 `requirements-dev.txt` 准备 Python 环境。静态测试会检查插件结构、YAML 元数据、连续性契约、路由用例以及评测器自身：

```bash
.venv/bin/python -m unittest discover -s plugins/engineering-workflow/tests -p 'test_*.py'
```

`evals/cases.json` 保存 20 个正反路由用例。评测只向独立 `codex exec` 上下文暴露七个工作流技能和一个 TDD 方法的元数据，检查最小技能组合、顺序、完整跳过集合和任务契约边界：

```bash
.venv/bin/python plugins/engineering-workflow/evals/run_cli_evals.py
```

每次评测都会启动新的临时会话，并把 Codex 的可写状态隔离到临时目录；只复用当前环境的认证和模型缓存，不读取主会话历史，也不会把临时工作区写入全局 `~/.codex/config.toml`。

发布前可重复执行高风险用例，并保存 JSON 报告。重复运行保持串行，避免多个 Codex 进程争用资源导致假超时：

```bash
.venv/bin/python plugins/engineering-workflow/evals/run_cli_evals.py \
  --repeat 3 --min-pass-rate 1.0 --json-report /tmp/engineering-routing.json

```

本插件的设计参考了 [mattpocock/skills 的 engineering 合集](https://github.com/mattpocock/skills/tree/main/skills/engineering)，但收敛为七个工作流入口、一个可选 TDD 方法和一个共享连续性契约，不绑定特定 Issue Tracker、固定报告或代理实现。
