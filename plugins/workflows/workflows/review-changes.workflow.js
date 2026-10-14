// Executed by the isolated workflow runtime, not as a Node module.
export const meta = {
  name: "review-changes",
  description: "逐文件审查改动，核实发现并汇总",
  phases: [{ title: "审查" }, { title: "核实" }, { title: "汇总" }],
  parameters: [{ name: "files", label: "审查文件", type: "string[]", required: true, description: "逐个审查这些文件的改动。", placeholder: "每行一个相对项目的文件路径", multiline: true }],
};

if (!Array.isArray(args?.files) || args.files.length === 0) {
  throw new Error("args.files 必须是非空文件路径数组");
}

phase("审查");
const findings = await pipeline(
  args.files,
  file => agent(`审查 ${file} 的改动，找出有证据支持的问题。`, { label: file, phase: "审查" }),
  finding => agent(`核实以下发现，排除误报：\n${JSON.stringify(finding)}`, { phase: "核实" }),
);

phase("汇总");
return await agent(`合并、去重并按影响排序：\n${JSON.stringify(findings.filter(Boolean))}`);
