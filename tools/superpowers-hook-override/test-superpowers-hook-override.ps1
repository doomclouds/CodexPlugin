[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$toolRoot = $PSScriptRoot
$applyScript = Join-Path $toolRoot 'apply-superpowers-codex-hook-override.ps1'
$canonicalCodexHooks = Join-Path $toolRoot 'hooks-codex.json'
$canonicalSessionStart = Join-Path $toolRoot 'session-start-codex'
$canonicalWindowsLauncher = Join-Path $toolRoot 'run-codex-session-start.cmd'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('superpowers-hook-override-test-' + [guid]::NewGuid().ToString('N'))
$originalUserProfile = $env:USERPROFILE

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
    Assert-True (Test-Path -LiteralPath $canonicalCodexHooks -PathType Leaf) 'canonical Codex hook config must exist'
    Assert-True (Test-Path -LiteralPath $canonicalSessionStart -PathType Leaf) 'canonical Codex session-start script must exist'
    Assert-True (Test-Path -LiteralPath $canonicalWindowsLauncher -PathType Leaf) 'canonical Windows launcher must exist'
    $windowsLauncherSource = Get-Content -LiteralPath $canonicalWindowsLauncher -Raw -Encoding utf8
    Assert-True (-not $windowsLauncherSource.Contains('where bash')) 'strict Windows launcher must not fall back to an arbitrary PATH bash executable'
    Assert-True ($windowsLauncherSource.Contains('Git Bash')) 'strict Windows launcher must report the Git Bash requirement'

    $applySource = Get-Content -LiteralPath $applyScript -Raw -Encoding utf8
    $hookCopyIndex = $applySource.IndexOf('Copy-FileAtomically -Source $canonicalHooks -Destination $targetHooks')
    $sessionStartCopyIndex = $applySource.IndexOf('Copy-FileAtomically -Source $canonicalSessionStart -Destination $targetSessionStart')
    $windowsLauncherCopyIndex = $applySource.IndexOf('Copy-FileAtomically -Source $canonicalWindowsLauncher -Destination $targetWindowsLauncher')
    $manifestCommitIndex = $applySource.IndexOf('Write-Utf8Atomically -Path $manifestPath -Content $appliedManifestContent')
    Assert-True (($hookCopyIndex -ge 0) -and ($sessionStartCopyIndex -ge 0) -and ($windowsLauncherCopyIndex -ge 0) -and ($manifestCommitIndex -ge 0)) 'apply script must expose all staged writes'
    Assert-True (($hookCopyIndex -lt $manifestCommitIndex) -and ($sessionStartCopyIndex -lt $manifestCommitIndex) -and ($windowsLauncherCopyIndex -lt $manifestCommitIndex)) 'apply script must install hook prerequisites before committing the manifest pointer'
    Assert-True (($sessionStartCopyIndex -lt $hookCopyIndex) -and ($windowsLauncherCopyIndex -lt $hookCopyIndex)) 'apply script must install hook dependencies before replacing the hook definition'

    $testUserProfile = Join-Path $tempRoot 'user-home'
    $marketplacePluginRoot = Join-Path $tempRoot 'marketplace-superpowers'
    $runtimePluginRoot = Join-Path $testUserProfile '.codex\plugins\cache\superpowers-dev\superpowers\test-version'
    $backupRoot = Join-Path $tempRoot 'backups'
    $originalManifest = '{"name":"superpowers","version":"test-version","hooks":{}}'
    $legacyHooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"legacy"}]}]}}'

    foreach ($pluginRoot in @($marketplacePluginRoot, $runtimePluginRoot)) {
        $hooksRoot = Join-Path $pluginRoot 'hooks'
        $manifestRoot = Join-Path $pluginRoot '.codex-plugin'
        $skillRoot = Join-Path $pluginRoot 'skills\using-superpowers'
        New-Item -ItemType Directory -Path $hooksRoot, $manifestRoot, $skillRoot -Force | Out-Null
        Write-Utf8File (Join-Path $manifestRoot 'plugin.json') $originalManifest
        Write-Utf8File (Join-Path $hooksRoot 'hooks.json') $legacyHooks
        Write-Utf8File (Join-Path $skillRoot 'SKILL.md') '# test skill'
    }

    $env:USERPROFILE = $testUserProfile
    & $applyScript -PluginRoot $marketplacePluginRoot -BackupRoot $backupRoot | Out-Null

    $targetManifest = Join-Path $runtimePluginRoot '.codex-plugin\plugin.json'
    $targetCodexHooks = Join-Path $runtimePluginRoot 'hooks\hooks-codex.json'
    $targetSessionStart = Join-Path $runtimePluginRoot 'hooks\session-start-codex'
    $targetWindowsLauncher = Join-Path $runtimePluginRoot 'hooks\run-codex-session-start.cmd'
    $snapshot = Get-ChildItem -LiteralPath $backupRoot -Directory | Select-Object -First 1
    Assert-True ($null -ne $snapshot) 'application must create one timestamped snapshot directory'
    Assert-True ((Get-Content -LiteralPath (Join-Path $snapshot.FullName 'manifest.original.json') -Raw -Encoding utf8) -eq $originalManifest) 'snapshot must preserve the original manifest'
    Assert-True ((Get-Content -LiteralPath (Join-Path $marketplacePluginRoot '.codex-plugin\plugin.json') -Raw -Encoding utf8) -eq $originalManifest) 'marketplace source manifest must remain unchanged when an active runtime cache exists'
    Assert-True ((Get-FileHash -LiteralPath $targetCodexHooks -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalCodexHooks -Algorithm SHA256).Hash) 'target Codex hook config must equal the canonical override'
    Assert-True ((Get-FileHash -LiteralPath $targetSessionStart -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalSessionStart -Algorithm SHA256).Hash) 'target Codex session-start script must equal the canonical override'
    Assert-True ((Get-FileHash -LiteralPath $targetWindowsLauncher -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalWindowsLauncher -Algorithm SHA256).Hash) 'target Windows launcher must equal the canonical override'
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $snapshot.FullName 'hooks-codex.applied.json') -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalCodexHooks -Algorithm SHA256).Hash) 'snapshot must preserve the applied Codex hook config'
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $snapshot.FullName 'session-start-codex.applied') -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $canonicalSessionStart -Algorithm SHA256).Hash) 'snapshot must preserve the applied Codex session-start script'

    $metadata = Get-Content -LiteralPath (Join-Path $snapshot.FullName 'metadata.json') -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($metadata.schemaVersion -eq 3) 'snapshot metadata must record the Codex restoration schema'
    Assert-True ($metadata.restoresCodexSessionStart -eq $true) 'snapshot metadata must record that Codex SessionStart was restored'
    Assert-True ($metadata.files.hooksCodex.originalExists -eq $false) 'snapshot metadata must record the absent upstream Codex hook config'
    Assert-True ($metadata.files.sessionStartCodex.originalExists -eq $false) 'snapshot metadata must record the absent upstream Codex session-start script'
    Assert-True ($metadata.files.windowsLauncher.originalExists -eq $false) 'snapshot metadata must record the absent strict Windows launcher'

    $manifest = Get-Content -LiteralPath $targetManifest -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($manifest.hooks -eq './hooks/hooks-codex.json') 'manifest must explicitly select the Codex hook config'

    $hookConfig = Get-Content -LiteralPath $targetCodexHooks -Raw -Encoding utf8 | ConvertFrom-Json
    $handler = $hookConfig.hooks.SessionStart[0].hooks[0]
    Assert-True ($hookConfig.hooks.SessionStart[0].matcher -eq 'startup|clear|compact') 'Codex hook must retain the no-resume matcher boundary'
    Assert-True ($handler.command -eq 'sh "$PLUGIN_ROOT/hooks/run-hook.cmd" session-start-codex') 'POSIX command must dispatch the Codex session-start script'
    Assert-True ($handler.commandWindows -eq '& "$env:PLUGIN_ROOT\hooks\run-codex-session-start.cmd"') 'Windows command must use the strict Codex launcher'
    $sessionStartContent = Get-Content -LiteralPath $targetSessionStart -Raw -Encoding utf8
    Assert-True ($sessionStartContent.Contains('"hookSpecificOutput"')) 'Codex session-start script must emit hookSpecificOutput'
    $launcherOutput = & $targetWindowsLauncher 2>&1
    $launcherExitCode = $LASTEXITCODE
    Assert-True ($launcherExitCode -eq 0) 'Windows launcher must return success when Git Bash is available'
    $launcherPayload = ($launcherOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($launcherPayload.hookSpecificOutput.hookEventName -eq 'SessionStart') 'Windows launcher must emit a SessionStart payload'
    Assert-True ($launcherPayload.hookSpecificOutput.additionalContext.Contains('You have superpowers.')) 'Windows launcher payload must inject Superpowers context'

    $noHooksMarketplacePluginRoot = Join-Path $tempRoot 'marketplace-superpowers-no-hooks'
    $noHooksRuntimePluginRoot = Join-Path $testUserProfile '.codex\plugins\cache\superpowers-dev\superpowers\no-hooks-version'
    $noHooksManifest = '{"name":"superpowers","version":"no-hooks-version"}'
    foreach ($pluginRoot in @($noHooksMarketplacePluginRoot, $noHooksRuntimePluginRoot)) {
        $hooksRoot = Join-Path $pluginRoot 'hooks'
        $manifestRoot = Join-Path $pluginRoot '.codex-plugin'
        $skillRoot = Join-Path $pluginRoot 'skills\using-superpowers'
        New-Item -ItemType Directory -Path $hooksRoot, $manifestRoot, $skillRoot -Force | Out-Null
        Write-Utf8File (Join-Path $manifestRoot 'plugin.json') $noHooksManifest
        Write-Utf8File (Join-Path $hooksRoot 'hooks.json') $legacyHooks
        Write-Utf8File (Join-Path $skillRoot 'SKILL.md') '# test skill'
    }
    & $applyScript -PluginRoot $noHooksMarketplacePluginRoot -BackupRoot $backupRoot | Out-Null
    $noHooksTargetManifest = Get-Content -LiteralPath (Join-Path $noHooksRuntimePluginRoot '.codex-plugin\plugin.json') -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($noHooksTargetManifest.hooks -eq './hooks/hooks-codex.json') 'manifest without a hooks property must receive the explicit Codex hook config'

    $wrongRoot = Join-Path $tempRoot 'wrong-plugin'
    $wrongHooksRoot = Join-Path $wrongRoot 'hooks'
    $wrongManifestRoot = Join-Path $wrongRoot '.codex-plugin'
    New-Item -ItemType Directory -Path $wrongHooksRoot, $wrongManifestRoot -Force | Out-Null
    Write-Utf8File (Join-Path $wrongManifestRoot 'plugin.json') '{"name":"not-superpowers","version":"test-version","hooks":{}}'
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
    if ($null -eq $originalUserProfile) {
        Remove-Item Env:USERPROFILE -ErrorAction SilentlyContinue
    } else {
        $env:USERPROFILE = $originalUserProfile
    }
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
    if ((Test-Path -LiteralPath $resolvedTempRoot) -and $resolvedTempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
