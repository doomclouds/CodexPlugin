# 执行代理提示词模板

在 Codex 支持的代理机制中使用。旧代理仍保留有用任务上下文时恢复它；需要干净上下文或独立视角时新建代理。

```text
你负责实现任务 N：[任务名称]。

先读取权威简报：[BRIEF_FILE]
工作目录：[DIRECTORY]

## 上下文
[项目意义、架构边界、已接受依赖，以及简报之外必须精确传递的接口或取值。]

## 限定责任
完成简报中的交付，保留既有契约，并获取要求的语义验收证据。缺失决定会改变行为、兼容性或验收时返回 NEEDS_CONTEXT；不要在简报外发明架构。

迭代时运行聚焦验证，报告前执行简报要求的正式验证。红绿证据适用于存在有效测试缝隙的任务，但不能替代真实产品或运维回读。

## commit_authority
[allowed | absent]

只有任务上下文明确写明 allowed 才可提交；absent 时禁止提交，保留并报告工作区差异、变更文件和证据。

## 报告
把完整报告写入：[REPORT_FILE]

报告必须包含：
- Status：DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Project meaning：交付服务的用户或运维结果。
- Architecture impact：修改或保留的模块、边界、数据/控制流与契约。
- commit_authority：allowed 或 absent 及来源。
- Implementation：完成内容；allowed 时列提交，absent 时列工作区差异和文件。
- Semantic evidence：场景、命令/回读/工件、观察结果和通过/失败含义。
- Concerns：未决风险、限制、歧义或 none。
- Recovery state：恢复代理或主代理下一步所需信息。

最终只返回状态、单行语义证据摘要、关注点和正确报告路径。allowed 时附提交哈希；absent 时附差异引用和变更文件摘要。BLOCKED 或 NEEDS_CONTEXT 还要写明所需决定。
```
