---
name: using-git-worktrees
description: Use when 隔离开发可能实质改善并发、风险控制或工作区生命周期。
---

# 使用 Git Worktree

## 先从上下文决定

先检查用户直接指令、仓库指令和持久偏好；已有明确选择就执行，不重新开启争论。共享技能不得硬编码某个用户的本地仓库策略。

只有并发工作、风险重构、受保护检出或 Codex 管理的工作区生命周期使**隔离会实质改变工作流**时，才询问或创建隔离。计划本身不自动要求 worktree；隔离没有净收益的边界修改可在当前检出中完成。

## 检测现有隔离

创建任何内容前先运行跨平台 Git 命令：

```console
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git worktree list --porcelain
```

在非 submodule 检出中，Git 目录与公共 Git 目录不同通常表示 linked worktree。记录当前路径、分支或 detached 状态；发现已有隔离就复用，禁止嵌套创建。这一步是**检测现有隔离**，不能只凭目录名猜。

## 创建隔离

Codex 或当前运行环境提供**原生 worktree 工具**时优先使用，因为它还管理工作区生命周期、分支状态与清理。没有原生能力且上下文已授权手动 worktree 时：

1. 遵循明确目录偏好；否则复用项目根目录已有的 `.worktrees/` 或 `worktrees/`，都不存在时提议 `.worktrees/`。
2. 对最终选定路径检查忽略规则，不能用相邻目录的结果代替：

   ```console
   git check-ignore -q .worktrees
   ```

3. 未被忽略时停止，说明需要的仓库状态变更；不得静默污染版本控制。
4. 获得授权后再创建：

   ```console
   git worktree add .worktrees/feature-name -b codex/feature-name
   ```

运行环境拒绝创建时，报告限制并按已选定的原地工作流继续，不和环境硬刚。

## 基线与安全

只运行与项目和任务风险相称的设置及基线验证。可信基线未失效时可以复用，否则运行能建立起始条件的聚焦命令，并区分既有失败与本次回归。

- 不在现有隔离中嵌套 worktree。
- 有原生生命周期机制时不绕过它。
- 未验证 ignore 安全前不创建项目内 worktree。
- 不把缺失偏好变成反复询问。
- 不把每份计划都当成必须隔离的证据。
