<#
.SYNOPSIS
  Writes a SHA-256 provenance manifest for a set of built artifacts.

.DESCRIPTION
  Answers, for every file it is given, the only questions that matter when
  somebody is holding an installer and wants to know what it is: which commit
  produced it, whether the tree was clean at the time, which version and
  architecture it claims, how large it is, what its SHA-256 is, and whether it
  carries a valid Authenticode signature.

  Two outputs, because they serve different readers:
    <name>.json   the full record, for a release page and for tooling
    <name>.sha256 one "<hash>  <filename>" line per artifact, the format
                  `sha256sum -c` and Get-FileHash comparisons already speak

  Reproducibility is asserted, never assumed. A build from a dirty working
  tree cannot be reproduced from its commit -- the bytes depend on edits that
  exist on exactly one machine -- so `reproducible` is false and `buildType`
  is "test-build" whenever git reports anything uncommitted. A dirty build is
  still produced, and still gets a manifest: refusing one would leave the most
  common local build with no provenance at all, which is worse than an honest
  label. What it must never do is claim to be a release artifact.

  Provenance is read from the sync stamp when there is one and from git
  otherwise, in that order. See Get-IonSyncStamp for why the order is
  load-bearing rather than a preference.

  Signing is likewise measured rather than declared. Each artifact's
  Authenticode status is read off the file itself with Get-AuthenticodeSignature
  where that cmdlet exists; on a non-Windows host it is reported as unchecked
  rather than guessed, so a manifest never says "signed" because somebody
  intended it to be.

.PARAMETER Path
  The artifacts to record. Missing files are a hard error: a manifest that
  silently omits an asset is worse than no manifest.

.PARAMETER OutputPath
  The .json file to write. The .sha256 file is written beside it with the same
  base name.

.PARAMETER Version
  The version these artifacts claim.

.PARAMETER Arch
  The architecture these artifacts were built for (x64 | arm64).

.PARAMETER RepoRoot
  The repository to read git state from. Defaults to this script's repository.

.PARAMETER StampPath
  The sync stamp to read provenance from. Defaults to
  <RepoRoot>/.ion-sync-stamp.json. A stamp that is present wins over git; see
  Get-IonProvenanceState for why.

.PARAMETER BuildType
  Overrides the computed label. Only ever narrows: a dirty tree stays
  "test-build" whatever is passed, because the label has to be true.
#>
# None of these are declared Mandatory. A mandatory parameter makes
# PowerShell prompt when the file is DOT-SOURCED, which is how the tests load
# the pure functions below -- a prompt in CI is an indefinite hang with no
# output. They are required all the same, and the body refuses without them
# with a better message than the prompt would have given.
[CmdletBinding()]
param(
  [string[]] $Path,
  [string] $OutputPath,
  [string] $Version,
  [ValidateSet('x64', 'arm64')] [string] $Arch,
  [string] $RepoRoot,
  [string] $StampPath,
  [ValidateSet('release', 'test-build')] [string] $BuildType = 'release'
)

$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
  The git commit and dirty state of a repository.
.DESCRIPTION
  Pure enough to test: it shells out to git and shapes the answer, and the
  shaping is what the tests exercise via Get-IonBuildLabel below. A repository
  git cannot read reports an unknown commit and a dirty tree -- the
  conservative pair, because an unknown commit is exactly the case where
  "reproducible" must not be claimed.
#>
function Get-IonGitState {
  param([Parameter(Mandatory = $true)] [string] $Root)
  $commit = (& git -C $Root rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $commit) {
    return [pscustomobject]@{ Commit = 'unknown'; Dirty = $true; DirtyFiles = @() }
  }
  $status = @(& git -C $Root status --porcelain 2>$null)
  return [pscustomobject]@{
    Commit     = $commit.Trim()
    Dirty      = ($status.Count -gt 0)
    DirtyFiles = @($status | ForEach-Object { $_.Substring(3) })
  }
}

<#
.SYNOPSIS
  The honest build label and reproducibility flag for a git state.
.DESCRIPTION
  The one rule this file exists to enforce: a dirty tree is never
  reproducible and is never a release, whatever the caller asked for.
#>
function Write-IonSha256File {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string[]] $Lines
  )
  # sha256sum treats CR as part of a filename on Unix. Write explicit ASCII LF
  # bytes so a checksum generated on Windows verifies unchanged on every host.
  $text = ($Lines -join "`n") + "`n"
  [System.IO.File]::WriteAllText($Path, $text, [System.Text.Encoding]::ASCII)
}

function Get-IonBuildLabel {
  param(
    [Parameter(Mandatory = $true)] [bool] $Dirty,
    [Parameter(Mandatory = $true)] [string] $Requested
  )
  if ($Dirty) {
    return [pscustomobject]@{ BuildType = 'test-build'; Reproducible = $false }
  }
  return [pscustomobject]@{ BuildType = $Requested; Reproducible = ($Requested -eq 'release') }
}

<#
.SYNOPSIS
  The provenance a sync stamp carries, or $null when there is no stamp.
.DESCRIPTION
  `.ion-sync-stamp.json` is written by scripts/sync-windows-vm.sh into the
  same archive as the source it describes, so its presence means "this exact
  tree arrived from that commit". It exists because the Windows VM builds from
  an extracted tar into a directory that has accumulated .git metadata from
  historic partial copies: git there answers about a tree nobody synced. That
  is not hypothetical. A build whose stamp correctly read commit 57423b95 with
  a clean tree still had its manifest written from git's stale, dirty 40d39acc,
  and the resulting installer's provenance named a commit its own bytes did
  not come from.

  A stamp that is present but unparseable, incomplete, or wrongly typed is a
  HARD FAILURE and never a fall-through to git. Falling through is precisely
  what produced the false provenance above: git is always willing to answer,
  and its answer looked authoritative. A stamp only exists because a sync
  wrote it, so a broken one means the sync is broken.

  A tree with no stamp -- an ordinary developer checkout, or a CI release
  runner -- reads git exactly as before.
#>
function Get-IonSyncStamp {
  param([Parameter(Mandatory = $true)] [string] $StampPath)

  if (-not (Test-Path -LiteralPath $StampPath)) { return $null }

  try {
    $raw = Get-Content -LiteralPath $StampPath -Raw
    $stamp = $raw | ConvertFrom-Json
  } catch {
    throw ("Write-IonArtifactManifest: $StampPath is not readable JSON: $($_.Exception.Message). " +
           'A present sync stamp is authoritative, so a broken one is fatal rather than a fallback to git. ' +
           'Re-run `make sync-windows-vm`.')
  }
  if ($null -eq $stamp -or $stamp -isnot [pscustomobject]) {
    throw "Write-IonArtifactManifest: $StampPath does not contain a JSON object. Re-run ``make sync-windows-vm``."
  }

  # Presence is checked on the property rather than on its value, because
  # `dirty: false` and "no dirty field at all" are the same falsy value to
  # PowerShell and mean opposite things: one is a clean tree, the other is a
  # stamp that cannot say.
  $props = @($stamp.PSObject.Properties.Name)
  foreach ($field in @('commit', 'desktopVersion', 'dirty', 'dirtyFiles', 'syncedAtUtc')) {
    if ($props -notcontains $field) {
      throw ("Write-IonArtifactManifest: $StampPath carries no '$field'. " +
             'A partial sync stamp cannot describe the tree it sits in. Re-run `make sync-windows-vm`.')
    }
  }

  # A full 40-hex SHA, not an abbreviation. The manifest is the record someone
  # resolves back to a commit six weeks later, and a short sha can become
  # ambiguous in a repository that has grown since.
  $commit = [string] $stamp.commit
  if ($commit -notmatch '^[0-9a-f]{40}$') {
    throw ("Write-IonArtifactManifest: $StampPath commit '$commit' is not a full 40-character SHA. " +
           'Re-run `make sync-windows-vm`.')
  }

  $version = [string] $stamp.desktopVersion
  if (-not $version.Trim()) {
    throw "Write-IonArtifactManifest: $StampPath carries an empty 'desktopVersion'. Re-run ``make sync-windows-vm``."
  }

  if ($stamp.dirty -isnot [bool]) {
    throw ("Write-IonArtifactManifest: $StampPath 'dirty' is not a JSON boolean (got '$($stamp.dirty)'). " +
           'Re-run `make sync-windows-vm`.')
  }

  # ConvertFrom-Json gives $null for `[]` on some hosts and Object[] elsewhere,
  # so an explicit non-array scalar is what is rejected here -- not emptiness.
  if ($null -ne $stamp.dirtyFiles -and $stamp.dirtyFiles -isnot [System.Collections.IEnumerable]) {
    throw "Write-IonArtifactManifest: $StampPath 'dirtyFiles' is not a JSON array. Re-run ``make sync-windows-vm``."
  }
  if ($stamp.dirtyFiles -is [string]) {
    throw "Write-IonArtifactManifest: $StampPath 'dirtyFiles' is a string, not a JSON array. Re-run ``make sync-windows-vm``."
  }

  # ConvertFrom-Json hydrates an ISO-8601 string into a [datetime], and casting
  # that to a string yields the host's local display format -- "09/07/2026
  # 21:00:00" rather than the instant the stamp wrote. Re-serialised here so the
  # manifest carries the same canonical form on every host.
  $synced = if ($stamp.syncedAtUtc -is [datetime]) {
    ([datetime] $stamp.syncedAtUtc).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  } else {
    [string] $stamp.syncedAtUtc
  }
  if (-not $synced.Trim()) {
    throw "Write-IonArtifactManifest: $StampPath carries an empty 'syncedAtUtc'. Re-run ``make sync-windows-vm``."
  }

  return [pscustomobject]@{
    Commit         = $commit
    Dirty          = [bool] $stamp.dirty
    DirtyFiles     = @($stamp.dirtyFiles)
    DesktopVersion = $version
    SyncedAtUtc    = $synced
    Source         = 'sync-stamp'
    StampPath      = $StampPath
  }
}

<#
.SYNOPSIS
  The commit and dirty state to record, from the stamp when there is one and
  from git otherwise.
.DESCRIPTION
  Order is the whole point: the stamp is consulted FIRST. Git answering first
  is what let a synced tree's leftover .git metadata overwrite correct
  provenance with a stale commit. `Source` says which answered, so the manifest
  itself records how it knows.
#>
function Get-IonProvenanceState {
  param(
    [Parameter(Mandatory = $true)] [string] $Root,
    [string] $StampPath
  )
  if (-not $StampPath) { $StampPath = Join-Path $Root '.ion-sync-stamp.json' }

  $stamp = Get-IonSyncStamp -StampPath $StampPath
  if ($stamp) { return $stamp }

  $git = Get-IonGitState -Root $Root
  return [pscustomobject]@{
    Commit         = $git.Commit
    Dirty          = [bool] $git.Dirty
    DirtyFiles     = @($git.DirtyFiles)
    DesktopVersion = $null
    SyncedAtUtc    = $null
    Source         = 'git'
    StampPath      = $StampPath
  }
}

<#
.SYNOPSIS
  The Authenticode state of one file, measured rather than assumed.
.DESCRIPTION
  Returns "valid", "unsigned", the failing status name, or "unchecked" on a
  host with no Get-AuthenticodeSignature. Never returns "signed" on intent.
#>
function Get-IonSignatureState {
  param([Parameter(Mandatory = $true)] [string] $File)
  if (-not (Get-Command -Name Get-AuthenticodeSignature -ErrorAction SilentlyContinue)) {
    return 'unchecked'
  }
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $File
  } catch {
    return 'unchecked'
  }
  switch ($sig.Status) {
    'Valid' { return 'valid' }
    'NotSigned' { return 'unsigned' }
    default { return [string] $sig.Status }
  }
}

# Dot-sourcing loads the functions without writing anything, which is how
# Write-IonArtifactManifest.test.ps1 exercises them on a Linux runner.
if ($MyInvocation.InvocationName -eq '.') { return }

foreach ($required in @('Path', 'OutputPath', 'Version', 'Arch')) {
  if (-not (Get-Variable -Name $required -ValueOnly)) {
    throw "Write-IonArtifactManifest: -$required is required."
  }
}

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path }

$artifacts = @()
foreach ($p in $Path) {
  if (-not (Test-Path -LiteralPath $p)) {
    throw "Write-IonArtifactManifest: artifact not found at $p. A manifest that omits an asset is worse than none."
  }
  $item = Get-Item -LiteralPath $p
  $artifacts += [pscustomobject]@{
    name      = $item.Name
    bytes     = [int64] $item.Length
    sha256    = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    signature = Get-IonSignatureState $item.FullName
  }
}

# An explicitly named stamp that is not there is a broken invocation, not a
# licence to ask git. The caller said where the provenance lives.
if ($StampPath -and -not (Test-Path -LiteralPath $StampPath)) {
  throw "Write-IonArtifactManifest: -StampPath $StampPath does not exist."
}

$state = Get-IonProvenanceState -Root $RepoRoot -StampPath $StampPath

# The version the caller stamped into the artifacts must be the version the
# stamp describes. They come from different places -- the caller resolved one
# at the start of the build, the stamp recorded one at sync time -- and a
# disagreement means the manifest is about to describe a different tree than
# the one that was built. That is the whole failure this file is defending
# against, so it is fatal rather than a warning.
if ($state.Source -eq 'sync-stamp' -and $Version -ne $state.DesktopVersion) {
  throw ("Write-IonArtifactManifest: -Version '$Version' does not match the sync stamp's " +
         "desktopVersion '$($state.DesktopVersion)' at $($state.StampPath). " +
         'The build and the source it was built from disagree; do not ship this artifact.')
}

$label = Get-IonBuildLabel -Dirty ([bool] $state.Dirty) -Requested $BuildType

$manifest = [ordered]@{
  version           = $Version
  arch              = $Arch
  commit            = $state.Commit
  dirty             = [bool] $state.Dirty
  buildType         = $label.BuildType
  reproducible      = $label.Reproducible
  provenanceSource  = $state.Source
  builtAtUtc        = (Get-Date).ToUniversalTime().ToString('o')
  artifacts         = $artifacts
}
if ($state.Source -eq 'sync-stamp') {
  $manifest['syncedAtUtc'] = $state.SyncedAtUtc
}
if ($state.Dirty) {
  # Named, not just flagged. "Which edits were in this build" is the question
  # asked six weeks later, and by then the working tree is gone.
  $manifest['dirtyFiles'] = @($state.DirtyFiles)
}

$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8

$sumsPath = [System.IO.Path]::ChangeExtension($OutputPath, '.sha256')
Write-IonSha256File -Path $sumsPath -Lines @(
  $artifacts | ForEach-Object { "$($_.sha256)  $($_.name)" }
)

Write-Output "artifact manifest: $OutputPath"
Write-Output "artifact checksums: $sumsPath"
Write-Output "  version=$Version arch=$Arch commit=$($state.Commit) dirty=$($state.Dirty) buildType=$($label.BuildType) reproducible=$($label.Reproducible) provenance=$($state.Source)"
foreach ($a in $artifacts) {
  Write-Output "  $($a.sha256)  $($a.name)  ($($a.bytes) bytes, signature: $($a.signature))"
}
if (-not $label.Reproducible) {
  Write-Warning "This build is NOT reproducible and is labelled $($label.BuildType). Do not publish it as a release artifact."
}
exit 0
