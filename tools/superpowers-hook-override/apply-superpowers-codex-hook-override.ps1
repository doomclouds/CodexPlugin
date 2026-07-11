[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $PluginRoot,

    [string] $BackupRoot = (Join-Path $env:USERPROFILE '.codex\plugin-overrides\superpowers@superpowers-dev')
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$canonicalHooks = Join-Path $PSScriptRoot 'hooks-codex.json'
$canonicalSessionStart = Join-Path $PSScriptRoot 'session-start-codex'
$canonicalWindowsLauncher = Join-Path $PSScriptRoot 'run-codex-session-start.cmd'
$requestedPluginRoot = [System.IO.Path]::GetFullPath($PluginRoot)
$requestedManifestPath = Join-Path $requestedPluginRoot '.codex-plugin\plugin.json'

function Get-HashOrNull {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-FileAtomically {
    param(
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Destination
    )

    $destinationDirectory = [System.IO.Path]::GetDirectoryName($Destination)
    $temporaryDestination = Join-Path $destinationDirectory ('.' + [System.IO.Path]::GetFileName($Destination) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Copy-Item -LiteralPath $Source -Destination $temporaryDestination -Force
        Move-Item -LiteralPath $temporaryDestination -Destination $Destination -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryDestination) {
            Remove-Item -LiteralPath $temporaryDestination -Force
        }
    }
}

function Write-Utf8Atomically {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Content
    )

    $directory = [System.IO.Path]::GetDirectoryName($Path)
    $temporaryPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Content, $utf8NoBom)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

if (-not (Test-Path -LiteralPath $canonicalHooks -PathType Leaf)) {
    throw "Canonical Codex hook config is missing: $canonicalHooks"
}
if (-not (Test-Path -LiteralPath $canonicalSessionStart -PathType Leaf)) {
    throw "Canonical Codex session-start script is missing: $canonicalSessionStart"
}
if (-not (Test-Path -LiteralPath $canonicalWindowsLauncher -PathType Leaf)) {
    throw "Canonical Windows launcher is missing: $canonicalWindowsLauncher"
}
if (-not (Test-Path -LiteralPath $requestedManifestPath -PathType Leaf)) {
    throw "Expected Superpowers manifest is missing: $requestedManifestPath"
}

$requestedManifestContent = Get-Content -LiteralPath $requestedManifestPath -Raw -Encoding utf8
try {
    $requestedManifest = $requestedManifestContent | ConvertFrom-Json
} catch {
    throw "Cannot parse plugin manifest as UTF-8 JSON: $requestedManifestPath"
}
if ($requestedManifest.name -ne 'superpowers') {
    throw "Expected plugin manifest name 'superpowers', got '$($requestedManifest.name)'."
}

$version = [string]$requestedManifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    $version = 'unknown-version'
}
$runtimeCacheCandidate = Join-Path (Join-Path $env:USERPROFILE '.codex\plugins\cache\superpowers-dev\superpowers') $version
$resolvedPluginRoot = $requestedPluginRoot
$runtimeCacheSelected = $false
if (Test-Path -LiteralPath (Join-Path $runtimeCacheCandidate '.codex-plugin\plugin.json') -PathType Leaf) {
    try {
        $runtimeManifest = Get-Content -LiteralPath (Join-Path $runtimeCacheCandidate '.codex-plugin\plugin.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if (($runtimeManifest.name -eq 'superpowers') -and ([string]$runtimeManifest.version -eq $version)) {
            $resolvedPluginRoot = [System.IO.Path]::GetFullPath($runtimeCacheCandidate)
            $runtimeCacheSelected = $true
        }
    } catch {
        # Fall back to the requested root when the cache candidate is malformed.
    }
}

$manifestPath = Join-Path $resolvedPluginRoot '.codex-plugin\plugin.json'
$hooksDirectory = Join-Path $resolvedPluginRoot 'hooks'
$targetHooks = Join-Path $hooksDirectory 'hooks-codex.json'
$targetSessionStart = Join-Path $hooksDirectory 'session-start-codex'
$targetWindowsLauncher = Join-Path $hooksDirectory 'run-codex-session-start.cmd'
if (-not (Test-Path -LiteralPath $hooksDirectory -PathType Container)) {
    throw "Expected Superpowers hooks directory is missing: $hooksDirectory"
}

$originalManifestContent = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8
try {
    $manifest = $originalManifestContent | ConvertFrom-Json
} catch {
    throw "Cannot parse selected plugin manifest as UTF-8 JSON: $manifestPath"
}
if ($manifest.name -ne 'superpowers') {
    throw "Expected selected plugin manifest name 'superpowers', got '$($manifest.name)'."
}
$safeVersion = $version -replace '[^A-Za-z0-9._-]', '_'
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$snapshotRoot = Join-Path $resolvedBackupRoot "$safeVersion-$timestamp"
$suffix = 1
while (Test-Path -LiteralPath $snapshotRoot) {
    $snapshotRoot = Join-Path $resolvedBackupRoot "$safeVersion-$timestamp-$suffix"
    $suffix++
}
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null

$originalManifestSnapshot = Join-Path $snapshotRoot 'manifest.original.json'
$appliedManifestSnapshot = Join-Path $snapshotRoot 'manifest.applied.json'
$originalHooksSnapshot = Join-Path $snapshotRoot 'hooks-codex.original.json'
$appliedHooksSnapshot = Join-Path $snapshotRoot 'hooks-codex.applied.json'
$originalSessionStartSnapshot = Join-Path $snapshotRoot 'session-start-codex.original'
$appliedSessionStartSnapshot = Join-Path $snapshotRoot 'session-start-codex.applied'
$originalWindowsLauncherSnapshot = Join-Path $snapshotRoot 'run-codex-session-start.original.cmd'
$appliedWindowsLauncherSnapshot = Join-Path $snapshotRoot 'run-codex-session-start.applied.cmd'

Copy-Item -LiteralPath $manifestPath -Destination $originalManifestSnapshot -Force
$originalHooksExists = Test-Path -LiteralPath $targetHooks -PathType Leaf
$originalSessionStartExists = Test-Path -LiteralPath $targetSessionStart -PathType Leaf
$originalWindowsLauncherExists = Test-Path -LiteralPath $targetWindowsLauncher -PathType Leaf
if ($originalHooksExists) {
    Copy-Item -LiteralPath $targetHooks -Destination $originalHooksSnapshot -Force
}
if ($originalSessionStartExists) {
    Copy-Item -LiteralPath $targetSessionStart -Destination $originalSessionStartSnapshot -Force
}
if ($originalWindowsLauncherExists) {
    Copy-Item -LiteralPath $targetWindowsLauncher -Destination $originalWindowsLauncherSnapshot -Force
}

$hooksProperty = $manifest.PSObject.Properties['hooks']
if ($null -eq $hooksProperty) {
    $manifest | Add-Member -NotePropertyName hooks -NotePropertyValue './hooks/hooks-codex.json'
} else {
    $hooksProperty.Value = './hooks/hooks-codex.json'
}
$appliedManifestContent = $manifest | ConvertTo-Json -Depth 20
Write-Utf8Atomically -Path $appliedManifestSnapshot -Content $appliedManifestContent
Copy-Item -LiteralPath $canonicalHooks -Destination $appliedHooksSnapshot -Force
Copy-Item -LiteralPath $canonicalSessionStart -Destination $appliedSessionStartSnapshot -Force
Copy-Item -LiteralPath $canonicalWindowsLauncher -Destination $appliedWindowsLauncherSnapshot -Force

Copy-FileAtomically -Source $canonicalSessionStart -Destination $targetSessionStart
Copy-FileAtomically -Source $canonicalWindowsLauncher -Destination $targetWindowsLauncher
Copy-FileAtomically -Source $canonicalHooks -Destination $targetHooks
Write-Utf8Atomically -Path $manifestPath -Content $appliedManifestContent

$metadata = [ordered]@{
    schemaVersion = 3
    appliedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    pluginName = $manifest.name
    pluginVersion = $version
    requestedPluginRoot = $requestedPluginRoot
    pluginRoot = $resolvedPluginRoot
    runtimeCacheSelected = $runtimeCacheSelected
    restoresCodexSessionStart = $true
    restartRequired = $true
    trustReviewRequired = $true
    files = [ordered]@{
        manifest = [ordered]@{
            relativePath = '.codex-plugin/plugin.json'
            originalExists = $true
            originalSha256 = Get-HashOrNull $originalManifestSnapshot
            appliedSha256 = Get-HashOrNull $appliedManifestSnapshot
        }
        hooksCodex = [ordered]@{
            relativePath = 'hooks/hooks-codex.json'
            originalExists = $originalHooksExists
            originalSha256 = Get-HashOrNull $originalHooksSnapshot
            appliedSha256 = Get-HashOrNull $appliedHooksSnapshot
        }
        sessionStartCodex = [ordered]@{
            relativePath = 'hooks/session-start-codex'
            originalExists = $originalSessionStartExists
            originalSha256 = Get-HashOrNull $originalSessionStartSnapshot
            appliedSha256 = Get-HashOrNull $appliedSessionStartSnapshot
        }
        windowsLauncher = [ordered]@{
            relativePath = 'hooks/run-codex-session-start.cmd'
            originalExists = $originalWindowsLauncherExists
            originalSha256 = Get-HashOrNull $originalWindowsLauncherSnapshot
            appliedSha256 = Get-HashOrNull $appliedWindowsLauncherSnapshot
        }
    }
}
$metadataPath = Join-Path $snapshotRoot 'metadata.json'
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 8), $utf8NoBom)

[pscustomobject]@{
    requestedPluginRoot = $requestedPluginRoot
    pluginRoot = $resolvedPluginRoot
    pluginVersion = $version
    runtimeCacheSelected = $runtimeCacheSelected
    manifest = $manifestPath
    hookConfig = $targetHooks
    sessionStart = $targetSessionStart
    windowsLauncher = $targetWindowsLauncher
    originalBackup = $snapshotRoot
    metadata = $metadataPath
    restartRequired = $true
    trustReviewRequired = $true
} | ConvertTo-Json -Depth 4
