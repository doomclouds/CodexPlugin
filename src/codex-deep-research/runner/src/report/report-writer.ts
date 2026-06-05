import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReportInput {
  outputDir: string;
  question: string;
  summary: string;
  findings: string[];
  sources: Array<{ id: string; title: string; urlOrPath: string }>;
}

export async function writeReports(input: ReportInput): Promise<{ reportPath: string; summaryPath: string; sourcesPath: string }> {
  const reportPath = join(input.outputDir, "report.md");
  const summaryPath = join(input.outputDir, "report.summary.md");
  const sourcesPath = join(input.outputDir, "report.sources.md");
  const findings = input.findings.length > 0
    ? input.findings.map((finding, index) => `### ${index + 1}. Finding\n\n${finding}`).join("\n\n")
    : "_No findings were produced by this v0 run._";
  const sources = formatSources(input.sources);

  const report = `# ${input.question}\n\n## 摘要\n\n${input.summary}\n\n## 关键发现\n\n${findings}\n\n## 来源\n\n${sources}\n`;

  await writeFile(reportPath, report, "utf8");
  await writeFile(summaryPath, input.summary + "\n", "utf8");
  await writeFile(sourcesPath, sources + "\n", "utf8");

  return { reportPath, summaryPath, sourcesPath };
}

function formatSources(sources: ReportInput["sources"]): string {
  if (sources.length === 0) {
    return "_No sources were collected by this v0 run._";
  }

  return sources.map((source) => `- [${source.id}] ${source.title}: ${source.urlOrPath}`).join("\n");
}
