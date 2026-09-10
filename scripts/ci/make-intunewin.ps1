<#
.SYNOPSIS
  Wraps the Windows Ion installer as an Intune Win32 package (.intunewin),
  with provenance.

.DESCRIPTION
  Downloads the Microsoft Win32 Content Prep Tool at a pinned tag, verifies
  its SHA-256, stamps the detection script with the packaged version, runs the
  tool to produce Ion-Setup-<version>-<arch>.intunewin, and records what it
  just built.

  WHAT IT PRODUCES, in -OutputDir:

    Ion-Setup-<version>-<arch>.intunewin   the upload artifact
    Detect-Ion.ps1                         the detector, stamped with the
                                           packaged version, so it can be
                                           uploaded as the detection rule
                                           without unpacking anything
    Ion-Setup-<version>-<arch>.json        provenance: commit, dirty state,
                                           the installer input's hash, and
                                           each artifact's hash and size
    Ion-Setup-<version>-<arch>.sha256      the same hashes in the format
                                           `sha256sum -c` already speaks

  The provenance is not optional and is not a duplicate of the installer's
  own Ion-Artifacts-<version>-<arch>.json. That manifest covers ONE file, the
  .exe, and is written in desktop/release by the desktop build. The two
  artifacts an administrator actually uploads to Intune -- the .intunewin and
  the stamped detector -- are produced HERE, out of that .exe, and had no
  generated record of any kind. Someone holding them could hash them by hand;
  hashing an artifact tells you what it is, not which commit produced it,
  which tree state it came from, or which installer went into it. That is what
  a manifest is for, and independently recomputing a hash is not a substitute
  for one.

  The tool is a Windows PE binary, so the wrapping step only runs on Windows.
  Everything else -- download, hash verification, version stamping, provenance
  -- works on any platform, which is what -SkipPackaging exercises.

  The pinned tag, its SHA-256 and the invocation live in
  IonContentPrepTool.ps1 beside this script, and the provenance resolution
  lives in Write-IonArtifactManifest.ps1, because the enterprise policy
  package wraps itself with the same binary and records itself the same way.
  A second copy of a pinned tag, or of the stamp-before-git rule, is a second
  thing to update and the one nobody updates is the one that silently keeps
  being wrong.

.PARAMETER InstallerPath
  Path to the built Ion-Setup-<version>-<arch>.exe.

.PARAMETER OutputDir
  Directory to write the .intunewin package, the stamped detection script and
  the provenance pair.

.PARAMETER Version
  The version the caller believes it is packaging. Optional, and confirmatory
  only: it must equal the version in the installer filename, which is the
  version actually stamped. It cannot relabel a package, because the bytes
  going in are whatever the .exe is.

.PARAMETER IntuneWinAppUtilPath
  Use an already-downloaded IntuneWinAppUtil.exe instead of fetching one.

.PARAMETER RepoRoot
  The repository to read provenance from -- its sync stamp, or its git state.
  Defaults to this script's own repository. Named for the same reason
  Write-IonArtifactManifest.ps1 names it: the tree that produced the bytes is
  not always the tree the script is sitting in.

.PARAMETER SkipPackaging
  Do everything except invoke the Windows-only packaging tool. Used by CI on
  non-Windows hosts and by the local test to exercise download + verify +
  stamp + provenance.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallerPath,
  [Parameter(Mandatory = $true)] [string] $OutputDir,
  [string] $Version,
  [string] $IntuneWinAppUtilPath,
  [string] $RepoRoot,
  [switch] $SkipPackaging
)

$ErrorActionPreference = 'Stop'

# Copied out of the parameters BEFORE the helpers are loaded.
#
# Dot-sourcing a script runs its param block in THIS scope, and
# Write-IonArtifactManifest.ps1 declares $Path, $Version, $OutputPath, $Arch
# and $RepoRoot of its own. Loading it first silently blanks this script's
# -Version and -RepoRoot, and the failure reads as a missing argument on a
# command line that passed one. The policy wrapper learned this the hard way.
$ionInstallerPath = $InstallerPath
$ionOutputDir = $OutputDir
$ionVersion = [string] $Version
$ionToolPath = $IntuneWinAppUtilPath
$ionSkipPackaging = [bool] $SkipPackaging

# Two roots, deliberately. The detector SOURCE always comes from this script's
# own repository -- it is a tracked file beside the script. The PROVENANCE
# root is what -RepoRoot overrides, because the tree whose commit describes
# these bytes is a separate question from where the script lives.
$ionScriptRepo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$ionProvenanceRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { $ionScriptRepo }

. (Join-Path $PSScriptRoot 'IonContentPrepTool.ps1')
. (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1')

$DetectSource = Join-Path $ionScriptRepo 'packaging/windows/intune/Detect-Ion.ps1'

<#
.SYNOPSIS
  The version and architecture the installer filename claims.
.DESCRIPTION
  Both come out of the same match. The architecture used to be matched and
  thrown away, which is why the package had a version in its provenance and no
  answer to "which architecture is this" -- a question that matters precisely
  when two builds are sitting in the same folder.

  A caller-supplied version is checked against the filename rather than
  trusted over it. The filename describes the bytes; an argument describes an
  intention, and the two disagreeing means a package would be named, stamped
  and recorded as a version it does not contain.
#>
function Resolve-IonPackageIdentity {
  param(
    [Parameter(Mandatory = $true)] [string] $InstallerFile,
    [string] $ExplicitVersion
  )
  $name = [System.IO.Path]::GetFileNameWithoutExtension($InstallerFile)
  $match = [regex]::Match($name, '^Ion-Setup-(?<v>.+)-(?<arch>x64|arm64)$')
  if (-not $match.Success) {
    throw ("make-intunewin: cannot read a version and architecture from '$InstallerFile'. " +
           'The installer must be named Ion-Setup-<version>-<x64|arm64>.exe.')
  }
  $filenameVersion = $match.Groups['v'].Value
  if ($ExplicitVersion -and $ExplicitVersion -ne $filenameVersion) {
    throw "make-intunewin: explicit version '$ExplicitVersion' does not match installer filename version '$filenameVersion'."
  }
  $resolved = if ($ExplicitVersion) { $ExplicitVersion } else { $filenameVersion }
  return [pscustomobject]@{ Version = $resolved; Arch = $match.Groups['arch'].Value }
}

<#
.SYNOPSIS
  The name, size, SHA-256 and -- when it can be measured -- signature state of
  one file.
.DESCRIPTION
  The signature field is present only when a host could actually read it.
  Get-IonSignatureState answers "unchecked" where Get-AuthenticodeSignature
  does not exist, and a field carrying "unchecked" reads to tooling as a
  measurement. Omitting it says the one true thing: nothing was measured.
#>
function Get-IonPackageFileRecord {
  param([Parameter(Mandatory = $true)] [string] $File)
  $item = Get-Item -LiteralPath $File
  $record = [ordered]@{
    name   = $item.Name
    bytes  = [int64] $item.Length
    sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $signature = Get-IonSignatureState $item.FullName
  if ($signature -ne 'unchecked') { $record['signature'] = $signature }
  return $record
}

if (-not (Test-Path -LiteralPath $ionInstallerPath)) {
  [Console]::Error.WriteLine("make-intunewin: installer not found at $ionInstallerPath")
  exit 1
}
if (-not (Test-Path -LiteralPath $DetectSource)) {
  [Console]::Error.WriteLine("make-intunewin: detection script not found at $DetectSource")
  exit 1
}

$installer = (Resolve-Path -LiteralPath $ionInstallerPath).Path
$setupFile = Split-Path -Leaf $installer
$identity = Resolve-IonPackageIdentity -InstallerFile $setupFile -ExplicitVersion $ionVersion
$packagedVersion = $identity.Version
$packagedArch = $identity.Arch
$packageName = "Ion-Setup-$packagedVersion-$packagedArch"

New-Item -ItemType Directory -Path $ionOutputDir -Force | Out-Null
$outputDirFull = (Resolve-Path -LiteralPath $ionOutputDir).Path

# Stamp the detection script. The sentinel is assembled from two halves in
# Detect-Ion.ps1's own guard so this replacement cannot accidentally rewrite
# the guard itself.
$stampedPath = Join-Path $outputDirFull 'Detect-Ion.ps1'
(Get-Content -LiteralPath $DetectSource -Raw).Replace("'__ION_VERSION__'", "'$packagedVersion'") |
  Set-Content -LiteralPath $stampedPath -NoNewline
Write-Output "make-intunewin: stamped detection script with version $packagedVersion -> $stampedPath"

$artifactPath = Join-Path $outputDirFull "$packageName.intunewin"

if ($ionSkipPackaging) {
  Write-Output 'make-intunewin: -SkipPackaging given, .intunewin not produced'
} else {
  # The content dir holds the installer and nothing else.
  #
  # This used to wrap the installer's own PARENT, which on a release runner is
  # a directory containing exactly that build's output and is therefore correct
  # there -- and on any machine that has built twice is desktop/release, holding
  # every previous installer, their blockmaps, the nsis payload and the whole
  # unpacked application. That produced a 1.6 GB content folder and a ~1 GB
  # package carrying three installers of other versions. A device would have
  # downloaded all of it to run one of them.
  #
  # Intune installs by running the setup file, so the installer alone is the
  # payload. Staged into a directory of its own, which also makes the package
  # byte-identical whatever else happens to be sitting in the release folder.
  $stageDir = Join-Path $outputDirFull '.content'
  if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
  Copy-Item -LiteralPath $installer -Destination (Join-Path $stageDir $setupFile) -Force

  try {
    $tool = Resolve-IonContentPrepTool -ExistingPath $ionToolPath
    $package = Invoke-IonContentPrep -ToolPath $tool -SourceDir $stageDir -SetupFile $setupFile -OutputDir $outputDirFull
  } catch {
    [Console]::Error.WriteLine("make-intunewin: $($_.Exception.Message)")
    exit 1
  } finally {
    # The staged copy is 130 MB and its only job is done.
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  # The tool names its output after the setup file, which for the installer is
  # already Ion-Setup-<version>-<arch>. Normalised anyway so the artifact this
  # script names in its provenance is the artifact it wrote, rather than a
  # coincidence of the tool's naming rule.
  if ($package -ne $artifactPath) {
    if (Test-Path -LiteralPath $artifactPath) { Remove-Item -LiteralPath $artifactPath -Force }
    Move-Item -LiteralPath $package -Destination $artifactPath -Force
  }
  Write-Output "make-intunewin: OK -> $artifactPath"
  Write-Output "  content: $setupFile only ($((Get-Item -LiteralPath $artifactPath).Length) bytes packaged)"
}

# -- Provenance ---------------------------------------------------------------
# Same rule and the same resolver the installer's manifest uses. Reading git
# directly here would reproduce the defect that resolver exists to remove: on a
# synced VM, leftover .git metadata describes a tree nobody built from, and it
# answers confidently.
$state = Get-IonProvenanceState -Root $ionProvenanceRoot

# The version stamped into the detector and into every artifact name must be
# the version the stamp describes. They come from different places -- one was
# parsed off an installer filename, the other recorded at sync time -- and a
# disagreement means these artifacts describe a different tree than the one
# that was synced. Fatal rather than a warning, for the same reason it is fatal
# in Write-IonArtifactManifest.ps1: the package is about to be uploaded to a
# fleet under a name that is not true.
if ($state.Source -eq 'sync-stamp' -and $packagedVersion -ne $state.DesktopVersion) {
  [Console]::Error.WriteLine(
    "make-intunewin: packaged version '$packagedVersion' does not match the sync stamp's " +
    "desktopVersion '$($state.DesktopVersion)' at $($state.StampPath). " +
    'The package and the source it was built from disagree; do not upload this artifact.')
  exit 1
}

# 'test-build', always, from this script.
#
# This wrapper runs on a developer or packaging workstation, not the pinned
# release runner. A clean tree makes the commit resolvable; it does not make
# the bytes reproducible, because nothing here pins the toolchain, the signing
# identity or the environment. Get-IonBuildLabel only ever narrows, so a dirty
# tree stays a test build regardless -- passing 'test-build' means a CLEAN
# local package is still honestly labelled rather than promoted by accident.
$label = Get-IonBuildLabel -Dirty ([bool] $state.Dirty) -Requested 'test-build'

$artifacts = @()
foreach ($f in @($artifactPath, $stampedPath)) {
  if (Test-Path -LiteralPath $f) { $artifacts += Get-IonPackageFileRecord $f }
}

$provenance = [ordered]@{
  schema           = 1
  package          = 'ion-desktop-intunewin'
  version          = $packagedVersion
  arch             = $packagedArch
  commit           = $state.Commit
  dirty            = [bool] $state.Dirty
  dirtyFiles       = @($state.DirtyFiles)
  buildType        = $label.BuildType
  reproducible     = $label.Reproducible
  provenanceSource = $state.Source
  builtAtUtc       = (Get-Date).ToUniversalTime().ToString('o')
  inputs           = [ordered]@{
    # The installer that went in. "Which .exe is inside this package" is the
    # question asked when a device installs a build nobody recognises, and the
    # .intunewin's own hash cannot answer it.
    installer = Get-IonPackageFileRecord $installer
  }
  artifacts        = $artifacts
}
if ($state.Source -eq 'sync-stamp') {
  $provenance['syncedAtUtc'] = $state.SyncedAtUtc
}

$provenancePath = Join-Path $outputDirFull "$packageName.json"
$provenance | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $provenancePath -Encoding utf8

$sha256Path = Join-Path $outputDirFull "$packageName.sha256"
Write-IonSha256File -Path $sha256Path -Lines @(
  $artifacts | ForEach-Object { "$($_.sha256)  $($_.name)" }
)

Write-Output "make-intunewin: provenance -> $provenancePath ($($label.BuildType), reproducible=$($label.Reproducible), provenance=$($state.Source))"
Write-Output "make-intunewin: checksums  -> $sha256Path"
foreach ($a in $artifacts) {
  Write-Output "  $($a.sha256)  $($a.name)  ($($a.bytes) bytes)"
}
exit 0
