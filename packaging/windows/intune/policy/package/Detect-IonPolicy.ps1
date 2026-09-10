<#
.SYNOPSIS
  Intune Win32 detection script for the Ion Enterprise Policy package.

.DESCRIPTION
  Intune treats a detection script as "detected" when it exits 0 AND writes
  something to STDOUT. Anything else is "not detected", which is what makes
  Intune (re)install.

  Detection compares the DEVICE against the PAYLOAD, value by value:

    1. The ownership record at HKLM\SOFTWARE\Ion\PolicyPackage must exist and
       name a version at least as new as this package's.
    2. Every value the payload declares must be present under
       HKLM\SOFTWARE\Policies\IonEngine, carry the registry TYPE the payload
       declares, and carry exactly the DATA the payload declares.
    3. The theme pack the payload carries must be installed at
       %ProgramData%\Ion\themes\<id>, with the declared id, the declared
       version, and each declared file's declared SHA-256.

  Why (2) is a comparison and not a presence check. An earlier version of this
  script asked only whether the owned value NAMES existed. That answers "did
  something write here once" and nothing else: a scope list edited by hand, a
  boolean flipped in regedit, a REG_SZ where the payload declares a
  REG_MULTI_SZ, or a Group Policy refresh that overwrote one value all leave
  every name in place. The device reports compliant, Intune never remediates,
  and the engine runs a configuration nobody approved. Comparing the data is
  what makes drift visible, and drift is the case this rule exists for.

  Why (3) is here at all. The policy locks a themeId. A device that applies
  the policy without the pack falls back to a built-in theme and reports
  itself compliant -- compliant and wrong. The pack is part of the package, so
  it is part of the detection.

  The payload is stamped INTO this file at packaging time. Intune uploads a
  detection script on its own and runs it with no arguments and nothing beside
  it, so anything this needs to know has to live inside it. The identical text
  also ships in the package directory as IonPolicy.json -- that copy is what
  an administrator reads and what the installer applies.

  Extra values under the policy key are deliberately NOT a failure. An ADMX
  profile or an administrator may enforce a setting this package does not
  declare, and this package has no opinion about those.

.PARAMETER PayloadPath
  Compare against a payload file instead of the stamped copy. For a manual
  run against a package directory; Intune runs this with no arguments.

.PARAMETER MinimumVersion
  Overrides the stamped version. Manual testing only.
#>
[CmdletBinding()]
param(
  [string] $PayloadPath,
  [string] $MinimumVersion
)

$ErrorActionPreference = 'Stop'

$StampedVersion = '__ION_POLICY_VERSION__'
$StampedExpected = '__ION_POLICY_EXPECTED_B64__'
$PolicyKey = 'HKLM:\SOFTWARE\Policies\IonEngine'
$OwnershipKey = 'HKLM:\SOFTWARE\Ion\PolicyPackage'

<#
.SYNOPSIS
  A version string reduced to something [version] can order.
#>
function ConvertTo-IonComparableVersion {
  param([Parameter(Mandatory = $true)] [AllowNull()] [string] $Raw)
  if (-not $Raw) { return $null }
  $core = ($Raw -split '[-+]')[0]
  [version] $parsed = $null
  if ([version]::TryParse($core, [ref] $parsed)) { return $parsed }
  return $null
}

<#
.SYNOPSIS
  Whether a registry reading equals what the payload declares.
.DESCRIPTION
  Pure, and the reason it is a separate function: the tests can hand it a
  reading without a registry. Both the TYPE and the DATA have to match.

  A REG_SZ carrying "a b" and a REG_MULTI_SZ carrying "a","b" are different
  configurations, and the engine's decoder treats them differently, so a
  comparison that ignored the kind would call a drifted device compliant.

  Multi-string equality is ordered and joined on a control character no
  registry value legitimately contains, so ["a|b"] and ["a","b"] do not
  compare equal.
#>
function Test-IonPolicyValueMatch {
  param(
    [Parameter(Mandatory = $true)] $Expected,
    [Parameter(Mandatory = $true)] [AllowNull()] $ActualData,
    [Parameter(Mandatory = $true)] [AllowNull()] [string] $ActualKind
  )
  if ($null -eq $ActualData) { return $false }
  if ($ActualKind -ne [string] $Expected.type) { return $false }

  switch ([string] $Expected.type) {
    'MultiString' {
      $want = @($Expected.value | ForEach-Object { [string] $_ })
      $got = @($ActualData | ForEach-Object { [string] $_ })
      if ($want.Count -ne $got.Count) { return $false }
      return (($want -join "`u{1}") -eq ($got -join "`u{1}"))
    }
    'DWord' {
      return ([int] $ActualData -eq [int] $Expected.value)
    }
    default {
      return ([string] $ActualData -eq [string] $Expected.value)
    }
  }
}

<#
.SYNOPSIS
  Every payload value the device does not carry exactly. Empty means match.
.DESCRIPTION
  Takes readings rather than a registry, so the tests exercise the comparison
  itself. -Readings is a hashtable of value name -> @{ Data; Kind }; a name it
  does not carry is a value the device does not have.
#>
function Get-IonPolicyDrift {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Expected,
    [Parameter(Mandatory = $true)] [AllowNull()] $Readings
  )
  $drift = @()
  foreach ($v in @($Expected)) {
    if ($null -eq $v) { continue }
    $name = [string] $v.name
    if ($null -eq $Readings -or -not $Readings.ContainsKey($name)) {
      $drift += "$name is absent"
      continue
    }
    $reading = $Readings[$name]
    if (-not (Test-IonPolicyValueMatch -Expected $v -ActualData $reading.Data -ActualKind ([string] $reading.Kind))) {
      $drift += "$name differs (expected $($v.type), found $($reading.Kind))"
    }
  }
  return $drift
}

<#
.SYNOPSIS
  Why an installed theme is not the one the payload carries. Empty means it is.
.DESCRIPTION
  Pure for the same reason as above. -Installed is
  @{ Id; Version; Files = @{ relPath = sha256 } }, or $null when the pack
  directory is absent.

  Every declared file's hash is compared, not just the manifest's. A pack
  whose theme.json is untouched while its background image was replaced is a
  device rendering something nobody shipped.
#>
function Get-IonThemeDrift {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Expected,
    [Parameter(Mandatory = $true)] [AllowNull()] $Installed
  )
  if ($null -eq $Expected) { return @() }
  if ($null -eq $Installed) { return @("theme '$($Expected.id)' is not installed") }

  $drift = @()
  if ([string] $Installed.Id -ne [string] $Expected.id) {
    $drift += "theme id is '$($Installed.Id)', expected '$($Expected.id)'"
  }
  if ([string] $Installed.Version -ne [string] $Expected.version) {
    $drift += "theme version is '$($Installed.Version)', expected '$($Expected.version)'"
  }
  foreach ($f in @($Expected.files)) {
    if ($null -eq $f) { continue }
    $rel = [string] $f.path
    if ($null -eq $Installed.Files -or -not $Installed.Files.ContainsKey($rel)) {
      $drift += "theme file '$rel' is missing"
      continue
    }
    $actual = [string] $Installed.Files[$rel]
    if ($actual.ToLowerInvariant() -ne ([string] $f.sha256).ToLowerInvariant()) {
      $drift += "theme file '$rel' has hash $actual, expected $($f.sha256)"
    }
  }
  return $drift
}

# Dot-sourcing loads the comparisons without touching a registry, which is how
# New-IonPolicyPackage.test.ps1 exercises them on a Linux runner.
if ($MyInvocation.InvocationName -eq '.') { return }

# ── The payload to compare against ───────────────────────────────────────────

$expectedPayload = $null
if ($PayloadPath) {
  if (-not (Test-Path -LiteralPath $PayloadPath)) {
    [Console]::Error.WriteLine("Detect-IonPolicy.ps1: no payload at $PayloadPath")
    exit 2
  }
  $expectedPayload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
} else {
  # Assembled from two halves so the packaging tool's replacement pass cannot
  # rewrite these guards along with the sentinels they check.
  if ($StampedExpected -eq ('__ION_POLICY' + '_EXPECTED_B64__')) {
    [Console]::Error.WriteLine('Detect-IonPolicy.ps1 was not stamped with a payload. Package it with New-IonPolicyPackage.ps1, or pass -PayloadPath for a manual run.')
    exit 2
  }
  try {
    $expectedPayload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($StampedExpected)) | ConvertFrom-Json
  } catch {
    [Console]::Error.WriteLine("Detect-IonPolicy.ps1: the stamped payload is unreadable: $($_.Exception.Message)")
    exit 2
  }
}

if (-not $MinimumVersion) {
  if ($StampedVersion -eq ('__ION_POLICY' + '_VERSION__')) {
    $MinimumVersion = [string] $expectedPayload.packageVersion
  } else {
    $MinimumVersion = $StampedVersion
  }
}
if (-not $MinimumVersion) {
  [Console]::Error.WriteLine('Detect-IonPolicy.ps1 has no version to compare against.')
  exit 2
}

# ── The ownership record ─────────────────────────────────────────────────────

if (-not (Test-Path -LiteralPath $OwnershipKey)) { exit 0 }
$record = Get-ItemProperty -LiteralPath $OwnershipKey -ErrorAction SilentlyContinue
if ($null -eq $record -or -not $record.Version) { exit 0 }

$installedVersion = ConvertTo-IonComparableVersion ([string] $record.Version)
$requiredVersion = ConvertTo-IonComparableVersion $MinimumVersion
if ($null -eq $installedVersion -or $null -eq $requiredVersion) {
  [Console]::Error.WriteLine("Detect-IonPolicy.ps1 could not compare versions (installed='$($record.Version)', required='$MinimumVersion').")
  exit 2
}
if ($installedVersion -lt $requiredVersion) { exit 0 }

# ── The registry values, read as data and type ───────────────────────────────

$readings = @{}
if (Test-Path -LiteralPath $PolicyKey) {
  $key = Get-Item -LiteralPath $PolicyKey
  foreach ($name in $key.GetValueNames()) {
    if (-not $name) { continue }
    $readings[$name] = @{
      Data = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = [string] $key.GetValueKind($name)
    }
  }
}

$drift = @(Get-IonPolicyDrift -Expected $expectedPayload.values -Readings $readings)

# ── The theme pack ───────────────────────────────────────────────────────────

$expectedTheme = $expectedPayload.theme
if ($expectedTheme) {
  $themesRoot = Join-Path ([Environment]::GetEnvironmentVariable('ProgramData')) 'Ion\themes'
  $packDir = Join-Path $themesRoot ([string] $expectedTheme.id)
  $installedTheme = $null
  $manifestPath = Join-Path $packDir 'theme.json'
  if (Test-Path -LiteralPath $manifestPath) {
    $files = @{}
    foreach ($f in @($expectedTheme.files)) {
      if ($null -eq $f) { continue }
      $rel = [string] $f.path
      $onDisk = Join-Path $packDir ($rel -replace '/', '\')
      if (Test-Path -LiteralPath $onDisk) {
        $files[$rel] = (Get-FileHash -LiteralPath $onDisk -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
    $manifest = $null
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $manifest = $null }
    $installedTheme = @{
      Id      = if ($manifest) { [string] $manifest.id } else { '' }
      Version = if ($manifest) { [string] $manifest.version } else { '' }
      Files   = $files
    }
  }
  $drift += @(Get-IonThemeDrift -Expected $expectedTheme -Installed $installedTheme)
}

# ── Verdict ──────────────────────────────────────────────────────────────────

if ($drift.Count -gt 0) {
  # Not detected: no STDOUT, exit 0, so Intune reinstalls. The reasons go to
  # STDERR, which Intune captures in the device's app diagnostics -- without
  # them a remediating device tells nobody which value drifted.
  foreach ($d in $drift) { [Console]::Error.WriteLine("Detect-IonPolicy: $d") }
  exit 0
}

Write-Output ("Ion Enterprise Policy $($record.Version) detected: $(@($expectedPayload.values).Count) value(s) match under $PolicyKey" +
  $(if ($expectedTheme) { ", theme $($expectedTheme.id) $($expectedTheme.version) matches" } else { '' }))
exit 0
