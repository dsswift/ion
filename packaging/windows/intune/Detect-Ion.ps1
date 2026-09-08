<#
.SYNOPSIS
  Intune Win32 app detection script for Ion Desktop.

.DESCRIPTION
  Intune treats a detection script as "detected" when it exits 0 AND writes
  something to STDOUT. Anything else -- non-zero exit, or exit 0 with no
  output -- is "not detected", which is what makes Intune (re)install.

  Detection reads the NSIS uninstall entry electron-builder writes for the
  GUID pinned in desktop/package.json (build.nsis.guid). A per-machine
  install (/allusers) writes it under HKLM; a per-user install writes it
  under HKCU. Both are checked, HKLM first, because a Win32 app assigned in
  System context installs per-machine but a user may already have a per-user
  copy.

  The version is stamped at packaging time by scripts/ci/make-intunewin.ps1,
  which replaces the __ION_VERSION__ sentinel. An unstamped script exits
  non-zero rather than reporting a version-blind detection -- Intune would
  otherwise consider every older build up to date.

.PARAMETER MinimumVersion
  Overrides the stamped version. For manual testing only; Intune runs this
  script with no arguments.
#>
[CmdletBinding()]
param(
  [string] $MinimumVersion
)

$ErrorActionPreference = 'Stop'

$StampedVersion = '__ION_VERSION__'
$AppGuid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
$UninstallSubKey = "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"

if (-not $MinimumVersion) {
  if ($StampedVersion -eq ('__ION' + '_VERSION__')) {
    [Console]::Error.WriteLine("Detect-Ion.ps1 was not stamped with a version. Package it with scripts/ci/make-intunewin.ps1, or pass -MinimumVersion for a manual run.")
    exit 2
  }
  $MinimumVersion = $StampedVersion
}

function Get-InstalledIonVersion {
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    $path = "$hive\$UninstallSubKey"
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $entry = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
    if ($null -eq $entry -or -not $entry.DisplayVersion) { continue }
    return [pscustomobject]@{ Hive = $hive; Version = [string] $entry.DisplayVersion }
  }
  return $null
}

$installed = Get-InstalledIonVersion
if ($null -eq $installed) {
  # No output, exit 0: Intune reads this as "not detected".
  exit 0
}

# NSIS DisplayVersion is the electron-builder app version, which may carry a
# prerelease suffix (1.83.0-dev.abc1234). [version] cannot parse that, so the
# suffix is dropped for the comparison and a prerelease never counts as newer
# than the release it precedes.
function ConvertTo-ComparableVersion([string] $raw) {
  $core = ($raw -split '[-+]')[0]
  [version] $parsed = $null
  if ([version]::TryParse($core, [ref] $parsed)) { return $parsed }
  return $null
}

$installedVersion = ConvertTo-ComparableVersion $installed.Version
$requiredVersion = ConvertTo-ComparableVersion $MinimumVersion
if ($null -eq $installedVersion -or $null -eq $requiredVersion) {
  [Console]::Error.WriteLine("Detect-Ion.ps1 could not compare versions (installed='$($installed.Version)', required='$MinimumVersion').")
  exit 2
}

if ($installedVersion -ge $requiredVersion) {
  Write-Output "Ion $($installed.Version) detected under $($installed.Hive)\$UninstallSubKey"
  exit 0
}

# Older build present: no output, exit 0 -- Intune installs over it.
exit 0
