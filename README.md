# Codex Plugin

小陌的 Codex 插件商城仓库，用来集中发布和维护个人/团队可复用插件。

当前包含：

- `figure`: 将图像类图表重建为可编辑 Visio 图形的 Codex 插件。
- `git-workflow`: 清理 stale branches、创建提交、推送并创建 PR 的 Git 工作流插件。
- `superpowers-asset-compounding`: 将完成的需求、调试经验和复用线索沉淀为仓库内 Superpowers 资产的 Codex 插件。

暂时不用的插件放在 `deprecated-plugins/`，不会出现在当前 marketplace 中。

## 安装商城

```powershell
codex plugin marketplace add doomclouds/CodexPlugin --ref main
codex plugin marketplace list
```

安装插件：

```powershell
codex plugin add figure@codex-plugin
codex plugin add git-workflow@codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin
```

安装或升级后，开启一个新线程再使用插件，确保 Codex 重新加载插件内的 skills、hooks 和工具配置。

## 更新远端商城快照

当 GitHub 仓库更新后，本地 Codex 不会自动热更新远端 Git marketplace snapshot。手动刷新远端 marketplace snapshot：

```powershell
codex plugin marketplace upgrade codex-plugin
codex plugin add figure@codex-plugin
codex plugin add git-workflow@codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin
```

然后开启新线程验证。旧的 `local-home` cache 同步脚本不再作为本仓库发布流程使用。

## 仓库结构

```text
.agents/
  plugins/
    marketplace.json
docs/
  superpowers/
    archives/
    inbox/
    plans/
    problems/
    specs/
deprecated-plugins/
  drawio/
plugins/
  figure/
    .codex-plugin/
      plugin.json
    skills/
  git-workflow/
    .codex-plugin/
      plugin.json
    skills/
  superpowers-asset-compounding/
    .codex-plugin/
      plugin.json
    skills/
    hooks/
    tests/
```

## License

MIT
