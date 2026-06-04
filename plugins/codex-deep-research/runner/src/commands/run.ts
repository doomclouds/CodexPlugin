import { RunStore } from "../runtime/run-store.js";
import { CodexExecWorkerClient } from "../workers/codex-exec-worker.js";
import { runDeepResearch } from "../workflow/deep-research.workflow.js";

export async function runCommand(runId: string): Promise<void> {
  const store = new RunStore(process.cwd());
  const manifest = await store.readManifest(runId);
  const worker = new CodexExecWorkerClient({ cwd: manifest.workspace });
  await runDeepResearch({ manifest, store, worker });
}
