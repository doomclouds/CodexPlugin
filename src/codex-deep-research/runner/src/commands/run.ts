import { RunStore } from "../runtime/run-store.js";
import { CodexExecWorkerClient } from "../workers/codex-exec-worker.js";
import { runDeepResearch } from "../workflow/deep-research.workflow.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export async function runCommand(runId: string): Promise<void> {
  const store = new RunStore(resolveWorkspaceRoot());
  const manifest = await store.readManifest(runId);
  const worker = new CodexExecWorkerClient({ cwd: manifest.workspace });
  await runDeepResearch({ manifest, store, worker });
}
