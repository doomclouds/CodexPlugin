import { spawn } from "node:child_process";
import type { WorkerClient, WorkerTask } from "./worker-client.js";

export interface CodexExecWorkerOptions {
  codexBinary?: string;
  cwd: string;
}

export interface CodexExecSpawnOptions {
  args: string[];
  command: string;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
}

export function buildCodexExecSpawnOptions(options: {
  codexBinary?: string;
  platform?: NodeJS.Platform;
}): CodexExecSpawnOptions {
  const codex = options.codexBinary ?? "codex";
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && (!options.codexBinary || isWindowsCommandShim(options.codexBinary))) {
    const command = options.codexBinary ? `${quoteWindowsCommand(options.codexBinary)} exec --json -` : "codex exec --json -";
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command],
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    };
  }

  return {
    command: codex,
    args: ["exec", "--json", "-"],
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  };
}

export class CodexExecWorkerClient implements WorkerClient {
  constructor(private readonly options: CodexExecWorkerOptions) {}

  async run<T = unknown>(task: WorkerTask): Promise<T> {
    const prompt = `${task.prompt}\n\nReturn only valid JSON for schema ${task.schemaName}.`;
    const spawnOptions = buildCodexExecSpawnOptions({ codexBinary: this.options.codexBinary });

    return await new Promise<T>((resolve, reject) => {
      const child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: this.options.cwd,
        shell: spawnOptions.shell,
        stdio: spawnOptions.stdio,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timeout = task.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, task.timeoutMs)
        : undefined;

      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        fn();
      };

      child.stdin.setDefaultEncoding("utf8");
      child.stdin.end(prompt);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        settle(() => {
          if (timedOut) {
            reject(new Error(`Worker timed out: ${task.label}`));
            return;
          }
          reject(error);
        });
      });
      child.on("close", (code) => {
        settle(() => {
          if (timedOut) {
            reject(new Error(`Worker timed out: ${task.label}`));
            return;
          }
          if (code !== 0) {
            reject(new Error(`codex exec failed with code ${code}: ${stderr}`));
            return;
          }
          resolve(parseCodexExecJsonOutput(stdout) as T);
        });
      });
    });
  }
}

export function parseCodexExecJsonOutput(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let latestCandidate: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type?: string; item?: unknown; message?: unknown };
      if (typeof parsed.message === "string") {
        if (looksLikeJsonPayload(parsed.message)) {
          latestCandidate = parsed.message;
        }
        continue;
      }
      if (parsed.item && typeof parsed.item === "object" && "text" in parsed.item) {
        const text = String((parsed.item as { text: unknown }).text);
        if (looksLikeJsonPayload(text)) {
          latestCandidate = text;
        }
      }
    } catch (error) {
      throw new Error(`Invalid JSONL event from codex exec output: ${formatParseError(error)}; line=${line}`);
    }
  }

  if (!latestCandidate) {
    throw new Error("No final message candidate found in codex exec output");
  }

  try {
    return JSON.parse(latestCandidate);
  } catch (error) {
    throw new Error(
      `Latest codex final message candidate was not valid JSON: ${formatParseError(error)}; candidate=${latestCandidate}`,
    );
  }
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isWindowsCommandShim(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}

function quoteWindowsCommand(command: string): string {
  return `"${command}"`;
}
