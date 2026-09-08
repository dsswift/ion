<#
.SYNOPSIS
  The iteration loop for a Windows dev VM: pull, then build.

.DESCRIPTION
  Run this after every change on the Mac. It is deliberately thin: pulling is
  the only thing it owns, and the build belongs to make.ps1 in the repository
  root. An earlier version carried its own copy of the engine build, the
  dependency install and the packaging step, which is how it came to hardcode
  an architecture that make.ps1 resolves correctly.

  Only committed work crosses. A clone reads the object store, not the Mac
  worktree's files, so commit on the Mac before pulling here.

  make.ps1 writes a transcript to make.log in the checkout, which is where to
  look when this is driven over SSH.

.PARAMETER Dest
  The repository checkout. Defaults to C:\dev\ion.

.PARAMETER NoPull
  Build what is already checked out.

.PARAMETER Install
  Close a running Ion and launch the installer, instead of only building it.

.PARAMETER Arch
  auto (default, follows the host), x64, or arm64.

.EXAMPLE
  .\Update-IonDev.ps1

.EXAMPLE
  .\Update-IonDev.ps1 -Install
#>
[CmdletBinding()]
param(
  [string] $Dest = 'C:\dev\ion',
  [switch] $NoPull,
  [switch] $Install,
  [ValidateSet('auto', 'x64', 'arm64')] [string] $Arch = 'auto'
)

$ErrorActionPreference = 'Stop'
$started = Get-Date

Set-Location $Dest
$before = (git rev-parse HEAD).Trim()

if ($NoPull) {
  Write-Host '--- skipped: git pull (-NoPull)' -ForegroundColor DarkGray
} else {
  Write-Host "`n=== git pull ===" -ForegroundColor Cyan
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('pull was not a fast-forward. The Mac side rewrote history (amend/rebase); run: git fetch origin; git reset --hard origin/<branch>')
    exit 1
  }
}

$after = (git rev-parse HEAD).Trim()
if ($before -eq $after) { Write-Host "already at $($after.Substring(0,9))" }

$target = if ($Install) { 'desktop' } else { 'installer' }
& (Join-Path $Dest 'make.ps1') $target -Arch $Arch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host "`nUpdate-IonDev: done in ${elapsed}s at $($after.Substring(0,9))" -ForegroundColor Green
