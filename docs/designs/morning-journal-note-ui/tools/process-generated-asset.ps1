param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [int]$Width,

  [Parameter(Mandatory = $true)]
  [int]$Height,

  [switch]$ChromaKeyGreen
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Resize-Cover {
  param(
    [System.Drawing.Image]$Image,
    [System.Drawing.Bitmap]$Destination,
    [int]$TargetWidth,
    [int]$TargetHeight
  )

  $scale = [Math]::Max($TargetWidth / $Image.Width, $TargetHeight / $Image.Height)
  $sourceWidth = [int]($TargetWidth / $scale)
  $sourceHeight = [int]($TargetHeight / $scale)
  $sourceX = [int](($Image.Width - $sourceWidth) / 2)
  $sourceY = [int](($Image.Height - $sourceHeight) / 2)

  $graphics = [System.Drawing.Graphics]::FromImage($Destination)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $graphics.DrawImage(
    $Image,
    (New-Object System.Drawing.Rectangle 0, 0, $TargetWidth, $TargetHeight),
    (New-Object System.Drawing.Rectangle $sourceX, $sourceY, $sourceWidth, $sourceHeight),
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $graphics.Dispose()
}

function Remove-Green-Key {
  param([System.Drawing.Bitmap]$Source)

  $clean = New-Object System.Drawing.Bitmap $Source.Width, $Source.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $minX = $Source.Width
  $minY = $Source.Height
  $maxX = 0
  $maxY = 0

  for ($y = 0; $y -lt $Source.Height; $y++) {
    for ($x = 0; $x -lt $Source.Width; $x++) {
      $color = $Source.GetPixel($x, $y)
      $isGreen = $color.G -gt 115 -and $color.G -gt ($color.R * 1.28) -and $color.G -gt ($color.B * 1.28)

      if ($isGreen) {
        $clean.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
      else {
        $clean.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $color.R, $color.G, $color.B))
        if ($x -lt $minX) { $minX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }

  $pad = 24
  $minX = [Math]::Max(0, $minX - $pad)
  $minY = [Math]::Max(0, $minY - $pad)
  $maxX = [Math]::Min($Source.Width - 1, $maxX + $pad)
  $maxY = [Math]::Min($Source.Height - 1, $maxY + $pad)

  $boxWidth = [Math]::Max(1, $maxX - $minX + 1)
  $boxHeight = [Math]::Max(1, $maxY - $minY + 1)
  $output = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

  $graphics = [System.Drawing.Graphics]::FromImage($output)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

  $scale = [Math]::Min(($Width - 56) / $boxWidth, ($Height - 56) / $boxHeight)
  $destWidth = [int]($boxWidth * $scale)
  $destHeight = [int]($boxHeight * $scale)
  $destX = [int](($Width - $destWidth) / 2)
  $destY = [int](($Height - $destHeight) / 2)

  $graphics.DrawImage(
    $clean,
    (New-Object System.Drawing.Rectangle $destX, $destY, $destWidth, $destHeight),
    (New-Object System.Drawing.Rectangle $minX, $minY, $boxWidth, $boxHeight),
    [System.Drawing.GraphicsUnit]::Pixel
  )

  $graphics.Dispose()
  $clean.Dispose()
  return $output
}

$resolvedInput = (Resolve-Path $InputPath).Path
$resolvedOutput = Join-Path (Get-Location) $OutputPath
New-Item -ItemType Directory -Force -Path (Split-Path $resolvedOutput -Parent) | Out-Null

if ($ChromaKeyGreen) {
  $source = [System.Drawing.Bitmap]::FromFile($resolvedInput)
  $result = Remove-Green-Key $source
  $result.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
  $result.Dispose()
  $source.Dispose()
}
else {
  $source = [System.Drawing.Image]::FromFile($resolvedInput)
  $result = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  Resize-Cover $source $result $Width $Height
  $result.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
  $result.Dispose()
  $source.Dispose()
}

$image = [System.Drawing.Image]::FromFile($resolvedOutput)
try {
  [PSCustomObject]@{
    path = $resolvedOutput
    width = $image.Width
    height = $image.Height
    chroma_key_green = [bool]$ChromaKeyGreen
  } | ConvertTo-Json -Compress
}
finally {
  $image.Dispose()
}
