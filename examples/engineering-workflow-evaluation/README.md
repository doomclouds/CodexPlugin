# Measurement Window

用于验收 `engineering-workflow` 技能组的小型 .NET 10 CLI。它读取按时间排序的 UTC 测量值，并按整秒窗口输出 JSONL 汇总。

## 输入与输出

输入格式为 `timestampUtc,value`：

```text
# timestampUtc,value
2026-07-22T10:00:00.100Z,1
2026-07-22T10:00:00.900Z,3
2026-07-22T10:00:01Z,10
```

输出：

```json
{"windowStartUtc":"2026-07-22T10:00:00+00:00","count":2,"mean":2,"min":1,"max":3}
{"windowStartUtc":"2026-07-22T10:00:01+00:00","count":1,"mean":10,"min":10,"max":10}
```

时间戳必须以 `Z` 结尾，空行和 `#` 注释会被忽略。格式错误、非有限数值或时间乱序会返回非零退出码，并报告行号。

只输出有数据的窗口，不为空窗补零。处理采用流式输出：晚到的坏行不会撤回已经输出的完整窗口，因此调用方必须检查进程退出码。

## 运行

```powershell
dotnet run --project examples/engineering-workflow-evaluation -- input.csv
dotnet run --project examples/engineering-workflow-evaluation -- --self-test
dotnet build examples/engineering-workflow-evaluation -c Release
```

不传文件时从标准输入读取。项目只使用 .NET 标准库，没有外部包。

技能组的实际使用记录与优化建议见 [EVALUATION.md](./EVALUATION.md)。
