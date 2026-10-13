// MCP App hosting probe only. This bridge never calls a worker or mutating tool.
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Workflows prototype", version: "0.1.3" }, {}, { autoResize: true });
app.onhostcontextchanged = context => {
  if (context.theme) applyDocumentTheme(context.theme);
};
app.onteardown = async () => {
  window.dispatchEvent(new Event("workflows-prototype-teardown"));
  return {};
};

app.connect().then(() => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  document.documentElement.dataset.workflowsHostConnected = "true";
}).catch(error => {
  console.error("Workflows prototype host connection failed:", error);
  const notice = document.createElement("div");
  notice.setAttribute("role", "alert");
  notice.textContent = "面板宿主连接失败，请重新打开插件面板。";
  document.body.prepend(notice);
});
