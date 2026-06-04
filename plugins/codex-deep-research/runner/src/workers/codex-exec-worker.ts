import { spawn } from "node:child_process";
import type { WorkerClient, WorkerTask } from "./worker-client.js";

export interface CodexExecWorkerOptions {
  codexBinary?: string;
  cwd: string;
}

export class CodexExecWorkerClient implements WorkerClient {
  constructor(private readonly options: CodexExecWorkerOptions) {}

  async run<T = unknown>(task: WorkerTask): Promise<T> {
    const codex = this.options.codexBinary ?? "codex";
    const prompt = `${task.prompt}\n\nReturn only valid JSON for schema ${task.schemaName}.`;

    return await new Promise<T>((resolve, reject) => {
      const child = spawn(codex, ["exec", "--json", prompt], {
        cwd: this.options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      const timeout = task.timeoutMs
        ? setTimeout(() => {
            child.kill();
            reject(new Error(`Worker timed out: ${task.label}`));
          }, task.timeoutMs)
        : undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (code !== 0) {
          reject(new Error(`codex exec failed with code ${code}: ${stderr}`));
          return;
        }
        resolve(parseLastJsonObject(stdout) as T);
      });
    });
  }
}

function parseLastJsonObject(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as { type?: string; item?: unknown; message?: unknown };
      if (typeof parsed.message === "string") {
        return JSON.parse(parsed.message);
      }
      if (parsed.item && typeof parsed.item === "object" && "text" in parsed.item) {
        return JSON.parse(String((parsed.item as { text: unknown }).text));
      }
    } catch {
      continue;
    }
  }
  throw new Error("No JSON object found in codex exec output");
}
