import type { ToolResponse } from "../prototypes/panel.ts";

export function projectFixtureResponse(projectPath = "/project"): ToolResponse {
  return { structuredContent: { available: true, contextSource: "thread", currentProjectId: "fixture-project", projects: [{ projectId: "fixture-project", label: "Fixture project", path: projectPath, hostId: "local" }] } };
}
