/** Keep a stdio runtime scoped to the process that originally launched it. */
export function watchParentExit(onExit: () => void, intervalMs = 1000): () => void {
  const parent = process.ppid;
  if (parent <= 1) return () => {};
  let finished = false;
  const timer = setInterval(() => {
    if (finished) return;
    let alive = true;
    try { process.kill(parent, 0); }
    catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive && (process.platform === "win32" || process.ppid === parent)) return;
    finished = true; clearInterval(timer); onExit();
  }, intervalMs);
  timer.unref();
  return () => { finished = true; clearInterval(timer); };
}
