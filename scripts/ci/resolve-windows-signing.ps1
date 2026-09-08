<#
.SYNOPSIS
  Decides whether this Windows build signs, proceeds unsigned, or fails.

.DESCRIPTION
  Authenticode signing is the difference between an installer Windows trusts
  and one SmartScreen warns about. The decision has to be made in one place,
  because the failure it guards against is silent: a release pipeline whose
  signing secret expired or was renamed would otherwise keep publishing
  installers, unsigned, and nothing would say so until a user saw the warning.

  Three outcomes, and the middle one is the whole point:

    sign      a certificate is configured -- use it, and a signing failure is
              fatal rather than a fallback to unsigned
    fail      signing is required and no certificate is configured -- stop
              before building, because an official release must not be
              published unsigned
    unsigned  nothing is configured and nothing is required -- build, and label
              the artifact so it can never be mistaken for a release asset

  The unsigned outcome is not a policy exception. It exists so a contributor
  and a pilot can build locally with no certificate, and the artifact it
  produces is labelled UNSIGNED in the build log and reported as unsigned in
  its provenance manifest (scripts/ci/Write-IonArtifactManifest.ps1 reads the
  signature off the file rather than trusting this decision).

  Secrets only. The certificate arrives base64-encoded in an environment
  variable, is written to a file under the runner's temp directory, and its
  path and password are handed to electron-builder. Nothing is written to the
  repository and no value is echoed.

.PARAMETER GitHubOutput
  Path to write `signed=`, `certificateFile=` and `buildType=` for a GitHub
  Actions step output. Defaults to $env:GITHUB_OUTPUT when set.

.PARAMETER CertificateBase64
  Base64 of the code-signing .pfx. Defaults to $env:WINDOWS_CERT_PFX_BASE64.

.PARAMETER CertificatePassword
  Its password. Defaults to $env:WINDOWS_CERT_PASSWORD.

.PARAMETER Required
  Fail when no certificate is configured. Defaults to
  $env:ION_REQUIRE_WINDOWS_SIGNING being "true".
#>
[CmdletBinding()]
param(
  [string] $GitHubOutput,
  [string] $CertificateBase64,
  [string] $CertificatePassword,
  [Nullable[bool]] $Required
)

$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
  The signing decision for a given configuration.
.DESCRIPTION
  Pure, so the three outcomes are pinned by tests rather than discovered at
  release time. Returns an Action of sign | fail | unsigned and the reason,
  which is what reaches the build log.
#>
function Resolve-IonSigningDecision {
  param(
    [Parameter(Mandatory = $true)] [bool] $HasCertificate,
    [Parameter(Mandatory = $true)] [bool] $Required
  )
  if ($HasCertificate) {
    return [pscustomobject]@{
      Action = 'sign'
      Reason = 'a code-signing certificate is configured; a signing failure will fail the build'
    }
  }
  if ($Required) {
    return [pscustomobject]@{
      Action = 'fail'
      Reason = 'signing is required (ION_REQUIRE_WINDOWS_SIGNING=true) but no certificate is configured'
    }
  }
  return [pscustomobject]@{
    Action = 'unsigned'
    Reason = 'no certificate configured and none required: this build is UNSIGNED and is not a release artifact'
  }
}

# Dot-sourcing loads the decision function without reading any secret, which
# is how Write-IonArtifactManifest.test.ps1 exercises it.
if ($MyInvocation.InvocationName -eq '.') { return }

if (-not $CertificateBase64) { $CertificateBase64 = $env:WINDOWS_CERT_PFX_BASE64 }
if (-not $CertificatePassword) { $CertificatePassword = $env:WINDOWS_CERT_PASSWORD }
if ($null -eq $Required) { $Required = ($env:ION_REQUIRE_WINDOWS_SIGNING -eq 'true') }
if (-not $GitHubOutput) { $GitHubOutput = $env:GITHUB_OUTPUT }

$hasCert = -not [string]::IsNullOrWhiteSpace($CertificateBase64)
$decision = Resolve-IonSigningDecision -HasCertificate $hasCert -Required ([bool] $Required)

Write-Output "windows signing: $($decision.Action) -- $($decision.Reason)"

if ($decision.Action -eq 'fail') {
  [Console]::Error.WriteLine('windows signing: refusing to build an unsigned release. Configure WINDOWS_CERT_PFX_BASE64 and WINDOWS_CERT_PASSWORD, or unset ION_REQUIRE_WINDOWS_SIGNING.')
  exit 1
}

$certPath = ''
if ($decision.Action -eq 'sign') {
  if ([string]::IsNullOrWhiteSpace($CertificatePassword)) {
    [Console]::Error.WriteLine('windows signing: a certificate is configured but WINDOWS_CERT_PASSWORD is empty. Refusing to attempt an unauthenticated signing run.')
    exit 1
  }
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-signing-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $certPath = Join-Path $dir 'ion-codesign.pfx'
  try {
    [System.IO.File]::WriteAllBytes($certPath, [Convert]::FromBase64String($CertificateBase64))
  } catch {
    # Deliberately does not echo the value. A malformed secret is a
    # configuration error, and an official release must stop rather than fall
    # back to unsigned.
    [Console]::Error.WriteLine("windows signing: WINDOWS_CERT_PFX_BASE64 is not valid base64 ($($_.Exception.Message)).")
    exit 1
  }
  Write-Output "windows signing: certificate staged at $certPath"
}

$buildType = if ($decision.Action -eq 'sign') { 'release' } else { 'test-build' }

if ($GitHubOutput) {
  Add-Content -LiteralPath $GitHubOutput -Value "signed=$($decision.Action -eq 'sign')"
  Add-Content -LiteralPath $GitHubOutput -Value "certificateFile=$certPath"
  Add-Content -LiteralPath $GitHubOutput -Value "buildType=$buildType"
}

if ($decision.Action -eq 'unsigned') {
  Write-Warning 'This installer will be UNSIGNED. Windows SmartScreen will warn on a self-service download. Do not publish it as a release asset.'
}
exit 0
