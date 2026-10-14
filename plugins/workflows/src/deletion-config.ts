import { ProtocolSession } from "./adapter.ts";
import { stat } from "node:fs/promises";

// Read through Codex's public configuration protocol; never return configuration
// bytes to a deletion caller or overwrite the user's complete configuration.
export async function readDeletionConfig(projectPaths: string[] = []): Promise<Record<string, unknown>> {
  const session = new ProtocolSession(process.env.WORKFLOWS_CODEX_COMMAND ?? "codex", ["app-server", "--disable", "plugins", "--disable", "apps", "--disable", "remote_plugin"], process.cwd(), 15000, 5000, () => {});
  try {
    await session.request("initialize", { clientInfo: { name: "workflows_deletion_preflight", version: "0.5.4" }, capabilities: { experimentalApi: true } });
    session.send({ method: "initialized", params: {} });
    const scopes: Array<{ cwd: string; mcp_servers: unknown }> = [];
    for (const cwd of [undefined, ...new Set(projectPaths)].slice(0, 101)) {
      if (cwd) { try { if (!(await stat(cwd)).isDirectory()) continue; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; } }
      const result = await session.request("config/read", { includeLayers: true, ...(cwd ? { cwd } : {}) });
      if (!result || typeof result !== "object" || !(result as Record<string, unknown>).config || typeof (result as Record<string, unknown>).config !== "object") throw new Error("Cannot inspect the effective Codex configuration for retained workflow references");
      const config = (result as { config: Record<string, unknown> }).config;
      const map = config.mcp_servers;
      scopes.push({ cwd: cwd ?? process.cwd(), mcp_servers: map && typeof map === "object" && !Array.isArray(map) ? map : {} });
    }
    if (new Set(projectPaths).size > 100) throw new Error("Too many project configuration scopes to verify; cannot confirm deletion references");
    return { scopes };
  } finally { await session.close(); }
}
