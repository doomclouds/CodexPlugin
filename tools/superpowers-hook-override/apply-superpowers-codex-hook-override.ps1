[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $PluginRoot,

    [string] $BackupRoot = (Join-Path $env:USERPROFILE '.codex\plugin-overrides\superpowers@superpowers-dev')
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$canonicalHooks = Join-Path $PSScriptRoot 'hooks.json'
$resolvedPluginRoot = [System.IO.Path]::GetFullPath($PluginRoot)
$manifestPath = Join-Path $resolvedPluginRoot '.codex-plugin\plugin.json'
$targetHooks = Join-Path $resolvedPluginRoot 'hooks\hooks.json'

if (-not (Test-Path -LiteralPath $canonicalHooks -PathType Leaf)) {
    throw "Canonical hook override is missing: $canonicalHooks"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Expected Superpowers manifest is missing: $manifestPath"
}
if (-not (Test-Path -LiteralPath $targetHooks -PathType Leaf)) {
    throw "Expected Superpowers hook file is missing: $targetHooks"
}

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
} catch {
    throw "Cannot parse plugin manifest as UTF-8 JSON: $manifestPath"
}
if ($manifest.name -ne 'superpowers') {
    throw "Expected plugin manifest name 'superpowers', got '$($manifest.name)'."
}

$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    $version = 'unknown-version'
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

$originalSnapshot = Join-Path $snapshotRoot 'hooks.original.json'
$appliedSnapshot = Join-Path $snapshotRoot 'hooks.applied.json'
Copy-Item -LiteralPath $targetHooks -Destination $originalSnapshot -Force
Copy-Item -LiteralPath $canonicalHooks -Destination $appliedSnapshot -Force

$originalHash = (Get-FileHash -LiteralPath $originalSnapshot -Algorithm SHA256).Hash.ToLowerInvariant()
$appliedHash = (Get-FileHash -LiteralPath $appliedSnapshot -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata = [ordered]@{
    schemaVersion = 1
    appliedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    pluginName = $manifest.name
    pluginVersion = $version
    pluginRoot = $resolvedPluginRoot
    originalHooksSha256 = $originalHash
    appliedHooksSha256 = $appliedHash
    restartRequired = $true
    trustReviewRequired = $true
}
$metadataPath = Join-Path $snapshotRoot 'metadata.json'
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 4), $utf8NoBom)

$targetDirectory = [System.IO.Path]::GetDirectoryName($targetHooks)
$temporaryTarget = Join-Path $targetDirectory ('.hooks.json.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    Copy-Item -LiteralPath $canonicalHooks -Destination $temporaryTarget -Force
    Move-Item -LiteralPath $temporaryTarget -Destination $targetHooks -Force
} finally {
    if (Test-Path -LiteralPath $temporaryTarget) {
        Remove-Item -LiteralPath $temporaryTarget -Force
    }
}

[pscustomobject]@{
    pluginRoot = $resolvedPluginRoot
    pluginVersion = $version
    originalBackup = $originalSnapshot
    appliedBackup = $appliedSnapshot
    metadata = $metadataPath
    originalHooksSha256 = $originalHash
    appliedHooksSha256 = $appliedHash
    restartRequired = $true
    trustReviewRequired = $true
} | ConvertTo-Json -Depth 4
