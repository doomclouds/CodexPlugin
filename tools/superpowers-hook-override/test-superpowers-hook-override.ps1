[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$toolRoot = $PSScriptRoot
$applyScript = Join-Path $toolRoot 'apply-superpowers-codex-hook-override.ps1'
$canonicalHooks = Join-Path $toolRoot 'hooks.json'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('superpowers-hook-override-test-' + [guid]::NewGuid().ToString('N'))

function Assert-True {
    param(
        [Parameter(Mandatory)] [bool] $Condition,
        [Parameter(Mandatory)] [string] $Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

try {
    Assert-True (Test-Path -LiteralPath $applyScript -PathType Leaf) 'override apply script must exist'
    Assert-True (Test-Path -LiteralPath $canonicalHooks -PathType Leaf) 'canonical hooks.json must exist'

    $pluginRoot = Join-Path $tempRoot 'superpowers'
    $hooksRoot = Join-Path $pluginRoot 'hooks'
    $manifestRoot = Join-Path $pluginRoot '.codex-plugin'
    $backupRoot = Join-Path $tempRoot 'backups'
    New-Item -ItemType Directory -Path $hooksRoot, $manifestRoot -Force | Out-Null
    Write-Utf8File (Join-Path $manifestRoot 'plugin.json') '{"name":"superpowers","version":"test-version"}'
    $legacyHooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"legacy"}]}]}}'
    Write-Utf8File (Join-Path $hooksRoot 'hooks.json') $legacyHooks

    & $applyScript -PluginRoot $pluginRoot -BackupRoot $backupRoot | Out-Null

    $targetHooks = Join-Path $hooksRoot 'hooks.json'
    $snapshot = Get-ChildItem -LiteralPath $backupRoot -Directory | Select-Object -First 1
    Assert-True ($null -ne $snapshot) 'application must create one timestamped snapshot directory'
    Assert-True ((Get-Content -LiteralPath (Join-Path $snapshot.FullName 'hooks.original.json') -Raw -Encoding utf8) -eq $legacyHooks) 'snapshot must preserve the original hooks file'
    Assert-True ((Get-FileHash -LiteralPath $targetHooks -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalHooks -Algorithm SHA256).Hash) 'target hooks file must equal canonical override'
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $snapshot.FullName 'hooks.applied.json') -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalHooks -Algorithm SHA256).Hash) 'snapshot must preserve the applied override'

    $hookConfig = Get-Content -LiteralPath $targetHooks -Raw -Encoding utf8 | ConvertFrom-Json
    $handler = $hookConfig.hooks.SessionStart[0].hooks[0]
    Assert-True ($handler.command -eq 'sh "$PLUGIN_ROOT/hooks/run-hook.cmd" session-start') 'POSIX command must expand PLUGIN_ROOT in sh'
    Assert-True ($handler.commandWindows -eq '& "$env:PLUGIN_ROOT\hooks\run-hook.cmd" session-start') 'Windows command must use the Codex PLUGIN_ROOT environment variable'

    $wrongRoot = Join-Path $tempRoot 'wrong-plugin'
    $wrongHooksRoot = Join-Path $wrongRoot 'hooks'
    $wrongManifestRoot = Join-Path $wrongRoot '.codex-plugin'
    New-Item -ItemType Directory -Path $wrongHooksRoot, $wrongManifestRoot -Force | Out-Null
    Write-Utf8File (Join-Path $wrongManifestRoot 'plugin.json') '{"name":"not-superpowers","version":"test-version"}'
    Write-Utf8File (Join-Path $wrongHooksRoot 'hooks.json') $legacyHooks
    $wrongTargetRejected = $false
    try {
        & $applyScript -PluginRoot $wrongRoot -BackupRoot $backupRoot | Out-Null
    } catch {
        $wrongTargetRejected = $true
    }
    Assert-True $wrongTargetRejected 'script must reject a non-superpowers plugin root'

    Write-Output 'PASS: Superpowers Codex hook override snapshot and replacement behavior verified.'
} finally {
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
    if ((Test-Path -LiteralPath $resolvedTempRoot) -and $resolvedTempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
