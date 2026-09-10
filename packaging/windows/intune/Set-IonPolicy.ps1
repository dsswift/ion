<#
.SYNOPSIS
  Writes Ion Engine enterprise policy to the machine registry.

.DESCRIPTION
  A ready-to-assign Intune platform script (Devices > Scripts and remediations
  > Platform scripts) for tenants that deliver policy this way rather than
  through ADMX ingestion. It writes the same values the ADMX template writes,
  under HKLM\SOFTWARE\Policies\IonEngine -- the only hive the engine reads.

  Edit the $Policy block below to your organisation's settings, then assign
  the script with "Run this script using the logged on credentials" set to No
  (it must run as SYSTEM to write HKLM).

  Every value is written idempotently: re-running the script converges the key
  to the block below and removes nothing else.

.PARAMETER WhatIfOnly
  Print the values that would be written and exit without touching the
  registry. Useful for a dry run on a test device.
#>
[CmdletBinding()]
param(
  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$PolicyKey = 'HKLM:\SOFTWARE\Policies\IonEngine'

# ---------------------------------------------------------------------------
# Edit this block. Each entry is one registry value:
#   MultiString -> a list field (AllowedModels, McpAllowlist, ...)
#   String      -> an object field, as one line of JSON (Permissions, Auth, ...)
# ConfigJson carries any nested setting that has no top-level value name of its
# own. See docs/enterprise/mdm.md, "Windows: registry policy and ProgramData".
# ---------------------------------------------------------------------------
$Policy = @(
  @{ Name = 'AllowedModels'; Type = 'MultiString'; Value = @('claude-sonnet-4-6', 'claude-haiku-4-5-20251001') }
  @{ Name = 'AllowedProviders'; Type = 'MultiString'; Value = @('anthropic') }
  @{ Name = 'Permissions'; Type = 'String'; Value = '{"mode":"ask"}' }
  @{ Name = 'ConfigJson'; Type = 'MultiString'; Value = @('{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}') }
)

foreach ($entry in $Policy) {
  $rendered = if ($entry.Value -is [array]) { $entry.Value -join ' | ' } else { $entry.Value }
  Write-Output "Set-IonPolicy: $($entry.Name) [$($entry.Type)] = $rendered"
}

if ($WhatIfOnly) {
  Write-Output 'Set-IonPolicy: -WhatIfOnly given, registry not modified'
  exit 0
}

if (-not (Test-Path -LiteralPath $PolicyKey)) {
  New-Item -Path $PolicyKey -Force | Out-Null
  Write-Output "Set-IonPolicy: created $PolicyKey"
}

foreach ($entry in $Policy) {
  New-ItemProperty -LiteralPath $PolicyKey -Name $entry.Name -PropertyType $entry.Type -Value $entry.Value -Force | Out-Null
}

Write-Output "Set-IonPolicy: wrote $($Policy.Count) values to $PolicyKey"
Write-Output 'Set-IonPolicy: restart the "Ion Engine" scheduled task for the change to take effect'
exit 0
