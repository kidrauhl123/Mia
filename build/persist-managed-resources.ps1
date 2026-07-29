param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Destination,

  [switch]$RemoveSourceOnSuccess
)

$ErrorActionPreference = "Stop"

function Resolve-ContainedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  $resolved = [IO.Path]::GetFullPath((Join-Path $resolvedRoot $RelativePath))
  if (-not $resolved.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed resource path escapes its root: $RelativePath"
  }
  return $resolved
}

function Test-ManagedRuntime {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot
  )

  $manifestPath = Join-Path $RuntimeRoot "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    return $false
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $entrypoint = [string]$manifest.entrypoint
    if ([string]::IsNullOrWhiteSpace($entrypoint)) {
      return $false
    }
    $entrypointPath = Resolve-ContainedPath -Root $RuntimeRoot -RelativePath $entrypoint
    return Test-Path -LiteralPath $entrypointPath -PathType Leaf
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
  exit 0
}

$sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd("\")
$destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd("\")
$runtimeManifests = @(
  Get-ChildItem -LiteralPath $sourceRoot -Filter "manifest.json" -File -Recurse |
    Where-Object {
      $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart("\")
      $segments = $relative.Split("\", [StringSplitOptions]::RemoveEmptyEntries)
      $segments.Length -eq 5 -and @("agents", "acp", "cli") -contains $segments[0]
    }
)

if ($runtimeManifests.Count -eq 0) {
  throw "Bundled managed resources contain no runtime manifests: $sourceRoot"
}

New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null

foreach ($manifest in $runtimeManifests) {
  $sourceRuntime = $manifest.Directory.FullName
  $relativeRuntime = $sourceRuntime.Substring($sourceRoot.Length).TrimStart("\")
  $targetRuntime = Resolve-ContainedPath -Root $destinationRoot -RelativePath $relativeRuntime
  if (Test-ManagedRuntime -RuntimeRoot $targetRuntime) {
    continue
  }

  $targetParent = Split-Path -Parent $targetRuntime
  $stagingRuntime = "$targetRuntime.mia-staging-$PID"
  New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
  if (Test-Path -LiteralPath $stagingRuntime) {
    Remove-Item -LiteralPath $stagingRuntime -Recurse -Force
  }

  Copy-Item -LiteralPath $sourceRuntime -Destination $stagingRuntime -Recurse -Force
  if (-not (Test-ManagedRuntime -RuntimeRoot $stagingRuntime)) {
    Remove-Item -LiteralPath $stagingRuntime -Recurse -Force -ErrorAction SilentlyContinue
    throw "Managed resource verification failed after copy: $relativeRuntime"
  }

  if (Test-Path -LiteralPath $targetRuntime) {
    Remove-Item -LiteralPath $targetRuntime -Recurse -Force
  }
  Move-Item -LiteralPath $stagingRuntime -Destination $targetRuntime
}

foreach ($manifest in $runtimeManifests) {
  $sourceRuntime = $manifest.Directory.FullName
  $relativeRuntime = $sourceRuntime.Substring($sourceRoot.Length).TrimStart("\")
  $targetRuntime = Resolve-ContainedPath -Root $destinationRoot -RelativePath $relativeRuntime
  if (-not (Test-ManagedRuntime -RuntimeRoot $targetRuntime)) {
    throw "Persistent managed resource verification failed: $relativeRuntime"
  }
}

if ($RemoveSourceOnSuccess) {
  Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
