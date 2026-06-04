param(
    [string]$DrawIoRoot = "C:\Program Files\draw.io"
)

$ErrorActionPreference = "Stop"
$asarPath = Join-Path $DrawIoRoot "resources\app.asar"

if (-not (Test-Path -LiteralPath $asarPath)) {
    throw "draw.io app.asar not found: $asarPath"
}

$lines = npx -y asar list $asarPath

function Get-TopEntries {
    param(
        [string]$Prefix,
        [string[]]$Exclude = @()
    )

    $result = foreach ($line in $lines) {
        if ($line -notlike "$Prefix*") {
            continue
        }

        $rest = $line.Substring($Prefix.Length)

        if (-not $rest) {
            continue
        }

        if ($rest -like "*\*") {
            $name = $rest.Split('\')[0]
        }
        else {
            $name = [IO.Path]::GetFileNameWithoutExtension($rest)
        }

        if ($name -and ($Exclude -notcontains $name)) {
            $name
        }
    }

    $result | Sort-Object -Unique
}

$templateCategories = Get-TopEntries -Prefix "\drawio\src\main\webapp\templates\" -Exclude @("LICENSE", "index")
$stencilFamilies = Get-TopEntries -Prefix "\drawio\src\main\webapp\stencils\" -Exclude @("LICENSE", "clipart")
$shapePacks = Get-TopEntries -Prefix "\drawio\src\main\webapp\shapes\" -Exclude @("LICENSE")

Write-Output "draw.io root: $DrawIoRoot"
Write-Output "app.asar: $asarPath"
Write-Output ""
Write-Output "Template categories:"
$templateCategories | ForEach-Object { Write-Output "  - $_" }
Write-Output ""
Write-Output "Stencil families:"
$stencilFamilies | ForEach-Object { Write-Output "  - $_" }
Write-Output ""
Write-Output "Shape packs:"
$shapePacks | ForEach-Object { Write-Output "  - $_" }
