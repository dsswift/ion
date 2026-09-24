<#
.SYNOPSIS
  Removes the Ion Engine machine policy and theme pack this package applied,
  and only those.

.DESCRIPTION
  The uninstall command of the Ion Enterprise Policy Win32 app, and the
  rollback path when a configuration change has to be reversed.

  It removes exactly what HKLM\SOFTWARE\Ion\PolicyPackage records as owned:

    - the named values under HKLM\SOFTWARE\Policies\IonEngine. Anything else
      there -- a value an administrator set by hand, a value delivered by
      Group Policy ADMX, a value from some other tool -- is left untouched.
      Removing the whole policy key would be simpler and would silently
      destroy configuration this package never placed.

    - the ONE theme pack directory it installed, identified by the recorded
      theme id. Every other pack under %ProgramData%\Ion\themes belongs to
      somebody else and stays. The pack root itself is never removed.

  What it never touches, whatever the ownership record says: a user profile,
  %USERPROFILE%\.ion, conversations, credentials, an operator's ~\orion or
  ~\.orion, a theme pack this package did not install, or the
  administrator-authored enterprise-config files under %ProgramData%\Ion.

  With no ownership record there is nothing to remove and that is not an
  error: an uninstall of something that was never installed succeeds, which
  is what Intune expects.

  The policy key itself is removed only when this package emptied it, and only
  when it has no subkeys.

.PARAMETER WhatIfOnly
  Print what would be removed and exit without touching the registry or disk.
#>
[CmdletBinding()]
param(
  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# -- 64-bit guard --------------------------------------------------------------
# Intune launches a Win32 app's command line from a 32-bit agent process, so a
# bare `powershell.exe` resolves to the SysWOW64 host. Inside that host every
# write under HKLM\SOFTWARE\Ion is redirected to HKLM\SOFTWARE\WOW6432Node\Ion,
# while HKLM\SOFTWARE\Policies is a shared key that is NOT redirected and
# %ProgramData% is the filesystem and so is never redirected at all.
#
# That combination is worse than an outright failure. A 32-bit run applies every
# policy value correctly, lays the theme pack down correctly, records its
# ownership in a hive nothing reads, and exits 0. Detection runs 64-bit, finds no
# ownership record, and reports the app installed-but-not-detected. Intune shows
# 0x87D1041C, and any app that names this one as a dependency is never attempted.
#
# Re-launching under the native host fixes it once, here, rather than teaching
# every registry call in this script about redirection and hoping the next call
# added remembers. PROCESSOR_ARCHITEW6432 exists only inside a 32-bit process on
# 64-bit Windows, which makes it the exact test. SysNative is the alias that maps
# a 32-bit process back to the real System32.

if ($env:PROCESSOR_ARCHITEW6432) {
  $native = Join-Path $env:SystemRoot 'SysNative\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $native)) {
    [Console]::Error.WriteLine("Uninstall-IonPolicy: running 32-bit and $native is missing, so it would read an empty ownership record and remove nothing while reporting success.")
    exit 1
  }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($WhatIfOnly) { $argv += '-WhatIfOnly' }
  & $native @argv
  exit $LASTEXITCODE
}

# The redirected record a 32-bit install may have left. It is removed on every
# uninstall, before the ownership check below decides there is nothing to do,
# because a device whose only record lives there must still end up clean.
$RedirectedOwnershipKey = 'HKLM:\SOFTWARE\WOW6432Node\Ion\PolicyPackage'
if (Test-Path -LiteralPath $RedirectedOwnershipKey) {
  Remove-Item -LiteralPath $RedirectedOwnershipKey -Recurse -Force -ErrorAction SilentlyContinue
  Write-IonPolicyLog "removed a stale ownership record at $RedirectedOwnershipKey written by a 32-bit install"
}

$PolicyKey = 'HKLM:\SOFTWARE\Policies\IonEngine'
$OwnershipKey = 'HKLM:\SOFTWARE\Ion\PolicyPackage'

function Write-IonPolicyLog([string] $Message) {
  Write-Output "Uninstall-IonPolicy: $Message"
}

if (-not (Test-Path -LiteralPath $OwnershipKey)) {
  Write-IonPolicyLog "no ownership record at $OwnershipKey; nothing was installed by this package"
  exit 0
}

$record = Get-ItemProperty -LiteralPath $OwnershipKey -ErrorAction SilentlyContinue
$owned = @()
if ($record -and $record.OwnedValues) { $owned = @($record.OwnedValues) }

# The theme directory is resolved from the recorded ID rather than the
# recorded PATH. A path in the registry is an instruction to delete a
# directory, and this script runs as SYSTEM; rebuilding it from an id that
# must match the pack-id grammar means a tampered record can name a pack under
# the theme root and nothing else on the disk.
$themeId = if ($record) { [string] $record.ThemeId } else { '' }
$packDir = ''
if ($themeId) {
  if ($themeId -match '^[a-z0-9][a-z0-9-]{0,63}$') {
    $packDir = Join-Path (Join-Path ([Environment]::GetEnvironmentVariable('ProgramData')) 'Ion\themes') $themeId
  } else {
    Write-IonPolicyLog "the ownership record names theme id '$themeId', which is not a usable pack directory name; leaving the disk alone"
    $themeId = ''
  }
}

Write-IonPolicyLog "package version $($record.Version) owns $($owned.Count) value(s)$(if ($themeId) { " and theme $themeId" })"
foreach ($name in $owned) { Write-IonPolicyLog "  will remove value $name" }
if ($packDir) { Write-IonPolicyLog "  will remove theme directory $packDir" }

if ($WhatIfOnly) {
  Write-IonPolicyLog '-WhatIfOnly given, nothing was modified'
  exit 0
}

$failed = 0
foreach ($name in $owned) {
  try {
    if (Get-ItemProperty -LiteralPath $PolicyKey -Name $name -ErrorAction SilentlyContinue) {
      Remove-ItemProperty -LiteralPath $PolicyKey -Name $name -Force
      Write-IonPolicyLog "removed $name"
    } else {
      # Already gone. Reported rather than silent, because "somebody else
      # removed it" and "we removed it" are different histories.
      Write-IonPolicyLog "$name was already absent"
    }
  } catch {
    $failed++
    Write-IonPolicyLog "FAILED to remove $name : $($_.Exception.Message)"
  }
}

if ($packDir) {
  if (Test-Path -LiteralPath $packDir) {
    try {
      Remove-Item -LiteralPath $packDir -Recurse -Force
      Write-IonPolicyLog "removed the theme pack directory $packDir"
    } catch {
      $failed++
      Write-IonPolicyLog "FAILED to remove $packDir : $($_.Exception.Message)"
    }
  } else {
    Write-IonPolicyLog "$packDir was already absent"
  }
}

# The ownership record is the retry metadata: it is the only statement of what
# this package still owns. If anything above could not be removed, the record
# stays exactly as it is, so the next attempt removes the remainder instead of
# leaving orphaned policy nothing claims. It goes only when everything it names
# is confirmed absent.
if ($failed -gt 0) {
  Write-IonPolicyLog "left the ownership record at $OwnershipKey in place; it still names what a retry has to remove"
  [Console]::Error.WriteLine("Uninstall-IonPolicy: $failed item(s) could not be removed. Re-run as SYSTEM or an administrator.")
  exit 1
}

Remove-Item -LiteralPath $OwnershipKey -Force -ErrorAction SilentlyContinue
Write-IonPolicyLog "removed the ownership record at $OwnershipKey"

# Only when this package left the key empty. A remaining value belongs to
# somebody else and the key has to stay for it.
if (Test-Path -LiteralPath $PolicyKey) {
  $remaining = @(
    (Get-Item -LiteralPath $PolicyKey).GetValueNames() | Where-Object { $_ -ne '' }
  )
  $subkeys = @((Get-Item -LiteralPath $PolicyKey).GetSubKeyNames())
  if ($remaining.Count -eq 0 -and $subkeys.Count -eq 0) {
    Remove-Item -LiteralPath $PolicyKey -Force -ErrorAction SilentlyContinue
    Write-IonPolicyLog "removed the now-empty $PolicyKey"
  } else {
    Write-IonPolicyLog "left $PolicyKey in place: $($remaining.Count) value(s) and $($subkeys.Count) subkey(s) belong to something else"
  }
}

Write-IonPolicyLog 'rollback complete'
exit 0
