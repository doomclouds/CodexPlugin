import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);

async function windowsSecurity(script: string, environment: Record<string, string>): Promise<string> {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershellDirectory = path.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0");
  const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const { stdout } = await exec(path.join(powershellDirectory, "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...childEnvironment, PSModulePath: path.join(powershellDirectory, "Modules"), ...environment }, windowsHide: true, timeout: 10000,
  });
  return stdout;
}

/** Only call immediately after allocating this test's unique mkdtemp root. */
export async function preparePrivateFixtureDirectory(directory: string): Promise<void> {
  assert.ok(path.isAbsolute(directory), "Private fixture root must be absolute");
  const entry = await lstat(directory);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "Private fixture root must remain a real non-link directory");
  const canonical = await realpath(directory);
  const relative = path.relative(await realpath(tmpdir()), canonical);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Private fixture root must be within the system temporary directory");
  assert.equal(path.relative(path.resolve(directory), canonical), "", "Private fixture root must not traverse a link");
  if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
  await windowsSecurity(`
$ErrorActionPreference = 'Stop'
$taskDirectory = Get-Item -LiteralPath $env:WORKFLOWS_FIXTURE_DIRECTORY -Force
if (!$taskDirectory.PSIsContainer -or ($taskDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private fixture root changed before ACL initialization' }
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$taskSecurity = [System.Security.AccessControl.DirectorySecurity]::new()
$taskSecurity.SetOwner($taskUser)
$taskSecurity.SetAccessRuleProtection($true, $false)
$taskInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($taskSid in @($taskUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $taskRule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($taskSid), [System.Security.AccessControl.FileSystemRights]::FullControl, $taskInheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $taskSecurity.AddAccessRule($taskRule)
}
Set-Acl -LiteralPath $env:WORKFLOWS_FIXTURE_DIRECTORY -AclObject $taskSecurity
`, { WORKFLOWS_FIXTURE_DIRECTORY: canonical });
}

/** NTFS privacy is an ACL property; Unix mode bits do not establish it on Windows. */
export async function assertPrivateFixtureFile(filename: string): Promise<void> {
  const entry = await lstat(filename);
  assert.ok(entry.isFile() && !entry.isSymbolicLink(), "Private fixture must remain a regular non-link file");
  if (process.platform !== "win32") {
    assert.equal(entry.mode & 0o777, 0o600);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$taskIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskAcl = Get-Acl -LiteralPath $env:WORKFLOWS_FIXTURE_FILE
$taskRules = @($taskAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow; inheritOnly = ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0; rights = [long]$_.FileSystemRights }
})
@{ user = $taskIdentity; owner = $taskAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules = $taskRules } | ConvertTo-Json -Depth 4 -Compress
`;
  const stdout = await windowsSecurity(script, { WORKFLOWS_FIXTURE_FILE: filename });
  const acl = JSON.parse(stdout) as { user: string; owner: string; rules: Array<{ sid: string; allow: boolean; inheritOnly: boolean; rights: number }> };
  assert.equal(acl.owner, acl.user, "Private fixture must be owned by the current user");
  // Windows administrators are trusted here, equivalent to privileged Unix access.
  const trusted = new Set([acl.user, "S-1-5-18", "S-1-5-32-544"]);
  // Include content reads/writes and permission-changing rights, not mere metadata reads.
  const contentOrMutation = 1 | 2 | 4 | 16 | 64 | 256 | 65536 | 262144 | 524288;
  const exposed = acl.rules.filter(rule => rule.allow && !rule.inheritOnly && (rule.rights & contentOrMutation) !== 0 && !trusted.has(rule.sid));
  assert.deepEqual(exposed, [], "Private fixture grants content or mutation access to an untrusted principal");
}
