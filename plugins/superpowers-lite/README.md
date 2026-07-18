# Superpowers Lite（Codex 中文版）

Superpowers Lite 是一组仅面向 **Codex CLI/App** 的中文工程工作流技能。它保留
Superpowers 中对设计、调试、测试、计划、评审和交付有价值的约束，同时按任务风险
与规模加载流程，减少小改动被机械展开成重型仪式的问题。

当前版本只交付 Codex 插件清单、图标和技能，不包含 hooks、MCP、apps，也不包含
其他平台的适配层。

## 安装

> [!WARNING]
> Superpowers Lite 不能与原版 Superpowers 同时安装。若 Codex 中已经启用原版，
> 请先移除或禁用它，再安装 Lite，并在更新后启动一个新任务。

从仓库源码安装时，先添加仓库 marketplace，再安装其中的插件：

```powershell
codex plugin marketplace add <仓库根目录>
codex plugin add superpowers-lite@superpowers-lite
```

第二个 `superpowers-lite` 是 `.agents/plugins/marketplace.json` 中声明的 marketplace
名称。插件安装后可直接描述任务；`using-superpowers` 会先判断风险与规模，再选择真正
匹配的技能。

rootless 发布归档不包含 `.agents/plugins/marketplace.json`，因此不能直接作为 marketplace 根目录，
也不会因为复制到某个 `plugins/` 目录就被 Codex 自动发现。该归档用于发布、审计和下游
marketplace 组装；直接安装请使用包含 marketplace 清单的仓库源码并执行上述两条命令。

## 本地验证

在仓库根目录运行：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
npm --prefix .\plugins\superpowers-lite test
& 'C:\Program Files\Git\bin\bash.exe' .\plugins\superpowers-lite\tests\codex\test-runtime-scripts.sh
& 'C:\Program Files\Git\bin\bash.exe' .\plugins\superpowers-lite\tests\codex\test-package-codex-plugin.sh
```

生成默认的 rootless ZIP 包：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' .\plugins\superpowers-lite\scripts\package-codex-plugin.sh
```

默认产物写入仓库外的 `../_tmp/superpowers-lite-packaging/`。归档根层只包含：

```text
.codex-plugin/
assets/
skills/
README.md
LICENSE
```

也可以用 `--format tar.gz` 生成 `tar.gz`，或用 `--output <路径>` 指定输出位置。
脚本默认从已提交的 `HEAD` 打包；工作区有未提交变更时会拒绝执行。

## 来源与许可

本项目派生自 [BB-84C/superpowers-lite](https://github.com/BB-84C/superpowers-lite)，
该项目又派生自 [obra/superpowers](https://github.com/obra/superpowers)。感谢原作者和
贡献者建立并演进这套工程工作流。

代码继续采用 **MIT** 许可证。完整授权文本及原版权声明见 [LICENSE](LICENSE)。

## 贡献与安全

- 贡献规则见 [CONTRIBUTING.md](https://github.com/doomclouds/Ambition/blob/main/plugins/superpowers-lite/CONTRIBUTING.md)。
- 安全边界和漏洞报告方式见 [SECURITY.md](https://github.com/doomclouds/Ambition/blob/main/plugins/superpowers-lite/SECURITY.md)。
