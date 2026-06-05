export function resolveWorkspaceRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}
