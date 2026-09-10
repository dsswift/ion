<#
  Behaviour tests for the Ion Enterprise Policy packaging tool, its .intunewin
  wrapper, and the three device-side scripts it packages.

  Runs anywhere PowerShell does, including the Linux CI runner: the tools are
  dot-sourced, which loads their pure functions without building anything, and
  the parts that write HKLM are checked structurally. The end-to-end build
  runs for real against a synthetic config and theme, because the packaging,
  the hashing and the stamping are all platform-independent -- only the
  content prep tool is a Windows binary, and -SkipPackaging is what steps past
  it.

  Invoked by `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1')
. (Join-Path $PSScriptRoot 'package/Detect-IonPolicy.ps1')

$script:failures = 0
function Assert-Equal {
  param($Expected, $Actual, [string] $Because)
  if ($Expected -ne $Actual) {
    Write-Host "FAIL  $Because`n      expected '$Expected', got '$Actual'" -ForegroundColor Red
    $script:failures++
  } else {
    Write-Host "ok    $Because" -ForegroundColor Green
  }
}

# -- Credentials never reach machine policy -----------------------------------
# HKLM policy is readable by every account on the device. On a multi-session
# host that is every signed-in user, so a key placed there is a key published.

$withKey = '{ "providers": { "gw": { "baseURL": "https://ai.internal", "apiKey": "sk-live-1234" } } }' | ConvertFrom-Json
$found = @(Find-IonCredential -Node $withKey)
Assert-Equal 1 $found.Count 'an apiKey anywhere in the config is found'
Assert-Equal 'providers.gw.apiKey' $found[0] 'the credential is reported by its full path'

$nested = '{ "auth": { "oauth": { "entra": { "clientId": "ok", "clientSecret": "shh" } } } }' | ConvertFrom-Json
Assert-Equal 1 @(Find-IonCredential -Node $nested).Count 'a nested clientSecret is found'

$inArray = '{ "targets": [ { "url": "https://a" }, { "url": "https://b", "password": "p" } ] }' | ConvertFrom-Json
Assert-Equal 1 @(Find-IonCredential -Node $inArray).Count 'a credential inside an array is found'

$clean = '{ "providers": { "gw": { "baseURL": "https://ai.internal", "authHeader": "x-api-key" } } }' | ConvertFrom-Json
Assert-Equal 0 @(Find-IonCredential -Node $clean).Count 'a header NAME is not a credential'

# -- Placeholders never reach a fleet -----------------------------------------

foreach ($case in @(
  @{ Json = '{ "a": "REPLACE_ME" }';                                   Why = 'REPLACE_ME' },
  @{ Json = '{ "a": "https://gateway.example.com" }';                  Why = 'an example.com URL' },
  @{ Json = '{ "a": "00000000-0000-0000-0000-000000000000" }';         Why = 'an all-zero GUID' },
  @{ Json = '{ "a": "<your gateway url>" }';                           Why = 'an angle-bracket placeholder' },
  @{ Json = '{ "a": { "b": [ "ok", "YOUR_TENANT" ] } }';               Why = 'a placeholder nested in an array' }
)) {
  $node = $case.Json | ConvertFrom-Json
  Assert-Equal $true (@(Find-IonPlaceholder -Node $node).Count -gt 0) "$($case.Why) is refused"
}

$real = '{ "allowedProviders": [ "acme" ], "providers": { "acme": { "baseURL": "https://ai.acme.internal" } } }' | ConvertFrom-Json
Assert-Equal 0 @(Find-IonPlaceholder -Node $real).Count 'a filled-in config carries no placeholders'

# The example shipped beside the tool must itself be refused. A template that
# packages cleanly is a template somebody deploys.
$example = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'enterprise-config.example.json') -Raw | ConvertFrom-Json
Assert-Equal $true (@(Find-IonPlaceholder -Node $example).Count -gt 0) `
  'the shipped example config is refused by the placeholder gate'
Assert-Equal 0 @(Find-IonCredential -Node $example).Count `
  'the shipped example config carries no credential-shaped key'

# -- The config must be COMPLETE ----------------------------------------------
# A config missing a production field installs cleanly and then fails when
# somebody tries to sign in, days later and far from the packaging step.

$completeJson = @'
{
  "allowedProviders": [ "acme" ],
  "providers": { "acme": { "displayName": "Acme", "baseURL": "https://ai.acme.internal", "authHeader": "x-api-key" } },
  "auth": {
    "identityProvider": "entra",
    "requireOperatorIdentity": true,
    "oauth": { "entra": {
      "issuerUrl": "https://login.microsoftonline.com/t/v2.0",
      "authorizationUrl": "https://login.microsoftonline.com/t/oauth2/v2.0/authorize",
      "tokenUrl": "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      "clientId": "11111111-2222-3333-4444-555555555555",
      "redirectUri": "http://localhost/callback",
      "usePkce": true,
      "scopes": [ "openid", "profile" ]
    } }
  },
  "customFields": { "ion-desktop": {
    "disableAutoUpdate": true,
    "themePolicy": { "themeId": "acme-brand", "locked": true }
  } }
}
'@
$complete = $completeJson | ConvertFrom-Json
Assert-Equal 0 @(Get-IonMissingField -Config $complete).Count `
  'a complete production config reports nothing missing'

Assert-Equal $true ((Get-IonRequiredField) -contains 'auth.oauth.entra.clientId') `
  'the required-field list names the Entra client id'
Assert-Equal $true ((Get-IonRequiredField) -contains 'customFields.ion-desktop.themePolicy.themeId') `
  'the required-field list names the locked theme id'

# Hyphenated keys are addressable, which is what makes the ion-desktop fields
# checkable at all.
Assert-Equal 'acme-brand' `
  (Get-IonConfigValue -Config $complete -Path 'customFields.ion-desktop.themePolicy.themeId') `
  'a dotted path reads through a hyphenated key'
Assert-Equal $null (Get-IonConfigValue -Config $complete -Path 'auth.oauth.okta.clientId') `
  'a dotted path through an absent segment is null, not an error'

foreach ($case in @(
  @{ Path = 'auth.oauth.entra.clientId';                       Why = 'a missing Entra client id' },
  @{ Path = 'customFields.ion-desktop.disableAutoUpdate';      Why = 'a missing desktop update kill switch' },
  @{ Path = 'customFields.ion-desktop.themePolicy.themeId';    Why = 'a missing locked theme id' },
  @{ Path = 'auth.identityProvider';                           Why = 'a missing identity provider' }
)) {
  $mutated = $completeJson | ConvertFrom-Json
  $segments = $case.Path.Split('.')
  $node = $mutated
  for ($i = 0; $i -lt $segments.Count - 1; $i++) { $node = $node.($segments[$i]) }
  $node.PSObject.Properties.Remove($segments[-1])
  Assert-Equal $true (@(Get-IonMissingField -Config $mutated) -contains $case.Path) `
    "$($case.Why) is reported missing"
}

# Empty is missing: an empty scope list and an absent one both reach a device
# as no configuration at all.
$emptyScopes = $completeJson | ConvertFrom-Json
$emptyScopes.auth.oauth.entra.scopes = @()
Assert-Equal $true (@(Get-IonMissingField -Config $emptyScopes) -contains 'auth.oauth.entra.scopes') `
  'an empty scope list counts as missing'

# The relational check: an allowed provider with no endpoint.
$danglingProvider = $completeJson | ConvertFrom-Json
$danglingProvider.allowedProviders = @('acme', 'ghost')
Assert-Equal $true (@(Get-IonMissingField -Config $danglingProvider) -contains 'providers.ghost') `
  'an allowed provider with no entry under providers is reported'

$noHeader = $completeJson | ConvertFrom-Json
$noHeader.providers.acme.PSObject.Properties.Remove('authHeader')
Assert-Equal $true (@(Get-IonMissingField -Config $noHeader) -contains 'providers.acme.authHeader') `
  "a provider missing its auth header is reported"

# -- The theme is a required package dependency -------------------------------

$themeManifest = '{ "id": "acme-brand", "name": "Acme", "version": "1.2.0", "desktop": { "tokens": {} } }' | ConvertFrom-Json
Assert-Equal 0 @(Get-IonThemeMismatch -Manifest $themeManifest -Config $complete).Count `
  'a theme whose id matches the locked themeId agrees with the policy'

$wrongId = '{ "id": "other-brand", "version": "1.2.0" }' | ConvertFrom-Json
Assert-Equal $true (@(Get-IonThemeMismatch -Manifest $wrongId -Config $complete).Count -gt 0) `
  'a theme whose id is not the one the policy locks is refused'

$noVersion = '{ "id": "acme-brand" }' | ConvertFrom-Json
Assert-Equal $true (@(Get-IonThemeMismatch -Manifest $noVersion -Config $complete).Count -gt 0) `
  'a theme declaring no version is refused'

$noThemePolicy = $completeJson | ConvertFrom-Json
$noThemePolicy.customFields.'ion-desktop'.PSObject.Properties.Remove('themePolicy')
Assert-Equal $true (@(Get-IonThemeMismatch -Manifest $themeManifest -Config $noThemePolicy).Count -gt 0) `
  'a config that locks no theme cannot carry one'

# Only the DECLARED files are packaged. Walking the directory would ship
# .DS_Store, Thumbs.db and whatever else sits beside a theme.json, into
# %ProgramData% on every managed device.
$plain = '{ "id": "a", "version": "1.0.0" }' | ConvertFrom-Json
Assert-Equal 'theme.json' (@(Get-IonThemeFile -Manifest $plain) -join ',') `
  'a theme with no assets packages its manifest and nothing else'

$withAssets = '{ "id": "a", "version": "1.0.0", "desktop": { "assets": { "background": "bg.png" } }, "ios": { "assets": { "logo": "img/logo.png" } } }' | ConvertFrom-Json
Assert-Equal 'theme.json,bg.png,img/logo.png' (@(Get-IonThemeFile -Manifest $withAssets) -join ',') `
  'declared assets from both components are packaged'

$dupAsset = '{ "id": "a", "version": "1.0.0", "desktop": { "assets": { "background": "bg.png" } }, "ios": { "assets": { "background": "bg.png" } } }' | ConvertFrom-Json
Assert-Equal 'theme.json,bg.png' (@(Get-IonThemeFile -Manifest $dupAsset) -join ',') `
  'an asset shared by both components is packaged once'

foreach ($case in @(
  @{ Json = '{ "id": "a", "version": "1.0.0", "desktop": { "assets": { "background": ".DS_Store" } } }'; Why = 'an asset named .DS_Store' },
  @{ Json = '{ "id": "a", "version": "1.0.0", "desktop": { "assets": { "logo": "../../secrets.png" } } }'; Why = 'an asset escaping the pack directory' }
)) {
  $threw = $false
  try { Get-IonThemeFile -Manifest ($case.Json | ConvertFrom-Json) | Out-Null } catch { $threw = $true }
  Assert-Equal $true $threw "$($case.Why) is refused"
}

# -- Registry typing matches the engine's decoder ------------------------------
# engine/internal/config/enterprise_registry_decode.go, rawFor.

Assert-Equal 'String'      (Get-IonRegistryType -Value 'text')                  'a string is REG_SZ'
Assert-Equal 'DWord'       (Get-IonRegistryType -Value $true)                   'a bool is REG_DWORD'
Assert-Equal 'DWord'       (Get-IonRegistryType -Value 7)                       'a number is REG_DWORD'
Assert-Equal 'MultiString' (Get-IonRegistryType -Value @('a', 'b'))             'a string list is REG_MULTI_SZ'
Assert-Equal 'String'      (Get-IonRegistryType -Value ('{"a":1}' | ConvertFrom-Json)) 'an object is REG_SZ carrying JSON'
Assert-Equal $null         (Get-IonRegistryType -Value $null)                   'a null has no registry type'

Assert-Equal 1 (ConvertTo-IonRegistryValue -Value $true -Type 'DWord') 'true renders as 1'
Assert-Equal 0 (ConvertTo-IonRegistryValue -Value $false -Type 'DWord') 'false renders as 0'
Assert-Equal '{"a":1}' (ConvertTo-IonRegistryValue -Value ('{"a":1}' | ConvertFrom-Json) -Type 'String') `
  'an object renders as compact JSON text'

$values = @(ConvertTo-IonPolicyValue -Config $complete)
Assert-Equal 4 $values.Count 'one registry value per top-level enterprise key'
$byName = @{}
foreach ($v in $values) { $byName[$v.name] = $v }
Assert-Equal 'MultiString' $byName['allowedProviders'].type 'allowedProviders is a REG_MULTI_SZ'
Assert-Equal 'String' $byName['providers'].type 'providers is JSON in a REG_SZ'
Assert-Equal $true ($byName['providers'].value -like '*ai.acme.internal*') 'the provider baseURL survives into the payload'
Assert-Equal $true ($byName['customFields'].value -like '*themePolicy*') 'the locked theme policy survives into the payload'

$threw = $false
try { ConvertTo-IonPolicyValue -Config ('{}' | ConvertFrom-Json) | Out-Null } catch { $threw = $true }
Assert-Equal $true $threw 'a config that declares nothing is a packaging error, not an empty policy'

# -- Detection compares DATA, not just value names ----------------------------
# The rule this replaced asked only whether the owned value NAMES existed,
# which answers "did something write here once". A scope list edited by hand,
# a boolean flipped in regedit, or a REG_SZ where a REG_MULTI_SZ belongs all
# left every name in place: the device reported compliant, Intune never
# remediated, and the engine ran a configuration nobody approved.

$expectedValues = @(
  [pscustomobject]@{ name = 'allowedProviders'; type = 'MultiString'; value = @('acme') },
  [pscustomobject]@{ name = 'requireAuth';      type = 'DWord';       value = 1 },
  [pscustomobject]@{ name = 'providers';        type = 'String';      value = '{"acme":{}}' }
)
$exactReadings = @{
  'allowedProviders' = @{ Data = @('acme');      Kind = 'MultiString' }
  'requireAuth'      = @{ Data = 1;              Kind = 'DWord' }
  'providers'        = @{ Data = '{"acme":{}}';  Kind = 'String' }
}
Assert-Equal 0 @(Get-IonPolicyDrift -Expected $expectedValues -Readings $exactReadings).Count `
  'a device carrying exactly the payload has no drift'

$extra = $exactReadings.Clone()
$extra['SomeAdmxValue'] = @{ Data = 'x'; Kind = 'String' }
Assert-Equal 0 @(Get-IonPolicyDrift -Expected $expectedValues -Readings $extra).Count `
  'a value this package does not declare belongs to somebody else and is not drift'

foreach ($case in @(
  @{ Name = 'allowedProviders'; Reading = @{ Data = @('acme', 'rogue'); Kind = 'MultiString' }; Why = 'an edited list' },
  @{ Name = 'allowedProviders'; Reading = @{ Data = 'acme';             Kind = 'String' };      Why = 'a REG_SZ where a REG_MULTI_SZ belongs' },
  @{ Name = 'requireAuth';      Reading = @{ Data = 0;                  Kind = 'DWord' };       Why = 'a flipped boolean' },
  @{ Name = 'requireAuth';      Reading = @{ Data = '1';                Kind = 'String' };      Why = 'a DWORD rewritten as text' },
  @{ Name = 'providers';        Reading = @{ Data = '{"rogue":{}}';     Kind = 'String' };      Why = 'a rewritten JSON blob' }
)) {
  $drifted = $exactReadings.Clone()
  $drifted[$case.Name] = $case.Reading
  Assert-Equal 1 @(Get-IonPolicyDrift -Expected $expectedValues -Readings $drifted).Count `
    "$($case.Why) is detected as drift"
}

$absent = $exactReadings.Clone()
$absent.Remove('requireAuth')
Assert-Equal 1 @(Get-IonPolicyDrift -Expected $expectedValues -Readings $absent).Count `
  'a value the payload declares and the device lacks is drift'
Assert-Equal 3 @(Get-IonPolicyDrift -Expected $expectedValues -Readings @{}).Count `
  'a cleared policy key is entirely drift'

# Ordered, joined on a control character: ["a|b"] and ["a","b"] are different
# configurations and must not compare equal.
Assert-Equal $false (Test-IonPolicyValueMatch `
    -Expected ([pscustomobject]@{ type = 'MultiString'; value = @('a', 'b') }) `
    -ActualData @('a|b') -ActualKind 'MultiString') `
  'a joined multi-string does not match the list it was joined from'
Assert-Equal $false (Test-IonPolicyValueMatch `
    -Expected ([pscustomobject]@{ type = 'MultiString'; value = @('a', 'b') }) `
    -ActualData @('b', 'a') -ActualKind 'MultiString') `
  'multi-string comparison is ordered'

# -- Detection compares the installed theme -----------------------------------
# The policy LOCKS a themeId. A device that applied the policy without the pack
# renders a built-in theme and reports itself compliant.

$expectedTheme = [pscustomobject]@{
  id      = 'acme-brand'
  version = '1.2.0'
  files   = @(
    [pscustomobject]@{ path = 'theme.json'; sha256 = 'aa11' },
    [pscustomobject]@{ path = 'bg.png';     sha256 = 'bb22' }
  )
}
$installedTheme = @{
  Id      = 'acme-brand'
  Version = '1.2.0'
  Files   = @{ 'theme.json' = 'aa11'; 'bg.png' = 'bb22' }
}
Assert-Equal 0 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $installedTheme).Count `
  'a device carrying exactly the packaged theme has no drift'

Assert-Equal 1 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $null).Count `
  'a missing theme is drift'

$wrongIdInstalled = @{ Id = 'other-brand'; Version = '1.2.0'; Files = $installedTheme.Files }
Assert-Equal 1 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $wrongIdInstalled).Count `
  'a theme with the wrong id is drift'

$wrongVersionInstalled = @{ Id = 'acme-brand'; Version = '1.1.0'; Files = $installedTheme.Files }
Assert-Equal 1 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $wrongVersionInstalled).Count `
  'a theme with the wrong version is drift'

# A pack whose theme.json is untouched while its background was replaced is a
# device rendering something nobody shipped, so every file is hashed.
$tamperedAsset = @{ Id = 'acme-brand'; Version = '1.2.0'; Files = @{ 'theme.json' = 'aa11'; 'bg.png' = 'ff99' } }
Assert-Equal 1 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $tamperedAsset).Count `
  'a replaced theme asset is drift even when the manifest is untouched'

$missingAsset = @{ Id = 'acme-brand'; Version = '1.2.0'; Files = @{ 'theme.json' = 'aa11' } }
Assert-Equal 1 @(Get-IonThemeDrift -Expected $expectedTheme -Installed $missingAsset).Count `
  'a missing theme asset is drift'

Assert-Equal 0 @(Get-IonThemeDrift -Expected $expectedTheme `
    -Installed @{ Id = 'acme-brand'; Version = '1.2.0'; Files = @{ 'theme.json' = 'AA11'; 'bg.png' = 'BB22' } }).Count `
  'hash comparison is case-insensitive, because Get-FileHash and JSON disagree on case'

# -- End to end: a real package, built from a real config and theme -----------

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-policy-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $themeDir = Join-Path $work 'theme-src'
  New-Item -ItemType Directory -Path $themeDir -Force | Out-Null
  $themeJson = @'
{
  "id": "acme-brand",
  "name": "Acme",
  "version": "1.2.0",
  "desktop": { "base": "ion-dark", "assets": { "background": "bg.png" }, "tokens": {} }
}
'@
  Set-Content -LiteralPath (Join-Path $themeDir 'theme.json') -Value $themeJson -Encoding utf8
  Set-Content -LiteralPath (Join-Path $themeDir 'bg.png') -Value 'not really a png' -NoNewline
  # The dropping the packaging must not ship. Present in the source directory,
  # absent from the payload, because the manifest never names it.
  Set-Content -LiteralPath (Join-Path $themeDir '.DS_Store') -Value 'finder junk' -NoNewline

  $configPath = Join-Path $work 'enterprise-config.json'
  Set-Content -LiteralPath $configPath -Value $completeJson -Encoding utf8

  $out = Join-Path $work 'out'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') `
    -ConfigPath $configPath -ThemePath (Join-Path $themeDir 'theme.json') `
    -Version '1.4.0' -OutputDir $out 2>&1 | Out-Null
  Assert-Equal 0 $LASTEXITCODE 'a complete config and a matching theme build a package'

  $payload = Get-Content -LiteralPath (Join-Path $out 'IonPolicy.json') -Raw | ConvertFrom-Json
  Assert-Equal 2 $payload.schema 'the payload declares the schema the installer understands'
  Assert-Equal '1.4.0' $payload.packageVersion 'the payload records the package version'
  Assert-Equal 'acme-brand' $payload.theme.id 'the payload records the theme id'
  Assert-Equal '1.2.0' $payload.theme.version 'the payload records the theme version'
  Assert-Equal 2 @($payload.theme.files).Count 'the payload records the declared theme files'
  Assert-Equal $true ($payload.theme.files[0].sha256.Length -eq 64) 'the payload records a SHA-256 per theme file'

  Assert-Equal $true (Test-Path (Join-Path $out 'theme/theme.json')) 'the package carries the theme manifest'
  Assert-Equal $true (Test-Path (Join-Path $out 'theme/bg.png')) 'the package carries the declared asset'
  Assert-Equal $false (Test-Path (Join-Path $out 'theme/.DS_Store')) `
    'the package does not carry .DS_Store from the theme source directory'

  # The stamped detector must be standalone: Intune uploads it on its own and
  # runs it with no arguments and nothing beside it.
  $stamped = Get-Content -LiteralPath (Join-Path $out 'Detect-IonPolicy.ps1') -Raw
  Assert-Equal $false ($stamped -match [regex]::Escape($VersionSentinel)) `
    'the packaged detector carries no unstamped version sentinel'
  Assert-Equal $false ($stamped -match [regex]::Escape($ExpectedSentinel)) `
    'the packaged detector carries no unstamped payload sentinel'
  Assert-Equal $true ($stamped -match "\`$StampedVersion = '1\.4\.0'") `
    'the packaged detector is stamped with the package version'

  # The embedded expected data is the payload, byte for byte.
  $b64 = [regex]::Match($stamped, "\`$StampedExpected = '([A-Za-z0-9+/=]+)'").Groups[1].Value
  Assert-Equal $true ($b64.Length -gt 0) 'the packaged detector embeds an expected payload'
  $embedded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  $packaged = Get-Content -LiteralPath (Join-Path $out 'IonPolicy.json') -Raw
  Assert-Equal $embedded.Trim() $packaged.Trim() `
    'the embedded expected data is the same payload that ships beside the detector'

  # A theme that is not the one the policy locks never reaches an output dir.
  $badTheme = Join-Path $work 'bad-theme'
  New-Item -ItemType Directory -Path $badTheme -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $badTheme 'theme.json') `
    -Value '{ "id": "other-brand", "name": "Other", "version": "9.0.0" }' -Encoding utf8
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') `
    -ConfigPath $configPath -ThemePath (Join-Path $badTheme 'theme.json') `
    -Version '1.4.0' -OutputDir (Join-Path $work 'out-bad') 2>&1 | Out-Null
  Assert-Equal $false ($LASTEXITCODE -eq 0) `
    'a theme that is not the one the policy locks fails the build'

  # An incomplete config fails the build rather than shipping a device that
  # installs cleanly and cannot sign in.
  $thinConfig = Join-Path $work 'thin.json'
  Set-Content -LiteralPath $thinConfig -Encoding utf8 -Value `
    '{ "allowedProviders": [ "acme" ], "providers": { "acme": { "displayName": "A", "baseURL": "https://a.internal", "authHeader": "x-api-key" } } }'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') `
    -ConfigPath $thinConfig -ThemePath (Join-Path $themeDir 'theme.json') `
    -Version '1.4.0' -OutputDir (Join-Path $work 'out-thin') 2>&1 | Out-Null
  Assert-Equal $false ($LASTEXITCODE -eq 0) 'an incomplete production config fails the build'

  # A theme is not optional.
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') `
    -ConfigPath $configPath -Version '1.4.0' -OutputDir (Join-Path $work 'out-notheme') 2>&1 | Out-Null
  Assert-Equal $false ($LASTEXITCODE -eq 0) 'a build with no -ThemePath is refused'

  # -- The .intunewin wrapper -------------------------------------------------
  # -SkipPackaging steps past the Windows-only content prep binary; everything
  # else -- the package build, the naming, the provenance -- runs for real.

  $wrapOut = Join-Path $work 'wrap'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'New-IonPolicyIntuneWin.ps1') `
    -ConfigPath $configPath -ThemePath (Join-Path $themeDir 'theme.json') `
    -Version '1.4.0' -OutputDir $wrapOut -SkipPackaging 2>&1 | Out-Null
  Assert-Equal 0 $LASTEXITCODE 'the wrapper builds and reports success'
  Assert-Equal $true (Test-Path (Join-Path $wrapOut 'Ion-Policy-1.4.0/IonPolicy.json')) `
    'the wrapper writes a deterministically named package directory'
  Assert-Equal $true (Test-Path (Join-Path $wrapOut 'Detect-IonPolicy-1.4.0.ps1')) `
    'the wrapper lifts the stamped detector out for upload as the detection rule'
  Assert-Equal $true (Test-Path (Join-Path $wrapOut 'Ion-Policy-1.4.0.json')) `
    'the wrapper writes provenance'
  Assert-Equal $true (Test-Path (Join-Path $wrapOut 'Ion-Policy-1.4.0.sha256')) `
    'the wrapper writes checksums'

  $prov = Get-Content -LiteralPath (Join-Path $wrapOut 'Ion-Policy-1.4.0.json') -Raw | ConvertFrom-Json
  Assert-Equal '1.4.0' $prov.version 'the provenance records the package version'
  Assert-Equal 64 $prov.inputs.config.sha256.Length `
    'the provenance records the config hash, so "which tenant config is inside" is answerable'
  Assert-Equal 'acme-brand' $prov.inputs.theme.id 'the provenance records the packaged theme'
  Assert-Equal $true ($prov.commit.Length -gt 0) 'the provenance records the commit'
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# -- The wrapper uses the SAME pinned, verified tool --------------------------
# Two things wrap an Intune package here. A second copy of the pinned tag and
# hash is a second thing to update, and the one nobody updates is the one that
# silently keeps running an old binary.

$shared = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../../scripts/ci/IonContentPrepTool.ps1') -Raw
$appWrap = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../../scripts/ci/make-intunewin.ps1') -Raw
$policyWrap = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'New-IonPolicyIntuneWin.ps1') -Raw

Assert-Equal $true ($shared -match 'IonContentPrepToolSha256 = ') `
  'the pinned SHA-256 lives in the shared helper'
foreach ($pair in @(
  @{ Text = $appWrap;    Name = 'the application wrapper' },
  @{ Text = $policyWrap; Name = 'the policy wrapper' }
)) {
  Assert-Equal $true ($pair.Text -match [regex]::Escape("IonContentPrepTool.ps1")) `
    "$($pair.Name) dot-sources the shared content prep helper"
  Assert-Equal $true ($pair.Text -match 'Resolve-IonContentPrepTool') `
    "$($pair.Name) resolves its tool through the SHA-256 verified path"
  Assert-Equal $false ($pair.Text -match 'raw\.githubusercontent\.com') `
    "$($pair.Name) carries no second copy of the download URL"
}
Assert-Equal $true ($policyWrap -match '\$packageName = "Ion-Policy-\$ionVersion"') `
  'the policy artifact is named for what it is, not for the setup file'
Assert-Equal $true ($policyWrap -match "SetupFile 'Install-IonPolicy\.ps1'") `
  'the policy package is wrapped with its install command as the setup file'

# -- The device scripts -------------------------------------------------------
# These write HKLM and %ProgramData%, so they are checked structurally rather
# than executed. Each assertion is a property the fleet depends on and that
# nothing else enforces.

$pkg = Join-Path $PSScriptRoot 'package'
$install = Get-Content -LiteralPath (Join-Path $pkg 'Install-IonPolicy.ps1') -Raw
$uninstall = Get-Content -LiteralPath (Join-Path $pkg 'Uninstall-IonPolicy.ps1') -Raw
$detect = Get-Content -LiteralPath (Join-Path $pkg 'Detect-IonPolicy.ps1') -Raw

foreach ($pair in @(
  @{ Text = $install;   Name = 'Install' },
  @{ Text = $uninstall; Name = 'Uninstall' },
  @{ Text = $detect;    Name = 'Detect' }
)) {
  Assert-Equal $true ($pair.Text -match [regex]::Escape('HKLM:\SOFTWARE\Policies\IonEngine')) `
    "$($pair.Name) targets the engine's policy key"
  Assert-Equal $true ($pair.Text -match [regex]::Escape('HKLM:\SOFTWARE\Ion\PolicyPackage')) `
    "$($pair.Name) uses an ownership record OUTSIDE the policy key the engine enumerates"
}

Assert-Equal $true ($install -match 'read back a different value') `
  'Install reads every value back and fails when it differs'
Assert-Equal $true ($install -match 'GetValueKind') `
  'Install verifies the registry TYPE it wrote, not only the text'
Assert-Equal $true ($install -match '"apiKey"') `
  'Install refuses a payload carrying a credential, even one hand-edited after packaging'
Assert-Equal $true ($install -match 'no longer declares') `
  'Install converges: a value this package no longer declares is removed'

# The theme install is atomic: staged, hashed, then swapped by rename. A copy
# over the live directory would let the desktop load a half-written pack.
Assert-Equal $true ($install -match '\$stagingDir') 'Install stages the theme before it goes live'
Assert-Equal $true ($install -match 'Get-FileHash') 'Install verifies each staged theme file against the payload hash'
Assert-Equal $true ($install -match 'Move-Item -LiteralPath \$stagingDir -Destination \$packDir') `
  'Install makes the theme live with a rename, not a copy over the live directory'
Assert-Equal $true ($install -match 'the previous theme pack was restored') `
  'a failed swap restores the pack the device already had'
Assert-Equal $true ($install -match "Name 'ThemeId'") `
  'Install records which theme it owns, so uninstall removes that one and no other'

Assert-Equal $true ($uninstall -match 'OwnedValues') `
  'Uninstall removes only the values recorded as owned'
Assert-Equal $true ($uninstall -match 'belong to something else') `
  'Uninstall leaves the policy key alone when anything else still lives in it'
Assert-Equal $true ($uninstall -match '\$record\.ThemeId') `
  'Uninstall removes the theme it recorded as owned, resolved from the id rather than a stored path'
Assert-Equal $true ($uninstall -match "a-z0-9\]\[a-z0-9-\]\{0,63\}") `
  'Uninstall refuses a recorded theme id that is not a pack directory name'

# -- The install is one transaction: theme AND policy, or neither -------------
# The swap makes the new pack live before the policy values are written. If
# anything after the swap fails -- a write, a readback, the ownership record --
# a device left carrying the new theme is a device rendering the managed brand
# while configured by something else, and the retired pack is the only copy of
# what it had. So the retired pack survives until the ownership record is
# complete, and the failure path undoes the swap.
#
# Checked by position rather than by presence: "the file mentions a rollback"
# was already true of the broken version. What was wrong was the ORDER.

function Get-IonScriptIndex([string] $Text, [string] $Needle, [string] $Because) {
  $i = $Text.IndexOf($Needle)
  if ($i -lt 0) {
    Write-Host "FAIL  $Because`n      '$Needle' does not appear at all" -ForegroundColor Red
    $script:failures++
  }
  return $i
}

$swapAt = Get-IonScriptIndex $install 'Move-Item -LiteralPath $stagingDir -Destination $packDir' `
  'Install swaps the staged pack into place'
$ownedAt = Get-IonScriptIndex $install "Name 'InstalledAtUtc'" `
  'Install stamps the ownership record when it is done'
$postSwap = if ($swapAt -ge 0 -and $ownedAt -gt $swapAt) { $install.Substring($swapAt, $ownedAt - $swapAt) } else { '' }

Assert-Equal $false ($postSwap -match [regex]::Escape('Remove-Item -LiteralPath $retiredDir')) `
  'Install keeps the retired theme pack until the ownership record is written'
Assert-Equal $true ($install.LastIndexOf('Remove-Item -LiteralPath $retiredDir') -gt $ownedAt) `
  'Install deletes the retired theme pack only after the install has fully succeeded'

$failurePath = if ($ownedAt -ge 0) { $install.Substring($ownedAt) } else { '' }
Assert-Equal $true ($failurePath -match [regex]::Escape('Remove-Item -LiteralPath $packDir')) `
  'a post-swap failure removes the pack this run installed'
Assert-Equal $true ($failurePath -match [regex]::Escape('Move-Item -LiteralPath $retiredDir -Destination $packDir')) `
  'a post-swap failure puts the previous theme pack back'
Assert-Equal $true ($failurePath -match [regex]::Escape('Restore-IonRegistrySnapshot $PolicyKey')) `
  'a post-swap failure restores the policy values the run replaced'
Assert-Equal $true ($failurePath -match [regex]::Escape('Restore-IonRegistrySnapshot $OwnershipKey')) `
  'a post-swap failure restores the ownership record rather than leaving half of a new one'

# The snapshots have to predate the swap, or there is nothing to restore to.
$snapAt = Get-IonScriptIndex $install '$policySnapshot = Get-IonRegistrySnapshot' `
  'Install snapshots the policy key before it changes anything'
Assert-Equal $true ($snapAt -ge 0 -and $snapAt -lt $swapAt) `
  'Install captures the registry snapshot before the theme swap goes live'

# A readback mismatch has to enter the rollback, not exit past it.
Assert-Equal $true ($install -match [regex]::Escape('throw "wrote $($mismatches -join')) `
  'a failed readback raises into the rollback instead of exiting with the new theme live'

# -- Uninstall keeps its retry metadata when cleanup fails --------------------
# The ownership record is the only statement of what this package still owns.
# Removing it after a failed removal orphans whatever is left: the next
# uninstall finds no record, reports success, and the policy stays forever.

$failCheckAt = Get-IonScriptIndex $uninstall 'if ($failed -gt 0)' `
  'Uninstall checks whether anything could not be removed'
$dropRecordAt = Get-IonScriptIndex $uninstall 'Remove-Item -LiteralPath $OwnershipKey' `
  'Uninstall removes the ownership record when it is done'
Assert-Equal $true ($failCheckAt -ge 0 -and $dropRecordAt -gt $failCheckAt) `
  'Uninstall removes the ownership record only after the failure check has passed'
Assert-Equal $true ($uninstall.Substring(0, [Math]::Max($failCheckAt, 0)) -notmatch [regex]::Escape('Remove-Item -LiteralPath $OwnershipKey')) `
  'nothing removes the ownership record before the failure check'
$failBranch = if ($failCheckAt -ge 0 -and $dropRecordAt -gt $failCheckAt) {
  $uninstall.Substring($failCheckAt, $dropRecordAt - $failCheckAt)
} else { '' }
Assert-Equal $true ($failBranch -match 'exit 1') `
  'a failed cleanup exits before the ownership record is deleted'
Assert-Equal $true ($uninstall -match 'still names what a retry has to remove') `
  'Uninstall says why it kept the ownership record'

Assert-Equal $true ($detect -match 'Get-IonPolicyDrift') `
  'Detect compares every declared value against the device'
Assert-Equal $true ($detect -match 'Get-IonThemeDrift') `
  'Detect compares the installed theme against the payload'
Assert-Equal $true ($detect -match [regex]::Escape($VersionSentinel)) `
  'Detect carries the version sentinel the packaging tool stamps'
Assert-Equal $true ($detect -match [regex]::Escape($ExpectedSentinel)) `
  'Detect carries the expected-payload sentinel the packaging tool stamps'

# -- Nothing in the package touches operator data -----------------------------
# %USERPROFILE%\.ion holds conversations and credentials; ~\orion and ~\.orion
# hold operator data. A policy package has no business in any of them, and the
# check is here because the cost of finding out otherwise is somebody's work.
# Comments are stripped first: these scripts DOCUMENT what they never touch,
# and a check that matched the documentation would fail on the sentence that
# promises the behaviour it is verifying.
function Remove-IonComment([string] $text) {
  $noBlocks = [regex]::Replace($text, '(?s)<#.*?#>', '')
  return (($noBlocks -split "`n" | ForEach-Object { ($_ -split '#')[0] }) -join "`n")
}

foreach ($pair in @(
  @{ Text = (Remove-IonComment $install);   Name = 'Install' },
  @{ Text = (Remove-IonComment $uninstall); Name = 'Uninstall' },
  @{ Text = (Remove-IonComment $detect);    Name = 'Detect' }
)) {
  foreach ($forbidden in @('USERPROFILE', 'orion', 'conversations')) {
    Assert-Equal $false ($pair.Text -match "(?<![A-Za-z])$([regex]::Escape($forbidden))(?![A-Za-z])") `
      "$($pair.Name) never operates on $forbidden"
  }
  # ProgramData IS referenced now -- the theme root lives there. What must not
  # be touched is the administrator's own policy files beside it.
  foreach ($forbidden in @('enterprise-config.json', 'enterprise-config.d')) {
    Assert-Equal $false ($pair.Text -match [regex]::Escape($forbidden)) `
      "$($pair.Name) never touches $forbidden"
  }
  Assert-Equal $true ($pair.Text -match [regex]::Escape("'Ion\themes'")) `
    "$($pair.Name) reaches only the machine-scope theme root under ProgramData"
}

# -- The 64-bit guard ---------------------------------------------------------
# Regression cover for a defect that reached three production session hosts on
# 2026-09-08. Intune ran Install-IonPolicy.ps1 through the 32-bit PowerShell
# host, so HKLM\SOFTWARE\Ion was redirected into WOW6432Node while
# HKLM\SOFTWARE\Policies (a shared key) and %ProgramData% were not. The policy
# values and the theme landed correctly, the ownership record landed where
# detection never looks, and the installer exited 0. Intune reported
# 0x87D1041C, installed-but-not-detected, and the application that names this
# package as a dependency was never attempted at all.
#
# These assertions pin the two properties that would have prevented it: the
# guard exists, and it runs BEFORE anything writes to the registry. A guard
# placed after the first write is the same defect with more code.

foreach ($pair in @(
  @{ Text = $install;   Name = 'Install' },
  @{ Text = $uninstall; Name = 'Uninstall' }
)) {
  Assert-Equal $true ($pair.Text -match [regex]::Escape('$env:PROCESSOR_ARCHITEW6432')) `
    "$($pair.Name) detects a 32-bit host by the one variable that only exists in one"
  Assert-Equal $true ($pair.Text -match [regex]::Escape("SysNative\WindowsPowerShell\v1.0\powershell.exe")) `
    "$($pair.Name) re-launches through SysNative, which maps a 32-bit process back to the real System32"
  Assert-Equal $true ($pair.Text -match [regex]::Escape('exit $LASTEXITCODE')) `
    "$($pair.Name) propagates the re-launched exit code rather than reporting its own success"
  Assert-Equal $true ($pair.Text -match [regex]::Escape('WOW6432Node\Ion\PolicyPackage')) `
    "$($pair.Name) clears a stale ownership record left by a 32-bit install"

  # Ordering. The guard is only worth anything if it precedes every write.
  # Comments are stripped first: the header of Install-IonPolicy.ps1 discusses
  # New-ItemProperty by name, above the guard, and an ordering check that
  # counted prose would fail on the documentation rather than on the code.
  $code = Remove-IonComment $pair.Text
  $guardAt = $code.IndexOf('$env:PROCESSOR_ARCHITEW6432')
  Assert-Equal $true ($guardAt -ge 0) "$($pair.Name) has a guard to order against"
  foreach ($write in @('New-ItemProperty', 'Remove-ItemProperty', 'New-Item -Path')) {
    $writeAt = $code.IndexOf($write)
    if ($writeAt -ge 0) {
      Assert-Equal $true ($guardAt -lt $writeAt) `
        "$($pair.Name) runs the 64-bit guard before its first $write"
    }
  }
}

# The guard must refuse rather than continue when SysNative is unreachable. A
# fallback to the 32-bit path would recreate the exact defect while looking
# defensive.
Assert-Equal $true ($install -match 'Refusing rather than reporting a success nothing can detect') `
  'Install refuses a 32-bit run it cannot escape instead of writing where detection cannot look'

# The published command line is the second half of the fix. Neither half is
# load-bearing alone, and a package whose printed guidance still says bare
# powershell.exe would put the next operator straight back into the defect.
$packager = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') -Raw
Assert-Equal $true ($packager -match [regex]::Escape('%SystemRoot%\SysNative\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-IonPolicy.ps1')) `
  'The packager prints a 64-bit install command line'
Assert-Equal $true ($packager -match [regex]::Escape('%SystemRoot%\SysNative\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File Uninstall-IonPolicy.ps1')) `
  'The packager prints a 64-bit uninstall command line'

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nNew-IonPolicyPackage.test.ps1: OK" -ForegroundColor Green
exit 0
