<#
.SYNOPSIS
  The Microsoft Win32 Content Prep Tool: one pinned source, one hash check,
  one invocation.

.DESCRIPTION
  Two things wrap an Intune package in this repository -- the desktop
  installer and the enterprise policy app -- and both need the same binary
  from the same pinned tag with the same SHA-256 verified before it runs.
  Held here rather than duplicated, because a second copy of a pinned tag and
  a pinned hash is a second thing to update and the one nobody updates is the
  one that silently keeps running an old tool.

  Dot-source this; it defines functions and does nothing on its own.

  Pinned tool source, verified at implementation time:
    repo   microsoft/Microsoft-Win32-Content-Prep-Tool
    tag    v1.8.7 (released 2025-08-13)
    file   IntuneWinAppUtil.exe, 62520 bytes
    sha256 c1ba45b5cb939e84af064bb7ff4b38fb3dfe33c8dc1078fd9b157672eae671f6
  The raw.githubusercontent URL is content-addressed by tag, so the bytes at
  that path do not change. Bumping the tag means re-recording both the tag and
  the hash from an actual download -- never from memory.
#>

$IonContentPrepToolTag = 'v1.8.7'
$IonContentPrepToolUrl = "https://raw.githubusercontent.com/microsoft/Microsoft-Win32-Content-Prep-Tool/$IonContentPrepToolTag/IntuneWinAppUtil.exe"
$IonContentPrepToolSha256 = 'c1ba45b5cb939e84af064bb7ff4b38fb3dfe33c8dc1078fd9b157672eae671f6'

<#
.SYNOPSIS
  Downloads IntuneWinAppUtil.exe at the pinned tag and verifies its SHA-256.
.DESCRIPTION
  A hash mismatch throws rather than warns. This binary is handed a directory
  and produces the artifact a fleet installs from; running an unverified one
  is running whatever a network path returned.
#>
function Get-IonContentPrepTool {
  param([Parameter(Mandatory = $true)] [string] $Destination)
  # Write-Host, not Write-Output. A function's return value in PowerShell is
  # its whole output stream, so Write-Output progress lines become part of it:
  # this returned three items, the caller passed the array to a [string]
  # parameter, and both .intunewin wrappers failed with "Cannot convert value
  # to type System.String" after the tool had already downloaded and verified.
  # Progress belongs on the host stream; the pipeline carries the path alone.
  Write-Host "content-prep: downloading IntuneWinAppUtil.exe $IonContentPrepToolTag"
  Invoke-WebRequest -Uri $IonContentPrepToolUrl -OutFile $Destination -UseBasicParsing
  $actual = (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $IonContentPrepToolSha256) {
    throw "content-prep: IntuneWinAppUtil.exe SHA-256 mismatch. expected=$IonContentPrepToolSha256 actual=$actual"
  }
  Write-Host 'content-prep: IntuneWinAppUtil.exe SHA-256 verified'
  return $Destination
}

<#
.SYNOPSIS
  Resolves a tool path: an already-downloaded copy, or a freshly verified one.
#>
function Resolve-IonContentPrepTool {
  param([string] $ExistingPath)
  if ($ExistingPath) {
    if (-not (Test-Path -LiteralPath $ExistingPath)) {
      throw "content-prep: IntuneWinAppUtil.exe not found at $ExistingPath"
    }
    return (Resolve-Path -LiteralPath $ExistingPath).Path
  }
  $toolDir = Join-Path ([System.IO.Path]::GetTempPath()) "ion-intunewin-$([guid]::NewGuid().ToString('n'))"
  New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
  return Get-IonContentPrepTool (Join-Path $toolDir 'IntuneWinAppUtil.exe')
}

<#
.SYNOPSIS
  Wraps a source directory as a .intunewin and returns the artifact path.
.DESCRIPTION
  The tool names its output after the SETUP file, not after anything the
  caller chooses, so a caller wanting a deterministic name renames afterwards.
  This returns the path the tool actually produced and fails when it produced
  nothing -- a tool that exits 0 without writing a package would otherwise be
  reported as a successful build with no artifact.
#>
function Invoke-IonContentPrep {
  param(
    [Parameter(Mandatory = $true)] [string] $ToolPath,
    [Parameter(Mandatory = $true)] [string] $SourceDir,
    [Parameter(Mandatory = $true)] [string] $SetupFile,
    [Parameter(Mandatory = $true)] [string] $OutputDir
  )
  # Same reason as above: this function's value is the artifact path.
  Write-Host "content-prep: source=$SourceDir setup=$SetupFile output=$OutputDir"
  # A native command's stdout joins the success stream exactly as Write-Output
  # would, and IntuneWinAppUtil.exe is chatty -- roughly twenty INFO lines. Left
  # alone they become part of what this function returns, so the caller's
  # "$package" was the whole transcript with the path on the end. Piped to the
  # host: still in the build log, out of the return value.
  & $ToolPath -c $SourceDir -s $SetupFile -o $OutputDir -q 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) {
    throw "content-prep: IntuneWinAppUtil.exe failed with exit code $LASTEXITCODE"
  }
  $produced = Join-Path $OutputDir ([System.IO.Path]::GetFileNameWithoutExtension($SetupFile) + '.intunewin')
  if (-not (Test-Path -LiteralPath $produced)) {
    throw "content-prep: expected package not produced at $produced"
  }
  return $produced
}
