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
