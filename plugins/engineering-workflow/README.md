# 工程协作流

面向中文开发者和强模型的精简工程工作流插件。它不强制所有任务走同一套流程，而是让模型按复杂度选择最小够用的技能，并用验收证据收口。

## 技能

| 技能 | 用途 |
|---|---|
| `clarify` | 澄清会改变方案的关键歧义，维护必要的领域术语和 ADR。 |
| `spec` | 把已讨论清楚的需求整理为紧凑、可验收的规格。 |
| `plan` | 生成单会话计划、垂直切片或大型决策地图。 |
| `build` | 在正确接缝上实现需求，并持续运行最小验证。 |
| `debug` | 通过复现、最小化、假设和回归测试定位根因。 |
| `explore` | 在一手资料研究和一次性原型之间选择最短探索路径。 |
| `review` | 从规格、工程质量、安全与可靠性三轴审查变更。 |
| `verify` | 独立核对验收条件，输出可复现的交付证据。 |

这些技能允许模型自动调用，也可以用 `$clarify`、`$build`、`$debug` 等名称显式调用。

## 推荐组合

- 小修改：`build → review → verify`
- 普通功能：`clarify → spec（按需）→ plan（按需）→ build → review → verify`
- 疑难 Bug：`debug → review → verify`
- 外部事实或方案未知：`explore → spec/plan → build → verify`

规格、Ticket、ADR、研究文档都按需生成。一天内能完成且边界清楚的任务，不应为了使用插件而制造额外资产。

本插件的设计参考了 [mattpocock/skills 的 engineering 合集](https://github.com/mattpocock/skills/tree/main/skills/engineering)，但重新收敛为八个中文入口，并移除了对特定 Issue Tracker、Claude 子代理和后台代理的强绑定。
