import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The test retains the other end of this socket, so parent death does not
// produce stdin EOF. Only the runtime's parent-lifetime guard can stop it.
const socket = connect(Number(process.argv[2]), "127.0.0.1", () => {
  const failure = process.argv[4] === "cleanup-failure";
  const preload = `import { WorkflowEngine } from ${JSON.stringify(new URL("../../src/engine.ts", import.meta.url).href)}; const close=WorkflowEngine.prototype.close; WorkflowEngine.prototype.close=async function(){await close.call(this);throw new Error("Fixture backend cleanup failed");};`;
  const child = spawn(process.execPath, ["--experimental-strip-types", ...(failure ? ["--import", "data:text/javascript;base64," + Buffer.from(preload).toString("base64")] : []), fileURLToPath(new URL("../../src/index.ts", import.meta.url))], {
    env: { ...process.env, WORKFLOWS_DATA_DIR: process.argv[3] },
    stdio: [socket, socket, "ignore"],
  });
  child.once("error", () => process.exit(1));
  child.once("spawn", () => process.send?.({ event: "spawned", pid: child.pid }));
});
socket.on("error", () => process.exit(1));
