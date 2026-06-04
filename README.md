# Codex Plugin

小陌的 Codex 插件商城仓库，用来集中发布和维护个人/团队可复用插件。

当前包含：

- `superpowers-asset-compounding`: 将完成的需求、调试经验和复用线索沉淀为仓库内 Superpowers 资产的 Codex 插件。

## 安装商城

```powershell
codex plugin marketplace add doomclouds/CodexPlugin --ref main
codex plugin marketplace list
```

安装插件：

```powershell
codex plugin add superpowers-asset-compounding@codex-plugin
```

安装或升级后，开启一个新线程再使用插件，确保 Codex 重新加载插件内的 skills、hooks 和工具配置。

## 更新本地商城快照

当 GitHub 仓库更新后，本地 Codex 不会自动热更新插件。手动刷新 Git marketplace snapshot：

```powershell
codex plugin marketplace upgrade codex-plugin
codex plugin add superpowers-asset-compounding@codex-plugin
```

然后开启新线程验证。

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
plugins/
  superpowers-asset-compounding/
    .codex-plugin/
      plugin.json
    skills/
    hooks/
    tests/
```

## License

MIT
