<#
.SYNOPSIS
  Builds the Ion Enterprise Policy package AND wraps it as a deterministically
  named .intunewin, with provenance.

.DESCRIPTION
  One command from the tenant's inputs to the artifact an administrator
  uploads. Before this existed the documented route ended at a package
  DIRECTORY and told a human to run IntuneWinAppUtil.exe themselves, from
  "the same pinned tag" as the application packaging script -- an instruction
  that is followed correctly right up until it is not, and the failure is an
  unverified binary producing the file a fleet installs from.

  So the wrapping happens here, through the same pinned, SHA-256-verified tool
  the application packaging uses (scripts/ci/IonContentPrepTool.ps1), and the
  result is named for what it is rather than for whichever file the tool was
  pointed at.

  WHAT IT PRODUCES, in -OutputDir:

    Ion-Policy-<version>\                  the package directory, as built by
                                           New-IonPolicyPackage.ps1: payload,
                                           theme, install, uninstall, and the
                                           detector stamped with both
    Ion-Policy-<version>.intunewin         the upload artifact
    Detect-IonPolicy-<version>.ps1         the stamped detector, lifted out so
                                           it can be uploaded as the detection
                                           rule without unpacking anything
    Ion-Policy-<version>.json              provenance: commit, dirty state,
                                           the inputs' hashes, the artifact's
                                           hash and size
    Ion-Policy-<version>.sha256            the same hashes in the format
                                           `sha256sum -c` already speaks

  The .intunewin's own name is not chosen by the content prep tool, which
  names its output after the setup file it was given -- every policy package
  ever built would be "Install-IonPolicy.intunewin", indistinguishable in a
  downloads folder and in an Intune app's history. It is renamed here.

  The provenance records the CONFIG and THEME hashes, not only the artifact's.
  "Which build is this" is answerable from a version; "which tenant
  configuration is inside it" is not, and that is the question asked when a
  device turns out to be carrying settings nobody recognises.

.PARAMETER ConfigPath
  The complete enterprise config JSON. Required. Passed through.

.PARAMETER ThemePath
  The theme pack manifest the config's themePolicy names. Required. Passed
  through.

.PARAMETER Version
  The package version. Required.

.PARAMETER OutputDir
  Where everything above is written. Required.

.PARAMETER IntuneWinAppUtilPath
  Use an already-downloaded IntuneWinAppUtil.exe instead of fetching one.

.PARAMETER SkipPackaging
  Do everything except invoke the Windows-only packaging tool. The tool is a
  Windows PE binary, so this is how a non-Windows host and CI exercise the
  build, the validation and the provenance.
#>
[CmdletBinding()]
param(
  [string] $ConfigPath,
  [string] $ThemePath,
  [string] $Version,
  [string] $OutputDir,
  [string] $IntuneWinAppUtilPath,
  [switch] $SkipPackaging
)

$ErrorActionPreference = 'Stop'

foreach ($required in @('ConfigPath', 'ThemePath', 'Version', 'OutputDir')) {
  if (-not (Get-Variable -Name $required -ValueOnly)) {
    throw "New-IonPolicyIntuneWin: -$required is required."
  }
}

# Copied out of the parameters BEFORE the helpers are loaded.
#
# Dot-sourcing a script runs its param block in THIS scope, and
# Write-IonArtifactManifest.ps1 declares $Path, $Version, $OutputPath, $Arch
# and $RepoRoot of its own. Loading it first silently blanked this script's
# own -Version, and the failure read as "-Version is required" on a command
# line that passed one.
$ionConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$ionThemePath = (Resolve-Path -LiteralPath $ThemePath).Path
$ionVersion = [string] $Version
$ionOutputDir = $OutputDir
$ionToolPath = $IntuneWinAppUtilPath
$ionSkipPackaging = [bool] $SkipPackaging
$ionRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path

. (Join-Path $ionRepoRoot 'scripts/ci/IonContentPrepTool.ps1')
. (Join-Path $ionRepoRoot 'scripts/ci/Write-IonArtifactManifest.ps1')

New-Item -ItemType Directory -Path $ionOutputDir -Force | Out-Null
$outputFull = (Resolve-Path -LiteralPath $ionOutputDir).Path
$packageName = "Ion-Policy-$ionVersion"
$packageDir = Join-Path $outputFull $packageName

# Build the package first. It validates the config and the theme, and a
# refusal there must stop before any artifact exists.
& (Join-Path $PSScriptRoot 'New-IonPolicyPackage.ps1') `
  -ConfigPath $ionConfigPath -ThemePath $ionThemePath -Version $ionVersion -OutputDir $packageDir
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("New-IonPolicyIntuneWin: the package build failed with exit code $LASTEXITCODE")
  exit $LASTEXITCODE
}

# The stamped detector, lifted out of the package. Intune's detection rule
# takes a script file on its own, so an administrator would otherwise have to
# unpack the .intunewin to get at the one that was actually stamped.
$stampedDetector = Join-Path $outputFull "Detect-IonPolicy-$ionVersion.ps1"
Copy-Item -LiteralPath (Join-Path $packageDir 'Detect-IonPolicy.ps1') -Destination $stampedDetector -Force
Write-Output "New-IonPolicyIntuneWin: stamped detector -> $stampedDetector"

$artifactPath = Join-Path $outputFull "$packageName.intunewin"

if ($ionSkipPackaging) {
  Write-Output 'New-IonPolicyIntuneWin: -SkipPackaging given, .intunewin not produced'
} else {
  try {
    $tool = Resolve-IonContentPrepTool -ExistingPath $ionToolPath
    $produced = Invoke-IonContentPrep -ToolPath $tool -SourceDir $packageDir `
      -SetupFile 'Install-IonPolicy.ps1' -OutputDir $outputFull
  } catch {
    [Console]::Error.WriteLine("New-IonPolicyIntuneWin: $($_.Exception.Message)")
    exit 1
  }
  if (Test-Path -LiteralPath $artifactPath) { Remove-Item -LiteralPath $artifactPath -Force }
  Move-Item -LiteralPath $produced -Destination $artifactPath -Force
  Write-Output "New-IonPolicyIntuneWin: OK -> $artifactPath"
}

# ── Provenance ───────────────────────────────────────────────────────────────
# Same rule the installer's manifest follows: a build from a dirty tree cannot
# be reproduced from its commit, so it is labelled a test build rather than
# refused. Refusing would leave the most common local build with no provenance
# at all, which is worse than an honest label.

function Get-IonFileRecord([string] $path) {
  return [ordered]@{
    name   = (Split-Path -Leaf $path)
    bytes  = (Get-Item -LiteralPath $path).Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

# Through the shared resolver, so this package records the same commit the
# installer's manifest does. Reading git directly here would reproduce the
# defect that resolver exists to remove: on a synced VM, leftover .git metadata
# describes a tree nobody built from.
$git = Get-IonProvenanceState -Root $ionRepoRoot
# This wrapper runs on a developer or packaging workstation, not the pinned release runner.
# A clean source identity is traceable, but local toolchain bytes are still a test build.
$label = Get-IonBuildLabel -Dirty $git.Dirty -Requested 'test-build'
$payload = Get-Content -LiteralPath (Join-Path $packageDir 'IonPolicy.json') -Raw | ConvertFrom-Json

$artifacts = @()
foreach ($f in @($artifactPath, $stampedDetector)) {
  if (Test-Path -LiteralPath $f) { $artifacts += Get-IonFileRecord $f }
}

$provenance = [ordered]@{
  schema         = 1
  package        = 'ion-enterprise-policy'
  version        = $ionVersion
  commit         = $git.Commit
  dirty          = $git.Dirty
  dirtyFiles     = @($git.DirtyFiles)
  buildType      = $label.BuildType
  reproducible   = $label.Reproducible
  provenanceSource = $git.Source
  builtAtUtc     = (Get-Date).ToUniversalTime().ToString('o')
  inputs         = [ordered]@{
    config = Get-IonFileRecord ((Resolve-Path -LiteralPath $ionConfigPath).Path)
    theme  = [ordered]@{
      id      = [string] $payload.theme.id
      version = [string] $payload.theme.version
      files   = @($payload.theme.files)
    }
  }
  policyValues   = @($payload.values | ForEach-Object { "$($_.name) [$($_.type)]" })
  artifacts      = $artifacts
}

$provenancePath = Join-Path $outputFull "$packageName.json"
$provenance | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $provenancePath -Encoding utf8

$sha256Path = Join-Path $outputFull "$packageName.sha256"
$lines = @($artifacts | ForEach-Object { "$($_.sha256)  $($_.name)" })
Write-IonSha256File -Path $sha256Path -Lines $lines

Write-Output "New-IonPolicyIntuneWin: provenance -> $provenancePath ($($label.BuildType), reproducible=$($label.Reproducible))"
Write-Output "New-IonPolicyIntuneWin: checksums  -> $sha256Path"
exit 0
