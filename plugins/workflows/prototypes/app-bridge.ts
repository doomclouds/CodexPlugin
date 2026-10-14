import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { applyPanelHostStyles, mountPanel } from "./panel.js";

const app = new App({ name: "Workflows", version: "0.5.0" }, {}, { autoResize: true });
const root = document.getElementById("workflow-panel-prototype");
if (!root) throw new Error("Workflows panel root is missing");
const panel = mountPanel(root, async (name, args) => app.callServerTool({ name, arguments: args }, { timeout: 120000 }));

function hostContext(context: Record<string, unknown>): void {
  applyPanelHostStyles(context, {
    theme: applyDocumentTheme,
    variables: variables => applyHostStyleVariables(variables as Parameters<typeof applyHostStyleVariables>[0]),
    fonts: applyHostFonts,
  });
}

// Register lifecycle handlers before the handshake so no host event is lost.
app.onhostcontextchanged = hostContext;
app.ontoolinput = input => {
  if (typeof input.arguments?.projectPath === "string") panel.setProjectPath(input.arguments.projectPath);
};
app.ontoolresult = result => panel.receive(result);
app.onteardown = async () => { await panel.teardown(); return {}; };
window.addEventListener("pagehide", () => { void panel.teardown(); });

// A standalone layout preview has no host and never falls back to simulated data.
if (window.parent !== window) {
  panel.connecting();
  app.connect().then(async () => {
    const context = app.getHostContext();
    if (context) hostContext(context);
    document.documentElement.dataset.workflowsHostConnected = "true";
    await panel.connected();
  }).catch(error => panel.disconnected(error));
}
