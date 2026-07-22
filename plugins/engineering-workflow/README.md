# Engineering Workflow

面向中文开发者和强模型的精简工程工作流插件。模型自行选择最小技能组合，插件只统一任务边界、仓库记忆和完成证据。

## 技能

| 技能 | 用途 |
|---|---|
| `clarify` | 澄清会改变方案的关键歧义，维护必要的领域术语和 ADR。 |
| `plan` | 把复杂任务整理为验收条件、执行切片、进度和下一步。 |
| `build` | 在合适位置实现需求，并持续运行相关验证。 |
| `debug` | 通过复现、最小化、假设和回归测试定位根因。 |
| `explore` | 在一手资料研究和一次性原型之间选择最短探索路径。 |
| `review` | 检查需求实现、代码质量、安全和稳定性。 |
| `verify` | 独立核对验收条件，输出可复现的交付证据。 |

七个技能允许模型自动调用，也可以显式使用 `$clarify`、`$plan`、`$build` 等名称。没有总路由器：强模型根据技能元数据选择最小链路。

所有技能遵循同一份[项目连续性契约](references/continuity-contract.md)。单会话小任务不创建文档；已有仓库约定优先，没有约定的复杂任务默认只维护：

- `docs/domain/CONTEXT.MAP.md`：多领域导航；
- `docs/domain/<domain>/CONTEXT.md`：各领域的稳定语言；
- `docs/tasks/YYYY/MM/<slug>.md`：目标、`AC-*`、边界、计划、进度、证据、风险和下一步；
- `docs/adr/YYYY/MM/` / `docs/research/YYYY/MM/`：只在决定难逆或证据较长、可复用时拆分。

年月取资产创建时间；后续始终原地更新，不按当前月份搬文件。

仓库已有 Spec、Plan、Handoff 结构时原地维护，不强制迁移；但必须明确唯一任务状态来源，避免多份文档漂移。

新建资产使用 [`assets/templates/`](assets/templates/) 中的领域地图、领域上下文和任务模板。

## 推荐组合

- 小修改：`build → review → verify`
- 普通功能：`clarify（按需）→ plan（按需）→ build → review → verify`
- 领域或架构未定：`clarify/explore → plan → build → review → verify`
- 疑难 Bug：`debug → review → verify`
- 外部事实或方案未知：`explore → plan（按需）→ build → verify`
- 跨会话暂停或恢复：任一技能更新任务文档的状态、证据和下一步

规格、Ticket、ADR、研究文档都按需生成。一天内能完成且边界清楚的任务，不应为了使用插件而制造额外资产。

## 验证

静态契约测试不依赖第三方包：

```bash
python3 -m unittest discover -s plugins/engineering-workflow/tests -p 'test_*.py'
```

`evals/cases.json` 保存路由用例；评测只向独立 `codex exec` 上下文暴露七个技能的元数据，再让模型读取自己选择的技能，避免用总路由器替模型思考。

```bash
python3 plugins/engineering-workflow/evals/run_cli_evals.py
```

本插件的设计参考了 [mattpocock/skills 的 engineering 合集](https://github.com/mattpocock/skills/tree/main/skills/engineering)，但收敛为七个中文入口和一个共享连续性契约，不绑定特定 Issue Tracker、固定报告或代理实现。
