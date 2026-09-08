<#
.SYNOPSIS
  Builds a versioned Ion Enterprise Policy package from an enterprise config
  and the theme pack that config mandates.

.DESCRIPTION
  The Ion Enterprise Policy package is a second Intune Win32 app, installed
  BEFORE Ion Studio as its dependency, whose only job is to place the machine
  configuration Ion Studio needs on first launch: policy values under
  HKLM\SOFTWARE\Policies\IonEngine, and the theme pack those values name
  under %ProgramData%\Ion\themes. Splitting it from the application is what
  lets configuration change without redeploying 130 MB, and what lets a
  configuration change be rolled back on its own.

  The theme is not an optional extra. A policy that sets a locked themePolicy
  naming a pack the device does not carry produces a desktop that falls back
  to a built-in theme while reporting the policy applied -- a device that is
  compliant and wrong. So the theme travels in the same package, is validated
  against the policy that names it, and is checked by the same detection rule.

  WHAT IT VALIDATES, AND WHY EACH ONE IS HERE

  1. The config parses as JSON. A hand-edited config that does not parse would
     otherwise reach a fleet and apply nothing while the app reported
     installed.

  2. The config is COMPLETE. Every field a production device needs must be
     present: the provider list and each provider's endpoint, the identity
     provider and its Entra endpoints, and the desktop fields that pin the
     version and the theme. A config missing one of these produces a device
     that installs cleanly and cannot sign in, and the symptom surfaces as
     "Ion does not work" days later rather than as a packaging error now.

  3. No credential anywhere. Machine policy under HKLM is readable by every
     account on the device, so an apiKey in it is a credential published to
     every user of a multi-session host. Refused here, and refused again on
     the device by Install-IonPolicy.ps1, because a payload can be edited
     after packaging.

  4. No placeholder survives. A template shipped with "REPLACE_ME", an
     all-zero GUID or an example.com URL that reaches a fleet configures the
     devices to talk to nothing.

  5. Every declared value maps onto a real EnterpriseConfig field, in a
     registry type the engine's decoder accepts. A value the engine does not
     recognise is logged as unknown policy and silently ignored.

  6. The theme pack's id and version match what the policy's themePolicy
     names. A package whose policy locks theme A while carrying theme B is
     the compliant-and-wrong device above, assembled by hand.

  WHAT IT DOES NOT DO

  It does not carry a tenant's values. The config and the theme are both
  INPUTS, kept wherever the tenant's configuration lives, so this repository
  never becomes the source of truth for somebody's tenant IDs, gateway URLs
  or scope lists. The example beside this script is placeholders only and is
  refused by check 4 -- it exists to document the shape, never to be filled
  in and packaged, and nobody retypes fields to use this tool.

.PARAMETER ConfigPath
  The complete enterprise config JSON to package. Required.

.PARAMETER ThemePath
  The theme pack manifest (theme.json) the config's themePolicy names.
  Required, for the reason in the description: a locked theme policy without
  its pack is a device that reports compliant and renders wrong.

.PARAMETER Version
  The package version. Detection compares against it, so a device carrying an
  older package reinstalls and a device carrying this one or newer does not.

.PARAMETER OutputDir
  Where the package directory is written. The contents of this directory are
  what IntuneWinAppUtil.exe wraps.

.PARAMETER AllowPlaceholders
  Skip checks 2 and 4. For building a package from the example config to
  exercise the install path on a throwaway device, and for nothing else.

.OUTPUTS
  A directory containing IonPolicy.json, the theme pack under theme\,
  Install-IonPolicy.ps1, Uninstall-IonPolicy.ps1 and a stamped
  Detect-IonPolicy.ps1, plus a one-line summary of every value the package
  will write.
#>
# Not declared Mandatory: a mandatory parameter makes PowerShell PROMPT when
# this file is dot-sourced, which is how the tests load the pure functions
# below -- and a prompt in CI is an indefinite hang with no output. The body
# refuses without them, with a better message than the prompt would give.
[CmdletBinding()]
param(
  [string] $ConfigPath,
  [string] $ThemePath,
  [string] $Version,
  [string] $OutputDir,
  [switch] $AllowPlaceholders
)

$ErrorActionPreference = 'Stop'

# The engine's policy key. Not configurable: it is the engine's contract, and
# a package that wrote somewhere else would apply nothing while reporting
# success. See engine/internal/config/enterprise_windows.go.
$PolicyKey = 'HKLM\SOFTWARE\Policies\IonEngine'

# The sentinel Detect-IonPolicy.ps1 carries until it is stamped. Assembled
# from two halves at every use site so this file's own replacement pass cannot
# rewrite the literal it is looking for.
$VersionSentinel = '__ION_POLICY' + '_VERSION__'
# The second sentinel: the base64 of the payload the detector compares a
# device against. Same two-halves assembly, same reason.
$ExpectedSentinel = '__ION_POLICY' + '_EXPECTED_B64__'

<#
.SYNOPSIS
  Every placeholder-looking value in a JSON document, as dotted paths.
.DESCRIPTION
  Pure and recursive, so the tests can hand it a shape rather than a file.

  The patterns are the ones a template actually ships with. An all-zero GUID
  is Microsoft's own "fill this in" tenant; example.com and example.org are
  the reserved documentation domains; the angle-bracket and REPLACE_ME forms
  are what a human writes. Each of them reaching a fleet configures devices to
  talk to nothing, and the symptom is "Ion does not work" rather than anything
  that names the cause.
#>
function Find-IonPlaceholder {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Node,
    [string] $Path = ''
  )
  $patterns = @(
    'REPLACE_ME', 'CHANGE_ME', 'TODO', 'FIXME',
    'example\.com', 'example\.org', 'contoso\.com',
    '00000000-0000-0000-0000-000000000000',
    '^<.*>$', 'YOUR_', 'your-tenant', 'xxxxxxxx'
  )
  $found = @()
  if ($null -eq $Node) { return $found }

  if ($Node -is [string]) {
    foreach ($p in $patterns) {
      if ([regex]::IsMatch($Node, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $found += "$Path = '$Node' (matches /$p/)"
        break
      }
    }
    return $found
  }
  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    $i = 0
    foreach ($item in $Node) {
      $found += Find-IonPlaceholder -Node $item -Path "$Path[$i]"
      $i++
    }
    return $found
  }
  if ($Node -is [pscustomobject]) {
    foreach ($prop in $Node.PSObject.Properties) {
      $child = if ($Path) { "$Path.$($prop.Name)" } else { $prop.Name }
      $found += Find-IonPlaceholder -Node $prop.Value -Path $child
    }
    return $found
  }
  return $found
}

<#
.SYNOPSIS
  Every credential-shaped property in a JSON document, as dotted paths.
.DESCRIPTION
  Machine policy under HKLM is readable by every account on the device. On a
  multi-session host that is every signed-in user, so a key placed here is a
  key published rather than a key deployed. Names are matched rather than
  values because a secret has no shape.
#>
function Find-IonCredential {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Node,
    [string] $Path = ''
  )
  $names = @('apikey', 'clientsecret', 'secret', 'password', 'privatekey', 'refreshtoken')
  $found = @()
  if ($null -eq $Node) { return $found }

  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    $i = 0
    foreach ($item in $Node) {
      $found += Find-IonCredential -Node $item -Path "$Path[$i]"
      $i++
    }
    return $found
  }
  if ($Node -is [pscustomobject]) {
    foreach ($prop in $Node.PSObject.Properties) {
      $child = if ($Path) { "$Path.$($prop.Name)" } else { $prop.Name }
      if ($names -contains $prop.Name.ToLowerInvariant()) {
        $found += $child
        continue
      }
      $found += Find-IonCredential -Node $prop.Value -Path $child
    }
    return $found
  }
  return $found
}

<#
.SYNOPSIS
  The registry type one enterprise config value is written as.
.DESCRIPTION
  Mirrors the engine's own decoding table
  (engine/internal/config/enterprise_registry_decode.go, rawFor):

    string     -> REG_SZ           verbatim
    string[]   -> REG_MULTI_SZ     one entry per line
    bool       -> REG_DWORD        non-zero is true
    number     -> REG_DWORD
    object     -> REG_SZ           JSON object text
    object[]   -> REG_SZ           JSON array text

  Returns $null for a shape the engine has no rule for, which the caller turns
  into a refusal rather than a value the engine would log as undecodable.
#>
function Get-IonRegistryType {
  param([Parameter(Mandatory = $true)] [AllowNull()] $Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [bool]) { return 'DWord' }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [int64]) { return 'DWord' }
  if ($Value -is [string]) { return 'String' }
  if ($Value -is [System.Collections.IEnumerable]) {
    $items = @($Value)
    if ($items.Count -gt 0 -and ($items | Where-Object { $_ -isnot [string] }).Count -eq 0) {
      return 'MultiString'
    }
    return 'String'  # array of objects, carried as JSON text
  }
  if ($Value -is [pscustomobject]) { return 'String' }
  return $null
}

<#
.SYNOPSIS
  Renders one enterprise config value into what the registry write takes.
#>
function ConvertTo-IonRegistryValue {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Value,
    [Parameter(Mandatory = $true)] [string] $Type
  )
  switch ($Type) {
    'DWord' { if ($Value -is [bool]) { return [int] ([bool] $Value) } ; return [int] $Value }
    'MultiString' { return @($Value | ForEach-Object { [string] $_ }) }
    'String' {
      if ($Value -is [string]) { return $Value }
      return ($Value | ConvertTo-Json -Depth 20 -Compress)
    }
  }
  throw "unsupported registry type '$Type'"
}

<#
.SYNOPSIS
  Turns a parsed enterprise config into the package payload's value list.
.DESCRIPTION
  One registry value per top-level enterprise key. Per-key rather than one
  opaque ConfigJson blob so that an administrator reading regedit can see what
  is enforced, an ADMX-delivered value for a different key can coexist, and
  Uninstall-IonPolicy can remove exactly what this package placed.

  Throws on a shape the engine cannot decode. A payload that writes a value
  the engine ignores is a device that reports compliant and runs unmanaged.
#>
function ConvertTo-IonPolicyValue {
  param([Parameter(Mandatory = $true)] $Config)
  $values = @()
  foreach ($prop in $Config.PSObject.Properties) {
    $type = Get-IonRegistryType -Value $prop.Value
    if (-not $type) {
      throw "enterprise config key '$($prop.Name)' has a value the engine's registry decoder has no rule for."
    }
    $values += [pscustomobject]@{
      name  = $prop.Name
      type  = $type
      value = (ConvertTo-IonRegistryValue -Value $prop.Value -Type $type)
    }
  }
  if ($values.Count -eq 0) {
    throw 'the enterprise config declares nothing. A package that applies nothing is a packaging error, not an empty policy.'
  }
  return $values
}

<#
.SYNOPSIS
  The production fields an enterprise config must declare, as dotted paths.
.DESCRIPTION
  Not every field the engine understands -- the ones a device cannot work
  without. A config missing any of these installs cleanly and then fails at
  the point a person tries to use it, which surfaces days later as "Ion does
  not work" rather than now as a packaging error.

  Kept as data next to the check that reads it, so adding a field is one line
  and the test that pins the list fails until the list is updated.
#>
function Get-IonRequiredField {
  return @(
    'allowedProviders',
    'providers',
    'auth.identityProvider',
    'auth.requireOperatorIdentity',
    'auth.oauth.entra.issuerUrl',
    'auth.oauth.entra.authorizationUrl',
    'auth.oauth.entra.tokenUrl',
    'auth.oauth.entra.clientId',
    'auth.oauth.entra.redirectUri',
    'auth.oauth.entra.usePkce',
    'auth.oauth.entra.scopes',
    'customFields.ion-desktop.disableAutoUpdate',
    'customFields.ion-desktop.themePolicy.themeId',
    'customFields.ion-desktop.themePolicy.locked'
  )
}

<#
.SYNOPSIS
  Reads one dotted path out of a parsed JSON document.
.DESCRIPTION
  Returns $null when any segment is absent. No enterprise field name contains
  a dot, so splitting on one is unambiguous -- which is what lets 'ion-desktop'
  and other hyphenated keys be addressed without quoting.
#>
function Get-IonConfigValue {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Config,
    [Parameter(Mandatory = $true)] [string] $Path
  )
  $node = $Config
  foreach ($segment in $Path.Split('.')) {
    if ($null -eq $node) { return $null }
    $prop = $node.PSObject.Properties[$segment]
    if (-not $prop) { return $null }
    $node = $prop.Value
  }
  return $node
}

<#
.SYNOPSIS
  Every required production field the config does not declare.
.DESCRIPTION
  Pure, so the tests hand it a shape rather than a file. An absent property,
  an empty string and an empty list are all "not declared": each of the three
  reaches a device as no configuration at all, and distinguishing them would
  only let one of them through.

  The provider cross-check is here rather than in the flat list because it is
  relational: an id in allowedProviders with no entry under providers is a
  device told to use a provider it has no endpoint for.
#>
function Get-IonMissingField {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Config,
    [string[]] $Required
  )
  if (-not $Required) { $Required = Get-IonRequiredField }
  $missing = @()
  foreach ($path in $Required) {
    $value = Get-IonConfigValue -Config $Config -Path $path
    if ($null -eq $value) { $missing += $path; continue }
    if ($value -is [string]) {
      if ($value.Trim().Length -eq 0) { $missing += $path }
      continue
    }
    if ($value -is [System.Collections.IEnumerable] -and @($value).Count -eq 0) {
      $missing += $path
    }
  }

  $allowed = @(Get-IonConfigValue -Config $Config -Path 'allowedProviders')
  $providers = Get-IonConfigValue -Config $Config -Path 'providers'
  foreach ($id in $allowed) {
    if (-not $id) { continue }
    $entry = if ($providers) { $providers.PSObject.Properties[[string] $id] } else { $null }
    if (-not $entry) {
      $missing += "providers.$id"
      continue
    }
    foreach ($field in @('displayName', 'baseURL', 'authHeader')) {
      $sub = $entry.Value.PSObject.Properties[$field]
      if (-not $sub -or -not $sub.Value) { $missing += "providers.$id.$field" }
    }
  }
  return $missing
}

<#
.SYNOPSIS
  The files a theme pack manifest declares, as pack-relative paths.
.DESCRIPTION
  Declared, never discovered. The desktop loads a pack from theme.json plus
  the asset paths that manifest names (desktop/src/main/theme-packs.ts), so
  those files are the pack and everything else beside them is somebody's
  editor droppings. Walking the directory instead would ship .DS_Store,
  Thumbs.db, an old copy someone left, and any stray file, into %ProgramData%
  on every managed device.

  A declared path that IS such a dropping is refused rather than shipped:
  nothing legitimately names .DS_Store as a background image, so a manifest
  that does is wrong in a way that should stop the build.
#>
function Get-IonThemeFile {
  param([Parameter(Mandatory = $true)] $Manifest)
  $junk = @('.DS_Store', 'Thumbs.db', 'desktop.ini')
  $files = @('theme.json')
  foreach ($side in @('desktop', 'ios')) {
    $component = $Manifest.PSObject.Properties[$side]
    if (-not $component -or $null -eq $component.Value) { continue }
    $assets = $component.Value.PSObject.Properties['assets']
    if (-not $assets -or $null -eq $assets.Value) { continue }
    foreach ($slot in @('background', 'logo')) {
      $ref = $assets.Value.PSObject.Properties[$slot]
      if (-not $ref -or -not $ref.Value) { continue }
      $rel = ([string] $ref.Value).Replace('\', '/').TrimStart('/')
      if ($rel -match '(^|/)\.\.(/|$)') {
        throw "theme pack asset '$side.assets.$slot' = '$rel' escapes the pack directory."
      }
      $leaf = $rel.Split('/')[-1]
      if ($junk -contains $leaf) {
        throw "theme pack asset '$side.assets.$slot' names '$leaf', which is not a theme asset."
      }
      if ($files -notcontains $rel) { $files += $rel }
    }
  }
  return $files
}

<#
.SYNOPSIS
  Why a theme pack is not the one the policy locks. Empty means they agree.
.DESCRIPTION
  A package whose policy locks theme A while carrying theme B produces a
  device that applies the policy, cannot find the pack, silently falls back to
  a built-in theme, and reports itself compliant. The mismatch is invisible on
  the device and obvious here.
#>
function Get-IonThemeMismatch {
  param(
    [Parameter(Mandatory = $true)] [AllowNull()] $Manifest,
    [Parameter(Mandatory = $true)] [AllowNull()] $Config
  )
  if ($null -eq $Manifest) { return @('the theme pack manifest is empty') }
  $problems = @()

  $id = [string] $Manifest.id
  $version = [string] $Manifest.version
  if (-not $id) { $problems += 'the theme pack declares no id' }
  if (-not $version) { $problems += 'the theme pack declares no version' }
  if ($id -and $id -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') {
    $problems += "the theme pack id '$id' is not a usable pack directory name"
  }

  $policyId = Get-IonConfigValue -Config $Config -Path 'customFields.ion-desktop.themePolicy.themeId'
  if (-not $policyId) {
    $problems += 'the config declares no customFields.ion-desktop.themePolicy.themeId, so nothing names this theme'
  } elseif ($id -and ([string] $policyId) -ne $id) {
    $problems += "the config locks themeId '$policyId' but the theme pack is '$id'"
  }
  return $problems
}

# Dot-sourcing loads the functions without building anything, which is how
# New-IonPolicyPackage.test.ps1 exercises them on a Linux runner.
if ($MyInvocation.InvocationName -eq '.') { return }

foreach ($required in @('ConfigPath', 'ThemePath', 'Version', 'OutputDir')) {
  if (-not (Get-Variable -Name $required -ValueOnly)) {
    throw "New-IonPolicyPackage: -$required is required."
  }
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "New-IonPolicyPackage: no enterprise config at $ConfigPath"
}
if (-not (Test-Path -LiteralPath $ThemePath)) {
  throw "New-IonPolicyPackage: no theme pack manifest at $ThemePath"
}
if ($Version -notmatch '^\d+\.\d+\.\d+') {
  throw "New-IonPolicyPackage: -Version '$Version' is not a comparable version. Detection compares it numerically."
}

$raw = Get-Content -LiteralPath $ConfigPath -Raw
try {
  $config = $raw | ConvertFrom-Json
} catch {
  throw "New-IonPolicyPackage: $ConfigPath is not valid JSON: $($_.Exception.Message)"
}

$credentials = @(Find-IonCredential -Node $config)
if ($credentials.Count -gt 0) {
  throw ("New-IonPolicyPackage: $ConfigPath carries credential-shaped values ($($credentials -join ', ')). " +
         "Machine policy under $PolicyKey is readable by every account on the device; a key there is published, not deployed.")
}

$placeholders = @(Find-IonPlaceholder -Node $config)
if ($placeholders.Count -gt 0) {
  if (-not $AllowPlaceholders) {
    throw ("New-IonPolicyPackage: $ConfigPath still carries placeholders:`n  " + ($placeholders -join "`n  ") +
           "`nPoint -ConfigPath at the real enterprise config, or pass -AllowPlaceholders to build a throwaway test package.")
  }
  Write-Warning "building with $($placeholders.Count) placeholder(s) because -AllowPlaceholders was given. Do NOT assign this package."
}

# Completeness. A config missing a production field installs cleanly and then
# fails when somebody tries to sign in, days later and far from here.
$missing = @(Get-IonMissingField -Config $config)
if ($missing.Count -gt 0) {
  if (-not $AllowPlaceholders) {
    throw ("New-IonPolicyPackage: $ConfigPath is not a complete production config. Missing:`n  " +
           ($missing -join "`n  ") +
           "`nA device configured with this installs cleanly and cannot sign in.")
  }
  Write-Warning "building with $($missing.Count) missing production field(s) because -AllowPlaceholders was given."
}

# The theme pack the policy locks. Read and matched before anything is
# written, so a mismatched pair never reaches an output directory at all.
$themeRaw = Get-Content -LiteralPath $ThemePath -Raw
try {
  $themeManifest = $themeRaw | ConvertFrom-Json
} catch {
  throw "New-IonPolicyPackage: $ThemePath is not valid JSON: $($_.Exception.Message)"
}
$themeProblems = @(Get-IonThemeMismatch -Manifest $themeManifest -Config $config)
if ($themeProblems.Count -gt 0) {
  throw ("New-IonPolicyPackage: the theme pack and the policy do not agree:`n  " + ($themeProblems -join "`n  ") +
         "`nA device would apply the policy, not find the pack, and silently render a built-in theme while reporting compliant.")
}

$themeId = [string] $themeManifest.id
$themeVersion = [string] $themeManifest.version
$themeSourceDir = Split-Path -Parent (Resolve-Path -LiteralPath $ThemePath).Path
$themeFiles = @(Get-IonThemeFile -Manifest $themeManifest)

$values = ConvertTo-IonPolicyValue -Config $config

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$outputFull = (Resolve-Path -LiteralPath $OutputDir).Path

# Copy the DECLARED theme files, recording each one's SHA-256 as it lands.
# Both the installer and the detection rule compare against these hashes, so
# they are what makes "the theme on this device is the theme we shipped" a
# measurement rather than an assumption.
$themeOut = Join-Path $outputFull 'theme'
if (Test-Path -LiteralPath $themeOut) { Remove-Item -LiteralPath $themeOut -Recurse -Force }
New-Item -ItemType Directory -Path $themeOut -Force | Out-Null

$themeRecords = @()
foreach ($rel in $themeFiles) {
  $src = Join-Path $themeSourceDir ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $src)) {
    throw "New-IonPolicyPackage: the theme pack declares '$rel' but $src does not exist."
  }
  $dest = Join-Path $themeOut ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  $themeRecords += [pscustomobject]@{
    path   = $rel
    sha256 = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
    size   = (Get-Item -LiteralPath $dest).Length
  }
}

$payload = [ordered]@{
  schema         = 2
  packageVersion = $Version
  policyKey      = $PolicyKey
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  values         = $values
  theme          = [ordered]@{
    id      = $themeId
    version = $themeVersion
    files   = $themeRecords
  }
}

$payloadJson = $payload | ConvertTo-Json -Depth 20
Set-Content -LiteralPath (Join-Path $outputFull 'IonPolicy.json') -Value $payloadJson -Encoding utf8

$source = Join-Path $PSScriptRoot 'package'
foreach ($name in @('Install-IonPolicy.ps1', 'Uninstall-IonPolicy.ps1')) {
  Copy-Item (Join-Path $source $name) (Join-Path $outputFull $name) -Force
}

# Stamp the detection script with the version AND with the payload it must
# compare a device against.
#
# Intune runs a custom detection script standalone -- uploaded on its own,
# executed with no arguments and nothing beside it -- so everything it needs
# to know has to be inside the file. The same payload ships in the package
# directory as IonPolicy.json, which is what an administrator reads and what
# the installer applies; the embedded copy is that identical text, base64ed so
# no quoting in a tenant's config can break the script carrying it.
$detect = Get-Content -LiteralPath (Join-Path $source 'Detect-IonPolicy.ps1') -Raw
foreach ($sentinel in @($VersionSentinel, $ExpectedSentinel)) {
  if ($detect -notmatch [regex]::Escape($sentinel)) {
    throw "New-IonPolicyPackage: Detect-IonPolicy.ps1 has no $sentinel to stamp."
  }
}
$expectedB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payloadJson))
$detect = $detect.Replace("'$VersionSentinel'", "'$Version'")
$detect = $detect.Replace("'$ExpectedSentinel'", "'$expectedB64'")
Set-Content -LiteralPath (Join-Path $outputFull 'Detect-IonPolicy.ps1') -Value $detect -Encoding utf8

Write-Output "Ion Enterprise Policy package $Version -> $outputFull"
Write-Output "  policy key: $PolicyKey"
foreach ($v in $values) {
  $rendered = if ($v.value -is [array]) { ($v.value -join ' | ') } else { [string] $v.value }
  if ($rendered.Length -gt 120) { $rendered = $rendered.Substring(0, 120) + '...' }
  Write-Output "  $($v.name) [$($v.type)] = $rendered"
}
Write-Output "  theme: $themeId $themeVersion -> %ProgramData%\Ion\themes\$themeId"
foreach ($f in $themeRecords) {
  Write-Output "    $($f.path)  $($f.sha256)  $($f.size) bytes"
}
Write-Output '  install:   powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-IonPolicy.ps1'
Write-Output '  uninstall: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Uninstall-IonPolicy.ps1'
Write-Output '  detection: Detect-IonPolicy.ps1 (custom script rule)'
exit 0
